// x402 v2 のワイヤ型（@x402/core/types の PaymentRequirements / PaymentRequired /
// PaymentPayload に対応）。買い手側は署名を AgentCore Payments に委ねるため
// @x402/* の実行時依存を持たず、検証用の zod スキーマだけをここに置く（決定24・25）
import { z } from 'zod';

export const paymentRequirementsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  extra: z.record(z.string(), z.unknown()),
});

export const paymentRequiredSchema = z.object({
  x402Version: z.number(),
  error: z.string().optional(),
  resource: z.unknown().optional(),
  accepts: z.array(paymentRequirementsSchema),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;

export type PaymentPayload = {
  x402Version: number;
  resource?: unknown;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

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
