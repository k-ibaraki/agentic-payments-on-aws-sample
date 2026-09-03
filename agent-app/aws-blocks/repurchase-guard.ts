// 二重支払いを防ぐ買い手側の硬い防護（決定31）。
// 「支払い済みなのに成果物が無い」購入が未解決のまま残っているとき、LLM の自動再試行で
// もう一度支払わせないための判断。ツールハンドラはこれが空でなければ interrupt で
// 人の承認を要求する。
//
// 「未解決」は最後に成功した購入より後の失敗に限る。人が承認して買い直しが成功したら
// それ以前の失敗は決着したものとして扱う。会話全体を対象にすると、一度事故が起きた会話は
// 以後すべての購入が承認待ちになり、決定31 が「毎回の承認を必須にする案は自律性を弱めるため
// 不採用」とした意図と食い違ってしまう
import type { PurchaseSummary } from './purchases.js';

export function unresolvedPayments(purchases: readonly PurchaseSummary[]): PurchaseSummary[] {
  const lastSuccess = purchases.findLastIndex((p) => p.ok);
  return purchases.slice(lastSuccess + 1).filter((p) => p.paymentMade && !p.ok);
}
