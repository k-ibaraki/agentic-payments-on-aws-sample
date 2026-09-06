import * as cdk from 'aws-cdk-lib';

import { Hosting, BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});

if (sandboxMode) {
  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');}

// Add static site hosting only when deploying (not in sandbox mode)
if (!sandboxMode) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    // 自動判定は next / nitro / astro / sveltekit 以外を全て 'spa' に落とし、CloudFront Function が
    // 拡張子の無い全パスを /index.html に書き換える（どんな URL でもアプリが 200 で返る）。
    // この画面はクライアントルーティングを使わないので 'static' を明示する。'static' にすると
    // アダプタが dist/404.html を 404 のエラーページへ自動で配線する（決定45）
    framework: 'static',
    buildOutputDir: 'dist',
    api: blocksStack
  });
}