// ウォレットの状態と上限変更（決定42・43・66）の配線のテスト。環境変数は vi.stubEnv で与え、
// SDK クライアントはモック、KVStore はメモリ実装で代える
import {
  DeletePaymentSessionCommand,
  GetPaymentInstrumentBalanceCommand,
  GetPaymentSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changeMaxAmount,
  changeSpendLimit,
  paymentPolicyFromEnv,
  walletStatus,
  type WalletStores,
} from './buyer-agent.js';

const ENV = {
  PAYMENT_MANAGER_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/x',
  PAYMENT_INSTRUMENT_ID: 'instrument-1',
  PAYMENT_CONNECTOR_ID: 'connector-1',
  PAYMENTS_USER_ID: 'wallet-owner',
  PAYMENT_SESSION_MAX_USD: '1.00',
  PAYMENT_MAX_AMOUNT: '150000',
};

function stubEnv(overrides: Partial<Record<keyof typeof ENV, string | undefined>> = {}) {
  for (const [key, value] of Object.entries({ ...ENV, ...overrides })) {
    vi.stubEnv(key, value as string);
  }
}

function memoryStores(): WalletStores & {
  sessions: Map<string, unknown>;
  limits: Map<string, unknown>;
  maxAmountRecords: Map<string, unknown>;
} {
  const sessions = new Map<string, any>();
  const limits = new Map<string, any>();
  const maxAmountRecords = new Map<string, any>();
  return {
    sessions,
    limits,
    maxAmountRecords,
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
    maxAmounts: {
      async get(key) {
        return maxAmountRecords.get(key) ?? null;
      },
      async put(key, value) {
        maxAmountRecords.set(key, value);
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
    expect(status.maxAmount).toEqual({ maxAmount: '150000', maxAmountUsd: '0.15', source: 'default' });
    expect(status.sessionMinutes).toBe(60);
  });

  // 画面の行が理由つきで出せるよう、支払いの設定が欠けて早く返る経路でも 1 回の上限は埋める
  it('PAYMENT_MANAGER_ARN が無くても 1 回の上限は返す', async () => {
    stubEnv({ PAYMENT_MANAGER_ARN: undefined });
    const status = await walletStatus(memoryStores(), 'user-a', { send: vi.fn() });
    expect(status.sessionError).toMatch(/PAYMENT_MANAGER_ARN/);
    expect(status.maxAmount).toEqual({ maxAmount: '150000', maxAmountUsd: '0.15', source: 'default' });
  });

  it('PAYMENT_MAX_AMOUNT が無ければコードの既定（0.15 USDC）を返す', async () => {
    stubEnv({ PAYMENT_MAX_AMOUNT: undefined });
    const status = await walletStatus(memoryStores(), 'user-a', { send: async () => ({}) });
    expect(status.maxAmount).toMatchObject({ maxAmount: '150000', source: 'default' });
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

  it('残高 API の失敗は全体を落とさず、例外文は画面に出さずログに残す', async () => {
    stubEnv();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetPaymentInstrumentBalanceCommand) {
        throw Object.assign(new Error('not authorized to access arn:aws:iam::111122223333:role/x'), {
          name: 'AccessDeniedException',
        });
      }
      return {};
    });
    const status = await walletStatus(memoryStores(), 'user-a', { send });
    expect(status.balance).toBeNull();
    // 画面向けの理由は例外名までで、ARN を含む原文は含めない
    expect(status.balanceError).toMatch(/AccessDeniedException/);
    expect(status.balanceError).not.toMatch(/arn:aws/);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('arn:aws:iam::111122223333:role/x'));
    consoleError.mockRestore();
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

describe('changeMaxAmount', () => {
  // 1 回の上限はアプリ側の判定だけに効くので、AgentCore Payments は呼ばない（セッションは残る）
  it('利用者ごとに保存し、セッションには触れない', async () => {
    stubEnv();
    const stores = memoryStores();
    const now = Date.now();
    stores.sessions.set('user-a', { paymentSessionId: 's1', createdAt: now, expiresAt: now + 30 * 60_000 });

    const result = await changeMaxAmount(stores, 'user-a', '0.2');

    expect(result).toEqual({ maxAmount: { maxAmount: '200000', maxAmountUsd: '0.20', source: 'user' } });
    expect(stores.sessions.has('user-a')).toBe(true);
    const send = vi.fn(async () => ({}));
    expect((await walletStatus(stores, 'user-a', { send })).maxAmount).toEqual(result.maxAmount);
    expect((await walletStatus(stores, 'user-b', { send })).maxAmount).toMatchObject({ source: 'default' });
  });

  it('書式外の値は保存しない', async () => {
    stubEnv();
    const stores = memoryStores();
    await expect(changeMaxAmount(stores, 'user-a', '0')).rejects.toThrow(/金額/);
    expect(stores.maxAmountRecords.size).toBe(0);
  });
});

describe('paymentPolicyFromEnv', () => {
  it('上限を渡せばそれを、無ければ PAYMENT_MAX_AMOUNT を使う', () => {
    stubEnv({ PAYMENT_MAX_AMOUNT: '120000' });
    expect(paymentPolicyFromEnv().maxAmount).toBe('120000');
    expect(paymentPolicyFromEnv('200000').maxAmount).toBe('200000');
  });
});
