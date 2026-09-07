import { deploy } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// deploy の意思を合成（index.cdk.ts）へ伝える。@aws-blocks/core の deploy() は cdk を
// { ...process.env } で起動するので子プロセスに届く。これが無いと index.cdk.ts は必須値を
// 検証しない（cdk destroy / diff を塞がないため。決定34 の改訂）
process.env.BUYER_CDK_DEPLOY = 'true';

deploy({
  cdkAppPath: join(__dirname, '..', 'index.cdk.ts'),
  projectRoot: join(__dirname, '..', '..')
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
