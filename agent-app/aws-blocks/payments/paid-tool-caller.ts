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
import type { PaidAmount } from './amount.js';
import type { X402Payer } from './x402-payer.js';
import { type PurchaseStep, sellerStep } from '../progress.js';

/** 支払い証明から、支払った額（最小単位と資産）を読む。読めなければ undefined（決定60） */
export function paidAmountOf(payload: PaymentPayload): PaidAmount | undefined {
  const { amount, asset } = payload.accepted ?? {};
  if (typeof amount !== 'string' || typeof asset !== 'string') return undefined;
  return { amount, asset };
}

// MCP SDK の Client.callTool と互換の最小の形（テストで差し替えるため）
export interface McpClientLike {
  callTool(
    params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    options?: McpCallOptions,
  ): Promise<Record<string, unknown>>;
}

/** MCP SDK の RequestOptions のうち、ここで使う部分 */
export interface McpCallOptions {
  timeout?: number;
  /** 売り手の経過（notifications/progress）を受ける。渡すと SDK が依頼に progressToken を付ける */
  onprogress?: (progress: { message?: string }) => void;
}

/** 購入の経過の受け口（決定65）。送信の成否は受け口の責任で、ここでは待たない */
export interface ProgressSink {
  report(step: PurchaseStep): void;
}

export interface CallOptions {
  /** 購入の経過を知らせる先（決定65）。省略すると売り手に経過を求めない */
  progress?: ProgressSink;
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
  /** 支払った額（決定60）。利用者が減った残高の理由に辿り着けるよう、失敗にも添える */
  readonly paidAmount?: PaidAmount;

  constructor(message: string, readonly paymentPayload: PaymentPayload, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PaidToolError';
    this.paidAmount = paidAmountOf(paymentPayload);
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
  /** 支払った額（決定60）。支払いをしていない呼び出しには付かない */
  paidAmount?: PaidAmount;
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

const TIERS = new Set(['ume', 'take', 'matsu']);

/** 見積書（売り手の決定55。`v1|価格帯|価格`）から価格帯を読む。読めなければ undefined */
function tierOfQuote(quote: unknown): 'ume' | 'take' | 'matsu' | undefined {
  if (typeof quote !== 'string') return undefined;
  const [version, tier] = quote.split('|');
  return version === 'v1' && TIERS.has(tier) ? (tier as 'ume' | 'take' | 'matsu') : undefined;
}

/** 支払い要求から、画面に出す見積もりを作る。額は最初の支払い条件のもの */
function quoteStep(required: PaymentRequired): PurchaseStep {
  const first = required.accepts[0];
  const tier = tierOfQuote(first?.extra?.quote);
  return {
    step: 'quote',
    ...(tier ? { tier } : {}),
    ...(typeof first?.amount === 'string' ? { amount: first.amount } : {}),
    ...(typeof first?.asset === 'string' ? { asset: first.asset } : {}),
  };
}

export async function callPaidTool(
  mcp: McpClientLike,
  name: string,
  args: Record<string, unknown>,
  payer: X402Payer,
  options?: CallOptions,
): Promise<PaidToolOutcome> {
  const progress = options?.progress;
  // 経過を求めるときだけ onprogress を渡す（SDK が依頼に progressToken を付け、売り手が SSE で応える）
  const mcpOptions: McpCallOptions = {
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(progress
      ? {
          onprogress: ({ message }: { message?: string }) => {
            const step = sellerStep(message);
            if (step) progress.report(step);
          },
        }
      : {}),
  };
  const callOptions = Object.keys(mcpOptions).length > 0 ? mcpOptions : undefined;

  const first = await mcp.callTool({ name, arguments: args }, callOptions);
  const required = parsePaymentRequired(first);
  if (!required) {
    return { result: first, paymentMade: false };
  }

  progress?.report(quoteStep(required));
  progress?.report({ step: 'paying' });
  const paymentPayload = await payer.pay(required);
  const signed = paidAmountOf(paymentPayload);
  progress?.report({ step: 'paid', ...(signed ?? {}) });
  let second: Record<string, unknown>;
  try {
    second = await mcp.callTool(
      {
        name,
        arguments: args,
        _meta: { [PAYMENT_META_KEY]: paymentPayload },
      },
      callOptions,
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
  const paidAmount = paidAmountOf(paymentPayload);
  const receipt = meta?.[PAYMENT_RESPONSE_META_KEY] as SettleResponse | undefined;
  if (receipt?.success) {
    progress?.report({ step: 'settled', ...(receipt.transaction ? { transaction: receipt.transaction } : {}) });
  }
  return {
    result: second,
    paymentMade: true,
    paymentResponse: receipt,
    ...(paidAmount ? { paidAmount } : {}),
  };
}
