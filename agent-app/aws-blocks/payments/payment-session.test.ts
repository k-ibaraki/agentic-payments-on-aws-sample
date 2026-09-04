// PaymentSession をアプリ側で作って使い回すモジュールのテスト（決定35）。
// CreatePaymentSession はモックし、KVStore は最小のメモリ実装で代える
import { CreatePaymentSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it, vi } from 'vitest';
import {
  isSessionRejection,
  isSpendLimitRejection,
  paymentSessionSource,
  type PaymentSessionRecord,
  type PaymentSessionStore,
} from './payment-session.js';

const CONFIG = {
  userId: 'sample-user-1',
  paymentManagerArn:
    'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/agenticpaymentssample-xxxx',
  expiryMinutes: 60,
  maxSpendUsd: '1.00',
};

// KVStore の最小実装。条件付き書き込み（ifNotExists / ifValueEquals）は DynamoDB と同じく
// 満たさなければ ConditionalCheckFailedException で落とす
function memoryStore(initial?: PaymentSessionRecord): PaymentSessionStore & {
  puts: Array<{ key: string; value: PaymentSessionRecord; options?: unknown }>;
} {
  const data = new Map<string, PaymentSessionRecord>();
  if (initial) data.set(CONFIG.userId, initial);
  const puts: Array<{ key: string; value: PaymentSessionRecord; options?: unknown }> = [];
  return {
    puts,
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
        throw Object.assign(new Error('条件を満たしませんでした'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      data.set(key, value);
    },
  };
}

function clientCreating(ids: string[]) {
  const send = vi.fn(async (command: unknown) => {
    if (!(command instanceof CreatePaymentSessionCommand)) throw new Error('想定外のコマンド');
    return { paymentSession: { paymentSessionId: ids.shift(), expiryTimeInMinutes: 60 } };
  });
  return { send };
}

describe('paymentSessionSource', () => {
  it('保存が無ければ CreatePaymentSession で切り、期限つきで保存する', async () => {
    const store = memoryStore();
    const client = clientCreating(['session-new']);
    const now = Date.parse('2026-09-04T12:00:00Z');
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.acquire()).resolves.toBe('session-new');

    const input = (client.send.mock.calls[0]![0] as CreatePaymentSessionCommand).input;
    expect(input).toMatchObject({
      userId: CONFIG.userId,
      paymentManagerArn: CONFIG.paymentManagerArn,
      expiryTimeInMinutes: 60,
      limits: { maxSpendAmount: { value: '1.00', currency: 'USD' } },
    });
    expect(input.clientToken).toBeTruthy();
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.key).toBe(CONFIG.userId);
    expect(store.puts[0]!.value).toEqual({
      paymentSessionId: 'session-new',
      createdAt: now,
      expiresAt: now + 60 * 60_000,
    });
    // DynamoDB の TTL で期限切れの記録を消す。読めた記録が無いので書き込みの条件は付けない
    expect(store.puts[0]!.options).toEqual({ expiresAt: new Date(now + 60 * 60_000) });
  });

  it('期限内の保存があればそれを使い、セッションを作らない', async () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    const store = memoryStore({
      paymentSessionId: 'session-kept',
      createdAt: now - 10 * 60_000,
      expiresAt: now + 50 * 60_000,
    });
    const client = clientCreating([]);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.acquire()).resolves.toBe('session-kept');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('期限まで 60 秒を切った保存は使わず作り直す（決済中に失効させない）', async () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    const store = memoryStore({
      paymentSessionId: 'session-stale',
      createdAt: now - 59 * 60_000,
      expiresAt: now + 30_000,
    });
    const client = clientCreating(['session-fresh']);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.acquire()).resolves.toBe('session-fresh');
  });

  it('renew は拒否された記録を新しいセッションで置き換える', async () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    const store = memoryStore({
      paymentSessionId: 'session-rejected',
      createdAt: now,
      expiresAt: now + 60 * 60_000,
    });
    const client = clientCreating(['session-renewed']);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.renew('session-rejected')).resolves.toBe('session-renewed');
    await expect(store.get(CONFIG.userId)).resolves.toMatchObject({ paymentSessionId: 'session-renewed' });
  });

  it('renew は別の呼び出しが既に作り直していれば、その有効なセッションに乗る', async () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    // 記録は既に別の購入が作り直した後のもの。自分が拒否された ID とは違う
    const store = memoryStore({
      paymentSessionId: 'session-by-other',
      createdAt: now,
      expiresAt: now + 60 * 60_000,
    });
    const client = clientCreating([]);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.renew('session-rejected')).resolves.toBe('session-by-other');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('記録の書き込みが競合しても、作ったセッションはそのまま使う', async () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    // 読んだ後・書く前に別の呼び出しが書き換えた状況。条件付き書き込みが必ず落ちる店を使う
    const store: PaymentSessionStore = {
      async get() {
        return { paymentSessionId: 'session-rejected', createdAt: now, expiresAt: now + 60 * 60_000 };
      },
      async put() {
        throw Object.assign(new Error('条件を満たしませんでした'), {
          name: 'ConditionalCheckFailedException',
        });
      },
    };
    const client = clientCreating(['session-mine']);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.renew('session-rejected')).resolves.toBe('session-mine');
  });

  // 本番の KVStore の get は、期限切れの記録を null で返す。ただし実体は消さない。
  // そのため ifNotExists（実体の有無を見る）を条件にすると、記録を保存できなくなる。
  // この状況は mock では起きない。mock は期限切れを即座に消すためである。
  // 本番でだけ壊れる経路なので、本番の挙動を模した store でここを押さえる
  it('期限切れの記録が実体として残っていても、新しいセッションを保存できる', async () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    let saved: PaymentSessionRecord | null = null;
    const options: unknown[] = [];
    const store: PaymentSessionStore = {
      async get() {
        return null; // 期限切れとして濾される（実体は残っている）
      },
      async put(_key, value, opts) {
        options.push(opts);
        if (opts?.ifNotExists) {
          throw Object.assign(new Error('条件を満たしませんでした'), {
            name: 'ConditionalCheckFailedException',
          });
        }
        saved = value;
      },
    };
    const client = clientCreating(['session-fresh']);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.acquire()).resolves.toBe('session-fresh');
    expect(saved).toMatchObject({ paymentSessionId: 'session-fresh' });
    expect(options[0]).not.toHaveProperty('ifNotExists');
  });

  it('CreatePaymentSession が ID を返さなければ失敗にする', async () => {
    const store = memoryStore();
    const client = { send: vi.fn(async () => ({ paymentSession: undefined })) };
    const source = paymentSessionSource(client, store, CONFIG);

    await expect(source.acquire()).rejects.toThrow(/CreatePaymentSession/);
    expect(store.puts).toHaveLength(0);
  });
});

describe('isSessionRejection', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('ResourceNotFoundException はセッション起因とみなす', () => {
    expect(isSessionRejection(named('ResourceNotFoundException', 'not found'))).toBe(true);
  });

  it('ValidationException / ConflictException はメッセージに session を含むときだけ', () => {
    expect(isSessionRejection(named('ValidationException', 'Payment session has expired'))).toBe(true);
    expect(isSessionRejection(named('ValidationException', 'Payment session not found: abc'))).toBe(true);
    expect(isSessionRejection(named('ValidationException', 'invalid payload'))).toBe(false);
  });

  // 決定37: 上限超過で作り直すと、上限に当たった支払いがその場で通ってしまい上限が上限でなくなる
  it('支出上限の超過は作り直しの対象にしない', () => {
    expect(isSessionRejection(named('ConflictException', 'Session limit exceeded'))).toBe(false);
    expect(isSessionRejection(named('ValidationException', 'session spend limit exceeded'))).toBe(false);
    expect(isSessionRejection(named('ConflictException', 'insufficient session budget'))).toBe(false);
  });

  it('それ以外（AccessDenied や一般の Error）はセッション起因ではない', () => {
    expect(isSessionRejection(named('AccessDeniedException', 'session'))).toBe(false);
    expect(isSessionRejection(new Error('session'))).toBe(false);
    expect(isSessionRejection('session')).toBe(false);
  });
});

describe('isSpendLimitRejection', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('上限や残高の不足を示す文言を拾う', () => {
    expect(isSpendLimitRejection(named('ConflictException', 'Session limit exceeded'))).toBe(true);
    expect(isSpendLimitRejection(named('ValidationException', 'maxSpendAmount exceeded'))).toBe(true);
    expect(isSpendLimitRejection(named('ConflictException', 'insufficient funds'))).toBe(true);
  });

  it('失効や未検出は上限超過ではない', () => {
    expect(isSpendLimitRejection(named('ValidationException', 'Payment session not found: abc'))).toBe(false);
    expect(isSpendLimitRejection(named('ValidationException', 'Payment session has expired'))).toBe(false);
    expect(isSpendLimitRejection('limit exceeded')).toBe(false);
  });

  // 一時的な失敗を「上限に達した」と誤って伝えないよう、業務ルールの拒否を表す例外に限る
  it('スロットリングなど別種の例外は、文言が似ていても上限超過とみなさない', () => {
    expect(isSpendLimitRejection(named('ThrottlingException', 'Rate exceeded'))).toBe(false);
    expect(isSpendLimitRejection(named('ServiceQuotaExceededException', 'limit exceeded'))).toBe(false);
    expect(isSpendLimitRejection(named('AccessDeniedException', 'insufficient permissions'))).toBe(false);
  });
});
