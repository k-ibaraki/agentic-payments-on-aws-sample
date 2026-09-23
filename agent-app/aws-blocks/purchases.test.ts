// 会話メッセージから購入記録を抜き出す純関数のテスト（決定29）。
// Realtime の tool-result チャンクは toolName しか運ばないため、ブラウザは
// 会話履歴の tool-result メッセージ（metadata.toolOutput）から resultId を知る
import { describe, expect, it } from 'vitest';
import { PURCHASE_HISTORY_CONVERSATIONS, PURCHASE_HISTORY_SCAN_LIMIT, extractPurchases, purchaseHistory } from './purchases.js';

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
    const history = await purchaseHistory(conversations, getMessages);
    expect(history.conversations.map((h) => h.conversationId)).toEqual(['c-new', 'c-old']);
    expect(history.conversations[0].purchases.map((p) => p.resultId)).toEqual(['r-1']);
    expect(history.conversations[1].purchases.map((p) => p.resultId)).toEqual(['r-2']);
    expect(history.conversations[0].updatedAt).toBe(300);
    expect(history).toMatchObject({ scanned: 3, total: 3, failed: 0 });
  });

  // 購入の無い会話（新規会話を押して 1 度でも送れば残る）が続いても、その前に買った
  // ページが履歴から消えないようにする。上限は「返す会話の数」で、読む数ではない
  it('購入の無い会話が続いても、購入のある会話が上限に届くまで古い方へ読み進める', async () => {
    const many = [
      { conversationId: 'c-bought', updatedAt: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({ conversationId: `c-empty-${i}`, updatedAt: 10 + i })),
    ];
    const history = await purchaseHistory(many, async (id) => (id === 'c-bought' ? messagesOf['c-new'] : []), {
      limit: 1,
    });
    expect(history.conversations.map((h) => h.conversationId)).toEqual(['c-bought']);
    expect(history.scanned).toBe(6);
  });

  it('返す会話の数が上限に届いたら、それより古い会話は読みに行かない', async () => {
    const read: string[] = [];
    const history = await purchaseHistory(
      conversations,
      async (id) => {
        read.push(id);
        return messagesOf[id] ?? [];
      },
      { limit: 1, batch: 1 },
    );
    expect(read).toEqual(['c-new']);
    expect(history.conversations.map((h) => h.conversationId)).toEqual(['c-new']);
    expect(history).toMatchObject({ scanned: 1, total: 3 });
  });

  // 読む量に天井を置く（1 回の呼び出しで Lambda が読む会話の数を有界にする）
  it('読む会話の数には天井があり、そこで打ち切る', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ conversationId: `c-${i}`, updatedAt: i }));
    const history = await purchaseHistory(many, async () => [], { limit: 20, scanLimit: 4 });
    expect(history.conversations).toEqual([]);
    expect(history).toMatchObject({ scanned: 4, total: 7 });
  });

  // 1 会話の取得失敗で全体を落とさない。読めた分は返し、読めなかった数を伝える
  it('取得に失敗した会話は飛ばし、読めた分だけを返す', async () => {
    const history = await purchaseHistory(conversations, async (id) => {
      if (id === 'c-new') throw new Error('読めない');
      return messagesOf[id] ?? [];
    });
    expect(history.conversations.map((h) => h.conversationId)).toEqual(['c-old']);
    expect(history).toMatchObject({ scanned: 3, failed: 1 });
  });

  it('会話が無ければ空', async () => {
    expect(await purchaseHistory([], getMessages)).toEqual({ conversations: [], scanned: 0, total: 0, failed: 0 });
  });

  it('既定は返す会話 20 件・読む会話 100 件まで', () => {
    expect(PURCHASE_HISTORY_CONVERSATIONS).toBe(20);
    expect(PURCHASE_HISTORY_SCAN_LIMIT).toBe(100);
  });
});

// 決定60: 支払った額を画面まで運ぶ。生の額ではなく、人が読む表記をそのまま渡す
describe('extractPurchases（支払額）', () => {
  it('要約の amountDisplay を購入に載せる', () => {
    const messages = [
      toolResultMessage([{ json: { ...okSummary, amountDisplay: '$0.15（150000）' } }]),
    ];
    expect(extractPurchases(messages)[0]?.amountDisplay).toBe('$0.15（150000）');
  });

  it('支払い済みの失敗にも載せる', () => {
    const messages = [
      toolResultMessage([{ json: { ...failedSummary, amountDisplay: '$0.2（200000）' } }]),
    ];
    expect(extractPurchases(messages)[0]?.amountDisplay).toBe('$0.2（200000）');
  });

  it('額の無い要約では欄ごと持たない', () => {
    expect(extractPurchases([toolResultMessage([{ json: okSummary }])])[0]?.amountDisplay).toBeUndefined();
  });
});
