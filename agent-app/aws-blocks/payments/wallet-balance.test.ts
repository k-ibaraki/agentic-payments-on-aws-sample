// ウォレット残高の取得（決定42）のテスト。GetPaymentInstrumentBalance はモックする
import { GetPaymentInstrumentBalanceCommand } from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it, vi } from 'vitest';
import { getWalletBalance } from './wallet-balance.js';

const CONTEXT = {
  userId: 'sample-user-1',
  paymentManagerArn:
    'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/agenticpaymentssample-xxxx',
  paymentConnectorId: 'connector-1',
  paymentInstrumentId: 'instrument-1',
};

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
