/**
 * amplify_outputs.json から dist/.blocks-sandbox/config.json を作る（決定33）。
 *
 * ブラウザの Blocks クライアントは起動時に同一オリジンの /.blocks-sandbox/config.json を取り、
 * その apiUrl へ RPC を投げる。CDK 直 deploy では Hosting construct がこれを配るが、
 * Amplify Hosting にはその層が無いので、フロントのビルド後にここで置く。
 * 使い方: npx tsx scripts/amplify-blocks-config.ts（npm run build:amplify の最後）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksConfigFromOutputs } from './blocks-config.js';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputsPath = join(appRoot, 'amplify_outputs.json');
const configPath = join(appRoot, 'dist', '.blocks-sandbox', 'config.json');

const outputs: unknown = JSON.parse(readFileSync(outputsPath, 'utf-8'));
const config = blocksConfigFromOutputs(outputs);
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`wrote ${configPath} (apiUrl: ${config.apiUrl})`);
