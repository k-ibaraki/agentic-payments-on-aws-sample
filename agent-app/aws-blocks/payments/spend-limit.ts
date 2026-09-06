// 利用者ごとの支出上限を画面から変えられるようにする（決定43）。
// 値は KVStore `spend-limit` に利用者（Cognito の sub）をキーで持ち、無ければ環境変数の既定
// （PAYMENT_SESSION_MAX_USD）を使う。ここで持つのは「次に切る PaymentSession の maxSpendAmount」で、
// AgentCore Payments にセッションの上限を後から変える API は無い（UpdatePaymentSession は存在しない）。
// 変更を即時に効かせる手順（現在のセッションを消す）は payment-session.ts の discardPaymentSession

export interface SpendLimitRecord {
  /** "2.50" のような小数 2 桁の USD */
  maxSpendUsd: string;
  updatedAt: number;
}

/** KVStore の必要最小限。テストではメモリ実装で代える */
export interface SpendLimitStore {
  get(key: string): Promise<SpendLimitRecord | null>;
  put(key: string, value: SpendLimitRecord): Promise<void>;
}

export interface SpendLimit {
  maxSpendUsd: string;
  /** user = 利用者が画面で設定した値、default = 環境変数の既定 */
  source: 'user' | 'default';
}

export interface SpendLimitSource {
  get(userSub: string): Promise<SpendLimit>;
  /** 書式外・0 は拒む。保存した値（小数 2 桁に正規化済み）を返す */
  set(userSub: string, maxSpendUsd: string): Promise<SpendLimit>;
}

/** 正の金額。小数は 2 桁まで、桁区切りは不可（amplify/runtime-env.ts の書式検証と同じ制約に 0 の除外を足したもの） */
const USD_PATTERN = /^\d+(\.\d{1,2})?$/;

export function isUsdAmount(value: string): boolean {
  return USD_PATTERN.test(value) && Number(value) > 0;
}

export function normalizeUsd(value: string): string {
  return Number(value).toFixed(2);
}

export function spendLimitSource(
  store: SpendLimitStore,
  defaultMaxSpendUsd: string,
  now: () => number = Date.now,
): SpendLimitSource {
  return {
    async get(userSub) {
      const saved = await store.get(userSub);
      if (saved) return { maxSpendUsd: saved.maxSpendUsd, source: 'user' };
      return { maxSpendUsd: defaultMaxSpendUsd, source: 'default' };
    },
    async set(userSub, maxSpendUsd) {
      if (!isUsdAmount(maxSpendUsd)) {
        throw new Error(
          `上限は正の金額で指定してください（例 1.00。小数は 2 桁まで、桁区切りは使えません）: ${maxSpendUsd}`,
        );
      }
      const normalized = normalizeUsd(maxSpendUsd);
      await store.put(userSub, { maxSpendUsd: normalized, updatedAt: now() });
      console.log(`[spend-limit] 支出上限を変更 利用者=${userSub} 上限=${normalized} USD`);
      return { maxSpendUsd: normalized, source: 'user' };
    },
  };
}
