/**
 * AWS Blocks を Amplify Gen2 のバックエンドへ配線する（決定33）。
 *
 * 公式 CLI（@aws-blocks/create-blocks-app 0.3.0）が Amplify プロジェクトを検出したときに
 * 生成する templates/amplify/amplify-blocks.ts を写したもの。違いは次の2点:
 * - Amplify の Cognito は使わないので、その設定の受け渡しは無い（認証は AuthCognito Block）
 * - フロント（Amplify Hosting）と API（API Gateway）が別オリジンになるため、
 *   CORS の許可オリジンとクロスドメイン Cookie の設定を渡す
 *
 * 実決済の実行時設定と IAM（決定34）は Amplify 固有ではなく cdk deploy 経路（aws-blocks/index.cdk.ts）
 * にも要るので、aws-blocks/runtime.cdk.ts の wireRuntime に寄せて両方から呼ぶ。
 */
import type { BackendBase } from '@aws-amplify/backend';
import { registerConfig } from '@aws-blocks/blocks/cdk';
import { createBlocksBackend } from '../aws-blocks/amplify.cdk.js';
import { wireRuntime } from '../aws-blocks/runtime.cdk.js';
import { requireCorsAllowedOrigins } from './cors-origins.js';

// 使うのは createStack と addOutput だけなので、リソース型に依存しない BackendBase で受ける
export async function initBlocks(backend: BackendBase) {
  const blocksStack = backend.createStack('blocks');
  // npm run amplify:sandbox が付ける。sandbox では削除保護を外し、localhost からの CORS を許す
  const sandboxMode = process.env.AMPLIFY_SANDBOX === 'true';
  // ブランチ deploy では amplifyapp.com のオリジンを許可する。決められなければ CORS 未設定のまま
  // deploy させず落とす。sandbox では既定が localhost を許可済みなので触らない。cdk deploy 経路では
  // Hosting construct が CloudFront のドメインを自動で足すため、この設定が要るのは Amplify 経路だけ
  const allowedOrigins = sandboxMode ? [] : [requireCorsAllowedOrigins(process.env)];
  const blocks = await createBlocksBackend(blocksStack, sandboxMode, allowedOrigins);

  // ブラウザは Amplify Hosting のオリジンから API Gateway を直接呼ぶ（別オリジン）。
  // AuthCognito のセッション Cookie を SameSite=None; Secure; Partitioned にする（index.ts が読む）
  registerConfig(blocks, 'BLOCKS_CROSS_DOMAIN', 'true');

  // 実決済の実行時設定（PAYMENT_* など）と AgentCore Payments の IAM（決定34）。
  // ampx は deploy でも削除（sandbox delete）でも合成するが、削除の合成は sandbox のみなので、
  // ブランチ deploy を必須にしても畳めなくなる経路は生まれない
  wireRuntime(blocks, process.env, { requireAll: !sandboxMode });

  // amplify_outputs.json に Blocks の API URL を出す。フロントのビルドはこれを
  // /.blocks-sandbox/config.json に写す（scripts/amplify-blocks-config.ts）
  backend.addOutput({
    custom: {
      blocks_api_url: blocks.publicApiUrl,
    },
  });

  return blocks;
}
