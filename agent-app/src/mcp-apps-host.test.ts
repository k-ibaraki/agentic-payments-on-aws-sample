// MCP Apps ホスト（決定29）のうち、DOM に依存しない解釈の部分をテストする。
// iframe や postMessage を伴う組み立ては手動検証（Playwright）に委ね、
// 「売り手が返した形をどう読むか」の規則だけをここで固定する
import { describe, expect, it } from 'vitest';
import { pickUiHtml, parseDownloadRequest } from './mcp-apps-host.js';

describe('pickUiHtml', () => {
  it('text を持つ contents から HTML 本文を取り出す', () => {
    const contents = [{ uri: 'ui://x', mimeType: 'text/html+skybridge', text: '<html>view</html>' }];
    expect(pickUiHtml(contents)).toBe('<html>view</html>');
  });

  it('blob だけの contents は解釈できない（undefined）', () => {
    expect(pickUiHtml([{ uri: 'ui://x', blob: 'AAAA' }])).toBeUndefined();
    expect(pickUiHtml([])).toBeUndefined();
  });

  it('text を持つ最初の要素を選ぶ', () => {
    const contents = [{ uri: 'ui://x', blob: 'AAAA' }, { uri: 'ui://y', text: '<html>後ろ</html>' }];
    expect(pickUiHtml(contents)).toBe('<html>後ろ</html>');
  });
});

describe('parseDownloadRequest', () => {
  it('resource の uri からファイル名を、text から本文を取り出す', () => {
    const contents = [
      { type: 'resource', resource: { uri: 'file:///generated.html', mimeType: 'text/html', text: '<p>買った</p>' } },
    ];
    expect(parseDownloadRequest(contents)).toEqual({ filename: 'generated.html', text: '<p>買った</p>' });
  });

  it('uri のスラッシュが何本でもファイル名だけを取り出す', () => {
    const contents = [{ type: 'resource', resource: { uri: 'file:cat.html', text: 'x' } }];
    expect(parseDownloadRequest(contents)?.filename).toBe('cat.html');
  });

  it('uri が無ければ既定のファイル名を使う', () => {
    const contents = [{ type: 'resource', resource: { uri: '', text: 'x' } }];
    expect(parseDownloadRequest(contents)?.filename).toBe('generated.html');
  });

  it('resource でない、または本文が無い要求は解釈できない（undefined）', () => {
    expect(parseDownloadRequest([{ type: 'text', text: 'x' }])).toBeUndefined();
    expect(parseDownloadRequest([{ type: 'resource', resource: { uri: 'file:///a.html' } }])).toBeUndefined();
    expect(parseDownloadRequest([])).toBeUndefined();
  });
});
