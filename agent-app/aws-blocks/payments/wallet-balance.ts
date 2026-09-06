// ウォレット（PaymentInstrument）の残高を AgentCore Payments から取る（決定42）。
// Base Sepolia の RPC に balanceOf を打つ案は採らず、Payments の GetPaymentInstrumentBalance を使う
// （AgentCore Payments の機能を試すのが本サンプルの趣旨で、RPC の依存も増やさない）。
// CLI から打てないのは userId ヘッダーの都合で、SDK は userId 引数から自動で付ける
import { GetPaymentInstrumentBalanceCommand } from '@aws-sdk/client-bedrock-agentcore';

export interface WalletBalanceContext {
  /** ウォレットの持ち主 ID（Payments 側の userId） */
  userId: string;
  paymentManagerArn: string;
  paymentConnectorId: string;
  paymentInstrumentId: string;
}

export interface WalletBalance {
  token: string;
  /** API が返した生の値（最小単位の整数か十進表記。実測で確定させる） */
  amount: string;
  decimals: number;
  /** 人が読む十進表記（USDC 単位） */
  display: string;
}

interface AwsClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * 最小単位の整数を decimals 桁で割った十進表記にする。末尾の 0 は落とす。
 * 既に小数点を含む値は十進表記とみなしてそのまま返す
 */
export function formatTokenAmount(amount: string, decimals: number): string {
  if (amount.includes('.')) return amount;
  const digits = amount.replace(/^-/, '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  const sign = amount.startsWith('-') ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export async function getWalletBalance(
  client: AwsClientLike,
  context: WalletBalanceContext,
): Promise<WalletBalance> {
  const response = (await client.send(
    new GetPaymentInstrumentBalanceCommand({
      userId: context.userId,
      paymentManagerArn: context.paymentManagerArn,
      paymentConnectorId: context.paymentConnectorId,
      paymentInstrumentId: context.paymentInstrumentId,
      // 決定8: Base Sepolia + テスト USDC
      chain: 'BASE_SEPOLIA',
      token: 'USDC',
    }),
  )) as { tokenBalance?: { amount?: string; decimals?: number; token?: string } };
  const balance = response.tokenBalance;
  if (!balance?.amount || balance.decimals === undefined) {
    throw new Error('GetPaymentInstrumentBalance が残高を返しませんでした');
  }
  return {
    token: balance.token ?? 'USDC',
    amount: balance.amount,
    decimals: balance.decimals,
    display: formatTokenAmount(balance.amount, balance.decimals),
  };
}
