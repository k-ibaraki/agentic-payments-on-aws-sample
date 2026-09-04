/**
 * Amplify Gen2 のバックエンド定義（決定33）。
 *
 * Amplify 側のリソース（defineAuth / defineData）は持たず、AWS Blocks のバックエンド一式を
 * ネストスタックとして載せるだけ。Blocks の Block を CDK 実装に解決させるため、
 * これを実行する ampx は必ず NODE_OPTIONS="--conditions=cdk" で起動する
 * （package.json の amplify:* スクリプトと amplify.yml が付ける）。
 */
import { defineBackend } from '@aws-amplify/backend';
import { initBlocks } from './blocks.js';

export const backend = defineBackend({});

await initBlocks(backend);
