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

  // 承認して買い直しが成功したら、その前の失敗は解決済みとして扱う。
  // さもないと一度事故が起きた会話は以後ずっと承認待ちになり、決定31 が
  // 「毎回の承認を必須にする案は不採用」とした意図と食い違う
  it('最後の成功より前の失敗は未解決に数えない', () => {
    expect(unresolvedPayments([paidFailed, paidOk])).toEqual([]);
    expect(unresolvedPayments([paidFailed, paidOk, unpaidFailed])).toEqual([]);
  });

  it('最後の成功より後の失敗は未解決に数える', () => {
    const later = { resultId: 'd', ok: false, paymentMade: true, error: '再び失敗' };
    expect(unresolvedPayments([paidFailed, paidOk, later])).toEqual([later]);
  });

  it('成功が一度も無ければ、支払い済みの失敗をすべて返す', () => {
    const another = { resultId: 'e', ok: false, paymentMade: true, error: '二度目の失敗' };
    expect(unresolvedPayments([paidFailed, another])).toEqual([paidFailed, another]);
  });
});
