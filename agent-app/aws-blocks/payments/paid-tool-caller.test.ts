// 有料 MCP ツール呼び出しのテスト（U6 回避の核心。決定25）。
// x402MCPClient のラッパを使わず素の callTool を2回叩く方式で、
// structuredContent（HTML 本体）が欠けずに届くことをここで固定する
import { describe, expect, it, vi } from 'vitest';
import { callPaidTool } from './paid-tool-caller.js';

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

const PAYMENT_PAYLOAD = {
  x402Version: 2,
  accepted: REQUIREMENT,
  payload: { signature: '0xsig' },
};

const PAID_RESULT = {
  content: [{ type: 'text', text: 'HTML を生成しました' }],
  structuredContent: { html: '<html><body>成果物</body></html>' },
  _meta: {
    'x402/payment-response': {
      success: true,
      transaction: '0xtx',
      network: 'eip155:84532',
    },
  },
};

function paymentRequiredResult() {
  return {
    isError: true,
    content: [{ type: 'text', text: 'payment required' }],
    structuredContent: structuredClone(PAYMENT_REQUIRED),
  };
}

function fakePayer() {
  return { pay: vi.fn().mockResolvedValue(structuredClone(PAYMENT_PAYLOAD)) };
}

describe('callPaidTool', () => {
  it('支払い要求が無ければ1回で返し、支払いはしない', async () => {
    const free = { content: [{ type: 'text', text: 'ok' }], structuredContent: { html: '<p>a</p>' } };
    const callTool = vi.fn().mockResolvedValue(free);
    const payer = fakePayer();

    const outcome = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer);

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(payer.pay).not.toHaveBeenCalled();
    expect(outcome.paymentMade).toBe(false);
    expect(outcome.result).toBe(free);
  });

  it('支払い要求なら支払って再呼び出し、structuredContent を欠かさず返す', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(paymentRequiredResult())
      .mockResolvedValueOnce(structuredClone(PAID_RESULT));
    const payer = fakePayer();

    const outcome = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer);

    expect(payer.pay).toHaveBeenCalledWith(PAYMENT_REQUIRED);
    expect(callTool).toHaveBeenCalledTimes(2);
    // 2回目の呼び出しに支払い証明が積まれている
    const second = callTool.mock.calls[1][0];
    expect(second.name).toBe('generate-html');
    expect(second.arguments).toEqual({ prompt: 'x' });
    expect(second._meta['x402/payment']).toEqual(PAYMENT_PAYLOAD);
    // U6 の回避が効いているか（HTML 本体がそのまま残る）
    expect(outcome.result.structuredContent).toEqual(PAID_RESULT.structuredContent);
    expect(outcome.paymentMade).toBe(true);
    expect(outcome.paymentResponse).toEqual(PAID_RESULT._meta['x402/payment-response']);
  });

  it('支払い後にまた支払い要求が返ったら失敗させる（無限ループ防止）', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(paymentRequiredResult())
      .mockResolvedValueOnce(paymentRequiredResult());
    const payer = fakePayer();

    await expect(
      callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer),
    ).rejects.toThrow(/支払い後/);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('支払い要求でない isError はそのまま返す（支払いはしない）', async () => {
    const failure = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    const callTool = vi.fn().mockResolvedValue(failure);
    const payer = fakePayer();

    const outcome = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer);

    expect(payer.pay).not.toHaveBeenCalled();
    expect(outcome.result).toBe(failure);
    expect(outcome.paymentMade).toBe(false);
  });
});
