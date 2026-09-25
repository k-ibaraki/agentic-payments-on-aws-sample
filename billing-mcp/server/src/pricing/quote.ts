// リクエスト本文から価格帯と価格を決める（DESIGN.md 決定55・56）。見積書の往復が
// 要る理由は quote-format.ts 参照。ここでは1往復目でのみ判定し、2往復目は見積書を
// 読めればそのまま使う。読めない、または価格表と食い違う場合（表を差し替えた直後の
// 古い見積書）は判定し直す。買い手（agent-app）は再判定後の 402 を決済の失敗と区別
// できないため利用者の承認を経てから買い直す（DESIGN.md 決定48）
import type { Judge } from "./judge.js";
import {
  decodeQuote,
  encodeQuote,
  matchesTable,
  type Tier,
} from "./quote-format.js";
import { priceOf, type TierTable } from "./tiers.js";

/** 値付けの対象となる有料ツール */
export const PAID_TOOL_NAME = "generate-html";

/** `_meta` に積まれる支払いのキー（`@x402/mcp` の MCP_PAYMENT_META_KEY と同値） */
const PAYMENT_META_KEY = "x402/payment";

/** 判定できないときに使う価格帯。判定処理の fallback と揃える */
const DEFAULT_TIER: Tier = "take";

export interface ResolveQuoteOptions {
  table: TierTable;
  judge: Judge;
}

export interface ResolvedQuote {
  tier: Tier;
  /** 価格帯に対応する価格（"$0.15" 形式） */
  price: string;
  /**
   * `accepts[].extra.quote` に載せる見積書。
   * 値付けの対象でない呼び出しでは付けない
   */
  quote?: string;
  /**
   * 判定モデルが確信度を返した場合のみ。判断には使わず、記録するために運ぶ。
   * 見積書を読んだ 2 往復目では付かない
   */
  confidence?: number;
  /** 判定した判定モデルの表示名（決定65）。判定した往復で、既定へ落ちなかったときだけ */
  judgedBy?: string;
  /** 判定できずに既定の価格帯へ落ちたか（決定65）。判定した往復でだけ付く */
  fellBack?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON-RPC の本文から、有料ツールの呼び出しを取り出す。無ければ undefined */
function findPaidCall(
  body: string,
): { prompt: string; quote?: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  // バッチで来た場合は最初の有料ツール呼び出しを見る
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/call") continue;
    const params = message.params;
    if (!isRecord(params) || params.name !== PAID_TOOL_NAME) continue;

    const args = params.arguments;
    if (!isRecord(args) || typeof args.prompt !== "string") continue;

    const meta = params._meta;
    const payment = isRecord(meta) ? meta[PAYMENT_META_KEY] : undefined;
    const accepted = isRecord(payment) ? payment.accepted : undefined;
    const extra = isRecord(accepted) ? accepted.extra : undefined;

    return {
      prompt: args.prompt,
      ...(isRecord(extra) ? { quote: extra.quote } : {}),
    };
  }
  return undefined;
}

/**
 * リクエスト本文を見て、この呼び出しに適用する価格帯と価格を決める。
 *
 * 判定モデルは 1 往復目でしか呼ばない。2 往復目は見積書を読むだけなので、判定の費用も
 * 遅延も 1 回分で済む
 */
export async function resolveQuote(
  body: string,
  options: ResolveQuoteOptions,
): Promise<ResolvedQuote> {
  const { table, judge } = options;
  const call = findPaidCall(body);

  // 値付けの対象でない呼び出し（initialize、tools/list、壊れた本文など）。
  // ツールを登録するために accepts は要るので、既定の価格帯で組む
  if (!call) {
    return { tier: DEFAULT_TIER, price: priceOf(table, DEFAULT_TIER) };
  }

  if (call.quote !== undefined) {
    const decoded = decodeQuote(call.quote);
    if (decoded && matchesTable(decoded, table)) {
      return {
        tier: decoded.tier,
        price: decoded.price,
        quote: encodeQuote(decoded),
      };
    }
    console.warn(
      "[pricing] 見積書を読めないか価格表と食い違うため判定し直します",
    );
  }

  const { tier, confidence, model, fellBack } = await judge({
    toolName: PAID_TOOL_NAME,
    state: call.prompt,
  });
  const price = priceOf(table, tier);
  return {
    tier,
    price,
    quote: encodeQuote({ tier, price }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(fellBack ? { fellBack: true } : model ? { judgedBy: model } : {}),
  };
}
