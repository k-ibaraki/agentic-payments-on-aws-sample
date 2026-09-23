// 有料ツール結果から HTML 成果物を取り出す部分のテスト。
// billing-mcp は structuredContent: { html, filename } を返す（売り手実装と同形）
import { describe, expect, it } from 'vitest';
import { extractHtml, outcomeFromError } from './buy-html.js';
import { PaidToolError } from './paid-tool-caller.js';
import { UncertainPaymentError } from './x402-payer.js';

describe('extractHtml', () => {
  it('structuredContent から html と filename を取り出す', () => {
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { html: '<html><body>成果物</body></html>', filename: 'generated.html' },
    };
    expect(extractHtml(result)).toEqual({
      html: '<html><body>成果物</body></html>',
      filename: 'generated.html',
    });
  });

  it('structuredContent が無ければ undefined（U6 が再発したら検知できる）', () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    expect(extractHtml(result)).toBeUndefined();
  });

  it('html が文字列でなければ undefined', () => {
    const result = { structuredContent: { html: 42 } };
    expect(extractHtml(result)).toBeUndefined();
  });
});

// 金が動いた（かもしれない）失敗は例外のまま投げず結果として返す。
// 呼び出し側（buyer-agent）がレシートを残し、次の購入で人の承認を要求するため
describe('outcomeFromError', () => {
  const payload = {
    x402Version: 2,
    accepted: { scheme: 'exact' },
    payload: { authorization: { nonce: '0xnonce' } },
  } as never;

  it('支払い後の失敗（決定31）は支払い済みの結果にする', () => {
    const error = new PaidToolError('支払い後のツール呼び出しに失敗しました', payload);
    expect(outcomeFromError(error)).toEqual({
      paymentMade: true,
      isError: true,
      message: '支払い後のツール呼び出しに失敗しました',
      authorizationNonce: '0xnonce',
    });
  });

  // 決定48: 支払われたかどうか分からない。paymentMade は立てず、別の印で残す
  it('成否不明の失敗（決定48）は paymentUncertain の結果にする', () => {
    const error = new UncertainPaymentError('ProcessPayment の結果を確認できませんでした', 'result-1');
    expect(outcomeFromError(error)).toEqual({
      paymentMade: false,
      paymentUncertain: true,
      isError: true,
      message: 'ProcessPayment の結果を確認できませんでした',
    });
  });

  // 支払いに至っていない失敗（ポリシー不一致・売り手に繋がらない等）は結果にせず投げ直させる
  it('それ以外の失敗は結果にしない', () => {
    expect(outcomeFromError(new Error('売り手に接続できません'))).toBeUndefined();
  });
});

// 決定60: 支払った額を失敗の結果にも載せる。画面とレシートに額を出すのはこの値が元になる
describe('outcomeFromError（支払った額）', () => {
  const PAID_AMOUNT = { amount: '150000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

  it('支払い済みの失敗は支払った額を伴う', () => {
    const error = new PaidToolError('支払い後のツール呼び出しに失敗しました', {
      x402Version: 2,
      accepted: { ...PAID_AMOUNT, scheme: 'exact' },
      payload: {},
    } as never);
    expect(outcomeFromError(error)?.paidAmount).toEqual(PAID_AMOUNT);
  });

  it('成否不明の失敗も、支払おうとした額を伴う（減っているかもしれない額として見せる）', () => {
    const error = new UncertainPaymentError('確認できませんでした', 'result-1', {
      paidAmount: PAID_AMOUNT,
    });
    expect(outcomeFromError(error)?.paidAmount).toEqual(PAID_AMOUNT);
  });

  it('額が読み取れない支払い証明では額を載せない', () => {
    const error = new PaidToolError('失敗', {
      x402Version: 2,
      accepted: { scheme: 'exact' },
      payload: {},
    } as never);
    expect(outcomeFromError(error)?.paidAmount).toBeUndefined();
  });
});
