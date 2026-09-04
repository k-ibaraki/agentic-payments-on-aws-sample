/**
 * Amplify Gen2 から使う Blocks の CDK 入口（決定33）。
 *
 * index.cdk.ts は単独の CDK アプリ（BlocksStack + Hosting。npm run deploy / sandbox 用）で、
 * 読み込むだけで App とスタックを作るため Amplify からは使えない。こちらは Amplify が用意する
 * スタックの上に BlocksBackend（構成要素）として載せるだけの関数で、amplify/blocks.ts から呼ぶ。
 * 公式 CLI の templates/amplify/aws-blocks/index.cdk.ts を写したもの。
 */
import { BlocksBackend, BlocksPresets } from '@aws-blocks/blocks/cdk';
import type { Stack } from 'aws-cdk-lib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createBlocksBackend(stack: Stack, sandboxMode: boolean) {
  // CDK コンテキストで sandbox を伝える。Block 側（削除ポリシー・削除保護・localhost の CORS）が
  // これを見る
  if (sandboxMode) {
    stack.node.setContext('sandboxMode', 'true');
  }

  // id は物理名の接頭辞になる（<Amplify のルートスタック名>-b-…）。Amplify のスタック名が長く、
  // Agent ブロック内蔵の S3 バケット名（…-b-app-buyer-sn）を 63 文字に収めるため 1 文字にしている。
  // Scope 'app' と Agent 'buyer' も同じ理由で短い（決定33）
  return BlocksBackend.create(stack, 'b', {
    backendHandlerPath: join(__dirname, 'index.handler.ts'),
    backendCDKPath: join(__dirname, 'index.ts'),
    defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
  });
}
