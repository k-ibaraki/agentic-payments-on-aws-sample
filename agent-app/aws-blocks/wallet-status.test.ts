// ウォレットの状態と上限変更（決定42・43）の配線のテスト。環境変数は vi.stubEnv で与え、
// SDK クライアントはモック、KVStore はメモリ実装で代える
import {
  DeletePaymentSessionCommand,
  GetPaymentInstrumentBalanceCommand,
  GetPaymentSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeSpendLimit, walletStatus, type WalletStores } from './buyer-agent.js';

const ENV = {
  PAYMENT_MANAGER_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/x',
  PAYMENT_INSTRUMENT_ID: 'instrument-1',
  PAYMENT_CONNECTOR_ID: 'connector-1',
  PAYMENTS_USER_ID: 'wallet-owner',
  PAYMENT_SESSION_MAX_USD: '1.00',
};

function stubEnv(overrides: Partial<Record<keyof typeof ENV, string | undefined>> = {}) {
  for (const [key, value] of Object.entries({ ...ENV, ...overrides })) {
    vi.stubEnv(key, value as string);
  }
}

function memoryStores(): WalletStores & { sessions: Map<string, unknown>; limits: Map<string, unknown> } {
  const sessions = new Map<string, any>();
  const limits = new Map<string, any>();
  return {
    sessions,
    limits,
    paymentSessions: {
      async get(key) {
        return sessions.get(key) ?? null;
      },
      async put(key, value) {
        sessions.set(key, value);
      },
      async delete(key) {
        sessions.delete(key);
      },
    },
    spendLimits: {
      async get(key) {
        return limits.get(key) ?? null;
      },
      async put(key, value) {
        limits.set(key, value);
      },
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('walletStatus', () => {
  it('残高・現在のセッション・上限を揃えて返す', async () => {
    stubEnv();
    const stores = memoryStores();
    const now = Date.now();
    stores.sessions.set('user-a', { paymentSessionId: 's1', createdAt: now, expiresAt: now + 30 * 60_000 });
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetPaymentInstrumentBalanceCommand) {
        expect(command.input).toMatchObject({ userId: 'wallet-owner', paymentConnectorId: 'connector-1' });
        return { tokenBalance: { amount: '900000', decimals: 6, token: 'USDC' } };
      }
      if (command instanceof GetPaymentSessionCommand) {
        return {
          paymentSession: {
            limits: { maxSpendAmount: { value: '1.00' } },
            availableLimits: { availableSpendAmount: { value: '0.9' } },
          },
        };
      }
      throw new Error('想定外のコマンド');
    });

    const status = await walletStatus(stores, 'user-a', { send });

    expect(status.balance).toEqual({ token: 'USDC', amount: '900000', decimals: 6, display: '0.9' });
    expect(status.balanceError).toBeNull();
    expect(status.session).toMatchObject({ paymentSessionId: 's1', maxSpendUsd: '1.00', availableSpendUsd: '0.9' });
    expect(status.spendLimit).toEqual({ maxSpendUsd: '1.00', source: 'default' });
    expect(status.sessionMinutes).toBe(60);
  });

  it('PAYMENT_CONNECTOR_ID が無ければ残高だけ理由つきで null にし、セッションは返す', async () => {
    stubEnv({ PAYMENT_CONNECTOR_ID: undefined });
    const send = vi.fn(async () => ({ paymentSession: {} }));
    const status = await walletStatus(memoryStores(), 'user-a', { send });
    expect(status.balance).toBeNull();
    expect(status.balanceError).toMatch(/PAYMENT_CONNECTOR_ID/);
    expect(status.sessionError).toBeNull();
    expect(send).not.toHaveBeenCalledWith(expect.any(GetPaymentInstrumentBalanceCommand));
  });

  it('残高 API の失敗は全体を落とさず理由に入れる', async () => {
    stubEnv();
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetPaymentInstrumentBalanceCommand) {
        throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
      }
      return {};
    });
    const status = await walletStatus(memoryStores(), 'user-a', { send });
    expect(status.balance).toBeNull();
    expect(status.balanceError).toMatch(/not authorized/);
  });
});

describe('changeSpendLimit', () => {
  it('上限を保存し、現在のセッションを AgentCore と記録の両方から消す', async () => {
    stubEnv();
    const stores = memoryStores();
    const now = Date.now();
    stores.sessions.set('user-a', { paymentSessionId: 's1', createdAt: now, expiresAt: now + 30 * 60_000 });
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof DeletePaymentSessionCommand)) throw new Error('想定外のコマンド');
      expect(command.input).toEqual({
        userId: 'wallet-owner',
        paymentManagerArn: ENV.PAYMENT_MANAGER_ARN,
        paymentSessionId: 's1',
      });
      return {};
    });

    const result = await changeSpendLimit(stores, 'user-a', '2.5', { send });

    expect(result).toEqual({ spendLimit: { maxSpendUsd: '2.50', source: 'user' }, discardedSession: 's1' });
    expect(stores.sessions.has('user-a')).toBe(false);
    expect(stores.limits.get('user-a')).toMatchObject({ maxSpendUsd: '2.50' });
    // 以後の状態は新しい上限を返す
    expect((await walletStatus(stores, 'user-a', { send: async () => ({}) })).spendLimit).toEqual({
      maxSpendUsd: '2.50',
      source: 'user',
    });
  });

  it('書式外の値は保存も破棄もしない', async () => {
    stubEnv();
    const stores = memoryStores();
    const send = vi.fn(async () => ({}));
    await expect(changeSpendLimit(stores, 'user-a', 'abc', { send })).rejects.toThrow(/金額/);
    expect(stores.limits.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
