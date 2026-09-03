// 購入物のキーが購入者で名前空間を切られていることの固定（セルフレビュー指摘1 の対処）。
// resultId の推測困難性だけに頼らず、他人の resultId では引けないことを構造で担保する
import { describe, expect, it } from 'vitest';
import { purchasedHtmlKey } from './buyer-agent.js';

describe('purchasedHtmlKey', () => {
  it('購入者ごとに異なるキーになる', () => {
    const resultId = '14d25ed9-250f-46a8-a20c-1e4ab6a156c8';
    expect(purchasedHtmlKey('user-a', resultId)).not.toBe(purchasedHtmlKey('user-b', resultId));
  });

  it('userId と resultId の両方を含む', () => {
    expect(purchasedHtmlKey('user-a', 'r-1')).toBe('user-a/r-1');
  });
});
