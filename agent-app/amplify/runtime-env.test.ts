// 合成時の環境変数から Lambda に写す実行時設定を決めるモジュールのテスト（決定34）
import { describe, expect, it } from 'vitest';
import { runtimeEnvironment } from './runtime-env.js';

const FULL = {
  PAYMENT_MANAGER_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/x',
  PAYMENT_INSTRUMENT_ID: 'instrument-1',
  BILLING_MCP_URL: 'https://example.lambda-url.ap-northeast-1.on.aws/mcp',
};

describe('runtimeEnvironment', () => {
  it('許可リストの変数だけを写し、無関係な変数は落とす', () => {
    const env = runtimeEnvironment(
      { ...FULL, PAYMENTS_USER_ID: 'u1', AWS_SECRET_ACCESS_KEY: 'x', PATH: '/bin' },
      { sandboxMode: false },
    );
    expect(env).toEqual({ ...FULL, PAYMENTS_USER_ID: 'u1' });
  });

  it('ブランチ deploy では必須の3変数が無いと落とす', () => {
    expect(() =>
      runtimeEnvironment({ PAYMENT_MANAGER_ARN: FULL.PAYMENT_MANAGER_ARN }, { sandboxMode: false }),
    ).toThrow(/PAYMENT_INSTRUMENT_ID.*BILLING_MCP_URL|BILLING_MCP_URL.*PAYMENT_INSTRUMENT_ID/);
  });

  it('sandbox では必須変数が欠けても通す（認証と API の疎通だけを見る用途）', () => {
    expect(runtimeEnvironment({}, { sandboxMode: true })).toEqual({});
  });

  it('空文字は未設定とみなす', () => {
    expect(() => runtimeEnvironment({ ...FULL, BILLING_MCP_URL: '' }, { sandboxMode: false })).toThrow(
      /BILLING_MCP_URL/,
    );
  });

  it('BUYER_TOOL_TIMEOUT_MS が共有 Lambda のタイムアウト（900 秒）を超えると落とす', () => {
    expect(() =>
      runtimeEnvironment({ ...FULL, BUYER_TOOL_TIMEOUT_MS: '900001' }, { sandboxMode: true }),
    ).toThrow(/BUYER_TOOL_TIMEOUT_MS/);
    expect(
      runtimeEnvironment({ ...FULL, BUYER_TOOL_TIMEOUT_MS: '900000' }, { sandboxMode: true }),
    ).toMatchObject({ BUYER_TOOL_TIMEOUT_MS: '900000' });
  });

  it('BUYER_TOOL_TIMEOUT_MS が数値でなければ落とす', () => {
    expect(() =>
      runtimeEnvironment({ ...FULL, BUYER_TOOL_TIMEOUT_MS: 'abc' }, { sandboxMode: true }),
    ).toThrow(/BUYER_TOOL_TIMEOUT_MS/);
  });

  // 支出上限は金額に直結する。実行時に黙って既定へ戻ると、上限を上げたつもりの設定ミスに
  // 気づけないため、合成の時点で落とす
  it('PAYMENT_SESSION_MAX_USD が金額の書式でなければ落とす', () => {
    for (const bad of ['10.000', '1,000.00', '1.0.0', 'abc', '-1.00']) {
      expect(() =>
        runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MAX_USD: bad }, { sandboxMode: true }),
      ).toThrow(/PAYMENT_SESSION_MAX_USD/);
    }
    expect(
      runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MAX_USD: '10.50' }, { sandboxMode: true }),
    ).toMatchObject({ PAYMENT_SESSION_MAX_USD: '10.50' });
  });

  it('PAYMENT_SESSION_MINUTES が 15 以上の整数でなければ落とす（API の下限。決定39 の実測）', () => {
    for (const bad of ['0', '-5', '14', '90.5', 'abc']) {
      expect(() =>
        runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MINUTES: bad }, { sandboxMode: true }),
      ).toThrow(/PAYMENT_SESSION_MINUTES/);
    }
    expect(
      runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MINUTES: '30' }, { sandboxMode: true }),
    ).toMatchObject({ PAYMENT_SESSION_MINUTES: '30' });
  });
  it('BUYER_RATE_LIMIT / BUYER_RATE_WINDOW_MINUTES を写し、正の整数でなければ落とす（決定40）', () => {
    expect(
      runtimeEnvironment(
        { ...FULL, BUYER_RATE_LIMIT: '20', BUYER_RATE_WINDOW_MINUTES: '30' },
        { sandboxMode: true },
      ),
    ).toMatchObject({ BUYER_RATE_LIMIT: '20', BUYER_RATE_WINDOW_MINUTES: '30' });
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() =>
        runtimeEnvironment({ ...FULL, BUYER_RATE_LIMIT: bad }, { sandboxMode: true }),
      ).toThrow(/BUYER_RATE_LIMIT/);
      expect(() =>
        runtimeEnvironment({ ...FULL, BUYER_RATE_WINDOW_MINUTES: bad }, { sandboxMode: true }),
      ).toThrow(/BUYER_RATE_WINDOW_MINUTES/);
    }
  });
});
