import { describe, expect, it, vi } from "vitest";
import {
  buildAttachmentBlock,
  buildUserMessage,
  generateHtmlWithBedrock,
  sanitizeDocumentName,
} from "./generate-html.js";

// Bedrock Converse の応答を偽装するヘルパー
function fakeConverse(text: string | undefined) {
  return vi.fn().mockResolvedValue({
    output: { message: { content: text === undefined ? [] : [{ text }] } },
  });
}

describe("buildUserMessage", () => {
  it("previousHtml なしなら prompt をそのまま返す", () => {
    expect(buildUserMessage("赤いボタン")).toBe("赤いボタン");
  });

  it("previousHtml ありなら前回HTMLと指示を結合する", () => {
    const msg = buildUserMessage("青くして", "<p>前回</p>");
    expect(msg).toContain("<p>前回</p>");
    expect(msg).toContain("青くして");
  });
});

describe("sanitizeDocumentName", () => {
  it("英数字はそのまま残す", () => {
    expect(sanitizeDocumentName("report-2026.pdf")).toBe("report-2026 pdf");
  });

  it("全角のみの名前は document にフォールバックする", () => {
    expect(sanitizeDocumentName("請求書")).toBe("document");
  });
});

describe("buildAttachmentBlock", () => {
  const data = Buffer.from("hello").toString("base64");

  it("画像メディアタイプは image ブロックになる", () => {
    const block = buildAttachmentBlock({
      name: "a.png",
      mediaType: "image/png",
      data,
    });
    expect(block).toMatchObject({ image: { format: "png" } });
  });

  it("PDF は document ブロックになる", () => {
    const block = buildAttachmentBlock({
      name: "請求書.pdf",
      mediaType: "application/pdf",
      data,
    });
    expect(block).toMatchObject({
      document: { format: "pdf", name: "pdf" },
    });
  });

  it("未対応メディアタイプは例外を投げる", () => {
    expect(() =>
      buildAttachmentBlock({
        name: "a.zip",
        mediaType: "application/zip",
        data,
      }),
    ).toThrow(/未対応/);
  });
});

describe("generateHtmlWithBedrock", () => {
  it("コードフェンス付きの応答からHTMLだけを取り出す", async () => {
    const converse = fakeConverse("```html\n<p>hi</p>\n```");
    const html = await generateHtmlWithBedrock(converse, {
      prompt: "挨拶",
      modelId: "jp.anthropic.claude-sonnet-4-6",
    });
    expect(html).toBe("<p>hi</p>");
  });

  it("modelId・システムプロンプト・maxTokens を Converse に渡す", async () => {
    const converse = fakeConverse("<p>ok</p>");
    await generateHtmlWithBedrock(converse, {
      prompt: "挨拶",
      modelId: "jp.anthropic.claude-opus-4-8",
    });
    const input = converse.mock.calls[0][0];
    expect(input.modelId).toBe("jp.anthropic.claude-opus-4-8");
    expect(input.system?.[0]?.text).toContain("HTML");
    expect(input.inferenceConfig?.maxTokens).toBe(64_000);
  });

  it("添付ファイルはテキストより前にコンテンツブロックとして並ぶ", async () => {
    const converse = fakeConverse("<p>ok</p>");
    await generateHtmlWithBedrock(converse, {
      prompt: "画像を使って",
      modelId: "jp.anthropic.claude-sonnet-4-6",
      attachments: [
        {
          name: "a.png",
          mediaType: "image/png",
          data: Buffer.from("x").toString("base64"),
        },
      ],
    });
    const content = converse.mock.calls[0][0].messages[0].content;
    expect(content[0]).toHaveProperty("image");
    expect(content[1]).toHaveProperty("text", "画像を使って");
  });

  it("空応答なら例外を投げる", async () => {
    const converse = fakeConverse(undefined);
    await expect(
      generateHtmlWithBedrock(converse, {
        prompt: "挨拶",
        modelId: "jp.anthropic.claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/empty/i);
  });
});
