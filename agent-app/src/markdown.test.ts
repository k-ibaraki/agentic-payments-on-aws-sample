// @vitest-environment jsdom
// Agent の応答の Markdown 描画（決定46）。DOMPurify が DOM を要るので、このファイルだけ jsdom で動かす。
// 見た目はブラウザでの目視確認に委ね、ここでは「何が通り、何が落ちるか」を固定する
import { describe, expect, it } from 'vitest';
import { renderAssistantMarkdown } from './markdown.js';

describe('renderAssistantMarkdown', () => {
  it('見出し・箇条書き・コードブロックを HTML にする', () => {
    expect(renderAssistantMarkdown('# 見出し')).toContain('<h1>見出し</h1>');
    expect(renderAssistantMarkdown('- ひとつ目')).toContain('<li>ひとつ目</li>');
    expect(renderAssistantMarkdown('```\nconst x = 1;\n```')).toContain('<code>');
  });

  it('GFM の表を解釈する', () => {
    const html = renderAssistantMarkdown('| 品目 | 価格 |\n| --- | --- |\n| ページ | 0.01 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>ページ</td>');
  });

  it('単独の改行を <br> にする（素のテキストで出していた頃の見え方を保つ）', () => {
    expect(renderAssistantMarkdown('一行目\n二行目')).toContain('<br>');
  });

  it('script タグを落とす', () => {
    const html = renderAssistantMarkdown('前 <script>alert("xss")</script> 後');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert');
  });

  it('イベントハンドラ属性を落とす', () => {
    const html = renderAssistantMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('javascript: のリンクは href ごと落とす（リンクの文字は残る）', () => {
    const html = renderAssistantMarkdown('[踏むな](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('踏むな');
  });

  it('通常のリンクは残す', () => {
    expect(renderAssistantMarkdown('[例](https://example.com)')).toContain('href="https://example.com"');
  });
});
