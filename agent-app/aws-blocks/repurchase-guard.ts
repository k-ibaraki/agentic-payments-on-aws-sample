// 二重支払いを防ぐ買い手側の硬い防護（決定31）。
// 「支払い済みなのに成果物が無い」購入が同じ会話にあるとき、LLM の自動再試行で
// もう一度支払わせないための判断。ツールハンドラはこれが空でなければ interrupt で
// 人の承認を要求してから購入に進む
import type { PurchaseSummary } from './purchases.js';

export function unresolvedPayments(purchases: readonly PurchaseSummary[]): PurchaseSummary[] {
  return purchases.filter((p) => p.paymentMade && !p.ok);
}
