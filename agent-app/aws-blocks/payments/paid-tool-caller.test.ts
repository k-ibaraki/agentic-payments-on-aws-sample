// 有料 MCP ツール呼び出しのテスト（U6 回避の核心。決定25）。
// x402MCPClient のラッパを使わず素の callTool を2回叩く方式で、
// structuredContent（HTML 本体）が欠けずに届くことをここで固定する
import { describe, expect, it, vi } from 'vitest';
import { callPaidTool, PaidToolError } from './paid-tool-caller.js';

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

  // 決定60: 買い手は支払った額をどこにも残していなかった。accepted から取って結果に載せる
  it('支払った額（最小単位と資産）を結果に載せる', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(paymentRequiredResult())
      .mockResolvedValueOnce(structuredClone(PAID_RESULT));

    const outcome = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, fakePayer());

    expect(outcome.paidAmount).toEqual({ amount: REQUIREMENT.amount, asset: REQUIREMENT.asset });
  });

  it('支払いをしていない呼び出しには額を載せない', async () => {
    const free = { content: [{ type: 'text', text: 'ok' }], structuredContent: { html: '<p>a</p>' } };
    const outcome = await callPaidTool(
      { callTool: vi.fn().mockResolvedValue(free) },
      'generate-html',
      { prompt: 'x' },
      fakePayer(),
    );

    expect(outcome.paidAmount).toBeUndefined();
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

  // 決定31 ③: 署名を売り手に渡した後の失敗は、資金の移動が確認できなくても「支払い済み」として
  // 扱う。売り手は署名の有効期限内なら後から決済を確定できるため、記録を残さないと追えない
  it('再度の支払い要求も PaidToolError にし、売り手の理由（error）を文面に含める', async () => {
    const rejected = paymentRequiredResult();
    (rejected.structuredContent as Record<string, unknown>).error = 'settle failed: invalid_signature';
    const callTool = vi.fn().mockResolvedValueOnce(paymentRequiredResult()).mockResolvedValueOnce(rejected);
    const payer = {
      pay: vi.fn().mockResolvedValue({
        ...structuredClone(PAYMENT_PAYLOAD),
        payload: { signature: '0xsig', authorization: { nonce: '0xnonce2' } },
      }),
    };

    const error = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PaidToolError);
    const paid = error as PaidToolError;
    expect(paid.paymentMade).toBe(true);
    expect(paid.authorizationNonce).toBe('0xnonce2');
    expect(paid.message).toContain('settle failed: invalid_signature');
  });

  // 支払い済みの失敗こそ額を残す。利用者が減った残高の理由に辿り着けるようにする（決定60）
  it('PaidToolError にも支払った額を持たせる', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(paymentRequiredResult())
      .mockResolvedValueOnce(paymentRequiredResult());

    const error = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, fakePayer()).catch(
      (e: unknown) => e,
    );

    expect((error as PaidToolError).paidAmount).toEqual({
      amount: REQUIREMENT.amount,
      asset: REQUIREMENT.asset,
    });
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

  // ── パース失敗を「支払い要求ではない」と混同しない ─────────────────────
  it('支払い要求らしき応答（accepts あり）が解釈できなければ無言で素通りせず失敗させる', async () => {
    const malformed = {
      isError: true,
      content: [{ type: 'text', text: 'payment required' }],
      // accepts はあるが amount が無い＝壊れた支払い要求
      structuredContent: { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532' }] },
    };
    const callTool = vi.fn().mockResolvedValue(malformed);
    const payer = fakePayer();

    await expect(
      callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer),
    ).rejects.toThrow(/支払い要求を解釈できません/);
    expect(payer.pay).not.toHaveBeenCalled();
  });

  it('上流仕様どおり extra が無い支払い要求も受け付ける', async () => {
    const { extra: _omitted, ...withoutExtra } = REQUIREMENT;
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        isError: true,
        content: [],
        structuredContent: { ...PAYMENT_REQUIRED, accepts: [withoutExtra] },
      })
      .mockResolvedValueOnce(structuredClone(PAID_RESULT));
    const payer = fakePayer();

    const outcome = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer);

    expect(payer.pay).toHaveBeenCalledTimes(1);
    expect(outcome.paymentMade).toBe(true);
  });

  it('売り手が増やした未知のフィールドを削らずに支払い手へ渡す（照合不成立を防ぐ）', async () => {
    const extended = { ...REQUIREMENT, futureField: 'keep-me' };
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        isError: true,
        content: [],
        structuredContent: { ...PAYMENT_REQUIRED, accepts: [extended] },
      })
      .mockResolvedValueOnce(structuredClone(PAID_RESULT));
    const payer = fakePayer();

    await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer);

    const passed = payer.pay.mock.calls[0][0];
    expect(passed.accepts[0]).toEqual(extended);
  });
});

describe('タイムアウトと決済後の失敗（二重支払いの防止）', () => {
  it('options.timeout を両方の callTool に渡す（売り手の生成時間より短い既定 60 秒を使わない）', async () => {
    const callTool = vi.fn().mockResolvedValueOnce(paymentRequiredResult()).mockResolvedValueOnce(structuredClone(PAID_RESULT));
    await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, fakePayer(), { timeout: 600_000 });
    expect(callTool.mock.calls[0]?.[1]).toEqual({ timeout: 600_000 });
    expect(callTool.mock.calls[1]?.[1]).toEqual({ timeout: 600_000 });
  });

  it('支払い後の再呼び出しが例外になったら、支払い済みであることと支払い証明を持つ PaidToolError にする', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(paymentRequiredResult())
      .mockRejectedValueOnce(new Error('MCP error -32001: Request timed out'));
    const payer = { pay: vi.fn().mockResolvedValue({ ...structuredClone(PAYMENT_PAYLOAD), payload: { signature: '0xsig', authorization: { nonce: '0xnonce1' } } }) };

    const error = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, payer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaidToolError);
    const paid = error as PaidToolError;
    expect(paid.paymentMade).toBe(true);
    expect(paid.authorizationNonce).toBe('0xnonce1');
    expect(paid.message).toContain('Request timed out');
  });

  it('支払い前（最初の呼び出し）の例外はそのまま投げる（支払いは無い）', async () => {
    const callTool = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const error = await callPaidTool({ callTool }, 'generate-html', { prompt: 'x' }, fakePayer()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PaidToolError);
    expect((error as Error).message).toBe('ECONNREFUSED');
  });
});
