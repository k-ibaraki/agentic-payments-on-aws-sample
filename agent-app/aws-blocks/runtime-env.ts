import { MIN_SESSION_MINUTES } from './payments/payment-session.js';

/**
 * 合成時の環境変数から、共有 Lambda に写す実行時設定を決める（決定34）。
 *
 * Amplify Hosting のコンソールで設定した環境変数はビルド（= ampx の合成）にしか届かない。
 * そこで許可リストの変数だけを拾い、runtime.cdk.ts の wireRuntime が
 * handler.addEnvironment で Lambda に写す。値はいずれも識別子や URL で秘密ではない。
 */

/**
 * buyer-agent.ts が process.env から読み、payments/ へは引数で渡す変数。
 * payments/ 自体は process.env を見ない（メモリ実装に差し替えてテストできるようにするため）
 */
export const RUNTIME_ENV_KEYS = [
  'PAYMENT_MANAGER_ARN',
  'PAYMENT_INSTRUMENT_ID',
  // 残高の表示（決定42）にだけ要る。無くても実決済は通るので必須にはしない
  'PAYMENT_CONNECTOR_ID',
  'BILLING_MCP_URL',
  'PAYMENTS_USER_ID',
  'PAYMENT_MAX_AMOUNT',
  'PAYMENT_PAY_TO',
  'BUYER_TOOL_TIMEOUT_MS',
  'PAYMENT_SESSION_MINUTES',
  'PAYMENT_SESSION_MAX_USD',
  'BUYER_RATE_LIMIT',
  'BUYER_RATE_WINDOW_MINUTES',
] as const;

/** ブランチ deploy で無ければ実決済が通らない変数。合成で落として気づけるようにする */
export const REQUIRED_ENV_KEYS = ['PAYMENT_MANAGER_ARN', 'PAYMENT_INSTRUMENT_ID', 'BILLING_MCP_URL'] as const;

/** @aws-blocks/core の BlocksBackend が共有 Lambda に設定するタイムアウト（15 分） */
export const SHARED_LAMBDA_TIMEOUT_MS = 15 * 60 * 1000;

export function runtimeEnvironment(
  env: Record<string, string | undefined>,
  options: { sandboxMode: boolean },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (value) result[key] = value;
  }

  if (!options.sandboxMode) {
    const missing = REQUIRED_ENV_KEYS.filter((key) => !result[key]);
    if (missing.length > 0) {
      throw new Error(
        `実決済に必要な環境変数が未設定です: ${missing.join(', ')}。` +
          '合成時の環境変数に設定してください（Amplify はコンソールのアプリ／ブランチ環境変数、' +
          'CDK 直の deploy はシェル。値は scripts/payments-setup.ts の出力と売り手の Function URL）',
      );
    }
  }

  const timeout = result.BUYER_TOOL_TIMEOUT_MS;
  if (timeout !== undefined) {
    const ms = Number(timeout);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`BUYER_TOOL_TIMEOUT_MS が数値ではありません: ${timeout}`);
    }
    // 決定31 の注記: Agent を実行する Lambda のタイムアウトが有料ツールの待ち時間を包含していないと、
    // 決済後に Lambda が先に打ち切られて成果物を失う
    if (ms > SHARED_LAMBDA_TIMEOUT_MS) {
      throw new Error(
        `BUYER_TOOL_TIMEOUT_MS=${timeout} は共有 Lambda のタイムアウト（${SHARED_LAMBDA_TIMEOUT_MS} ms）を超えています`,
      );
    }
  }

  // 支出上限と期限は金額に直結する。実行時に黙って既定へ戻すと「上限を上げたつもり」の
  // 書式ミスに気づけないため、合成の時点で落とす（決定37）
  const maxUsd = result.PAYMENT_SESSION_MAX_USD;
  if (maxUsd !== undefined && !/^\d+(\.\d{1,2})?$/.test(maxUsd)) {
    throw new Error(
      `PAYMENT_SESSION_MAX_USD=${maxUsd} は金額の書式ではありません（例 1.00。小数は2桁まで、桁区切りは使えません）`,
    );
  }

  const minutes = result.PAYMENT_SESSION_MINUTES;
  if (minutes !== undefined) {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < MIN_SESSION_MINUTES) {
      throw new Error(
        `PAYMENT_SESSION_MINUTES=${minutes} は ${MIN_SESSION_MINUTES} 以上の整数ではありません（CreatePaymentSession の下限）`,
      );
    }
  }

  // 依頼回数の上限（決定40）。回数と時間窓はどちらも正の整数
  for (const key of ['BUYER_RATE_LIMIT', 'BUYER_RATE_WINDOW_MINUTES'] as const) {
    const raw = result[key];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key}=${raw} は正の整数ではありません`);
    }
  }

  return result;
}
