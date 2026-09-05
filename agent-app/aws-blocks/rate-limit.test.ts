// 利用者ごとの依頼回数の上限（決定40）。固定時間窓のカウンタを KVStore の条件付き書き込みで回す
import { describe, expect, it } from 'vitest';
import { type RateLimitRecord, type RateLimitStore, rateLimiter } from './rate-limit.js';

function memoryStore() {
  const data = new Map<string, RateLimitRecord>();
  const puts: Array<{ key: string; value: RateLimitRecord; options?: unknown }> = [];
  const store: RateLimitStore = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
      const current = data.get(key) ?? null;
      const conflict = options?.ifNotExists
        ? current !== null
        : options?.ifValueEquals !== undefined
          ? JSON.stringify(current) !== JSON.stringify(options.ifValueEquals)
          : false;
      if (conflict) {
        throw Object.assign(new Error('条件を満たしませんでした'), { name: 'ConditionalCheckFailedException' });
      }
      data.set(key, value);
    },
  };
  return { store, data, puts };
}

const CONFIG = { limit: 3, windowMinutes: 60 };
const T0 = Date.parse('2026-09-05T12:00:00Z');

describe('rateLimiter', () => {
  it('上限までは通し、超えたら拒否する', async () => {
    const { store } = memoryStore();
    const limiter = rateLimiter(store, CONFIG, () => T0);
    await expect(limiter.consume('user-a')).resolves.toEqual({ allowed: true, remaining: 2 });
    await expect(limiter.consume('user-a')).resolves.toEqual({ allowed: true, remaining: 1 });
    await expect(limiter.consume('user-a')).resolves.toEqual({ allowed: true, remaining: 0 });
    await expect(limiter.consume('user-a')).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it('利用者ごとに数える', async () => {
    const { store } = memoryStore();
    const limiter = rateLimiter(store, CONFIG, () => T0);
    for (let i = 0; i < 3; i++) await limiter.consume('user-a');
    await expect(limiter.consume('user-b')).resolves.toMatchObject({ allowed: true });
  });

  it('時間窓が変わればやり直す。記録には窓の終わりを期限に付ける', async () => {
    const { store, puts } = memoryStore();
    let now = T0;
    const limiter = rateLimiter(store, CONFIG, () => now);
    for (let i = 0; i < 3; i++) await limiter.consume('user-a');
    await expect(limiter.consume('user-a')).resolves.toMatchObject({ allowed: false });
    // 窓は 60 分で区切る（T0 は 12:00 ちょうどなので次の窓は 13:00）
    now = T0 + 60 * 60_000;
    await expect(limiter.consume('user-a')).resolves.toMatchObject({ allowed: true, remaining: 2 });
    expect(puts[0]!.options).toMatchObject({ ifNotExists: true, expiresAt: new Date(T0 + 60 * 60_000) });
    // 窓ごとに別のキーにする（前の窓の記録は TTL に任せる）
    expect(new Set(puts.map((p) => p.key)).size).toBe(2);
  });

  it('拒否には窓が明ける時刻を含める', async () => {
    const { store } = memoryStore();
    const limiter = rateLimiter(store, { limit: 1, windowMinutes: 60 }, () => T0 + 5 * 60_000);
    await limiter.consume('user-a');
    await expect(limiter.consume('user-a')).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAt: new Date(T0 + 60 * 60_000),
    });
  });

  it('読んでから書くまでに別の依頼が書いていたら読み直す（compare-and-swap）', async () => {
    const { store, data } = memoryStore();
    // 1 回目の get の後に横から書き込む店
    let reads = 0;
    const racing: RateLimitStore = {
      async get(key) {
        reads++;
        const value = await store.get(key);
        if (reads === 1) await store.put(key, { count: 2 }, { ifNotExists: true });
        return value;
      },
      put: (key, value, options) => store.put(key, value, options),
    };
    const limiter = rateLimiter(racing, CONFIG, () => T0);
    await expect(limiter.consume('user-a')).resolves.toEqual({ allowed: true, remaining: 0 });
    expect([...data.values()][0]).toEqual({ count: 3 });
  });

  // 本番の KVStore の get は期限切れを null で返すが、実体は消さない（TTL 掃除は最大 48 時間）。
  // 一方 ifNotExists は実体の有無を見る。窓の長さを変えるとキーが過去の窓と一致しうるため
  // （60 分の境界は 120 分の境界を含む）、この状況は本番でだけ起こる。mock は期限切れを即削除するので再現しない
  it('期限切れの実体が残っているキーでも数え直せる', async () => {
    let saved: RateLimitRecord | null = null;
    const conditions: unknown[] = [];
    const store: RateLimitStore = {
      async get() {
        return null; // 論理的には期限切れ（実体は残っている）
      },
      async put(_key, value, options) {
        conditions.push(options);
        if (options?.ifNotExists) {
          throw Object.assign(new Error('条件を満たしませんでした'), { name: 'ConditionalCheckFailedException' });
        }
        saved = value;
      },
    };
    const limiter = rateLimiter(store, CONFIG, () => T0);

    await expect(limiter.consume('user-a')).resolves.toEqual({ allowed: true, remaining: 2 });
    expect(saved).toEqual({ count: 1 });
    // 1 回目は ifNotExists、落ちた後は条件を外して書く
    expect(conditions[0]).toMatchObject({ ifNotExists: true });
    expect(conditions[1]).not.toHaveProperty('ifNotExists');
    expect(conditions[1]).not.toHaveProperty('ifValueEquals');
  });

  it('競合が続いても無限には回らない', async () => {
    const alwaysConflict: RateLimitStore = {
      async get() {
        return { count: 1 };
      },
      async put() {
        throw Object.assign(new Error('条件を満たしませんでした'), { name: 'ConditionalCheckFailedException' });
      },
    };
    const limiter = rateLimiter(alwaysConflict, CONFIG, () => T0);
    await expect(limiter.consume('user-a')).rejects.toThrow(/競合/);
  });
});
