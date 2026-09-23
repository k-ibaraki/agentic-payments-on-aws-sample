// リクエスト本文から価格帯と価格を決める（DESIGN.md 決定55・56）。
//
// x402 は 2 往復する。1 往復目（支払い無し）で価格帯を判定し、見積書を `accepts[].extra.quote`
// に載せる。2 往復目（支払い付き）では買い手がその見積書をそのまま返してくるので、判定を
// やり直さずその値を使う。判定モデルは決定的でないため、やり直すと額がぶれて上流の照合が
// 外れ、買い手が 402 を受け取り続ける。
//
// 見積書が読めない場合、または価格表と食い違う場合（表を差し替えた直後の古い見積書）は
// 判定し直す。新しい額で 402 を返すことになり買い手は買い直しになるが、表と違う額で
// 売るよりは良い。
import type { Judge } from "./judge.js";
import {
  decodeQuote,
  encodeQuote,
  matchesTable,
  type Tier,
} from "./quote-seal.js";
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

  const { tier, confidence } = await judge({
    toolName: PAID_TOOL_NAME,
    state: call.prompt,
  });
  const price = priceOf(table, tier);
  return {
    tier,
    price,
    quote: encodeQuote({ tier, price }),
    ...(confidence === undefined ? {} : { confidence }),
  };
}
