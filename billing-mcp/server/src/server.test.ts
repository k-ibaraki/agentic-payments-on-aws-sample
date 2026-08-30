import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingMcpServer } from "./billing-mcp-server.js";
import { PREVIEW_VIEW_RESOURCE_URI } from "./tools/generate-html.js";

// ---- 偽 facilitator（x402.org の代役。/supported /verify /settle を提供）----

interface FacilitatorLog {
  verify: unknown[];
  settle: unknown[];
}

function startFakeFacilitator(): Promise<{
  url: string;
  log: FacilitatorLog;
  close: () => void;
}> {
  const app = express();
  app.use(express.json());
  const log: FacilitatorLog = { verify: [], settle: [] };

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    });
  });
  app.post("/verify", (req, res) => {
    log.verify.push(req.body);
    res.json({
      isValid: true,
      payer: "0x1111111111111111111111111111111111111111",
    });
  });
  app.post("/settle", (req, res) => {
    log.settle.push(req.body);
    res.json({
      success: true,
      transaction: "0xfaketx",
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
    });
  });

  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://localhost:${port}`,
        log,
        close: () => server.close(),
      });
    });
  });
}

// ---- テスト用の支払いペイロード（構造のみ。検証は偽 facilitator が通す）----
// v2 では accepted（クライアントが選んだ支払い条件の写し）がサーバー側の
// accepts と完全一致しないと照合に失敗する

const PAY_TO = "0x2222222222222222222222222222222222222222";

const FAKE_PAYMENT = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:84532",
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  },
  payload: { signature: "0xsig", authorization: {} },
};

describe("billing-mcp server（x402 課金付き MCP Apps）", () => {
  let facilitator: Awaited<ReturnType<typeof startFakeFacilitator>>;

  beforeAll(async () => {
    facilitator = await startFakeFacilitator();
  });

  afterAll(() => {
    facilitator.close();
  });

  async function connect(converseText = "<p>generated</p>") {
    const converse = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: converseText }] } },
    });
    const mcpServer = await createBillingMcpServer({
      converse,
      facilitatorUrl: facilitator.url,
      payTo: PAY_TO,
      loadUiHtml: () => "<html><body>preview-ui</body></html>",
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      mcpServer.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { client, converse };
  }

  it("tools/list に generate-html があり UI リソースが紐付く", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "generate-html");
    expect(tool).toBeDefined();
    expect(tool?._meta?.ui).toMatchObject({
      resourceUri: PREVIEW_VIEW_RESOURCE_URI,
    });
  });

  it("ui:// リソースは未払いで読める", async () => {
    const { client } = await connect();
    const result = await client.readResource({
      uri: PREVIEW_VIEW_RESOURCE_URI,
    });
    const first = result.contents[0];
    expect(first.text).toContain("preview-ui");
    expect(first.mimeType).toContain("text/html");
  });

  it("支払いなしのツール呼び出しは PaymentRequired を返す", async () => {
    const { client, converse } = await connect();
    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "挨拶ページ" },
    });
    expect(result.isError).toBe(true);
    const paymentRequired = result.structuredContent as {
      x402Version: number;
      accepts: Array<Record<string, unknown>>;
    };
    expect(paymentRequired.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      payTo: PAY_TO,
      amount: "10000",
    });
    // 未払いでは生成処理も呼ばれない
    expect(converse).not.toHaveBeenCalled();
  });

  it("支払い付きのツール呼び出しは HTML を生成しレシートを返す", async () => {
    const { client, converse } = await connect("<p>paid page</p>");
    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "有料ページ" },
      _meta: { "x402/payment": FAKE_PAYMENT },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      html: "<p>paid page</p>",
      filename: "generated.html",
    });
    const receipt = (result._meta as Record<string, unknown>)?.[
      "x402/payment-response"
    ] as { success: boolean };
    expect(receipt.success).toBe(true);
    expect(converse).toHaveBeenCalledTimes(1);
    expect(facilitator.log.verify.length).toBeGreaterThan(0);
    expect(facilitator.log.settle.length).toBeGreaterThan(0);
  });

  it("生成が失敗した場合は決済（settle）しない", async () => {
    const settleCountBefore = facilitator.log.settle.length;
    const converse = vi.fn().mockRejectedValue(new Error("Bedrock落ちた"));
    const mcpServer = await createBillingMcpServer({
      converse,
      facilitatorUrl: facilitator.url,
      payTo: PAY_TO,
      loadUiHtml: () => "<html></html>",
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      mcpServer.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "失敗するページ" },
      _meta: { "x402/payment": FAKE_PAYMENT },
    });
    expect(result.isError).toBe(true);
    expect(facilitator.log.settle.length).toBe(settleCountBefore);
  });
});
