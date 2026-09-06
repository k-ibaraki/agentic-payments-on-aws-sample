// 金が動いた（かもしれない）失敗の記録（決定31・48）。
// ここが例外を外に出すと、ツールが要約を返せず tool-result が会話に残らない。
// すると KVStore の記録（利用者単位）と会話履歴の判定（会話単位）が同時に失われ、
// 次の購入が何の抵抗もなく通ってしまう。「投げない」ことと書き込みの順序を固定する
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { purchasedHtmlKey, recordFailedPurchase, type FailedPurchaseStores } from './buyer-agent.js';
import type { UnresolvedPaymentRecord } from './repurchase-guard.js';

const USER = 'user-sub-a';
const RESULT_ID = 'result-1';

function memoryStores(): FailedPurchaseStores & {
  unresolved: Map<string, UnresolvedPaymentRecord>;
  receipts: Map<string, unknown>;
  order: string[];
} {
  const unresolved = new Map<string, UnresolvedPaymentRecord>();
  const receipts = new Map<string, unknown>();
  const order: string[] = [];
  return {
    unresolved,
    receipts,
    order,
    unresolvedPurchases: {
      async get(key) {
        return unresolved.get(key) ?? null;
      },
      async put(key, value) {
        order.push('unresolved');
        unresolved.set(key, value);
      },
      async delete(key) {
        unresolved.delete(key);
      },
    },
    artifacts: {
      async put(key, value) {
        order.push('receipt');
        receipts.set(key, value);
      },
    },
  };
}

beforeEach(() => {
  // 失敗経路は必ずログを出す。テストの出力を汚さないよう黙らせる
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordFailedPurchase', () => {
  it('未解決の記録とレシートの両方を書く', async () => {
    const stores = memoryStores();

    await recordFailedPurchase(stores, {
      userId: USER,
      resultId: RESULT_ID,
      message: '支払い後のツール呼び出しに失敗しました',
      transaction: '0xtx',
      authorizationNonce: '0xnonce',
    });

    expect(stores.unresolved.get(USER)?.resultIds).toEqual([RESULT_ID]);
    expect(stores.receipts.get(purchasedHtmlKey(USER, RESULT_ID))).toMatchObject({
      error: '支払い後のツール呼び出しに失敗しました',
      transaction: '0xtx',
      authorizationNonce: '0xnonce',
    });
  });

  it('成否不明の購入はレシートにもその印を残す', async () => {
    const stores = memoryStores();

    await recordFailedPurchase(stores, {
      userId: USER,
      resultId: RESULT_ID,
      message: 'ProcessPayment の結果を確認できませんでした',
      paymentUncertain: true,
    });

    expect(stores.receipts.get(purchasedHtmlKey(USER, RESULT_ID))).toMatchObject({
      paymentUncertain: true,
    });
  });

  // 片方しか残らないなら、残すべきは次の支払いを止める側（決定48）
  it('防護の記録をレシートより先に書く', async () => {
    const stores = memoryStores();

    await recordFailedPurchase(stores, { userId: USER, resultId: RESULT_ID, message: '失敗' });

    expect(stores.order).toEqual(['unresolved', 'receipt']);
  });

  it('未解決の記録に失敗しても投げない（会話単位の防護に委ねる）', async () => {
    const stores = memoryStores();
    stores.unresolvedPurchases.put = async () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    };

    await expect(
      recordFailedPurchase(stores, { userId: USER, resultId: RESULT_ID, message: '失敗' }),
    ).resolves.toBeUndefined();
    // レシートの保存は続ける
    expect(stores.receipts.has(purchasedHtmlKey(USER, RESULT_ID))).toBe(true);
  });

  it('レシートの保存に失敗しても投げない', async () => {
    const stores = memoryStores();
    stores.artifacts.put = async () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    };

    await expect(
      recordFailedPurchase(stores, { userId: USER, resultId: RESULT_ID, message: '失敗' }),
    ).resolves.toBeUndefined();
    // 防護の記録は先に済んでいる
    expect(stores.unresolved.get(USER)?.resultIds).toEqual([RESULT_ID]);
  });

  it('両方が失敗しても投げない', async () => {
    const stores = memoryStores();
    const fail = async () => {
      throw new Error('store down');
    };
    stores.unresolvedPurchases.put = fail;
    stores.artifacts.put = fail;

    await expect(
      recordFailedPurchase(stores, { userId: USER, resultId: RESULT_ID, message: '失敗' }),
    ).resolves.toBeUndefined();
  });
});
