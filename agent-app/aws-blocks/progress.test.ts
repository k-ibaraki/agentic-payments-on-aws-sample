// 購入の経過（決定65）の送信処理のテスト。順序と「飾りなので止めない」ことを固定する
import { describe, expect, it, vi } from 'vitest';
import { createProgressPublisher, progressEventSchema, SELLER_MESSAGE_LIMIT, sellerStep } from './progress.js';

describe('createProgressPublisher', () => {
  it('送った順に通し番号を振って届ける', async () => {
    const sent: unknown[] = [];
    const publisher = createProgressPublisher('r-1', async (event) => {
      sent.push(event);
    }, () => 1000);
    publisher.report({ step: 'paying' });
    publisher.report({ step: 'seller', message: '決済を確定しています' });
    await publisher.flush();
    expect(sent).toEqual([
      { purchaseId: 'r-1', seq: 1, at: 1000, event: { step: 'paying' } },
      { purchaseId: 'r-1', seq: 2, at: 1000, event: { step: 'seller', message: '決済を確定しています' } },
    ]);
  });

  // 届け先（Realtime）への送信は並べて投げると追い越し得る。前の送信が終わってから次を送る
  it('前の送信が終わるまで次を送らない', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const publisher = createProgressPublisher('r-1', async (event) => {
      if (event.seq === 1) await new Promise<void>((resolve) => (release = resolve));
      order.push(`sent ${event.seq}`);
    });
    publisher.report({ step: 'paying' });
    publisher.report({ step: 'paid' });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await publisher.flush();
    expect(order).toEqual(['sent 1', 'sent 2']);
  });

  // 経過は飾り。届かなくても購入は止めない
  it('送信に失敗しても投げず、後続は送る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: number[] = [];
    const publisher = createProgressPublisher('r-1', async (event) => {
      if (event.seq === 1) throw new Error('gone');
      sent.push(event.seq);
    });
    publisher.report({ step: 'paying' });
    publisher.report({ step: 'paid' });
    await expect(publisher.flush()).resolves.toBeUndefined();
    expect(sent).toEqual([2]);
    warn.mockRestore();
  });

  it('送る形はスキーマに合う', async () => {
    const sent: unknown[] = [];
    const publisher = createProgressPublisher('r-1', async (event) => {
      sent.push(event);
    });
    publisher.report({ step: 'quote', tier: 'take', amount: '100000', asset: '0xabc' });
    publisher.report({ step: 'settled', transaction: '0xtx' });
    publisher.report({ step: 'received', htmlBytes: 12 });
    publisher.report({ step: 'failed', message: '失敗' });
    await publisher.flush();
    for (const event of sent) expect(progressEventSchema.safeParse(event).success).toBe(true);
  });
});

describe('sellerStep', () => {
  // 売り手の文は相手方の言葉。長すぎるものは切り、空は捨てる（画面では textContent で入れる）
  it('売り手の文を上限で切る', () => {
    const long = 'あ'.repeat(SELLER_MESSAGE_LIMIT + 10);
    expect(sellerStep(long)).toEqual({ step: 'seller', message: 'あ'.repeat(SELLER_MESSAGE_LIMIT) });
  });

  it('空や文字列でないものは捨てる', () => {
    expect(sellerStep('   ')).toBeUndefined();
    expect(sellerStep(undefined)).toBeUndefined();
  });
});
