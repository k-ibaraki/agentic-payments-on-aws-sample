// Amplify 経路の Blocks の既定値（決定33・72）。
// フロント（Amplify Hosting）と API（API Gateway）が別オリジンなので、ブランチ deploy では
// Amplify のオリジンを CORS で許す。core はこれを defaults.allowedOrigins から受け取り、拒んだときの
// 警告でもここへ足すよう案内している
import { BlocksPresets } from '@aws-blocks/blocks/cdk';
import { describe, expect, it } from 'vitest';
import { blocksDefaults } from './amplify.cdk.js';

describe('blocksDefaults', () => {
  it('sandbox では sandbox の既定をそのまま使う（localhost は既定で許されている）', () => {
    expect(blocksDefaults(true, [])).toEqual(BlocksPresets.sandbox);
  });

  it('ブランチ deploy では production の既定に許可オリジンを足す', () => {
    const defaults = blocksDefaults(false, ['https://[a-z0-9-]+\\.d1abc\\.amplifyapp\\.com']);

    expect(defaults).toEqual({
      ...BlocksPresets.production,
      allowedOrigins: [...BlocksPresets.production.allowedOrigins, 'https://[a-z0-9-]+\\.d1abc\\.amplifyapp\\.com'],
    });
  });
});
