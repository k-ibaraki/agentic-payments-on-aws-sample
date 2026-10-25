// 価格表を AWS AppConfig から読む（DESIGN.md 決定56・74）。
//
// AppConfigData の API を SDK で直接呼ぶ。セッションを開き（StartConfigurationSession）、
// 以後はトークンを引き継いで最新を取る（GetLatestConfiguration）。変更が無い回は本文が
// 空で返るので、直前に読めた表をそのまま使う。
//
// 当初は Lambda の拡張（レイヤー）が localhost で配っていたが、Web Functions には
// レイヤーが無いので SDK に置き換えた（決定74）。表は実行環境の中に一定時間持ち回す。
// 1 つの実行環境が多数の依頼を同時にさばくので、依頼ごとに取りに行く必要はない。
//
// 読めない設定は退け、直前に読めた表（無ければ既定の表）を使い続ける。設定の
// 書き損じで売り手が止まるより、古い表で売り続けるほうが害が小さい。
//
// 価格を差し替えても進行中の取引（価格を提示してから決済が終わるまでのもの）は壊れない。提示済みの価格は見積書
// （`accepts[].extra.quote`、決定55）としてそのまま往復し、価格表と食い違えば
// 使わずに判定し直すため。
import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { DEFAULT_TIER_TABLE, parseTierTable, type TierTable } from "./tiers.js";

/** AppConfigData のセッションに求める、取りに行ける間隔の下限（秒）。API が受ける最小値 */
export const MIN_POLL_INTERVAL_SECONDS = 15;

export interface AppConfigTarget {
  application: string;
  environment: string;
  profile: string;
}

/** AppConfigDataClient のうち使う口だけ（テストで差し替えるため） */
export interface AppConfigDataClientLike {
  send(
    command: StartConfigurationSessionCommand,
  ): Promise<{ InitialConfigurationToken?: string }>;
  send(command: GetLatestConfigurationCommand): Promise<{
    Configuration?: Uint8Array;
    NextPollConfigurationToken?: string;
  }>;
}

/**
 * 最新の設定を返す。変更が無ければ undefined。失敗は投げる。
 * 投げた後の次回はセッションを開き直す（トークンは 24 時間で切れる）
 */
export type ConfigReader = () => Promise<unknown>;

/** AppConfigData から設定 JSON を読む読み手を作る */
export function createAppConfigDataReader(options: {
  client: AppConfigDataClientLike;
  target: AppConfigTarget;
}): ConfigReader {
  const { client, target } = options;
  let token: string | undefined;

  return async () => {
    try {
      if (!token) {
        const started = await client.send(
          new StartConfigurationSessionCommand({
            ApplicationIdentifier: target.application,
            EnvironmentIdentifier: target.environment,
            ConfigurationProfileIdentifier: target.profile,
            // 取りに行ける間隔の下限。指定しないと AppConfig の既定（60 秒）になり、
            // それより早い呼び出しは弾かれる。持ち回し（既定 30 秒）より短い最小値にしておく
            RequiredMinimumPollIntervalInSeconds: MIN_POLL_INTERVAL_SECONDS,
          }),
        );
        token = started.InitialConfigurationToken;
        if (!token) throw new Error("AppConfig のセッションを開けませんでした");
      }
      const latest = await client.send(
        new GetLatestConfigurationCommand({ ConfigurationToken: token }),
      );
      token = latest.NextPollConfigurationToken;
      if (!latest.Configuration || latest.Configuration.byteLength === 0) {
        return undefined;
      }
      return JSON.parse(new TextDecoder().decode(latest.Configuration));
    } catch (error) {
      token = undefined;
      throw error;
    }
  };
}

export interface TierTableLoaderOptions {
  read: ConfigReader;
  /** 実行環境の中で表を持ち回す時間 */
  ttlMs: number;
  /**
   * 1 回の取得を待つ上限。取得は 1 本に束ねて皆で待つので、止まると実行環境の全依頼が
   * 道連れになる。超えたら直前の表で売り続ける（省略時 READ_TIMEOUT_MS）
   */
  readTimeoutMs?: number;
  now?: () => number;
}

/** 価格表の 1 回の取得を待つ上限の既定値 */
export const READ_TIMEOUT_MS = 3_000;

export type TierTableLoader = () => Promise<TierTable>;

/**
 * 価格表の読み手を作る。
 *
 * 失敗しても投げない。直前に読めた表を返し、それも無ければ既定の表を返す
 */
export function createTierTableLoader(
  options: TierTableLoaderOptions,
): TierTableLoader {
  const now = options.now ?? Date.now;

  let cached: TierTable = DEFAULT_TIER_TABLE;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  // 進行中の取得。1 つの実行環境が多数の依頼を同時にさばくので、有効期間が切れた
  // 瞬間に依頼の数だけ取りに行かないよう、取得は 1 本に束ねて皆で待つ
  let inflight: Promise<TierTable> | undefined;

  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const readWithTimeout = (): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${readTimeoutMs}ms 以内に取れませんでした`)),
        readTimeoutMs,
      );
    });
    return Promise.race([options.read(), timeout]).finally(() =>
      clearTimeout(timer),
    );
  };

  const refresh = async (): Promise<TierTable> => {
    try {
      const raw = await readWithTimeout();
      // undefined は「変更なし」。いまの表のまま
      if (raw !== undefined) {
        const table = parseTierTable(raw);
        if (table) cached = table;
        else
          console.warn(
            "[pricing] 価格表の内容が妥当でないため、直前の表を使います",
          );
      }
    } catch (error) {
      console.warn(
        "[pricing] 価格表の取得に失敗しました。直前の表を使います",
        error,
      );
    } finally {
      fetchedAt = now();
    }
    return cached;
  };

  return () => {
    if (now() - fetchedAt < options.ttlMs) return Promise.resolve(cached);
    inflight ??= refresh().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}

/**
 * 環境変数から読み手を組み立てる。
 *
 * AppConfig の指定が揃っていなければ undefined を返し、呼び出し側は既定の表を使う。
 * ローカル開発では AppConfig を指さないため、これが通常の経路になる
 */
export function tierTableLoaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TierTableLoader | undefined {
  const application = env.APPCONFIG_APPLICATION;
  const environment = env.APPCONFIG_ENVIRONMENT;
  const profile = env.APPCONFIG_PROFILE;
  if (!application || !environment || !profile) return undefined;

  return createTierTableLoader({
    read: createAppConfigDataReader({
      // リージョンの既定は他のクライアント（Secrets Manager・Bedrock）と揃える
      client: new AppConfigDataClient({
        region: env.AWS_REGION ?? "ap-northeast-1",
        // SDK の既定には時間制限が無い。止まった接続を待ち続けないよう、
        // 取得を待つ上限（READ_TIMEOUT_MS）に収まる値で切る
        requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 },
      }),
      target: { application, environment, profile },
    }),
    ttlMs: Number(env.APPCONFIG_TTL_MS ?? 30_000),
  });
}
