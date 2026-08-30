// MCP の HTTP 層。Lambda Function URL とローカル開発サーバーの共通実装。
// Web 標準の Request/Response で完結させ、express は使わない（DESIGN.md 決定22）
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type BillingMcpServerOptions,
  createBillingMcpServer,
  createPaidWrapper,
} from "./billing-mcp-server.js";

/** MCP のエンドポイント。ローカルも Function URL も同じパス（決定4） */
export const MCP_PATH = "/mcp";

// ブラウザが ui:// リソースを直接取得する経路（決定10）のために CORS を開ける。
// Function URL 側の CORS 設定には寄せず、ローカルと本番で同じ挙動にする
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function withCors(headers: Headers): Headers {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors(new Headers({ "content-type": "application/json" })),
  });
}

/**
 * MCP を処理する fetch ハンドラを作る。
 *
 * facilitator への /supported 照会を伴う支払いラッパーの構築は、Lambda の
 * INIT フェーズ（10 秒制限）を避けるため初回リクエストまで遅延させる。
 * 失敗した場合は次のリクエストで作り直す。
 */
export function createMcpFetchHandler(
  options: BillingMcpServerOptions,
): (request: Request) => Promise<Response> {
  let paidPromise: ReturnType<typeof createPaidWrapper> | undefined;

  const getPaid = () => {
    if (!paidPromise) {
      const pending = createPaidWrapper({
        facilitatorUrl: options.facilitatorUrl,
        payTo: options.payTo,
        price: options.price,
      });
      paidPromise = pending;
      pending.catch(() => {
        if (paidPromise === pending) paidPromise = undefined;
      });
    }
    return paidPromise;
  };

  return async function handleMcpRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: withCors(new Headers()),
      });
    }

    if (new URL(request.url).pathname !== MCP_PATH) {
      return jsonResponse(404, { error: "Not Found" });
    }

    let paid: Awaited<ReturnType<typeof createPaidWrapper>>;
    try {
      paid = await getPaid();
    } catch (error) {
      // facilitator に到達できないと価格を広告できない。落ちた理由を残す
      console.error("支払いラッパーの初期化に失敗しました", error);
      return jsonResponse(503, {
        error: "Payment facilitator unavailable",
      });
    }

    // ステートレス（sessionIdGenerator 未指定）。1 リクエストごとに
    // サーバーとトランスポートを立て、応答を読み切ってから閉じる
    const server = await createBillingMcpServer(options, paid);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      const body = await response.text();
      return new Response(body === "" ? null : body, {
        status: response.status,
        headers: withCors(new Headers(response.headers)),
      });
    } finally {
      await server.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

/** 環境変数から売り手の設定を読む。PAY_TO_ADDRESS は必須 */
export function optionsFromEnv(): BillingMcpServerOptions {
  const payTo = process.env.PAY_TO_ADDRESS as `0x${string}` | undefined;
  if (!payTo) {
    throw new Error("環境変数 PAY_TO_ADDRESS（売上受取ウォレット）が必要です");
  }
  return {
    facilitatorUrl:
      process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
    payTo,
    price: process.env.PRICE,
  };
}
