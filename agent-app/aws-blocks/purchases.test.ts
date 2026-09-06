// 会話メッセージから購入記録を抜き出す純関数のテスト（決定29）。
// Realtime の tool-result チャンクは toolName しか運ばないため、ブラウザは
// 会話履歴の tool-result メッセージ（metadata.toolOutput）から resultId を知る
import { describe, expect, it } from 'vitest';
import { PURCHASE_HISTORY_CONVERSATIONS, extractPurchases, purchaseHistory } from './purchases.js';

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

// ── 利用者ごとの購入履歴（決定50） ──
describe('purchaseHistory', () => {
  const conversations = [
    { conversationId: 'c-old', updatedAt: 100 },
    { conversationId: 'c-new', updatedAt: 300 },
    { conversationId: 'c-empty', updatedAt: 200 },
  ];

  const messagesOf: Record<string, ReturnType<typeof toolResultMessage>[]> = {
    'c-old': [toolResultMessage([{ json: failedSummary }])],
    'c-new': [toolResultMessage([{ json: okSummary }])],
    'c-empty': [],
  };

  const getMessages = async (conversationId: string) => messagesOf[conversationId] ?? [];

  it('新しい会話から順に並べ、購入の無い会話は落とす', async () => {
    const history = await purchaseHistory(conversations, getMessages, 10);
    expect(history.map((h) => h.conversationId)).toEqual(['c-new', 'c-old']);
    expect(history[0].purchases.map((p) => p.resultId)).toEqual(['r-1']);
    expect(history[1].purchases.map((p) => p.resultId)).toEqual(['r-2']);
    expect(history[0].updatedAt).toBe(300);
  });

  it('たどる会話の数は上限まで（古い会話は読みに行かない）', async () => {
    const read: string[] = [];
    const history = await purchaseHistory(conversations, async (id) => {
      read.push(id);
      return messagesOf[id] ?? [];
    }, 1);
    expect(read).toEqual(['c-new']);
    expect(history.map((h) => h.conversationId)).toEqual(['c-new']);
  });

  it('会話が無ければ空', async () => {
    expect(await purchaseHistory([], getMessages, 10)).toEqual([]);
  });

  it('たどる会話の数の既定は 20 件', () => {
    expect(PURCHASE_HISTORY_CONVERSATIONS).toBe(20);
  });
});
