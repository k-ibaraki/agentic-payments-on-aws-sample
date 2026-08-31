import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingMcpServer } from "./billing-mcp-server.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";
import { PREVIEW_VIEW_RESOURCE_URI } from "./tools/generate-html.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";

// x402 v2 では accepted（クライアントが選んだ支払い条件の完全な写し）が
// サーバー側の accepts と一致しないと照合に失敗する。手書きすると
// extra の中身（paymentFlow 等）の変更で壊れるため、サーバーが広告した
// 支払い条件をそのまま写して支払いペイロードを組み立てる
function buildPayment(accepted: Record<string, unknown>) {
  return {
    x402Version: 2,
    scheme: accepted.scheme,
    network: accepted.network,
    accepted,
    payload: { signature: "0xsig", authorization: {} },
  };
}

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
    return connectWith(converse);
  }

  async function connectWith(converse: ReturnType<typeof vi.fn>) {
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

  // サーバーが広告する支払い条件を取り出す（未払い呼び出しの結果から）
  async function advertisedAccepts(
    client: Client,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "価格照会" },
    });
    const paymentRequired = result.structuredContent as {
      accepts: Array<Record<string, unknown>>;
    };
    return paymentRequired.accepts[0];
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
      amount: "100000",
    });
    // 未払いでは生成処理も呼ばれない
    expect(converse).not.toHaveBeenCalled();
  });

  it("ui:// の HTML は UI_HTML_PATH から読む（バンドル後のパス崩れ対策）", async () => {
    // Lambda ではバンドル後に import.meta.dirname が変わるため、CDK が
    // UI_HTML_PATH で明示する。この経路が生きていることを固定する
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "billing-mcp-ui-")),
      "preview-view.html",
    );
    fs.writeFileSync(file, "<html><body>from-UI_HTML_PATH</body></html>");
    const previous = process.env.UI_HTML_PATH;
    process.env.UI_HTML_PATH = file;
    try {
      const mcpServer = await createBillingMcpServer({
        converse: vi.fn(),
        facilitatorUrl: facilitator.url,
        payTo: PAY_TO,
      });
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        mcpServer.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.readResource({
        uri: PREVIEW_VIEW_RESOURCE_URI,
      });
      expect(result.contents[0]?.text).toContain("from-UI_HTML_PATH");
    } finally {
      if (previous === undefined) delete process.env.UI_HTML_PATH;
      else process.env.UI_HTML_PATH = previous;
    }
  });

  it("支払い条件は upfront フローを広告する（決定21）", async () => {
    const { client } = await connect();
    const accepted = await advertisedAccepts(client);
    expect((accepted.extra as Record<string, unknown>)?.paymentFlow).toBe(
      "upfront",
    );
  });

  it("支払い付きのツール呼び出しは HTML を生成しレシートを返す", async () => {
    const { client, converse } = await connect("<p>paid page</p>");
    const accepted = await advertisedAccepts(client);
    const settleCountBefore = facilitator.log.settle.length;

    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "有料ページ" },
      _meta: { "x402/payment": buildPayment(accepted) },
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
    expect(facilitator.log.settle.length).toBe(settleCountBefore + 1);
  });

  it("決済（settle）が失敗した場合は生成処理を走らせない（upfront）", async () => {
    // 無認証の公開エンドポイントでは、署名は有効だが決済が通らない支払いを
    // 送りつけて Bedrock の生成コストだけ売り手に負わせられる。upfront では
    // 決済確定が先なので、この経路で生成が走らないことを固定する（決定19・21）
    const { client, converse } = await connect("<p>settle-fail page</p>");
    const accepted = await advertisedAccepts(client);
    facilitator.failNextSettle();

    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "決済が失敗するページ" },
      _meta: { "x402/payment": buildPayment(accepted) },
    });
    expect(converse).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.html).toBeUndefined();
  });

  it("生成が失敗しても決済は済んでいる（upfront のリスクは買い手側）", async () => {
    // authorization フローとの違いを明示的に固定する。upfront では決済が先に
    // 確定するため、生成の失敗は返金されない。この代償を承知で採用している
    const converse = vi.fn().mockRejectedValue(new Error("Bedrock落ちた"));
    const { client } = await connectWith(converse);
    const accepted = await advertisedAccepts(client);
    const settleCountBefore = facilitator.log.settle.length;

    const result = await client.callTool({
      name: "generate-html",
      arguments: { prompt: "失敗するページ" },
      _meta: { "x402/payment": buildPayment(accepted) },
    });
    expect(result.isError).toBe(true);
    expect(facilitator.log.settle.length).toBe(settleCountBefore + 1);
  });
});
