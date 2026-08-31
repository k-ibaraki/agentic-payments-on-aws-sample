// AgentCore Payments を x402 の支払い手として使うモジュールのテスト（決定24・25）。
// ProcessPayment はモックし、支払い要求（PaymentRequired）から
// _meta["x402/payment"] に積む PaymentPayload を組み立てる責務を検証する
import { describe, expect, it, vi } from 'vitest';
import { createAgentCorePayer } from './x402-payer.js';

const REQUIREMENT = {
  scheme: 'exact',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '100000',
  payTo: '0x833E0000000000000000000000000000000AB94D',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
};

const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'mcp://billing-mcp/generate-html' },
  accepts: [REQUIREMENT],
};

const CONTEXT = {
  userId: 'sample-user-1',
  paymentManagerArn:
    'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/agenticpaymentssample-xxxx',
  paymentSessionId: 'session-1',
  paymentInstrumentId: 'instrument-1',
};

// 署名済みの内側ペイロード（ExactEvmScheme が作るものに相当）
const SIGNED = { signature: '0xsig', authorization: { from: '0xbuyer' } };

function fakeClient(paymentOutput: unknown, status = 'PROOF_GENERATED') {
  const send = vi.fn().mockResolvedValue({ status, paymentOutput });
  return { client: { send }, send };
}

describe('createAgentCorePayer', () => {
  it('accepts から exact スキームを選び ProcessPayment に渡す', async () => {
    const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT);

    await payer.pay(PAYMENT_REQUIRED);

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][0].input;
    expect(input.paymentManagerArn).toBe(CONTEXT.paymentManagerArn);
    expect(input.paymentSessionId).toBe(CONTEXT.paymentSessionId);
    expect(input.paymentInstrumentId).toBe(CONTEXT.paymentInstrumentId);
    expect(input.userId).toBe(CONTEXT.userId);
    expect(input.paymentType).toBe('CRYPTO_X402');
    expect(input.paymentInput.cryptoX402.version).toBe('2');
    expect(input.paymentInput.cryptoX402.payload).toEqual(REQUIREMENT);
  });

  it('出力が内側ペイロードだけの場合、PaymentPayload に包んで返す', async () => {
    const { client } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT);

    const payload = await payer.pay(PAYMENT_REQUIRED);

    expect(payload).toEqual({
      x402Version: 2,
      resource: PAYMENT_REQUIRED.resource,
      accepted: REQUIREMENT,
      payload: SIGNED,
    });
  });

  it('出力が完全な PaymentPayload の場合、そのまま返す', async () => {
    const complete = {
      x402Version: 2,
      accepted: REQUIREMENT,
      payload: SIGNED,
    };
    const { client } = fakeClient({ cryptoX402: { version: '2', payload: complete } });
    const payer = createAgentCorePayer(client, CONTEXT);

    const payload = await payer.pay(PAYMENT_REQUIRED);

    expect(payload).toEqual(complete);
  });

  it('exact スキームが accepts に無ければ支払いを拒む', async () => {
    const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT);

    await expect(
      payer.pay({ ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENT, scheme: 'upto' }] }),
    ).rejects.toThrow(/exact/);
    expect(send).not.toHaveBeenCalled();
  });

  it('ProcessPayment が支払い証明を返さなければ失敗させる', async () => {
    const { client } = fakeClient(undefined, 'PROOF_GENERATED');
    const payer = createAgentCorePayer(client, CONTEXT);

    await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toThrow(/支払い証明/);
  });
});
