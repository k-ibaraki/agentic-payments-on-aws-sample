/**
 * aws-blocks/client.js（ブラウザ用の型付きクライアント）を生成する。
 *
 * cdk deploy 経路（npm run deploy）と npm run dev は内部で同じ生成を行うが、Amplify Hosting の
 * ビルドはどちらも通らないため、フロントのビルド前にこれを走らせる（npm run build:amplify）。
 * 中身は @aws-blocks/core の generate-client-worker.js と同じ。
 * NODE_OPTIONS="--conditions=aws-runtime" で実行する（package.json の blocks:client）。
 */
import { generateClientCode } from '@aws-blocks/blocks/scripts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const awsBlocksDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'aws-blocks');
const foundationPath = join(awsBlocksDir, 'index.ts');
const clientPath = join(awsBlocksDir, 'client.js');

const code = await generateClientCode(foundationPath);
mkdirSync(dirname(clientPath), { recursive: true });
writeFileSync(clientPath, code);
console.log(`generated ${clientPath}`);
