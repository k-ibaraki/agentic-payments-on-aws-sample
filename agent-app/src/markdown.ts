// Agent の応答を Markdown として描く（決定46）。
// LLM の出力は信頼できない入力なので、HTML にした後は必ず DOMPurify に通してから innerHTML へ渡す
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Markdown を、そのまま innerHTML に入れて安全な HTML へ変換する */
export function renderAssistantMarkdown(content: string): string {
  // breaks: true は、pre-wrap をやめた後も単独の改行が改行として見える状態を保つため
  // （既定の false だと段落に潰れ、素のテキストで出していた頃より読みにくくなる）
  const html = marked.parse(content, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}
