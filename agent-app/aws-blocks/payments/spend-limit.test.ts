// 利用者ごとの支出上限（決定43）のテスト。KVStore は最小のメモリ実装で代える
import { describe, expect, it } from 'vitest';
import { isUsdAmount, normalizeUsd, spendLimitSource, type SpendLimitRecord, type SpendLimitStore } from './spend-limit.js';

function memoryStore(): SpendLimitStore & { data: Map<string, SpendLimitRecord> } {
  const data = new Map<string, SpendLimitRecord>();
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

describe('isUsdAmount', () => {
  it('正の金額（小数 2 桁まで、桁区切りなし）だけを通す', () => {
    for (const ok of ['1.00', '0.5', '10', '250.75', '0.01']) expect(isUsdAmount(ok), ok).toBe(true);
    for (const bad of ['0', '0.00', '1.000', '1,000.00', 'abc', '-1', '', ' 1', '1e3']) {
      expect(isUsdAmount(bad), bad).toBe(false);
    }
  });
});

describe('normalizeUsd', () => {
  it('小数 2 桁に揃える（CreatePaymentSession に渡す表記）', () => {
    expect(normalizeUsd('1')).toBe('1.00');
    expect(normalizeUsd('0.5')).toBe('0.50');
    expect(normalizeUsd('250.75')).toBe('250.75');
  });
});

describe('spendLimitSource', () => {
  const now = Date.parse('2026-09-06T10:00:00Z');

  it('記録が無ければ既定（環境変数の値）を返す', async () => {
    const source = spendLimitSource(memoryStore(), '1.00', () => now);
    await expect(source.get('user-a')).resolves.toEqual({ maxSpendUsd: '1.00', source: 'default' });
  });

  it('set で利用者ごとに保存し、以後 get はその値を返す', async () => {
    const store = memoryStore();
    const source = spendLimitSource(store, '1.00', () => now);
    await expect(source.set('user-a', '2.5')).resolves.toEqual({ maxSpendUsd: '2.50', source: 'user' });
    await expect(source.get('user-a')).resolves.toEqual({ maxSpendUsd: '2.50', source: 'user' });
    await expect(source.get('user-b')).resolves.toEqual({ maxSpendUsd: '1.00', source: 'default' });
    expect(store.data.get('user-a')).toEqual({ maxSpendUsd: '2.50', updatedAt: now });
  });

  it('書式でない値と 0 は拒み、保存しない', async () => {
    const store = memoryStore();
    const source = spendLimitSource(store, '1.00', () => now);
    for (const bad of ['0', 'abc', '1.234', '-1']) {
      await expect(source.set('user-a', bad)).rejects.toThrow(/金額/);
    }
    expect(store.data.size).toBe(0);
  });
});
