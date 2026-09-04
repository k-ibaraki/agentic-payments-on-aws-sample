// 有料 MCP ツールの呼び出し（U6 回避の核心。決定25）。
// @x402/mcp の x402MCPClient は結果の structuredContent を落とすため使わず、
// 素の callTool を「支払い要求の受領 → 支払い → 証明付きで再呼び出し」の2段で叩く
import {
  PAYMENT_META_KEY,
  PAYMENT_RESPONSE_META_KEY,
  type PaymentPayload,
  type PaymentRequired,
  paymentRequiredSchema,
  type SettleResponse,
} from './x402-types.js';
import type { X402Payer } from './x402-payer.js';

// MCP SDK の Client.callTool と互換の最小の形（テストで差し替えるため）
export interface McpClientLike {
  callTool(
    params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    options?: CallOptions,
  ): Promise<Record<string, unknown>>;
}

export interface CallOptions {
  /**
   * 応答を待つ上限（ミリ秒）。MCP SDK の既定は 60 秒で、売り手の生成（Bedrock を 570 秒で打ち切り、
   * その外側の Lambda が 600 秒）より短い。既定のまま使うと、売り手が決済済みで生成を続けている
   * 最中に買い手が諦め、成果物だけが失われる（2026-09-03 に実際に起きた二重支払いの原因）
   */
  timeout?: number;
}

/**
 * 支払いが成立した後にツール呼び出しが失敗したことを表す。
 * 呼び出し側はこれを「未払いの失敗」と区別し、レシートを残して自動再試行しないこと
 */
export class PaidToolError extends Error {
  readonly paymentMade = true as const;
  /** EIP-3009 の nonce。売り手側の清算をオンチェーンで辿る手がかり */
  readonly authorizationNonce?: string;

  constructor(message: string, readonly paymentPayload: PaymentPayload, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PaidToolError';
    const inner = paymentPayload.payload as { authorization?: { nonce?: unknown } } | undefined;
    if (typeof inner?.authorization?.nonce === 'string') {
      this.authorizationNonce = inner.authorization.nonce;
    }
  }
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
  options?: CallOptions,
): Promise<PaidToolOutcome> {
  const first = await mcp.callTool({ name, arguments: args }, options);
  const required = parsePaymentRequired(first);
  if (!required) {
    return { result: first, paymentMade: false };
  }

  const paymentPayload = await payer.pay(required);
  let second: Record<string, unknown>;
  try {
    second = await mcp.callTool(
      {
        name,
        arguments: args,
        _meta: { [PAYMENT_META_KEY]: paymentPayload },
      },
      options,
    );
  } catch (error) {
    // 支払い証明は送った後。売り手は upfront（決定21）で決済済みの可能性が高い
    const message = error instanceof Error ? error.message : String(error);
    throw new PaidToolError(`支払い後のツール呼び出しに失敗しました: ${message}`, paymentPayload, {
      cause: error,
    });
  }

  const again = parsePaymentRequired(second);
  if (again) {
    // 売り手は upfront（決定21）で決済確定に失敗すると再び 402 を返す。理由は PaymentRequired.error に載る。
    // 2026-09-04 の sandbox 実測では facilitator の settle が失敗し、オンチェーンの送金は起きなかったが、
    // 署名は売り手に渡っており PaymentSession の残枠は署名の時点で減っている（1.00 → 0.8 USD）。
    // 売り手は署名の有効期限内なら後から決済を確定できるので、「資金が動いていないから無害」とは扱わない。
    // PaidToolError にしてレシート（nonce）を残し、決定31 ③ の承認要求を働かせる
    throw new PaidToolError(
      `支払い後の再呼び出しでも支払い要求が返りました（決済が受理されていません）: ${again.error ?? '理由なし'}`,
      paymentPayload,
    );
  }

  const meta = second._meta as Record<string, unknown> | undefined;
  return {
    result: second,
    paymentMade: true,
    paymentResponse: meta?.[PAYMENT_RESPONSE_META_KEY] as SettleResponse | undefined,
  };
}
