// PaymentSession をアプリ側で作って使い回す（決定35）。
// セッションは AgentCore Payments の時限・支出上限つきの枠で、60 分ほどで失効する。
// 手渡しの PAYMENT_SESSION_ID に頼らず、有効なものが無ければツールハンドラがここで切る。
// 保存先は KVStore（ウォレットの持ち主 ID をキーにアプリ全体で 1 つ）。
import { CreatePaymentSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

export interface PaymentSessionRecord {
  paymentSessionId: string;
  /** ミリ秒（Date.now() 基準） */
  createdAt: number;
  expiresAt: number;
}

/** KVStore の必要最小限。テストではメモリ実装で代える */
export interface PaymentSessionStore {
  get(key: string): Promise<PaymentSessionRecord | null>;
  put(key: string, value: PaymentSessionRecord, options?: { expiresAt: Date }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PaymentSessionConfig {
  /** ウォレット（PaymentInstrument）の持ち主 ID。保存のキーにも使う */
  userId: string;
  paymentManagerArn: string;
  expiryMinutes: number;
  /** セッションあたりの支出上限（USD。"1.00" のような文字列） */
  maxSpendUsd: string;
}

/** 支払い手が使う。acquire で有効な ID を得て、拒否されたら renew で作り直す */
export interface PaymentSessionSource {
  acquire(): Promise<string>;
  renew(): Promise<string>;
}

interface AwsClientLike {
  send(command: unknown): Promise<unknown>;
}

/** 期限のこれだけ手前からは使わない（署名から決済までの間に失効させないため） */
const SAFETY_MARGIN_MS = 60_000;

export function paymentSessionSource(
  client: AwsClientLike,
  store: PaymentSessionStore,
  config: PaymentSessionConfig,
  now: () => number = Date.now,
): PaymentSessionSource {
  async function create(): Promise<string> {
    const createdAt = now();
    const response = (await client.send(
      new CreatePaymentSessionCommand({
        userId: config.userId,
        paymentManagerArn: config.paymentManagerArn,
        expiryTimeInMinutes: config.expiryMinutes,
        limits: { maxSpendAmount: { value: config.maxSpendUsd, currency: 'USD' } },
        clientToken: randomUUID(),
      }),
    )) as { paymentSession?: { paymentSessionId?: string } };
    const paymentSessionId = response.paymentSession?.paymentSessionId;
    if (!paymentSessionId) {
      throw new Error('CreatePaymentSession がセッション ID を返しませんでした');
    }
    const expiresAt = createdAt + config.expiryMinutes * 60_000;
    await store.put(
      config.userId,
      { paymentSessionId, createdAt, expiresAt },
      { expiresAt: new Date(expiresAt) },
    );
    console.log(
      `[payment-session] PaymentSession を作成 id=${paymentSessionId} 期限=${new Date(expiresAt).toISOString()} 上限=${config.maxSpendUsd} USD`,
    );
    return paymentSessionId;
  }

  return {
    async acquire() {
      const saved = await store.get(config.userId);
      if (saved && saved.expiresAt - SAFETY_MARGIN_MS > now()) {
        return saved.paymentSessionId;
      }
      return create();
    },
    async renew() {
      await store.delete(config.userId);
      return create();
    },
  };
}

/**
 * ProcessPayment の失敗がセッション起因（失効・上限超過・削除済み）かどうか。
 * SDK の型から推定した判定で、sandbox の実測で確定させる（決定35）。
 * 判定に漏れても支払いが失敗するだけで、二重に払うことはない
 */
export function isSessionRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ResourceNotFoundException') return true;
  if (error.name === 'ValidationException' || error.name === 'ConflictException') {
    return /session/i.test(error.message);
  }
  return false;
}

/** 固定のセッション ID を返す（テストや、手渡しの ID で一度だけ検証する用途） */
export function fixedPaymentSession(paymentSessionId: string): PaymentSessionSource {
  return {
    async acquire() {
      return paymentSessionId;
    },
    async renew() {
      throw new Error(`固定の PaymentSession（${paymentSessionId}）は作り直せません`);
    },
  };
}
