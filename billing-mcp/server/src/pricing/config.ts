// 価格表を AWS AppConfig から読む（DESIGN.md 決定56）。
//
// Lambda には AppConfig の拡張（レイヤー）を載せる。拡張が設定の取得・キャッシュ・
// 定期更新を担い、関数からは localhost の決まった口に GET するだけでよい。
// 資格情報も SDK も要らない。
//
// 読めない設定は退け、直前に読めた表（無ければ既定の表）を使い続ける。設定の
// 書き損じで売り手が止まるより、古い表で売り続けるほうが害が小さい。
//
// 価格を差し替えても飛行中の取引は壊れない。提示済みの価格は見積書の封（決定55）に
// 封じられており、有効期限までその値で通るため。
import { DEFAULT_TIER_TABLE, parseTierTable, type TierTable } from "./tiers.js";

/** AppConfig Lambda 拡張が待ち受ける口。拡張の既定値 */
export const APPCONFIG_EXTENSION_PORT = 2772;

export interface AppConfigTarget {
  application: string;
  environment: string;
  profile: string;
}

/** 拡張から設定を取る URL を組み立てる */
export function appConfigEndpoint(target: AppConfigTarget): string {
  return (
    `http://localhost:${APPCONFIG_EXTENSION_PORT}` +
    `/applications/${target.application}` +
    `/environments/${target.environment}` +
    `/configurations/${target.profile}`
  );
}

export interface TierTableLoaderOptions {
  endpoint: string;
  /**
   * 関数内で表を持ち回す時間。
   *
   * 拡張自身も取得結果を抱えるため短くする意味は薄いが、毎リクエストの
   * localhost 往復を省く分だけ置く
   */
  ttlMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type TierTableLoader = () => Promise<TierTable>;

/**
 * 価格表の読み手を作る。
 *
 * 失敗しても投げない。直前に読めた表を返し、それも無ければ既定の表を返す
 */
export function createTierTableLoader(
  options: TierTableLoaderOptions,
): TierTableLoader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let cached: TierTable = DEFAULT_TIER_TABLE;
  let fetchedAt = Number.NEGATIVE_INFINITY;

  return async () => {
    if (now() - fetchedAt < options.ttlMs) return cached;

    try {
      const response = await fetchImpl(options.endpoint);
      if (!response.ok) {
        console.warn(
          `[pricing] 価格表を取得できませんでした（HTTP ${response.status}）。直前の表を使います`,
        );
        fetchedAt = now();
        return cached;
      }
      const table = parseTierTable(await response.json());
      if (!table) {
        console.warn(
          "[pricing] 価格表の内容が妥当でないため、直前の表を使います",
        );
        fetchedAt = now();
        return cached;
      }
      cached = table;
      fetchedAt = now();
      return cached;
    } catch (error) {
      console.warn(
        "[pricing] 価格表の取得に失敗しました。直前の表を使います",
        error,
      );
      fetchedAt = now();
      return cached;
    }
  };
}

/**
 * 環境変数から読み手を組み立てる。
 *
 * AppConfig の指定が揃っていなければ undefined を返し、呼び出し側は既定の表を使う。
 * ローカル開発では拡張が居ないため、これが通常の経路になる
 */
export function tierTableLoaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TierTableLoader | undefined {
  const application = env.APPCONFIG_APPLICATION;
  const environment = env.APPCONFIG_ENVIRONMENT;
  const profile = env.APPCONFIG_PROFILE;
  if (!application || !environment || !profile) return undefined;

  return createTierTableLoader({
    endpoint: appConfigEndpoint({ application, environment, profile }),
    ttlMs: Number(env.APPCONFIG_TTL_MS ?? 30_000),
  });
}
