/**
 * AWS Blocks を Amplify Gen2 のバックエンドへ配線する（決定33）。
 *
 * 公式 CLI（@aws-blocks/create-blocks-app 0.1.21）が Amplify プロジェクトを検出したときに
 * 生成する templates/amplify/amplify-blocks.ts を写したもの。違いは次の2点:
 * - Amplify の Cognito は使わないので、その環境変数の受け渡しは無い（認証は AuthCognito Block）
 * - フロント（Amplify Hosting）と API（API Gateway）が別オリジンになるため、
 *   CORS とクロスドメイン Cookie の設定を Lambda に渡す
 */
import type { BackendBase } from '@aws-amplify/backend';
import { createBlocksBackend } from '../aws-blocks/amplify.cdk.js';
import { requireCorsAllowedOrigins } from './cors-origins.js';

// 使うのは createStack と addOutput だけなので、リソース型に依存しない BackendBase で受ける
export async function initBlocks(backend: BackendBase) {
  const blocksStack = backend.createStack('blocks');
  // npm run amplify:sandbox が付ける。sandbox では削除保護を外し、localhost からの CORS を許す
  const sandboxMode = process.env.AMPLIFY_SANDBOX === 'true';
  const blocks = await createBlocksBackend(blocksStack, sandboxMode);

  // ブラウザは Amplify Hosting のオリジンから API Gateway を直接呼ぶ（別オリジン）。
  // AuthCognito のセッション Cookie を SameSite=None; Secure; Partitioned にする
  blocks.handler.addEnvironment('BLOCKS_CROSS_DOMAIN', 'true');

  // ブランチ deploy では amplifyapp.com のオリジンを許可する。決められなければ CORS 未設定のまま
  // deploy させず落とす。sandbox では BlocksBackend が localhost を許可済みなので触らない
  // （同じキーを二重に足すと上書きになる）
  if (!sandboxMode) {
    blocks.handler.addEnvironment('CORS_ALLOWED_ORIGINS', requireCorsAllowedOrigins(process.env));
  }

  // amplify_outputs.json に Blocks の API URL を出す。フロントのビルドはこれを
  // /.blocks-sandbox/config.json に写す（scripts/amplify-blocks-config.ts）
  backend.addOutput({
    custom: {
      blocks_api_url: blocks.apiUrl,
    },
  });

  return blocks;
}
