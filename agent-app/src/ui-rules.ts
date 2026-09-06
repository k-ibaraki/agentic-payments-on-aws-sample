// 画面の振る舞いのうち DOM に依存しない規則（決定44・45）。index.ts から呼び、テストはここで固定する
import { PURCHASE_TOOL_NAME } from '../aws-blocks/purchases.js';

/** 新規会話は会話をブラウザから捨てる操作。吹き出しが 1 つでもあれば確認を挟む */
export function shouldConfirmNewConversation(messageCount: number): boolean {
  return messageCount > 0;
}

/** 「内部情報」の折りたたみは既定で開く。閉じた記憶があるときだけ閉じる（壊れた値は既定に倒す） */
export function readInternalsOpen(stored: string | null): boolean {
  return stored !== 'closed';
}

export function storeInternalsOpen(open: boolean): 'open' | 'closed' {
  return open ? 'open' : 'closed';
}

/**
 * 生成中の応答が入る吹き出しの位置（無ければ -1）。最後の assistant を指す。
 * 承認へ応答すると末尾に approval が積まれ、生成先はその手前の空プレースホルダになり得るため、
 * 「末尾」の決め打ちでは外れる（決定46）
 */
export function findLastAssistant(messages: Array<{ role: string }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

// ── 依頼の枠の帯（残高と残枠）と、購入中の取り直し（決定47） ──

/** 有料ツールの応答を待つ上限の既定（`BUYER_TOOL_TIMEOUT_MS`。決定31）。ブラウザは環境変数を知らないので既定に合わせる */
export const BALANCE_WATCH_MAX_MS = 600_000;
/** 支払いは有料ツールの呼び出しの中で起き、ツールが返るまでは何も届かない。その間はこの間隔で残高を取り直す */
export const BALANCE_WATCH_INTERVAL_MS = 3000;

/** 帯の残高。説明は付けず値と通貨だけ。取れていなければ「—」 */
export function formatStripBalance(balance: { display: string; token: string } | null | undefined): string {
  return balance ? `${balance.display} ${balance.token}` : '—';
}

/** 帯の残枠。今のセッションが無い（次の購入で切られる）ときは残枠そのものが無いので「—」 */
export function formatStripRemaining(session: { availableSpendUsd: string | null } | null | undefined): string {
  return session?.availableSpendUsd ? `${session.availableSpendUsd} USD` : '—';
}

/** 取り直しを始めるのは支払いが起きる有料ツールの呼び出しだけ */
export function isPaidToolCall(toolName: string | undefined): boolean {
  return toolName === PURCHASE_TOOL_NAME;
}

/** 値が変わった（減った値を掴めた）か、ツールが返った（tool-result / done / error）か、上限に達したら止める */
export function shouldContinueBalanceWatch(state: { changed: boolean; settled: boolean; elapsedMs: number }): boolean {
  return !state.changed && !state.settled && state.elapsedMs < BALANCE_WATCH_MAX_MS;
}

/** 変化の判定に使う組。残高と残枠のどちらが動いても「変わった」とみなす */
export function walletSnapshot(status: {
  balance: { display: string } | null | undefined;
  session: { availableSpendUsd: string | null } | null | undefined;
}): string {
  return `${status.balance?.display ?? ''}|${status.session?.availableSpendUsd ?? ''}`;
}
