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
      { requireAll: true },
    );
    expect(env).toEqual({ ...FULL, PAYMENTS_USER_ID: 'u1' });
  });

  it('必須にすると 3 変数が無いときに落とす', () => {
    expect(() =>
      runtimeEnvironment({ PAYMENT_MANAGER_ARN: FULL.PAYMENT_MANAGER_ARN }, { requireAll: true }),
    ).toThrow(/PAYMENT_INSTRUMENT_ID.*BILLING_MCP_URL|BILLING_MCP_URL.*PAYMENT_INSTRUMENT_ID/);
  });

  it('必須にしなければ変数が欠けても通す（sandbox と、deploy を伴わない合成）', () => {
    expect(runtimeEnvironment({}, { requireAll: false })).toEqual({});
  });

  it('空文字は未設定とみなす', () => {
    expect(() => runtimeEnvironment({ ...FULL, BILLING_MCP_URL: '' }, { requireAll: true })).toThrow(
      /BILLING_MCP_URL/,
    );
  });

  it('BUYER_TOOL_TIMEOUT_MS が共有 Lambda のタイムアウト（900 秒）を超えると落とす', () => {
    expect(() =>
      runtimeEnvironment({ ...FULL, BUYER_TOOL_TIMEOUT_MS: '900001' }, { requireAll: false }),
    ).toThrow(/BUYER_TOOL_TIMEOUT_MS/);
    expect(
      runtimeEnvironment({ ...FULL, BUYER_TOOL_TIMEOUT_MS: '900000' }, { requireAll: false }),
    ).toMatchObject({ BUYER_TOOL_TIMEOUT_MS: '900000' });
  });

  it('BUYER_TOOL_TIMEOUT_MS が数値でなければ落とす', () => {
    expect(() =>
      runtimeEnvironment({ ...FULL, BUYER_TOOL_TIMEOUT_MS: 'abc' }, { requireAll: false }),
    ).toThrow(/BUYER_TOOL_TIMEOUT_MS/);
  });

  // 支出上限は金額に直結する。実行時に黙って既定へ戻ると、上限を上げたつもりの設定ミスに
  // 気づけないため、合成の時点で落とす
  it('PAYMENT_SESSION_MAX_USD が金額の書式でなければ落とす', () => {
    for (const bad of ['10.000', '1,000.00', '1.0.0', 'abc', '-1.00']) {
      expect(() =>
        runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MAX_USD: bad }, { requireAll: false }),
      ).toThrow(/PAYMENT_SESSION_MAX_USD/);
    }
    expect(
      runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MAX_USD: '10.50' }, { requireAll: false }),
    ).toMatchObject({ PAYMENT_SESSION_MAX_USD: '10.50' });
  });

  it('PAYMENT_SESSION_MINUTES が 15 以上の整数でなければ落とす（API の下限。決定39 の実測）', () => {
    for (const bad of ['0', '-5', '14', '90.5', 'abc']) {
      expect(() =>
        runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MINUTES: bad }, { requireAll: false }),
      ).toThrow(/PAYMENT_SESSION_MINUTES/);
    }
    expect(
      runtimeEnvironment({ ...FULL, PAYMENT_SESSION_MINUTES: '30' }, { requireAll: false }),
    ).toMatchObject({ PAYMENT_SESSION_MINUTES: '30' });
  });
  it('BUYER_RATE_LIMIT / BUYER_RATE_WINDOW_MINUTES を写し、正の整数でなければ落とす（決定40）', () => {
    expect(
      runtimeEnvironment(
        { ...FULL, BUYER_RATE_LIMIT: '20', BUYER_RATE_WINDOW_MINUTES: '30' },
        { requireAll: false },
      ),
    ).toMatchObject({ BUYER_RATE_LIMIT: '20', BUYER_RATE_WINDOW_MINUTES: '30' });
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() =>
        runtimeEnvironment({ ...FULL, BUYER_RATE_LIMIT: bad }, { requireAll: false }),
      ).toThrow(/BUYER_RATE_LIMIT/);
      expect(() =>
        runtimeEnvironment({ ...FULL, BUYER_RATE_WINDOW_MINUTES: bad }, { requireAll: false }),
      ).toThrow(/BUYER_RATE_WINDOW_MINUTES/);
    }
  });
});

describe('runtimeEnvironment（決定42: 残高の取得）', () => {
  it('PAYMENT_CONNECTOR_ID を写す。無くても落とさない（残高の表示にだけ要る）', () => {
    const FULL = {
      PAYMENT_MANAGER_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/x',
      PAYMENT_INSTRUMENT_ID: 'instrument-1',
      BILLING_MCP_URL: 'https://example.lambda-url.ap-northeast-1.on.aws/mcp',
    };
    expect(runtimeEnvironment({ ...FULL, PAYMENT_CONNECTOR_ID: 'connector-1' }, { requireAll: true })).toMatchObject({
      PAYMENT_CONNECTOR_ID: 'connector-1',
    });
    expect(runtimeEnvironment(FULL, { requireAll: true })).not.toHaveProperty('PAYMENT_CONNECTOR_ID');
  });
});
