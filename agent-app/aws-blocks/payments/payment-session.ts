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
  put(
    key: string,
    value: PaymentSessionRecord,
    options?: {
      expiresAt?: Date;
      /** 記録が無いときだけ書く */
      ifNotExists?: boolean;
      /** 読んだ時点の記録と一致するときだけ書く（compare-and-swap） */
      ifValueEquals?: PaymentSessionRecord;
    },
  ): Promise<void>;
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
  /**
   * 拒否された ID を渡して作り直す。記録はウォレットの持ち主単位でアプリ全体に 1 つなので、
   * 別の購入が既に作り直していればその有効なセッションに乗る（作り直しの重複を避ける）
   */
  renew(rejectedSessionId: string): Promise<string>;
}

interface AwsClientLike {
  send(command: unknown): Promise<unknown>;
}

/** 期限のこれだけ手前からは使わない（署名から決済までの間に失効させないため） */
const SAFETY_MARGIN_MS = 60_000;

/** KVStore の条件付き書き込みが条件を満たさなかったときの名前（DynamoDB 由来） */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

export function paymentSessionSource(
  client: AwsClientLike,
  store: PaymentSessionStore,
  config: PaymentSessionConfig,
  now: () => number = Date.now,
): PaymentSessionSource {
  const usable = (record: PaymentSessionRecord | null): record is PaymentSessionRecord =>
    record !== null && record.expiresAt - SAFETY_MARGIN_MS > now();

  // previous は「読んだ時点の記録」。これを書き込みの条件にすると、読んでから書くまでの間に
  // 別の購入が作り直していた場合に、相手の記録を残せる（キーはアプリ全体で共有のため）。
  //
  // 記録を読めなかったときは条件を付けない。`ifNotExists` を使うと本番だけで壊れるためである。
  // KVStore の get は、期限切れの記録を null で返す。ただし実体は消さない
  // （DynamoDB が実際に掃除するまで最大 48 時間かかる）。
  // 一方 `ifNotExists` が見るのは、その実体の有無である。
  // つまり期限切れの実体が残っている間は、何を書こうとしても必ず条件不一致になる。
  // そうなると記録を保存できないまま、購入のたびに新しいセッションを切り続けることになる
  async function create(previous: PaymentSessionRecord | null): Promise<string> {
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
    try {
      await store.put(
        config.userId,
        { paymentSessionId, createdAt, expiresAt },
        {
          expiresAt: new Date(expiresAt),
          ...(previous ? { ifValueEquals: previous } : {}),
        },
      );
      console.log(
        `[payment-session] PaymentSession を作成 id=${paymentSessionId} 期限=${new Date(expiresAt).toISOString()} 上限=${config.maxSpendUsd} USD`,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== CONDITIONAL_CHECK_FAILED) throw error;
      // 別の購入が先に書いていた。相手の記録はそのままにし、作ったセッションはこの購入にだけ使う
      console.warn(
        `[payment-session] PaymentSession を作成したが記録は別の購入に書き換えられていた id=${paymentSessionId} 上限=${config.maxSpendUsd} USD。保存はせず、この購入にだけ使う`,
      );
    }
    return paymentSessionId;
  }

  return {
    async acquire() {
      const saved = await store.get(config.userId);
      if (usable(saved)) return saved.paymentSessionId;
      return create(saved);
    },
    async renew(rejectedSessionId) {
      const saved = await store.get(config.userId);
      // 別の購入が既に作り直していれば、その有効なセッションに乗る
      if (usable(saved) && saved.paymentSessionId !== rejectedSessionId) {
        return saved.paymentSessionId;
      }
      return create(saved);
    },
  };
}

/**
 * 支出上限や残高の不足による拒否かどうか。
 * これを作り直しで通すと、上限に当たった支払いがその場で成立してしまい
 * `PAYMENT_SESSION_MAX_USD` が上限として機能しなくなるため、再試行の対象から外す（決定37）。
 *
 * 判定は業務ルールの拒否を表す例外（`ValidationException` / `ConflictException`）に限る。
 * 文言だけで見ると `ThrottlingException` の `Rate exceeded` なども拾ってしまい、
 * 一時的な失敗を「上限に達した」と誤って伝えることになるため。
 * 文言での判定なので、失効を上限超過と読み違えたときは支払いが失敗する側に倒れる
 */
const SPEND_LIMIT_PATTERN = /\b(limit|exceed(ed|s)?|budget|insufficient)\b/i;

export function isSpendLimitRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== 'ValidationException' && error.name !== 'ConflictException') return false;
  return SPEND_LIMIT_PATTERN.test(error.message);
}

/**
 * ProcessPayment の失敗が「作り直せば解消するセッション起因」（失効・削除済み）かどうか。
 * 上限超過は作り直しでは解消させない（決定37。上限の迂回になるため）。
 * `ValidationException` + message `Payment session not found` は sandbox で実測済み、
 * `ResourceNotFoundException` / `ConflictException` は SDK の型からの推定（決定35）。
 * 判定に漏れても支払いが失敗するだけで、二重に払うことはない
 */
export function isSessionRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isSpendLimitRejection(error)) return false;
  if (error.name === 'ResourceNotFoundException') return true;
  if (error.name === 'ValidationException' || error.name === 'ConflictException') {
    return /session/i.test(error.message);
  }
  return false;
}

/** 固定のセッション ID を返す（テスト用。手渡しの PAYMENT_SESSION_ID は決定35 で廃止した） */
export function fixedPaymentSession(paymentSessionId: string): PaymentSessionSource {
  return {
    async acquire() {
      return paymentSessionId;
    },
    async renew(_rejectedSessionId: string) {
      throw new Error(`固定の PaymentSession（${paymentSessionId}）は作り直せません`);
    },
  };
}
