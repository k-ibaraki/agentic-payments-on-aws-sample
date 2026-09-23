// settle 前の門番。`@x402/mcp` のラッパは買い手がエコーバックする `accepted` ブロックしか
// 照合せず、`payload.authorization`（宛先・金額・有効期限・署名）は見ずに facilitator へ渡す
// ため、無認証の相手が settle 往復を無制限に発生させられる（DESIGN.md 決定19・21、U9）。
//
// **この門番は上の脅威を塞がない**（実測済み。U9 参照）。塞げるのは形式検査だけで、
// EIP-712 署名の復元（スマートコントラクトウォレットを弾く恐れがあり未実施）がなければ、
// 捏造ペイロードは通過する（x402-flow.test.ts が実行可能な形で残す）。
//
// 要求の照合を scheme / network の 2 つだけで行うのは、accepted ブロック全体の一致は
// 上流がこの門番の後段で見るため。マッチした要求には eip3009 の authorization を必ず
// 要求しており、この売り手が広告する条件が exact / eip3009 の 1 通りだけだからで、
// accepts に別のスキームを足すときはここも直す必要がある
import type { PaymentRequirements } from "@x402/core/types";

/** ツール引数の _meta に積まれる支払いのキー（@x402/mcp の MCP_PAYMENT_META_KEY と同値） */
export const PAYMENT_META_KEY = "x402/payment";

/** 65 バイト（r 32 + s 32 + v 1）の 16 進数 */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/** ツール結果の最小形。素のハンドラと x402 ラッパー適用後の両方が満たす */
export interface ToolResultLike {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 10 進の非負整数の文字列だけを受ける。解釈できなければ undefined */
function toBigInt(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

/**
 * 支払いペイロードが売り手の要求に合致しているか。合致していれば undefined、
 * 弾くべきなら理由を返す。
 *
 * 判断できないもの（支払いの形をなしていない、合致する要求が無い）は undefined を
 * 返して上流に委ねる。上流はそれらを facilitator に問い合わせずに支払い要求へ差し戻す
 *
 * @param payment - `_meta["x402/payment"]` に積まれてきた値（外部入力なので unknown）
 * @param accepts - 売り手が提示している支払い条件
 * @param nowSeconds - 現在時刻（UNIX 秒）
 */
export function paymentRejectionReason(
  payment: unknown,
  accepts: readonly PaymentRequirements[],
  nowSeconds: number,
): string | undefined {
  if (!isRecord(payment)) return undefined;

  // 買い手が返してきた accepted と同じ scheme / network の要求を、売り手側の提示から探す。
  // 判定には売り手側の値（payTo・amount）を使う。買い手が返した accepted は信用しない
  const accepted = payment.accepted;
  if (!isRecord(accepted)) return undefined;
  const requirement = accepts.find(
    (r) => r.scheme === accepted.scheme && r.network === accepted.network,
  );
  if (!requirement) return undefined;

  const inner = payment.payload;
  if (!isRecord(inner)) {
    return "支払いペイロードの形式が想定と異なります";
  }

  // この売り手が提示する条件（exact / eip3009）では authorization が必ず要る
  const auth = inner.authorization;
  if (!isRecord(auth) || typeof auth.to !== "string") {
    return "支払いペイロードの形式が想定と異なります（eip3009 の authorization がありません）";
  }

  if (auth.to.toLowerCase() !== requirement.payTo.toLowerCase()) {
    return "支払いの宛先が売り手の受取アドレスと一致しません";
  }

  const value = toBigInt(auth.value);
  const required = toBigInt(requirement.amount);
  if (value === undefined || required === undefined) {
    return "支払い金額の形式が想定と異なります";
  }
  if (value < required) {
    return `支払い金額が要求額に足りません（要求 ${requirement.amount}、提示 ${auth.value}）`;
  }

  const validAfter = toBigInt(auth.validAfter);
  const validBefore = toBigInt(auth.validBefore);
  if (validAfter === undefined || validBefore === undefined) {
    return "支払いの有効期間の形式が想定と異なります";
  }
  const now = BigInt(Math.floor(nowSeconds));
  if (validAfter > now) {
    return "支払いの有効期間がまだ始まっていません";
  }
  if (validBefore <= now) {
    return "支払いの有効期限が切れています";
  }

  if (
    typeof inner.signature !== "string" ||
    !SIGNATURE_PATTERN.test(inner.signature)
  ) {
    return "支払いの署名の形式が想定と異なります";
  }

  return undefined;
}

/**
 * 支払いラッパー適用済みのハンドラを、settle 前の門番で包む。
 *
 * 弾くときは支払い要求（structuredContent に accepts を持つ形）ではなく、ただの
 * 失敗として返す。支払い要求の形で返すと、`@x402/mcp` の `x402MCPClient`
 * （`autoPayment: true`。buy-once.ts と x402-flow.test.ts が使う）が「まだ払っていない」と
 * 解釈して `createPaymentPayload` で署名を作り直し、再試行するため。
 * なお agent-app の paid-tool-caller は structuredContent の有無で判定するので、
 * どちらの形でも再署名はしない（2026-09-07 のセルフレビューで訂正）
 *
 * @param now - 現在時刻をミリ秒で返す（`Date.now` と同じ単位）。
 *              `paymentRejectionReason` は秒で受けるので、変換はここで行う
 */
export function guardPayment<TArgs>(
  handler: (
    args: TArgs,
    extra: unknown,
  ) => ToolResultLike | Promise<ToolResultLike>,
  accepts: readonly PaymentRequirements[],
  now: () => number = Date.now,
): (args: TArgs, extra: unknown) => Promise<ToolResultLike> {
  return async (args, extra) => {
    const meta = isRecord(extra) ? extra._meta : undefined;
    const payment = isRecord(meta) ? meta[PAYMENT_META_KEY] : undefined;
    const reason =
      payment === undefined
        ? undefined
        : paymentRejectionReason(payment, accepts, Math.floor(now() / 1000));
    if (reason) {
      console.warn(`[x402] settle 前に支払いを拒否しました: ${reason}`);
      return {
        isError: true,
        content: [
          { type: "text", text: `支払いを受け付けられません: ${reason}` },
        ],
      };
    }
    return await handler(args, extra);
  };
}
