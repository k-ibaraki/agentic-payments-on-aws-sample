// x402 v2 のワイヤ型（@x402/core/types の PaymentRequirements / PaymentRequired /
// PaymentPayload に対応）。買い手側は署名を AgentCore Payments に委ねるため
// @x402/* の実行時依存を持たず、検証用の zod スキーマだけをここに置く（決定24・25）。
//
// スキーマは上流の緩さに合わせる: extra は上流で optional/nullable。未知のフィールドは
// 削らず通す（passthrough）。削ると売り手側の deepEqual 照合が不成立になり、
// 「支払い後にまた支払い要求が返った」という誤った診断に化けるため
import { z } from 'zod';

export const paymentRequirementsSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    asset: z.string(),
    amount: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number(),
    extra: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const paymentRequiredSchema = z
  .object({
    x402Version: z.number(),
    error: z.string().optional(),
    resource: z.unknown().optional(),
    accepts: z.array(paymentRequirementsSchema),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;

export type PaymentPayload = {
  x402Version: number;
  resource?: unknown;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

// 買い手が受け入れる支払い条件。売り手の提示を無条件に払わないための歯止め
export interface PaymentPolicy {
  /** 受け入れるネットワーク（決定8: eip155:84532 = Base Sepolia） */
  network: string;
  /** 受け入れる資産のコントラクトアドレス（テスト USDC） */
  asset: string;
  /** 1回の支払いの上限（資産の最小単位。USDC なら 6 桁） */
  maxAmount: string;
  /** 指定した場合、宛先がこれと一致しなければ支払わない */
  payTo?: string;
}

// ツール結果の _meta キー（@x402/mcp の MCP_PAYMENT_META_KEY / MCP_PAYMENT_RESPONSE_META_KEY と同値）
export const PAYMENT_META_KEY = 'x402/payment';
export const PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction?: string;
  network?: string;
};
