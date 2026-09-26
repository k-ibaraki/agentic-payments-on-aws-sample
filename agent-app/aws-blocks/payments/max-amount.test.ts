// 利用者ごとの 1 回の支払い上限（決定66）のテスト。KVStore は最小のメモリ実装で代える
import { describe, expect, it } from 'vitest';
import { maxAmountSource, type MaxAmountRecord, type MaxAmountStore } from './max-amount.js';

function memoryStore(): MaxAmountStore & { data: Map<string, MaxAmountRecord> } {
  const data = new Map<string, MaxAmountRecord>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

describe('maxAmountSource', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');

  it('記録が無ければ既定（環境変数の最小単位の値）を返し、USD 表記を添える', async () => {
    const source = maxAmountSource(memoryStore(), '150000', () => now);
    await expect(source.get('user-a')).resolves.toEqual({
      maxAmount: '150000',
      maxAmountUsd: '0.15',
      source: 'default',
    });
  });

  it('set は USD で受けて最小単位で保存し、以後 get はその値を返す（他の利用者は既定のまま）', async () => {
    const store = memoryStore();
    const source = maxAmountSource(store, '150000', () => now);
    const saved = { maxAmount: '200000', maxAmountUsd: '0.20', source: 'user' };
    await expect(source.set('user-a', '0.2')).resolves.toEqual(saved);
    await expect(source.get('user-a')).resolves.toEqual(saved);
    await expect(source.get('user-b')).resolves.toMatchObject({ maxAmount: '150000', source: 'default' });
    expect(store.data.get('user-a')).toEqual({ maxAmount: '200000', updatedAt: now });
  });

  // 支出上限の欄（"2.50"）と並べて読むので、USD 表記は小数 2 桁以上に揃える
  it('USD 表記は小数 2 桁以上に揃え、それより細かい既定は桁を落とさない', async () => {
    const source = maxAmountSource(memoryStore(), '1000000', () => now);
    await expect(source.get('user-a')).resolves.toMatchObject({ maxAmountUsd: '1.00' });
    const odd = maxAmountSource(memoryStore(), '123456', () => now);
    await expect(odd.get('user-a')).resolves.toMatchObject({ maxAmountUsd: '0.123456' });
  });

  // PAYMENT_MAX_AMOUNT は合成時に書式を検証していない。読めない既定でも状態の取得は落とさない
  it('既定が最小単位の整数でなければ USD 表記は null にする', async () => {
    const source = maxAmountSource(memoryStore(), 'abc', () => now);
    await expect(source.get('user-a')).resolves.toEqual({ maxAmount: 'abc', maxAmountUsd: null, source: 'default' });
  });

  it('書式でない値と 0 は拒み、保存しない（支出上限と同じ書式）', async () => {
    const store = memoryStore();
    const source = maxAmountSource(store, '150000', () => now);
    for (const bad of ['0', '0.00', 'abc', '0.123', '-1', '1,000']) {
      await expect(source.set('user-a', bad), bad).rejects.toThrow(/金額/);
    }
    expect(store.data.size).toBe(0);
  });
});
