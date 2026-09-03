// MCP Apps のホスト実装（決定29）。
// 売り手の ui:// リソース（preview-view）を無課金で直接取得し、sandbox iframe に入れ、
// AppBridge で初期化してから、購入済み HTML を tool-result として注入する。
//
// 経路: ブラウザ → 売り手 /mcp（initialize, resources/read）… 支払い不要（決定11）
//       ブラウザ → iframe（postMessage）… ui/initialize → ui/notifications/tool-result
//
// 外部生成の HTML をアプリのオリジンで描画すると XSS になるため、外側の iframe は
// sandbox="allow-scripts"（allow-same-origin 無し）+ srcdoc で不透明オリジンに置く。
// PostMessageTransport は postMessage(msg, "*") で送るので不透明オリジンでも通る
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface SellerInfo {
  mcpUrl: string;
  resourceUri: string;
}

export interface PreviewHost {
  /** 購入済み HTML を View に渡して描画させる */
  showHtml(html: string, filename?: string): Promise<void>;
  /** iframe を外す前に呼ぶ */
  destroy(): void;
}

/** resources/read の応答から HTML 本文を選ぶ。売り手は text で返す（blob は解釈しない） */
export function pickUiHtml(contents: readonly Record<string, unknown>[]): string | undefined {
  const content = contents.find((c) => typeof c.text === 'string');
  return content ? (content.text as string) : undefined;
}

/** View からの ui/download-file 要求を、保存するファイル名と本文に読み替える */
export function parseDownloadRequest(
  contents: readonly Record<string, unknown>[],
): { filename: string; text: string } | undefined {
  const first = contents[0];
  if (!first || first.type !== 'resource') return undefined;
  const resource = first.resource as Record<string, unknown> | undefined;
  if (!resource || typeof resource.text !== 'string') return undefined;
  const uri = typeof resource.uri === 'string' ? resource.uri : '';
  // file:///name.html・file:name.html いずれの形でもファイル名だけを取る
  const filename = uri.replace(/^file:\/*/, '') || 'generated.html';
  return { filename, text: resource.text };
}

/** 売り手から ui:// リソースの HTML 本文を取得する（無課金の resources/read） */
export async function fetchUiResource(seller: SellerInfo): Promise<{ client: Client; html: string }> {
  const client = new Client({ name: 'agent-app-browser', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(seller.mcpUrl)));
    const result = await client.readResource({ uri: seller.resourceUri });
    const html = pickUiHtml(result.contents);
    if (html === undefined) {
      throw new Error(`ui:// リソースに HTML が含まれていません: ${seller.resourceUri}`);
    }
    return { client, html };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/**
 * View との初期化のやり取り（ui/initialize への応答 → ui/notifications/initialized の受信）が
 * 終わるまで待つ上限。売り手 UI のスクリプトが動かない場合に永久に待たないため
 */
const VIEW_INITIALIZE_TIMEOUT_MS = 15_000;

/**
 * 与えられた iframe に View を載せ、初期化が済んだホストを返す。
 * View 側（preview-view.ts）は app.connect() で ui/initialize を送り、
 * ホストが応えると ui/notifications/initialized が届く
 */
export async function mountPreviewHost(
  iframe: HTMLIFrameElement,
  seller: SellerInfo,
  options: { onDownload?: (filename: string, html: string) => void } = {},
): Promise<PreviewHost> {
  const { client, html } = await fetchUiResource(seller);

  const bridge = new AppBridge(
    client,
    { name: 'agent-app', version: '0.1.0' },
    // View が使う downloadFile を受ける。openLinks 等は今回の View には不要
    { downloadFile: {}, logging: {} },
  );

  bridge.ondownloadfile = async ({ contents }) => {
    const request = parseDownloadRequest(contents);
    if (!request) return { isError: true };
    options.onDownload?.(request.filename, request.text);
    return {};
  };

  const initialized = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP Apps の View が ${VIEW_INITIALIZE_TIMEOUT_MS / 1000} 秒以内に初期化されませんでした`)),
      VIEW_INITIALIZE_TIMEOUT_MS,
    );
    bridge.oninitialized = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  // srcdoc を設定してから接続する。contentWindow は srcdoc 設定直後から同じオブジェクトが
  // 使えるため、読み込み完了を待たずに transport を作ってよい（View 側は接続後に
  // initialize を送る）
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = html;
  const target = iframe.contentWindow;
  try {
    if (!target) throw new Error('iframe の contentWindow を取得できません');
    await bridge.connect(new PostMessageTransport(target, target));
    await initialized;
  } catch (error) {
    await bridge.close().catch(() => {});
    await client.close().catch(() => {});
    throw error;
  }

  return {
    async showHtml(htmlBody, filename) {
      await bridge.sendToolInput({ arguments: {} });
      await bridge.sendToolResult({
        content: [{ type: 'text', text: 'HTML を生成しました' }],
        structuredContent: { html: htmlBody, ...(filename ? { filename } : {}) },
      });
    },
    destroy() {
      void bridge.close();
      void client.close();
    },
  };
}
