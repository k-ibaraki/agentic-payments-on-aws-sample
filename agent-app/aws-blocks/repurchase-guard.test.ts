// 二重支払いを防ぐ買い手側の硬い防護（決定31）。
// 同じ会話に「支払い済みなのに成果物が無い」購入があれば、LLM の自動再試行では次の購入を
// 始めさせず、人の承認（interrupt）を要求する。判断の規則をここで固定する
import { describe, expect, it } from 'vitest';
import { unresolvedPayments } from './repurchase-guard.js';

const paidOk = { resultId: 'a', ok: true, paymentMade: true, htmlBytes: 100 };
const paidFailed = { resultId: 'b', ok: false, paymentMade: true, error: 'Request timed out' };
const unpaidFailed = { resultId: 'c', ok: false, paymentMade: false, error: '売り手に接続できません' };

describe('unresolvedPayments', () => {
  it('支払い済みで成果物の無い購入だけを返す', () => {
    expect(unresolvedPayments([paidOk, paidFailed, unpaidFailed])).toEqual([paidFailed]);
  });

  it('無ければ空（承認は不要）', () => {
    expect(unresolvedPayments([paidOk, unpaidFailed])).toEqual([]);
    expect(unresolvedPayments([])).toEqual([]);
  });
});
