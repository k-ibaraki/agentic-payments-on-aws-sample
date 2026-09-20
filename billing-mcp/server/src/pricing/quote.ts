// リクエスト本文から段と価格を決める（DESIGN.md 決定55・56）。
//
// x402 は 2 往復する。1 往復目（支払い無し）で段を判じ、封をして `accepts[].extra.quote`
// に載せる。2 往復目（支払い付き）では買い手がその封をそのまま返してくるので、判定を
// やり直さず封を検めるだけにする。判定器は決定的でないため、やり直すと額がぶれて
// 上流の照合が外れ、買い手が 402 を受け取り続ける。
//
// 封が通らない場合（期限切れ、引数の付け替え、壊れた値）は判定し直す。新しい額で
// 402 を返すことになり買い手は買い直しになるが、誤った額で売るよりは良い。
import type { Judge } from "./judge.js";
import {
  fingerprintArgs,
  openQuoteSeal,
  sealQuote,
  type Tier,
} from "./quote-seal.js";
import { priceOf, type TierTable } from "./tiers.js";

/** 値付けの対象となる有料ツール */
export const PAID_TOOL_NAME = "generate-html";

/** `_meta` に積まれる支払いのキー（`@x402/mcp` の MCP_PAYMENT_META_KEY と同値） */
const PAYMENT_META_KEY = "x402/payment";

/**
 * 封の有効期間。
 *
 * 買い手は決定31・48 の防護で人の承認を待つことがあり、その間に失効すると買えなくなる。
 * 短くするより長めに取る（決定55）
 */
export const QUOTE_TTL_SECONDS = 15 * 60;

/** 判定できないときに使う段。判定器の fallback と揃える */
const DEFAULT_TIER: Tier = "take";

export interface ResolveQuoteOptions {
  table: TierTable;
  judge: Judge;
  /** 封の鍵 */
  key: string;
  /** 現在時刻（UNIX 秒） */
  nowSeconds: number;
}

export interface ResolvedQuote {
  tier: Tier;
  /** 段に対応する価格（"$0.15" 形式） */
  price: string;
  /**
   * `accepts[].extra.quote` に載せる封。
   * 値付けの対象でない呼び出しでは付けない
   */
  seal?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON-RPC の本文から、有料ツールの呼び出しを取り出す。無ければ undefined */
function findPaidCall(
  body: string,
): { args: unknown; prompt: string; sealed?: string } | undefined {
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
    const sealed =
      isRecord(extra) && typeof extra.quote === "string"
        ? extra.quote
        : undefined;

    return { args, prompt: args.prompt, ...(sealed ? { sealed } : {}) };
  }
  return undefined;
}

/**
 * リクエスト本文を見て、この呼び出しに適用する段と価格を決める。
 *
 * 判定器は 1 往復目でしか呼ばない。2 往復目は封を検めるだけなので、判定の費用も
 * 遅延も 1 回分で済む
 */
export async function resolveQuote(
  body: string,
  options: ResolveQuoteOptions,
): Promise<ResolvedQuote> {
  const { table, judge, key, nowSeconds } = options;
  const call = findPaidCall(body);

  // 値付けの対象でない呼び出し（initialize、tools/list、壊れた本文など）。
  // ツールを登録するために accepts は要るので、既定の段で組む
  if (!call) {
    return { tier: DEFAULT_TIER, price: priceOf(table, DEFAULT_TIER) };
  }

  const argsFingerprint = fingerprintArgs(call.args);

  if (call.sealed) {
    const opened = openQuoteSeal(call.sealed, {
      toolName: PAID_TOOL_NAME,
      argsFingerprint,
      key,
      nowSeconds,
    });
    if (opened) {
      return { tier: opened.tier, price: opened.price, seal: call.sealed };
    }
    console.warn("[pricing] 見積書の封を検められなかったため判定し直します");
  }

  const { tier } = await judge({
    toolName: PAID_TOOL_NAME,
    state: call.prompt,
  });
  const price = priceOf(table, tier);
  const seal = sealQuote(
    {
      toolName: PAID_TOOL_NAME,
      argsFingerprint,
      tier,
      price,
      expiresAt: nowSeconds + QUOTE_TTL_SECONDS,
    },
    key,
  );
  return { tier, price, seal };
}
