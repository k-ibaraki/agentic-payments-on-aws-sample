// 売り手の中の経過を、ツール呼び出しの途中で買い手へ知らせる（DESIGN.md 決定65）。
// MCP 標準の notifications/progress を使い、買い手が依頼に progressToken を付けたときだけ送る。
// 付けないクライアント（他の MCP クライアント・古い買い手）には何も流れず、応答も従来どおり JSON になる
// （app.ts が wantsProgress で応答の形を選ぶ）
import { AsyncLocalStorage } from "node:async_hooks";
import type { Tier } from "./pricing/quote-format.js";
import { tierLabel } from "./pricing/tiers.js";

/** `_meta` に積まれる支払いのキー（`@x402/mcp` の MCP_PAYMENT_META_KEY と同値） */
const PAYMENT_META_KEY = "x402/payment";

export type ProgressReporter = (message: string) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function progressTokenOf(meta: unknown): string | number | undefined {
  if (!isRecord(meta)) return undefined;
  const token = meta.progressToken;
  return typeof token === "string" || typeof token === "number"
    ? token
    : undefined;
}

// progress の値は同じトークンの中で増え続けなければならない（MCP の仕様）。
// 通知の送信関数はラッパーごとに作るので、progress の数は送信関数ではなくプロセス全体で持つ（依頼をまたいでも増え続けるだけ）
let sequence = 0;

/**
 * ツール呼び出しの extra から、経過を知らせる口を作る。progressToken が無ければ何もしない口を返す。
 * 送れなくても投げない（経過は飾りで、届かないことを理由に売り買いを止めない）
 */
export function progressReporter(extra: unknown): ProgressReporter {
  const token = isRecord(extra) ? progressTokenOf(extra._meta) : undefined;
  const send = isRecord(extra) ? extra.sendNotification : undefined;
  if (token === undefined || typeof send !== "function") return async () => {};
  return async (message) => {
    sequence += 1;
    try {
      await send({
        method: "notifications/progress",
        params: { progressToken: token, progress: sequence, message },
      });
    } catch (error) {
      console.warn("[progress] 経過の通知に失敗しました", error);
    }
  };
}

/**
 * 依頼（JSON-RPC の本文。バッチ可）のどれかが progressToken を付けているか。
 * 付いていれば応答を SSE にして途中の通知を流す。壊れた本文は偽（従来どおり JSON で返す）
 */
export function wantsProgress(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some(
    (message) =>
      isRecord(message) &&
      isRecord(message.params) &&
      progressTokenOf(message.params._meta) !== undefined,
  );
}

/** この往復で価格帯を判定した結果。見積書を読んだだけの往復では judgedBy も fellBack も付かない */
export interface PricingProgress {
  tier: Tier;
  judgedBy?: string;
  fellBack?: boolean;
}

/** 判定の結果を買い手に伝える一文。判定していない往復では undefined */
export function pricingMessage(pricing: PricingProgress): string | undefined {
  const label = tierLabel(pricing.tier);
  if (pricing.fellBack)
    return `価格帯を判定できなかったため、既定の「${label}」にしました`;
  if (pricing.judgedBy) {
    return `判定モデル ${pricing.judgedBy} が依頼を読み、価格帯を「${label}」と判定しました`;
  }
  return undefined;
}

// いちばん外側のラッパー（announcePricing）で作った通知の送信関数を、内側のラッパー（announceGeneration）からも
// 呼べるようにする。`@x402/mcp` の支払いラッパーは内側のハンドラに { toolName, arguments, meta } しか渡さず、
// sendNotification が落ちるため。
// 呼び出しごとの非同期の文脈に載せるので、バッチで呼び出しが並んでも混ざらない
const currentReporter = new AsyncLocalStorage<ProgressReporter>();

type ToolHandler<TArgs, TResult> = (
  args: TArgs,
  extra: unknown,
) => TResult | Promise<TResult>;

/**
 * 有料ツールのいちばん外側を包む。支払いの無い呼び出し（1 往復目）では判定の結果を、
 * 支払い付きの呼び出し（2 往復目）では決済に進むことを、処理の前に知らせる
 */
export function announcePricing<TArgs, TResult>(
  handler: ToolHandler<TArgs, TResult>,
  pricing: PricingProgress | undefined,
): (args: TArgs, extra: unknown) => Promise<TResult> {
  return async (args, extra) => {
    const report = progressReporter(extra);
    const meta = isRecord(extra) ? extra._meta : undefined;
    const paying = isRecord(meta) && meta[PAYMENT_META_KEY] !== undefined;
    const message = paying
      ? "支払いの署名を受け取りました。決済を確定しています"
      : pricing && pricingMessage(pricing);
    if (message) await report(message);
    return await currentReporter.run(
      report,
      async () => await handler(args, extra),
    );
  };
}

/**
 * 生成の処理を包む。支払いラッパーの内側に置くので、ここに来たときには決済が確定している
 * （upfront。決定21）。決済の取引 ID は `@x402/mcp` が最終結果にしか載せないため、ここでは言わない
 */
export function announceGeneration<
  TArgs,
  TResult extends { isError?: boolean },
>(
  handler: ToolHandler<TArgs, TResult>,
): (args: TArgs, extra: unknown) => Promise<TResult> {
  return async (args, extra) => {
    const report = currentReporter.getStore() ?? progressReporter(extra);
    await report("決済が確定しました。ページの生成を始めます");
    try {
      const result = await handler(args, extra);
      await report(
        result.isError ? "ページの生成に失敗しました" : "ページを生成しました",
      );
      return result;
    } catch (error) {
      await report("ページの生成に失敗しました");
      throw error;
    }
  };
}
