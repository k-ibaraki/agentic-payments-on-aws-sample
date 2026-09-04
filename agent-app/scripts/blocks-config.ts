/**
 * amplify_outputs.json から、ブラウザの Blocks クライアントが読む
 * /.blocks-sandbox/config.json の中身を作る（決定33）。
 * apiUrl は amplify/blocks.ts が backend.addOutput で出す custom.blocks_api_url。
 */
export interface BlocksBrowserConfig {
  apiUrl: string;
}

export function blocksConfigFromOutputs(outputs: unknown): BlocksBrowserConfig {
  const apiUrl =
    outputs && typeof outputs === 'object'
      ? (outputs as { custom?: { blocks_api_url?: unknown } }).custom?.blocks_api_url
      : undefined;
  if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
    throw new Error(
      'amplify_outputs.json に custom.blocks_api_url がありません。' +
        'バックエンド（npx ampx sandbox / pipeline-deploy）が先に通っているか確認してください',
    );
  }
  return { apiUrl };
}
