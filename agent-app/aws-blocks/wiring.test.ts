// 2 つの deploy の入口が、共有 Lambda への配線（wireRuntime）を必ず呼ぶことの固定（決定34 の改訂）。
//
// この PR が直した不具合は「配線の中身」ではなく「片方の入口が呼び忘れていたこと」だった。
// runtime.cdk.test.ts は中身（環境変数とポリシー）しか見ないので、呼び出しが消えても緑のまま通る。
// 入口の合成をテストから走らせるのは現実的でない——index.cdk.ts は読み込むだけで CDK App を作り
// esbuild のバンドルを走らせ、--conditions=cdk も要る——ため、ここではソースを読んで呼び出しの
// 存在を確かめる。安いかわりに、呼び出しが「あること」しか見ていない点は承知の上。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const awsBlocksDir = dirname(fileURLToPath(import.meta.url));
const agentAppDir = join(awsBlocksDir, '..');

const ENTRY_POINTS = [
  { name: 'CDK 直経路', path: join(awsBlocksDir, 'index.cdk.ts') },
  { name: 'Amplify 経路', path: join(agentAppDir, 'amplify', 'blocks.ts') },
];

describe('deploy の入口', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry.name}は wireRuntime を import して呼ぶ`, () => {
      const source = readFileSync(entry.path, 'utf-8');

      expect(source).toMatch(/import \{[^}]*\bwireRuntime\b[^}]*\} from '[^']*runtime\.cdk\.js'/);
      // コメント中の言及と区別するため、行頭（字下げ込み）から始まる呼び出しだけを数える
      expect(source).toMatch(/^\s*wireRuntime\(/m);
    });
  }
});
