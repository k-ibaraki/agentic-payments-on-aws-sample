/**
 * 合成時の環境変数から、共有 Lambda に写す実行時設定を決める（決定34）。
 *
 * Amplify Hosting のコンソールで設定した環境変数はビルド（= ampx の合成）にしか届かない。
 * そこで許可リストの変数だけを拾い、amplify/blocks.ts が blocks.handler.addEnvironment で
 * Lambda に写す。値はいずれも識別子や URL で秘密ではない。
 */

/** buyer-agent.ts と payments/ が process.env から読む変数 */
export const RUNTIME_ENV_KEYS = [
  'PAYMENT_MANAGER_ARN',
  'PAYMENT_INSTRUMENT_ID',
  'BILLING_MCP_URL',
  'PAYMENTS_USER_ID',
  'PAYMENT_MAX_AMOUNT',
  'PAYMENT_PAY_TO',
  'BUYER_TOOL_TIMEOUT_MS',
  'PAYMENT_SESSION_MINUTES',
  'PAYMENT_SESSION_MAX_USD',
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
          'Amplify コンソールのブランチ環境変数に設定してください（scripts/payments-setup.ts の出力と売り手の Function URL）',
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

  return result;
}
