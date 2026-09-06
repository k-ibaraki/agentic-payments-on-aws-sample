// ウォレット残高の取得（決定42）のテスト。GetPaymentInstrumentBalance はモックする
import { GetPaymentInstrumentBalanceCommand } from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it, vi } from 'vitest';
import { formatTokenAmount, getWalletBalance } from './wallet-balance.js';

const CONTEXT = {
  userId: 'sample-user-1',
  paymentManagerArn:
    'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/agenticpaymentssample-xxxx',
  paymentConnectorId: 'connector-1',
  paymentInstrumentId: 'instrument-1',
};

describe('formatTokenAmount', () => {
  it('最小単位の整数を decimals 桁で割った十進表記にし、末尾の 0 は落とす', () => {
    expect(formatTokenAmount('1100000', 6)).toBe('1.1');
    expect(formatTokenAmount('1000000', 6)).toBe('1');
    expect(formatTokenAmount('5', 6)).toBe('0.000005');
    expect(formatTokenAmount('0', 6)).toBe('0');
    expect(formatTokenAmount('123', 0)).toBe('123');
  });

  it('既に小数表記で来た値はそのまま返す（API の表記が最小単位か十進かは実測で確定させる）', () => {
    expect(formatTokenAmount('1.1', 6)).toBe('1.1');
  });
});

describe('getWalletBalance', () => {
  it('Base Sepolia の USDC 残高を GetPaymentInstrumentBalance で取り、十進表記を添えて返す', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof GetPaymentInstrumentBalanceCommand)) throw new Error('想定外のコマンド');
      return {
        paymentInstrumentId: CONTEXT.paymentInstrumentId,
        tokenBalance: { amount: '1100000', decimals: 6, token: 'USDC' },
      };
    });

    const balance = await getWalletBalance({ send }, CONTEXT);

    expect(balance).toEqual({ token: 'USDC', amount: '1100000', decimals: 6, display: '1.1' });
    const input = (send.mock.calls[0]![0] as GetPaymentInstrumentBalanceCommand).input;
    expect(input).toEqual({ ...CONTEXT, chain: 'BASE_SEPOLIA', token: 'USDC' });
  });

  it('残高が返らなければ落とす', async () => {
    const send = vi.fn(async () => ({ paymentInstrumentId: CONTEXT.paymentInstrumentId }));
    await expect(getWalletBalance({ send }, CONTEXT)).rejects.toThrow(/残高/);
  });
});
