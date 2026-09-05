// 利用者ごとの依頼回数の上限（決定40）。
// 支払いに至らない依頼でも LLM（Bedrock）の費用は掛かるため、支出上限（決定37・@39@）とは別に
// 「時間窓あたりの依頼回数」を利用者単位で数える。窓は固定（例: 60 分なら時刻を 60 分で区切る）で、
// 窓ごとに別のキーに記録し、前の窓の記録は KVStore の TTL に任せる。
// KVStore に加算命令は無いので、読んだ値を条件（ifValueEquals）にして書く compare-and-swap で数える。

export interface RateLimitRecord {
  count: number;
}

/** KVStore の必要最小限。テストではメモリ実装で代える */
export interface RateLimitStore {
  get(key: string): Promise<RateLimitRecord | null>;
  put(
    key: string,
    value: RateLimitRecord,
    options?: { expiresAt?: Date; ifNotExists?: boolean; ifValueEquals?: RateLimitRecord },
  ): Promise<void>;
}

export interface RateLimitConfig {
  /** 時間窓あたりの上限回数 */
  limit: number;
  windowMinutes: number;
}

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; remaining: 0; retryAt: Date };

/** 読んでから書くまでに横から書かれた場合の読み直し回数の上限 */
const MAX_ATTEMPTS = 5;
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/**
 * 書き込みに付ける条件を決める。
 *
 * - 記録を読めた → `ifValueEquals`。読んでから書くまでに別の依頼が数えていたら譲って読み直す
 * - 読めない1回目 → `ifNotExists`。同時に始まった依頼のうち1つだけを通す
 * - 読めないのに `ifNotExists` が落ちた → 条件を外す。
 *   本番の KVStore は `get` で期限切れを null にするが実体は消さない（TTL 掃除は最大 48 時間）。
 *   一方 `ifNotExists` が見るのは実体の有無なので、期限切れの実体が残っている間は何を書いても
 *   条件不一致になり、その利用者の依頼が窓の終わりまで通らなくなる。
 *   キーは「利用者/窓の開始」で通常は再利用されないが、窓の長さを変えると過去の窓と一致しうる
 *   （60 分の境界は 120 分の境界を含む）。mock は期限切れを即削除するためテストでは再現しない
 */
function condition(
  current: RateLimitRecord | null,
  staleItem: boolean,
): { ifValueEquals?: RateLimitRecord; ifNotExists?: boolean } {
  if (current) return { ifValueEquals: current };
  return staleItem ? {} : { ifNotExists: true };
}

export function rateLimiter(store: RateLimitStore, config: RateLimitConfig, now: () => number = Date.now) {
  const windowMs = config.windowMinutes * 60_000;
  return {
    /** 1 回分を消費する。上限に達していれば消費せず拒否を返す */
    async consume(userKey: string): Promise<RateLimitResult> {
      const windowStart = Math.floor(now() / windowMs) * windowMs;
      const windowEnd = new Date(windowStart + windowMs);
      const key = `${userKey}/${windowStart}`;
      // 記録を読めないのに ifNotExists が落ちた = 期限切れの実体が残っている、と判定するための印
      let staleItem = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const current = await store.get(key);
        const count = current?.count ?? 0;
        if (count >= config.limit) return { allowed: false, remaining: 0, retryAt: windowEnd };
        try {
          await store.put(key, { count: count + 1 }, { expiresAt: windowEnd, ...condition(current, staleItem) });
          return { allowed: true, remaining: config.limit - (count + 1) };
        } catch (error) {
          if (!(error instanceof Error) || error.name !== CONDITIONAL_CHECK_FAILED) throw error;
          // 別の依頼が先に書いたか、期限切れの実体が残っている。後者は current が無いまま落ちることで分かる
          if (!current) staleItem = true;
        }
      }
      throw new Error('依頼回数の記録が競合し続けたため数えられませんでした');
    },
  };
}

/** 環境変数から上限を読む。既定は 10 回 / 60 分（決定40）。書式の検証は合成時に runtime-env.ts が行う */
export function rateLimitConfigFromEnv(env: Record<string, string | undefined> = process.env): RateLimitConfig {
  const limit = positiveInt(env.BUYER_RATE_LIMIT, 10, 'BUYER_RATE_LIMIT');
  const windowMinutes = positiveInt(env.BUYER_RATE_WINDOW_MINUTES, 60, 'BUYER_RATE_WINDOW_MINUTES');
  return { limit, windowMinutes };
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  console.warn(`[rate-limit] ${name}=${raw} は正の整数ではないため既定の ${fallback} を使います`);
  return fallback;
}
