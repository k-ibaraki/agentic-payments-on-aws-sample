import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpFetchHandler, isStreamingResponse, MCP_PATH } from "./app.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";
import { PREVIEW_VIEW_RESOURCE_URI } from "./tools/generate-html.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const ORIGIN = "https://billing-mcp.example.test";

describe("MCP fetch ハンドラ（Function URL / ローカル共通）", () => {
  let facilitator: Awaited<ReturnType<typeof startFakeFacilitator>>;
  let app: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    facilitator = await startFakeFacilitator();
    app = createMcpFetchHandler({
      facilitatorUrl: facilitator.url,
      payTo: PAY_TO,
      converse: vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: "<p>generated</p>" }] } },
      }),
      loadUiHtml: () => "<html><body>preview-ui</body></html>",
    });
  });

  afterAll(() => {
    facilitator.close();
  });

  function initializeBody() {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
  }

  function mcpRequest(body: string, extraHeaders: Record<string, string> = {}) {
    return new Request(`${ORIGIN}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...extraHeaders,
      },
      body,
    });
  }

  async function connectClient() {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ORIGIN}${MCP_PATH}`),
      { fetch: (url, init) => app(new Request(url, init)) },
    );
    await client.connect(transport);
    return client;
  }

  it("初期化リクエストが 200 で通る", async () => {
    const response = await app(mcpRequest(initializeBody()));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: unknown };
    expect(payload.result).toBeDefined();
  });

  it("見知らぬ Mcp-Session-Id が付いていても初期化が通る（ステートレス。決定22）", async () => {
    // Lambda は実行環境が毎回同じとは限らず、インメモリのセッション管理は
    // 温まっているときだけ動く。ステートレスならセッション検証を行わないため、
    // サーバーが発行していないセッション ID を渡されても弾かない
    const response = await app(
      mcpRequest(initializeBody(), {
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: unknown };
    expect(payload.result).toBeDefined();
    // ステートレスなのでセッション ID は発行しない
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("MCP クライアント経由で tools/list に generate-html が見える", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("generate-html");
    await client.close();
  });

  it("ui:// リソースは無課金で読める（決定11）", async () => {
    const client = await connectClient();
    const result = await client.readResource({
      uri: PREVIEW_VIEW_RESOURCE_URI,
    });
    expect(result.contents[0]?.text).toContain("preview-ui");
    await client.close();
  });

  it("支払いなしのツール呼び出しは PaymentRequired を返す", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "挨拶ページ" },
    });
    expect(result.isError).toBe(true);
    const paymentRequired = result.structuredContent as {
      accepts: Array<Record<string, unknown>>;
    };
    expect(paymentRequired.accepts[0]).toMatchObject({ payTo: PAY_TO });
    await client.close();
  });

  it("プリフライト（OPTIONS）に CORS を返す（決定10 のブラウザ直接取得）", async () => {
    const response = await app(
      new Request(`${ORIGIN}${MCP_PATH}`, { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "mcp-protocol-version",
    );
  });

  it("GET（SSE ストリーム要求）は 405 を返し、応答を待たせない", async () => {
    // ステートレス + enableJsonResponse では単独の SSE ストリームを提供しない。
    // これを SDK に渡すと終わらないストリームが返り、本文をバッファする実装が
    // 永久に待つ。クラウドで Runtime.NodeJsExit（Promise が未解決のまま Node が
    // 終了）として実際に発生したため、応答が返ることをテストで固定する
    const response = await Promise.race([
      app(
        new Request(`${ORIGIN}${MCP_PATH}`, {
          method: "GET",
          headers: { accept: "text/event-stream" },
        }),
      ),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("応答が返りませんでした")), 5000),
      ),
    ]);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("ストリーミング応答はバッファ対象と判定しない", () => {
    expect(
      isStreamingResponse(
        new Response("", { headers: { "content-type": "text/event-stream" } }),
      ),
    ).toBe(true);
    expect(
      isStreamingResponse(
        new Response("{}", { headers: { "content-type": "application/json" } }),
      ),
    ).toBe(false);
  });

  it("MCP エンドポイント以外のパスは 404", async () => {
    const response = await app(
      new Request(`${ORIGIN}/somewhere-else`, { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });
});
