// 有料ツール結果から HTML 成果物を取り出す部分のテスト。
// billing-mcp は structuredContent: { html, filename } を返す（売り手実装と同形）
import { describe, expect, it } from 'vitest';
import { extractHtml } from './buy-html.js';

describe('extractHtml', () => {
  it('structuredContent から html と filename を取り出す', () => {
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { html: '<html><body>成果物</body></html>', filename: 'generated.html' },
    };
    expect(extractHtml(result)).toEqual({
      html: '<html><body>成果物</body></html>',
      filename: 'generated.html',
    });
  });

  it('structuredContent が無ければ undefined（U6 が再発したら検知できる）', () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    expect(extractHtml(result)).toBeUndefined();
  });

  it('html が文字列でなければ undefined', () => {
    const result = { structuredContent: { html: 42 } };
    expect(extractHtml(result)).toBeUndefined();
  });
});
