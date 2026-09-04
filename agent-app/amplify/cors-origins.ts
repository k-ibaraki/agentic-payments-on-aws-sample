/**
 * Blocks の Lambda に渡す CORS_ALLOWED_ORIGINS を決める（決定33）。
 *
 * 各項目は ^…$ で括った正規表現として評価される（@aws-blocks/core README「CORS Configuration」）。
 * Amplify Hosting のブランチ URL は https://<branch>.<appId>.amplifyapp.com で、ブランチ名は
 * URL 用に正規化される（英小文字・数字・ハイフン）ため、branch 部分はその文字集合で受ける。
 */
export function amplifyHostingOriginPattern(appId: string): string {
  return `https://[a-z0-9-]+\\.${escapeRegex(appId)}\\.amplifyapp\\.com`;
}

/**
 * @param env  ビルド環境の環境変数。Amplify Hosting は AWS_APP_ID を必ず渡す。
 *             独自ドメインを使うときは CORS_ALLOWED_ORIGINS を Amplify の環境変数で明示する
 * @returns    設定する値。undefined なら触らない（sandbox は BlocksBackend が localhost を許す）
 */
export function corsAllowedOrigins(env: {
  AWS_APP_ID?: string;
  CORS_ALLOWED_ORIGINS?: string;
}): string | undefined {
  if (env.CORS_ALLOWED_ORIGINS) return env.CORS_ALLOWED_ORIGINS;
  if (env.AWS_APP_ID) return amplifyHostingOriginPattern(env.AWS_APP_ID);
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
