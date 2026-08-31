// AgentCore Payments（ap-southeast-1）を x402 の支払い手として使う（決定24・27）。
// 秘密鍵はローカルに存在せず、署名は ProcessPayment(CRYPTO_X402) がウォレット側で行う。
// 返り値は billing-mcp の _meta["x402/payment"] に積める PaymentPayload
import { ProcessPaymentCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { DocumentType } from '@smithy/types';
import { randomUUID } from 'node:crypto';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from './x402-types.js';

export interface X402Payer {
  pay(required: PaymentRequired): Promise<PaymentPayload>;
}

export interface AgentCorePayerContext {
  userId: string;
  paymentManagerArn: string;
  paymentSessionId: string;
  paymentInstrumentId: string;
}

// テストで差し替えられるよう、SDK クライアントは send を持つ最小の形で受ける
interface AwsClientLike {
  send(command: unknown): Promise<unknown>;
}

function isCompletePaymentPayload(value: Record<string, unknown>): boolean {
  return typeof value.x402Version === 'number' && 'accepted' in value && 'payload' in value;
}

export function createAgentCorePayer(client: AwsClientLike, context: AgentCorePayerContext): X402Payer {
  return {
    async pay(required: PaymentRequired): Promise<PaymentPayload> {
      // 売り手は exact スキーム（決定18）。他スキームの提示しか無ければ支払わない
      const accepted: PaymentRequirements | undefined = required.accepts.find(
        (a) => a.scheme === 'exact',
      );
      if (!accepted) {
        throw new Error('支払い要求に exact スキームが含まれていないため支払えません');
      }

      const response = (await client.send(
        new ProcessPaymentCommand({
          userId: context.userId,
          paymentManagerArn: context.paymentManagerArn,
          paymentSessionId: context.paymentSessionId,
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
          clientToken: randomUUID(),
        }),
      )) as {
        status?: string;
        paymentOutput?: { cryptoX402?: { version?: string; payload?: unknown } };
      };

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
