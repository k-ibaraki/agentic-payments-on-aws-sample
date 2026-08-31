import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const PREVIEW_VIEW_RESOURCE_URI = "ui://billing-mcp/preview-view.html";

// ホスト側の生成タイムアウトより短くし、時間切れ時は Bedrock 由来の
// 具体的なエラーが先に届くようにする（踏襲元と同じ考え方）
const BEDROCK_TIMEOUT_MS = 570_000;

const ALLOWED_MODEL_IDS = [
  "jp.anthropic.claude-sonnet-4-6",
  "jp.anthropic.claude-opus-4-8",
] as const;

const DEFAULT_MODEL_ID = "jp.anthropic.claude-sonnet-4-6";

const SYSTEM_PROMPT =
  "あなたはHTMLを生成するアシスタントです。ユーザーの指示に従い、完全で動作するHTMLを生成してください。HTMLのみを返し、説明文は不要です。";

// Bedrock 呼び出しをテストで差し替えられるよう関数として注入する
export type ConverseFn = (
  input: ConverseCommandInput,
) => Promise<ConverseCommandOutput>;

export function createDefaultConverse(): ConverseFn {
  const bedrock = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    requestHandler: { requestTimeout: BEDROCK_TIMEOUT_MS },
  });
  return (input) => bedrock.send(new ConverseCommand(input));
}

const IMAGE_FORMATS: Record<string, "png" | "jpeg" | "gif" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type DocFormat =
  | "pdf"
  | "csv"
  | "doc"
  | "docx"
  | "xls"
  | "xlsx"
  | "html"
  | "txt"
  | "md";

const DOC_FORMATS: Record<string, DocFormat> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
};

const EXT_TO_DOC_FORMAT: Record<string, DocFormat> = {
  pdf: "pdf",
  csv: "csv",
  doc: "doc",
  docx: "docx",
  xls: "xls",
  xlsx: "xlsx",
  html: "html",
  htm: "html",
  txt: "txt",
  md: "md",
};

const AttachmentSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  data: z.string(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;

function resolveDocFormat(
  mediaType: string,
  filename: string,
): DocFormat | undefined {
  const byMime = DOC_FORMATS[mediaType];
  if (byMime) return byMime;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_DOC_FORMAT[ext];
}

// Bedrock の DocumentBlock.name は英数字・空白・ハイフン・丸/角括弧のみ許可
// （最大200文字）。許可外文字を空白に置換して畳み、空になったら汎用名に落とす
export function sanitizeDocumentName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9 \-()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "document";
}

export function buildAttachmentBlock(att: Attachment) {
  const bytes = Buffer.from(att.data, "base64");
  const imgFormat = IMAGE_FORMATS[att.mediaType];
  if (imgFormat) {
    return { image: { format: imgFormat, source: { bytes } } };
  }
  const docFormat = resolveDocFormat(att.mediaType, att.name);
  if (docFormat) {
    return {
      document: {
        format: docFormat,
        name: sanitizeDocumentName(att.name),
        source: { bytes },
      },
    };
  }
  throw new Error(`未対応のメディアタイプです: ${att.mediaType}`);
}

export function buildUserMessage(
  prompt: string,
  previousHtml?: string,
): string {
  return previousHtml
    ? `前回のHTML:\n${previousHtml}\n\n指示: ${prompt}`
    : prompt;
}

export interface GenerateHtmlParams {
  prompt: string;
  modelId: string;
  previousHtml?: string;
  attachments?: Attachment[];
}

export async function generateHtmlWithBedrock(
  converse: ConverseFn,
  { prompt, modelId, previousHtml, attachments }: GenerateHtmlParams,
): Promise<string> {
  const userMessage = buildUserMessage(prompt, previousHtml);
  const attachmentBlocks = (attachments ?? []).map(buildAttachmentBlock);
  const content = [...attachmentBlocks, { text: userMessage }];

  const response = await converse({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content }],
    // 未指定だとモデル既定値で出力が打ち切られ、長いHTMLが閉じタグ欠落の
    // まま黙って返るため、モデルの出力上限に合わせる
    inferenceConfig: { maxTokens: 64_000 },
  });

  const text = response.output?.message?.content?.[0]?.text;
  if (!text) throw new Error("Bedrock returned empty response");
  return text
    .replace(/^```(?:html)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

export const GENERATE_HTML_INPUT_SCHEMA = {
  prompt: z.string().describe("HTMLの内容についての指示"),
  modelId: z
    .enum(ALLOWED_MODEL_IDS)
    .default(DEFAULT_MODEL_ID)
    .describe("使用するBedrockモデルID"),
  previousHtml: z.string().optional().describe("前回生成したHTML（修正時）"),
  attachments: z
    .array(AttachmentSchema)
    // Function URL のリクエスト上限 6MB に収めるため1件に絞る（DESIGN.md 決定23）
    .max(1)
    .optional()
    .describe(
      "添付ファイル（画像・ドキュメント、最大1件、base64エンコード。" +
        "リクエスト全体で base64 後 6MB 以内 = 元データ約4.4MB まで）",
    ),
};

// ツール本体のハンドラ。x402 の支払いラッパーで包めるよう register とは分離する
export function createGenerateHtmlHandler(converse?: ConverseFn) {
  const converseFn = converse ?? createDefaultConverse();
  return async ({
    prompt,
    modelId,
    previousHtml,
    attachments,
  }: {
    prompt: string;
    modelId: string;
    previousHtml?: string;
    attachments?: Attachment[];
  }) => {
    try {
      const html = await generateHtmlWithBedrock(converseFn, {
        prompt,
        modelId,
        previousHtml,
        attachments,
      });
      return {
        content: [{ type: "text" as const, text: "HTMLを生成しました" }],
        structuredContent: { html, filename: "generated.html" },
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "不明なエラーが発生しました";
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `HTML生成に失敗しました: ${message}` },
        ],
      };
    }
  };
}

export interface GenerateHtmlArgs {
  prompt: string;
  modelId: string;
  previousHtml?: string;
  attachments?: Attachment[];
}

// ツール結果の最小形。素のハンドラと x402 ラッパー適用後の両方が満たす
export interface GenerateHtmlToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// 支払いラッパー適用済み（または素の）ハンドラを MCP Apps ツールとして登録する
export function registerGenerateHtmlTool(
  server: McpServer,
  handler: (
    args: GenerateHtmlArgs,
    extra: unknown,
  ) => GenerateHtmlToolResult | Promise<GenerateHtmlToolResult>,
): void {
  registerAppTool(
    server,
    "generate-html",
    {
      // 金額は書かない（PRICE 環境変数で可変。正確な額は PaymentRequired 応答が伝える）
      description:
        "ユーザーの指示に従ってHTMLを生成する（有料: x402 決済が必要）",
      inputSchema: GENERATE_HTML_INPUT_SCHEMA,
      _meta: { ui: { resourceUri: PREVIEW_VIEW_RESOURCE_URI } },
    },
    handler,
  );
}
