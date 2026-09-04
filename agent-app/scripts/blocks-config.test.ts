import { describe, expect, it } from 'vitest';
import { blocksConfigFromOutputs } from './blocks-config.js';

// ブラウザ側の Blocks クライアントは /.blocks-sandbox/config.json の apiUrl を読む
// （@aws-blocks/core client/index.js の解決順 4）。Amplify では amplify_outputs.json の
// custom.blocks_api_url から作る
describe('blocksConfigFromOutputs', () => {
  it('custom.blocks_api_url を apiUrl に写す', () => {
    const outputs = {
      version: '1.4',
      custom: { blocks_api_url: 'https://abc.execute-api.ap-northeast-1.amazonaws.com/prod/aws-blocks/api' },
    };
    expect(blocksConfigFromOutputs(outputs)).toEqual({
      apiUrl: 'https://abc.execute-api.ap-northeast-1.amazonaws.com/prod/aws-blocks/api',
    });
  });

  it('blocks_api_url が無ければ amplify_outputs.json の不備として落とす', () => {
    expect(() => blocksConfigFromOutputs({ version: '1.4' })).toThrow(/amplify_outputs\.json/);
    expect(() => blocksConfigFromOutputs(null)).toThrow(/amplify_outputs\.json/);
  });
});
