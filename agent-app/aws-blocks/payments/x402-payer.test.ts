// AgentCore Payments を x402 の支払い手として使うモジュールのテスト（決定24・25）。
// ProcessPayment はモックし、支払い要求（PaymentRequired）から
// _meta["x402/payment"] に積む PaymentPayload を組み立てる責務と、
// 「提示された条件を無条件に払わない」ための支払いポリシーの検証を固定する
import { describe, expect, it, vi } from 'vitest';
import { fixedPaymentSession } from './payment-session.js';
import { createAgentCorePayer, UncertainPaymentError } from './x402-payer.js';

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
  paymentSession: fixedPaymentSession('session-1'),
  paymentInstrumentId: 'instrument-1',
};

// 買い手が受け入れる条件（決定8: Base Sepolia + テスト USDC、決定18: 1回 0.1 USDC）
const POLICY = {
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  maxAmount: '100000',
};

// 署名済みの内側ペイロード（ExactEvmScheme が作るものに相当）
const SIGNED = { signature: '0xsig', authorization: { from: '0xbuyer' } };

function fakeClient(paymentOutput: unknown, status = 'PROOF_GENERATED') {
  const send = vi.fn().mockResolvedValue({ status, paymentOutput });
  return { client: { send }, send };
}

// AWS SDK のサービス例外に相当する形。4xx（$fault: client）はサービスが入力を拒んだ＝
// 支払いは処理されていない。5xx や $metadata の無い失敗（タイムアウト・接続断）は、
// AgentCore 側で支払いが進んでいた可能性を否定できない（決定48）
const named = (name: string, message: string, httpStatusCode = 400) =>
  Object.assign(new Error(message), {
    name,
    $fault: httpStatusCode >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode },
  });

/** クライアント側で起きた失敗（タイムアウト・接続断）。$metadata を持たない */
const clientSideFailure = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

describe('createAgentCorePayer', () => {
  it('accepts から exact スキームを選び ProcessPayment に渡す', async () => {
    const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT, POLICY);

    await payer.pay(PAYMENT_REQUIRED);

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][0].input;
    expect(input.paymentManagerArn).toBe(CONTEXT.paymentManagerArn);
    expect(input.paymentSessionId).toBe('session-1');
    expect(input.paymentInstrumentId).toBe(CONTEXT.paymentInstrumentId);
    expect(input.userId).toBe(CONTEXT.userId);
    expect(input.paymentType).toBe('CRYPTO_X402');
    expect(input.paymentInput.cryptoX402.version).toBe('2');
    expect(input.paymentInput.cryptoX402.payload).toEqual(REQUIREMENT);
  });

  it('出力が内側ペイロードだけの場合、PaymentPayload に包んで返す', async () => {
    const { client } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT, POLICY);

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
    const payer = createAgentCorePayer(client, CONTEXT, POLICY);

    const payload = await payer.pay(PAYMENT_REQUIRED);

    expect(payload).toEqual(complete);
  });

  it('exact スキームが accepts に無ければ支払いを拒む', async () => {
    const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT, POLICY);

    await expect(
      payer.pay({ ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENT, scheme: 'upto' }] }),
    ).rejects.toThrow(/exact/);
    expect(send).not.toHaveBeenCalled();
  });

  // 呼び出しそのものは成功している以上、支払いが立っている可能性を否定できない（決定48）
  it('ProcessPayment が支払い証明を返さなければ、成否不明として失敗させる', async () => {
    const { client } = fakeClient(undefined, 'PROOF_GENERATED');
    const payer = createAgentCorePayer(client, CONTEXT, POLICY);

    await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toThrow(/支払い証明/);
    await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toBeInstanceOf(UncertainPaymentError);
  });

  // ── 支払いポリシー（売り手の提示を無条件に払わない）──────────────────
  describe('セッションの作り直し（決定35）', () => {
    const sessionSource = () => ({
      acquire: vi.fn().mockResolvedValue('session-old'),
      renew: vi.fn().mockResolvedValue('session-new'),
    });

    it('ProcessPayment がセッション起因で拒否したら、一度だけ作り直して再試行する', async () => {
      const send = vi
        .fn()
        .mockRejectedValueOnce(named('ResourceNotFoundException', 'session not found'))
        .mockResolvedValueOnce({ paymentOutput: { cryptoX402: { version: '2', payload: SIGNED } } });
      const session = sessionSource();
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, paymentSession: session }, POLICY);

      const payload = await payer.pay(PAYMENT_REQUIRED);

      expect(payload.payload).toEqual(SIGNED);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][0].input.paymentSessionId).toBe('session-old');
      expect(send.mock.calls[1][0].input.paymentSessionId).toBe('session-new');
      expect(session.renew).toHaveBeenCalledTimes(1);
      // 拒否された ID を渡す。別の購入が既に作り直していればそれに乗るため（決定35 追記）
      expect(session.renew).toHaveBeenCalledWith('session-old');
    });

    // 決定37: 上限超過で作り直すと、上限に当たった支払いがその場で通り、上限が上限でなくなる
    it('支出上限の超過では作り直さず、上限に当たったことを伝えて失敗する', async () => {
      const send = vi.fn().mockRejectedValue(named('ConflictException', 'Session limit exceeded'));
      const session = sessionSource();
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, paymentSession: session }, POLICY);

      await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toThrow(/支出上限/);
      expect(send).toHaveBeenCalledTimes(1);
      expect(session.renew).not.toHaveBeenCalled();
    });

    it('作り直した後も拒否されたら、それ以上は再試行せず失敗にする', async () => {
      const send = vi
        .fn()
        .mockRejectedValueOnce(named('ResourceNotFoundException', 'session not found'))
        .mockRejectedValueOnce(named('ValidationException', 'Payment session not found: session-new'));
      const session = sessionSource();
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, paymentSession: session }, POLICY);

      await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toThrow(/Payment session not found/);
      expect(send).toHaveBeenCalledTimes(2);
      expect(session.renew).toHaveBeenCalledTimes(1);
    });

    it('セッション以外の失敗（権限など）は作り直さない', async () => {
      const send = vi.fn().mockRejectedValue(named('AccessDeniedException', 'not authorized', 403));
      const session = sessionSource();
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, paymentSession: session }, POLICY);

      await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toThrow(/not authorized/);
      expect(send).toHaveBeenCalledTimes(1);
      expect(session.renew).not.toHaveBeenCalled();
    });
  });

  // 決定48: ProcessPayment の失敗のうち「支払いが立っていないと言い切れない」ものを
  // 区別する。言い切れるのはサービスが 4xx で拒んだ場合だけで、タイムアウト・接続断・5xx は
  // AgentCore 側で支払いが進んでいた可能性が残る。ここを普通の失敗として扱うと、
  // 記録も承認要求も無いまま LLM が別の resultId（＝別の冪等キー）で買い直し、二重に払う
  describe('支払いの成否が確認できない失敗（決定48）', () => {
    const sessionSource = () => ({
      acquire: vi.fn().mockResolvedValue('session-old'),
      renew: vi.fn().mockResolvedValue('session-new'),
    });

    it('タイムアウトは成否不明として扱う', async () => {
      const send = vi.fn().mockRejectedValue(clientSideFailure('TimeoutError', 'socket timed out'));
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, purchaseId: 'result-1' }, POLICY);

      const error = await payer.pay(PAYMENT_REQUIRED).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UncertainPaymentError);
      expect((error as UncertainPaymentError).paymentUncertain).toBe(true);
      // 冪等キー（= 購入の resultId）を持たせ、Payments 側の記録と突き合わせられるようにする
      expect((error as UncertainPaymentError).clientToken).toBe('result-1');
      expect((error as UncertainPaymentError).message).toMatch(/socket timed out/);
    });

    it('サーバー側の失敗（5xx）も成否不明として扱う', async () => {
      const send = vi.fn().mockRejectedValue(named('InternalServerException', 'internal error', 500));
      const payer = createAgentCorePayer({ send }, CONTEXT, POLICY);

      await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toBeInstanceOf(UncertainPaymentError);
    });

    it('サービスが 4xx で拒んだ失敗は成否不明にしない（支払いは立っていない）', async () => {
      const send = vi.fn().mockRejectedValue(named('AccessDeniedException', 'not authorized', 403));
      const payer = createAgentCorePayer({ send }, CONTEXT, POLICY);

      const error = await payer.pay(PAYMENT_REQUIRED).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(UncertainPaymentError);
      expect((error as Error).message).toMatch(/not authorized/);
    });

    it('支出上限の超過は成否不明にしない', async () => {
      const send = vi.fn().mockRejectedValue(named('ConflictException', 'Session limit exceeded', 409));
      const payer = createAgentCorePayer({ send }, CONTEXT, POLICY);

      const error = await payer.pay(PAYMENT_REQUIRED).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(UncertainPaymentError);
      expect((error as Error).message).toMatch(/支出上限/);
    });

    // 作り直した後の呼び出しは try/catch の外にあり、同じ穴が開いていた
    it('作り直した後のタイムアウトも成否不明として扱う', async () => {
      const send = vi
        .fn()
        .mockRejectedValueOnce(named('ResourceNotFoundException', 'session not found', 404))
        .mockRejectedValueOnce(clientSideFailure('TimeoutError', 'socket timed out'));
      const session = sessionSource();
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, paymentSession: session }, POLICY);

      await expect(payer.pay(PAYMENT_REQUIRED)).rejects.toBeInstanceOf(UncertainPaymentError);
      expect(send).toHaveBeenCalledTimes(2);
    });

    // セッションを切れなかっただけなら、まだ ProcessPayment を呼んでいない
    it('セッションの作成に失敗しただけなら成否不明にしない', async () => {
      const send = vi.fn().mockRejectedValue(named('ResourceNotFoundException', 'session not found', 404));
      const session = {
        acquire: vi.fn().mockResolvedValue('session-old'),
        renew: vi.fn().mockRejectedValue(clientSideFailure('TimeoutError', 'create timed out')),
      };
      const payer = createAgentCorePayer({ send }, { ...CONTEXT, paymentSession: session }, POLICY);

      const error = await payer.pay(PAYMENT_REQUIRED).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(UncertainPaymentError);
      expect((error as Error).message).toMatch(/create timed out/);
    });

    it('支払い要求がポリシーに合わない場合は成否不明にしない（呼ぶ前に止まる）', async () => {
      const send = vi.fn();
      const payer = createAgentCorePayer({ send }, CONTEXT, POLICY);

      const error = await payer
        .pay({ ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENT, network: 'eip155:8453' }] })
        .catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(UncertainPaymentError);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('支払いポリシー', () => {
    it('ネットワークが違えば支払わない（メインネットへの誘導を防ぐ）', async () => {
      const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
      const payer = createAgentCorePayer(client, CONTEXT, POLICY);

      await expect(
        payer.pay({ ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENT, network: 'eip155:8453' }] }),
      ).rejects.toThrow(/ネットワーク/);
      expect(send).not.toHaveBeenCalled();
    });

    it('資産（トークン）が違えば支払わない', async () => {
      const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
      const payer = createAgentCorePayer(client, CONTEXT, POLICY);

      await expect(
        payer.pay({
          ...PAYMENT_REQUIRED,
          accepts: [{ ...REQUIREMENT, asset: '0x1111111111111111111111111111111111111111' }],
        }),
      ).rejects.toThrow(/資産/);
      expect(send).not.toHaveBeenCalled();
    });

    it('金額が上限を超えていれば支払わない', async () => {
      const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
      const payer = createAgentCorePayer(client, CONTEXT, POLICY);

      await expect(
        payer.pay({ ...PAYMENT_REQUIRED, accepts: [{ ...REQUIREMENT, amount: '100001' }] }),
      ).rejects.toThrow(/上限/);
      expect(send).not.toHaveBeenCalled();
    });

    it('payTo を指定した場合、宛先が違えば支払わない', async () => {
      const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
      const payer = createAgentCorePayer(client, CONTEXT, {
        ...POLICY,
        payTo: '0x833E0000000000000000000000000000000AB94D',
      });

      await expect(
        payer.pay({
          ...PAYMENT_REQUIRED,
          accepts: [{ ...REQUIREMENT, payTo: '0xAttacker000000000000000000000000000000000' }],
        }),
      ).rejects.toThrow(/宛先/);
      expect(send).not.toHaveBeenCalled();
    });

    it('アドレスの大文字小文字は同一視する', async () => {
      const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
      const payer = createAgentCorePayer(client, CONTEXT, {
        ...POLICY,
        asset: POLICY.asset.toLowerCase(),
      });

      await payer.pay(PAYMENT_REQUIRED);

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('条件に合う要素が複数候補の中にあればそれを選ぶ', async () => {
      const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
      const payer = createAgentCorePayer(client, CONTEXT, POLICY);

      await payer.pay({
        ...PAYMENT_REQUIRED,
        accepts: [{ ...REQUIREMENT, network: 'eip155:8453' }, REQUIREMENT],
      });

      expect(send.mock.calls[0][0].input.paymentInput.cryptoX402.payload).toEqual(REQUIREMENT);
    });
  });
});

describe('購入単位の冪等キー（決定30）', () => {
  it('purchaseId を渡すと ProcessPayment の clientToken にそのまま使う', async () => {
    const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, { ...CONTEXT, purchaseId: 'result-123' }, POLICY);
    await payer.pay(PAYMENT_REQUIRED);
    const command = send.mock.calls[0]?.[0] as { input: { clientToken: string } };
    expect(command.input.clientToken).toBe('result-123');
  });

  it('purchaseId が無ければ呼び出しごとに一意なトークンを採番する', async () => {
    const { client, send } = fakeClient({ cryptoX402: { version: '2', payload: SIGNED } });
    const payer = createAgentCorePayer(client, CONTEXT, POLICY);
    await payer.pay(PAYMENT_REQUIRED);
    await payer.pay(PAYMENT_REQUIRED);
    const tokens = send.mock.calls.map((c) => (c[0] as { input: { clientToken: string } }).input.clientToken);
    expect(tokens[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});
