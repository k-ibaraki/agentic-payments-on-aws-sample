// AgentCore Payments（ap-southeast-1）を x402 の支払い手として使う（決定24・27）。
// 秘密鍵はローカルに存在せず、署名は ProcessPayment(CRYPTO_X402) がウォレット側で行う。
// 返り値は billing-mcp の _meta["x402/payment"] に積める PaymentPayload。
//
// 売り手の提示（accepts）は外部入力なので、支払いポリシー（ネットワーク・資産・上限・宛先）に
// 合致する条件だけを受け入れる。合致しなければ署名を求めずに失敗させる
import { ProcessPaymentCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { DocumentType } from '@smithy/types';
import { randomUUID } from 'node:crypto';
import { isSessionRejection, type PaymentSessionSource } from './payment-session.js';
import type {
  PaymentPayload,
  PaymentPolicy,
  PaymentRequired,
  PaymentRequirements,
} from './x402-types.js';

export interface X402Payer {
  pay(required: PaymentRequired): Promise<PaymentPayload>;
}

export interface AgentCorePayerContext {
  userId: string;
  paymentManagerArn: string;
  /** 有効な PaymentSession の供給元（決定35）。拒否されたら一度だけ renew して再試行する */
  paymentSession: PaymentSessionSource;
  paymentInstrumentId: string;
  /**
   * 購入単位の冪等キー（決定30）。指定すると ProcessPayment の clientToken にそのまま使う。
   * 購入物の resultId と同じ値にして、Payments 側の記録から購入物へ辿れるようにする
   */
  purchaseId?: string;
}

// テストで差し替えられるよう、SDK クライアントは send を持つ最小の形で受ける
interface AwsClientLike {
  send(command: unknown): Promise<unknown>;
}

function isCompletePaymentPayload(value: Record<string, unknown>): boolean {
  return typeof value.x402Version === 'number' && 'accepted' in value && 'payload' in value;
}

// EVM アドレスは大文字小文字の違い（チェックサム表記）を同一視する
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ポリシーに合う条件を選ぶ。合わない理由は最初に見つかった不一致で報告する
function selectAcceptable(
  accepts: PaymentRequirements[],
  policy: PaymentPolicy,
): { accepted: PaymentRequirements } | { reason: string } {
  const exact = accepts.filter((a) => a.scheme === 'exact');
  if (exact.length === 0) {
    return { reason: '支払い要求に exact スキームが含まれていないため支払えません' };
  }
  let reason = '';
  for (const a of exact) {
    if (a.network !== policy.network) {
      reason ||= `ネットワークが受け入れ条件と異なります（提示 ${a.network} / 許可 ${policy.network}）`;
      continue;
    }
    if (!sameAddress(a.asset, policy.asset)) {
      reason ||= `資産が受け入れ条件と異なります（提示 ${a.asset} / 許可 ${policy.asset}）`;
      continue;
    }
    if (policy.payTo && !sameAddress(a.payTo, policy.payTo)) {
      reason ||= `宛先が受け入れ条件と異なります（提示 ${a.payTo} / 許可 ${policy.payTo}）`;
      continue;
    }
    if (BigInt(a.amount) > BigInt(policy.maxAmount)) {
      reason ||= `金額が1回あたりの上限を超えています（提示 ${a.amount} / 上限 ${policy.maxAmount}）`;
      continue;
    }
    return { accepted: a };
  }
  return { reason };
}

export function createAgentCorePayer(
  client: AwsClientLike,
  context: AgentCorePayerContext,
  policy: PaymentPolicy,
): X402Payer {
  return {
    async pay(required: PaymentRequired): Promise<PaymentPayload> {
      const selection = selectAcceptable(required.accepts, policy);
      if ('reason' in selection) {
        throw new Error(selection.reason);
      }
      const { accepted } = selection;

      // 冪等キーは再試行でも同じ値にする（同じ購入の二重処理を Payments 側でも防ぐ）
      const clientToken = context.purchaseId ?? randomUUID();
      const process = (paymentSessionId: string) =>
        client.send(
          new ProcessPaymentCommand({
            userId: context.userId,
            paymentManagerArn: context.paymentManagerArn,
            paymentSessionId,
            paymentInstrumentId: context.paymentInstrumentId,
            paymentType: 'CRYPTO_X402',
            paymentInput: {
              cryptoX402: {
                version: String(required.x402Version),
                // ProcessPayment には「受諾した支払い条件」を渡すと、署名済みの支払い証明が返る。
                // zod 由来の Record<string, unknown> は SDK の DocumentType と構造互換だが
                // 型上は合わないためキャストする（JSON 化可能な値のみ）
                payload: accepted as DocumentType,
              },
            },
            clientToken,
          }),
        ) as Promise<{
          status?: string;
          paymentOutput?: { cryptoX402?: { version?: string; payload?: unknown } };
        }>;

      let response: Awaited<ReturnType<typeof process>>;
      try {
        response = await process(await context.paymentSession.acquire());
      } catch (error) {
        // セッションの失効・上限超過なら作り直して一度だけ再試行する。ProcessPayment の失敗は
        // 署名前なので、再試行しても支払いが二重になることはない（決定35）
        if (!isSessionRejection(error)) throw error;
        console.warn(
          `[x402-payer] PaymentSession が拒否されたため作り直します: ${(error as Error).name}: ${(error as Error).message}`,
        );
        response = await process(await context.paymentSession.renew());
      }

      const output = response.paymentOutput?.cryptoX402;
      if (!output?.payload || typeof output.payload !== 'object') {
        throw new Error(
          `ProcessPayment が支払い証明を返しませんでした（status: ${response.status ?? '不明'}）`,
        );
      }

      const payload = output.payload as Record<string, unknown>;
      // 実装により出力が「完全な PaymentPayload」か「内側の署名ペイロードのみ」の
      // どちらでも来られるよう、形を見て包み直す
      if (isCompletePaymentPayload(payload)) {
        return payload as PaymentPayload;
      }
      return {
        x402Version: required.x402Version,
        ...(required.resource !== undefined ? { resource: required.resource } : {}),
        accepted,
        payload,
      };
    },
  };
}
