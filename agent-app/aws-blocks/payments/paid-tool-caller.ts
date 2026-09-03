// 有料 MCP ツールの呼び出し（U6 回避の核心。決定25）。
// @x402/mcp の x402MCPClient は結果の structuredContent を落とすため使わず、
// 素の callTool を「支払い要求の受領 → 支払い → 証明付きで再呼び出し」の2段で叩く
import {
  PAYMENT_META_KEY,
  PAYMENT_RESPONSE_META_KEY,
  type PaymentRequired,
  paymentRequiredSchema,
  type SettleResponse,
} from './x402-types.js';
import type { X402Payer } from './x402-payer.js';

// MCP SDK の Client.callTool と互換の最小の形（テストで差し替えるため）
export interface McpClientLike {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export interface PaidToolOutcome {
  /** ツールの最終結果。structuredContent を含め一切加工しない */
  result: Record<string, unknown>;
  paymentMade: boolean;
  paymentResponse?: SettleResponse;
}

// 支払い要求かどうかを判定する。「支払い要求らしいのに解釈できない」は
// 「支払い要求ではない」と区別して例外にする。混同すると 402 を受けても支払わずに
// 素通りし、購入が無言で失敗するため
function parsePaymentRequired(result: Record<string, unknown>): PaymentRequired | undefined {
  if (!result.isError || !result.structuredContent) return undefined;
  const parsed = paymentRequiredSchema.safeParse(result.structuredContent);
  if (parsed.success) return parsed.data;
  const looksLikePaymentRequired =
    typeof result.structuredContent === 'object' && 'accepts' in result.structuredContent;
  if (looksLikePaymentRequired) {
    throw new Error(`支払い要求を解釈できません: ${parsed.error.message}`);
  }
  return undefined;
}

export async function callPaidTool(
  mcp: McpClientLike,
  name: string,
  args: Record<string, unknown>,
  payer: X402Payer,
): Promise<PaidToolOutcome> {
  const first = await mcp.callTool({ name, arguments: args });
  const required = parsePaymentRequired(first);
  if (!required) {
    return { result: first, paymentMade: false };
  }

  const paymentPayload = await payer.pay(required);
  const second = await mcp.callTool({
    name,
    arguments: args,
    _meta: { [PAYMENT_META_KEY]: paymentPayload },
  });

  if (parsePaymentRequired(second)) {
    throw new Error('支払い後の再呼び出しでも支払い要求が返りました（決済が受理されていません）');
  }

  const meta = second._meta as Record<string, unknown> | undefined;
  return {
    result: second,
    paymentMade: true,
    paymentResponse: meta?.[PAYMENT_RESPONSE_META_KEY] as SettleResponse | undefined,
  };
}
