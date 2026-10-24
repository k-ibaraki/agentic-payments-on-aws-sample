/**
 * Amplify Gen2 から使う Blocks の CDK 入口（決定33）。
 *
 * index.cdk.ts は単独の CDK アプリ（BlocksStack + Hosting。npm run deploy / sandbox 用）で、
 * 読み込むだけで App とスタックを作るため Amplify からは使えない。こちらは Amplify が用意する
 * スタックの上に BlocksBackend（構成要素）として載せるだけの関数で、amplify/blocks.ts から呼ぶ。
 * 公式 CLI（@aws-blocks/create-blocks-app 0.3.0）の templates/amplify/aws-blocks/index.cdk.ts を
 * 写したもの。違いは、CORS の許可オリジンを受け取って既定値に足すこと（blocksDefaults。決定72）
 */
import { type BlocksDefaults, BlocksBackend, BlocksPresets } from '@aws-blocks/blocks/cdk';
import type { Stack } from 'aws-cdk-lib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Blocks の既定値を選ぶ。ブランチ deploy では production の既定に CORS の許可オリジンを足す。
 * Blocks（bb-lambda-compute）がこれを CORS_ALLOWED_ORIGINS として共有 Lambda に載せる
 * （0.3 系では handler.addEnvironment で直接載せていたが、0.8.0 で handler が無くなった。決定72）
 *
 * @param allowedOrigins  正規表現の文字列（^…$ で括って評価される）。sandbox では使わない
 *                        （sandbox の既定が localhost を許している）
 */
export function blocksDefaults(sandboxMode: boolean, allowedOrigins: string[]): BlocksDefaults {
  if (sandboxMode) return BlocksPresets.sandbox;
  return {
    ...BlocksPresets.production,
    allowedOrigins: [...BlocksPresets.production.allowedOrigins, ...allowedOrigins],
  };
}

export async function createBlocksBackend(stack: Stack, sandboxMode: boolean, allowedOrigins: string[]) {
  // CDK コンテキストで sandbox を伝える。Block 側（削除ポリシー・削除保護・localhost の CORS）が
  // これを見る
  if (sandboxMode) {
    stack.node.setContext('sandboxMode', 'true');
  }

  // Amplify は cdk.json を読まないので、公式テンプレートの cdk.json にある bb-data の保存時暗号化の
  // 既定をここで立てる（テンプレートの写し。いまは Database を使っていないので合成結果は変わらない）
  stack.node.setContext('@aws-blocks/bb-data:encryptStorageByDefault', true);

  // id は物理名の接頭辞になる（<Amplify のルートスタック名>-b-…）。Amplify のスタック名が長く、
  // Agent ブロック内蔵の S3 バケット名（…-b-app-buyer-sn）を 63 文字に収めるため 1 文字にしている。
  // Scope 'app' と Agent 'buyer' も同じ理由で短い（決定33）
  return BlocksBackend.create(stack, 'b', {
    backendHandlerPath: join(__dirname, 'index.handler.ts'),
    backendCDKPath: join(__dirname, 'index.ts'),
    defaults: blocksDefaults(sandboxMode, allowedOrigins),
  });
}
