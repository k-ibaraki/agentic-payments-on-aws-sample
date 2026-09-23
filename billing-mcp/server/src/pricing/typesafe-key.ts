// Jev の API キーの読み手（DESIGN.md 決定58）。
//
// 鍵は Secrets Manager に置き、コールドスタートに一度だけ読んでコンテナ内に保持する。
// CDK が作るのは空の Secret で、値は人が後から入れる（`pnpm set:jev-key`）。
// ゆえに「指定はあるが値が無い」状態は通常運転の一部であり、落ちてはならない。
//
// ローカル開発では環境変数 `TYPESAFE_API_KEY` を優先する。Secrets Manager を
// 引くための資格情報を手元に要求しないため。
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * 鍵が未投入であることを表す仮の値。
 *
 * CDK は値の入っていない Secret を作りたいが、Secrets Manager は空文字を嫌う。
 * かといって CDK の既定（ランダム生成）に任せると、出鱈目な鍵で Jev を叩いて
 * 毎回 401 になり、全件がフォールバックの価格帯に落ちる。そこで人が置き換える前提の
 * 仮の値を入れ、サーバー側では未設定と同じに扱う（決定58）
 */
export const UNSET_API_KEY = "REPLACE_ME";

/** 秘密を1つ読む。テストで差し替えられるよう関数として注入する */
export type ReadSecretFn = (secretId: string) => Promise<string | undefined>;

/**
 * 読めなかったあと、読み直すまでの間。
 *
 * 失敗を永久に覚えると、あとから鍵を入れてもコンテナが入れ替わるまで効かない。
 * かといって毎リクエスト叩くと、権限不足のときに無駄な呼び出しが積み上がる
 */
export const RETRY_COOLDOWN_MS = 60_000;

export interface ApiKeyLoaderOptions {
  env: NodeJS.ProcessEnv;
  read: ReadSecretFn;
  now?: () => number;
}

export type ApiKeyLoader = () => Promise<string | undefined>;

/** 既定の読み手。Lambda の実行ロールで Secrets Manager を引く */
export function createDefaultSecretReader(): ReadSecretFn {
  // 鍵を使わない構成（既定の Bedrock）でクライアントを作らずに済むよう、
  // 初回の呼び出しまで遅らせる
  let client: SecretsManagerClient | undefined;
  return async (secretId) => {
    client ??= new SecretsManagerClient({
      region: process.env.AWS_REGION ?? "ap-northeast-1",
    });
    const out = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    return out.SecretString;
  };
}

/**
 * API キーの読み手を作る。
 *
 * 失敗しても投げない。鍵が無ければ undefined を返し、呼び出し側は既定の判定モデル
 * （Bedrock）に留まる（決定58）
 */
export function createApiKeyLoader(options: ApiKeyLoaderOptions): ApiKeyLoader {
  const now = options.now ?? Date.now;

  let cached: string | undefined;
  let failedAt = Number.NEGATIVE_INFINITY;

  return async () => {
    const fromEnv = options.env.TYPESAFE_API_KEY?.trim();
    if (fromEnv) return fromEnv;

    if (cached) return cached;

    const secretId = options.env.TYPESAFE_API_KEY_SECRET_ARN;
    if (!secretId) return undefined;

    if (now() - failedAt < RETRY_COOLDOWN_MS) return undefined;

    try {
      const value = (await options.read(secretId))?.trim();
      if (!value || value === UNSET_API_KEY) {
        failedAt = now();
        console.warn(
          "[pricing] Jev の API キーが未投入です。値を入れるまで既定の判定モデルで応じます",
        );
        return undefined;
      }
      cached = value;
      return cached;
    } catch (error) {
      failedAt = now();
      console.warn(
        "[pricing] Jev の API キーを取り出せませんでした。既定の判定モデルで応じます",
        error,
      );
      return undefined;
    }
  };
}
