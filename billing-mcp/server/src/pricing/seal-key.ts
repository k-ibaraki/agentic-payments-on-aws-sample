// 見積書の封の鍵を調達する（DESIGN.md 決定55）。
//
// 鍵が漏れると、封を偽造して安い段で買える。本番では Secrets Manager に置き、
// ARN だけを環境変数で渡す。ローカル開発では `QUOTE_SEAL_KEY` を直接渡す。
//
// どちらも無い場合は開発用の固定鍵に落ちる。売り手を止めないためだが、本番で
// これが使われると防護が無いのと同じなので、警告を必ず残す。
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * 開発とテスト専用の鍵。
 *
 * 本番で使うと封を偽造され、松の依頼を梅の値段で買われる
 */
export const DEV_QUOTE_SEAL_KEY = "dev-only-quote-seal-key";

/** Secrets Manager から値を取る関数。テストで差し替える */
export type FetchSecret = (secretArn: string) => Promise<string>;

export type QuoteSealKeyLoader = () => Promise<string>;

/** 既定の取得手段。Lambda の実行ロールに読み取り権限が要る */
export function createDefaultFetchSecret(): FetchSecret {
  const client = new SecretsManagerClient({});
  return async (secretArn) => {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const value = response.SecretString;
    if (!value) throw new Error("Secrets Manager が空の値を返しました");
    return value;
  };
}

/**
 * 鍵の読み手を作る。一度読めた鍵はコンテナが生きている間は取り直さない。
 *
 * 取得に失敗しても投げない。鍵が無いことで売り買いを止めるより、警告を残して
 * 開発用の鍵で動くほうが、サンプルとしては扱いやすい
 */
export function createQuoteSealKeyLoader(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecret?: FetchSecret,
): QuoteSealKeyLoader {
  let cached: string | undefined;

  return async () => {
    if (cached) return cached;

    const direct = env.QUOTE_SEAL_KEY;
    if (direct) {
      cached = direct;
      return cached;
    }

    const secretArn = env.QUOTE_SEAL_SECRET_ARN;
    if (secretArn) {
      try {
        const fetcher = fetchSecret ?? createDefaultFetchSecret();
        cached = await fetcher(secretArn);
        return cached;
      } catch (error) {
        console.error(
          "[pricing] 封の鍵を Secrets Manager から読めませんでした。" +
            "開発用の鍵で続行しますが、封は偽造できる状態です（決定55）",
          error,
        );
      }
    } else {
      console.warn(
        "[pricing] QUOTE_SEAL_KEY も QUOTE_SEAL_SECRET_ARN も未設定です。" +
          "開発用の鍵で動きますが、本番では封を偽造されます（決定55）",
      );
    }

    cached = DEV_QUOTE_SEAL_KEY;
    return cached;
  };
}
