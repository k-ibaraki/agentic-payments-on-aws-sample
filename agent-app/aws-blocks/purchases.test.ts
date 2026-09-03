// 会話メッセージから購入記録を抜き出す純関数のテスト（決定29）。
// Realtime の tool-result チャンクは toolName しか運ばないため、ブラウザは
// 会話履歴の tool-result メッセージ（metadata.toolOutput）から resultId を知る
import { describe, expect, it } from 'vitest';
import { extractPurchases } from './purchases.js';

const okSummary = { ok: true, resultId: 'r-1', paymentMade: true, htmlBytes: 3000, transaction: '0xabc' };
const failedSummary = { ok: false, resultId: 'r-2', paymentMade: true, message: '生成に失敗', transaction: '0xdef' };

function toolResultMessage(toolOutput: unknown, toolName = 'generateHtml') {
  return {
    messageId: 'm',
    role: 'tool-result' as const,
    content: '',
    metadata: { toolName, toolOutput },
  };
}

describe('extractPurchases', () => {
  it('JsonBlock 形式（{ json }）の toolOutput から購入を抜き出す', () => {
    const messages = [
      { messageId: 'u', role: 'user' as const, content: 'ページを作って', metadata: {} },
      toolResultMessage([{ json: okSummary }]),
    ];
    expect(extractPurchases(messages)).toEqual([
      { resultId: 'r-1', ok: true, paymentMade: true, transaction: '0xabc', htmlBytes: 3000 },
    ]);
  });

  it('TextBlock 形式（{ text: JSON 文字列 }）でも抜き出せる', () => {
    const messages = [toolResultMessage([{ text: JSON.stringify(okSummary) }])];
    expect(extractPurchases(messages)).toHaveLength(1);
    expect(extractPurchases(messages)[0]?.resultId).toBe('r-1');
  });

  it('toolOutput が文字列化された JSON でも抜き出せる', () => {
    const messages = [toolResultMessage(JSON.stringify([{ json: okSummary }]))];
    expect(extractPurchases(messages)[0]?.resultId).toBe('r-1');
  });

  it('支払い済みで成果物が無い失敗も購入として残す（レシートを辿れるようにする）', () => {
    const messages = [toolResultMessage([{ json: failedSummary }])];
    expect(extractPurchases(messages)).toEqual([
      { resultId: 'r-2', ok: false, paymentMade: true, transaction: '0xdef', error: '生成に失敗' },
    ]);
  });

  it('resultId の無いツール結果（支払い前の失敗）や他のツールは無視する', () => {
    const messages = [
      toolResultMessage([{ json: { ok: false, paymentMade: false, message: '売り手に接続できません' } }]),
      toolResultMessage([{ json: okSummary }], 'otherTool'),
      toolResultMessage('壊れた JSON {'),
    ];
    expect(extractPurchases(messages)).toEqual([]);
  });

  it('会話の順序どおりに並べる', () => {
    const messages = [
      toolResultMessage([{ json: { ...okSummary, resultId: 'first' } }]),
      toolResultMessage([{ json: { ...okSummary, resultId: 'second' } }]),
    ];
    expect(extractPurchases(messages).map((p) => p.resultId)).toEqual(['first', 'second']);
  });
});
