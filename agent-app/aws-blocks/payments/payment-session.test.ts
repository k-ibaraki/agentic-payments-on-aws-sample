// PaymentSession をアプリ側で作って使い回すモジュールのテスト（決定35）。
// CreatePaymentSession はモックし、KVStore は最小のメモリ実装で代える
import { CreatePaymentSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it, vi } from 'vitest';
import {
  isSessionRejection,
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
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
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
    // DynamoDB の TTL で期限切れの記録を消す
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

  it('renew は保存を捨てて新しいセッションを切る', async () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    const store = memoryStore({
      paymentSessionId: 'session-rejected',
      createdAt: now,
      expiresAt: now + 60 * 60_000,
    });
    const client = clientCreating(['session-renewed']);
    const source = paymentSessionSource(client, store, CONFIG, () => now);

    await expect(source.renew()).resolves.toBe('session-renewed');
    await expect(store.get(CONFIG.userId)).resolves.toMatchObject({ paymentSessionId: 'session-renewed' });
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
    expect(isSessionRejection(named('ConflictException', 'Session limit exceeded'))).toBe(true);
    expect(isSessionRejection(named('ValidationException', 'invalid payload'))).toBe(false);
  });

  it('それ以外（AccessDenied や一般の Error）はセッション起因ではない', () => {
    expect(isSessionRejection(named('AccessDeniedException', 'session'))).toBe(false);
    expect(isSessionRejection(new Error('session'))).toBe(false);
    expect(isSessionRejection('session')).toBe(false);
  });
});
