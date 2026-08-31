// billing-mcp の有料ツール generate-html を x402 支払い付きで1回呼ぶ買い付け口。
// MCP セッションはステートレス（売り手側 決定22）なので、呼び出しごとに接続してよい
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callPaidTool } from './paid-tool-caller.js';
import type { X402Payer } from './x402-payer.js';
import type { SettleResponse } from './x402-types.js';

export interface BuyHtmlOutcome {
  paymentMade: boolean;
  paymentResponse?: SettleResponse;
  html?: string;
  filename?: string;
  /** ツールのテキスト出力（エラーメッセージ含む） */
  message?: string;
  isError: boolean;
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
): Promise<BuyHtmlOutcome> {
  const client = new Client({ name: 'agent-app-buyer', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  try {
    const outcome = await callPaidTool(
      // Client.callTool は既定で結果スキーマ検証を挟むが、素の結果（_meta 含む）を
      // そのまま扱いたいので Record として受ける
      { callTool: (params) => client.callTool(params) as Promise<Record<string, unknown>> },
      'generate-html',
      { prompt },
      payer,
    );
    const artifact = extractHtml(outcome.result);
    return {
      paymentMade: outcome.paymentMade,
      ...(outcome.paymentResponse ? { paymentResponse: outcome.paymentResponse } : {}),
      ...(artifact ?? {}),
      ...(firstText(outcome.result) !== undefined ? { message: firstText(outcome.result) } : {}),
      isError: outcome.result.isError === true,
    };
  } finally {
    await client.close();
  }
}
