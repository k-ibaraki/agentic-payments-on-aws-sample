// billing-mcp の有料ツール generate-html を x402 支払い付きで1回呼ぶ買い付け口。
// MCP セッションはステートレス（売り手側 決定22）なので、呼び出しごとに接続してよい
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PaidAmount } from './amount.js';
import { type CallOptions, callPaidTool, PaidToolError } from './paid-tool-caller.js';
import { UncertainPaymentError, type X402Payer } from './x402-payer.js';
import type { SettleResponse } from './x402-types.js';

export interface BuyHtmlOutcome {
  paymentMade: boolean;
  /** 支払いの成否を確認できなかった（決定48。UncertainPaymentError 参照） */
  paymentUncertain?: boolean;
  paymentResponse?: SettleResponse;
  html?: string;
  filename?: string;
  /** ツールのテキスト出力（エラーメッセージ含む） */
  message?: string;
  isError: boolean;
  /** 支払い後に応答を得られなかった場合の EIP-3009 nonce（清算をオンチェーンで辿る手がかり） */
  authorizationNonce?: string;
  /**
   * 支払った（成否不明なら支払おうとした）額（決定60）。
   * 画面・ツール要約・レシートに出す額はすべてこれが元になる
   */
  paidAmount?: PaidAmount;
}

/**
 * 金が動いた（かもしれない）失敗を、例外ではなく結果に変える。
 * 呼び出し側がレシートを残し、次の購入で人の承認を要求できるようにするため（決定31・48）。
 * 支払いに至っていない失敗は undefined を返し、そのまま投げ直させる
 */
export function outcomeFromError(error: unknown): BuyHtmlOutcome | undefined {
  if (error instanceof PaidToolError) {
    // 支払い済みで応答が無い。呼び出し側がレシートを残せるよう、失敗の結果として返す
    return {
      paymentMade: true,
      isError: true,
      message: error.message,
      ...(error.authorizationNonce ? { authorizationNonce: error.authorizationNonce } : {}),
      ...(error.paidAmount ? { paidAmount: error.paidAmount } : {}),
    };
  }
  if (error instanceof UncertainPaymentError) {
    // 支払われたかどうか分からない。paymentMade は立てず、成否不明の印だけを残す
    return {
      paymentMade: false,
      paymentUncertain: true,
      isError: true,
      message: error.message,
      ...(error.paidAmount ? { paidAmount: error.paidAmount } : {}),
    };
  }
  return undefined;
}

export function extractHtml(
  result: Record<string, unknown>,
): { html: string; filename?: string } | undefined {
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  if (!sc || typeof sc.html !== 'string') return undefined;
  return {
    html: sc.html,
    ...(typeof sc.filename === 'string' ? { filename: sc.filename } : {}),
  };
}

function firstText(result: Record<string, unknown>): string | undefined {
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  return content?.find((c) => typeof c.text === 'string')?.text;
}

export async function buyHtml(
  mcpUrl: string,
  prompt: string,
  payer: X402Payer,
  options?: CallOptions,
): Promise<BuyHtmlOutcome> {
  const client = new Client({ name: 'agent-app-buyer', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    let outcome: Awaited<ReturnType<typeof callPaidTool>>;
    try {
      outcome = await callPaidTool(
        // Client.callTool は既定で結果スキーマ検証を挟むが、素の結果（_meta 含む）を
        // そのまま扱いたいので Record として受ける
        {
          callTool: (params, callOptions) =>
            client.callTool(params, undefined, callOptions) as Promise<Record<string, unknown>>,
        },
        'generate-html',
        { prompt },
        payer,
        options,
      );
    } catch (error) {
      const failure = outcomeFromError(error);
      if (failure) return failure;
      throw error;
    }
    const artifact = extractHtml(outcome.result);
    return {
      paymentMade: outcome.paymentMade,
      ...(outcome.paymentResponse ? { paymentResponse: outcome.paymentResponse } : {}),
      ...(outcome.paidAmount ? { paidAmount: outcome.paidAmount } : {}),
      ...(artifact ?? {}),
      ...(firstText(outcome.result) !== undefined ? { message: firstText(outcome.result) } : {}),
      isError: outcome.result.isError === true,
    };
  } finally {
    await client.close();
  }
}
