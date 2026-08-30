// 買い手（@x402/mcp の実クライアント）から売り手までを通す統合テスト。
// 署名は本物の EIP-3009 署名を作り、facilitator だけ偽物に差し替えるので、
// テスト USDC を消費せずに upfront フロー全体を検証できる。
// buy-once.ts と同じ経路を通るため、実決済の前段の確認になる
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpFetchHandler, MCP_PATH } from "./app.js";
import { NETWORK } from "./billing-mcp-server.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const ORIGIN = "https://billing-mcp.example.test";

describe("x402 の往復（実クライアント × 偽 facilitator）", () => {
  let facilitator: Awaited<ReturnType<typeof startFakeFacilitator>>;
  let app: (request: Request) => Promise<Response>;
  const converse = vi.fn();

  beforeAll(async () => {
    facilitator = await startFakeFacilitator();
    converse.mockResolvedValue({
      output: { message: { content: [{ text: "<p>x402 で買えた</p>" }] } },
    });
    app = createMcpFetchHandler({
      facilitatorUrl: facilitator.url,
      payTo: PAY_TO,
      converse,
      loadUiHtml: () => "<html></html>",
    });
  });

  afterAll(() => {
    facilitator.close();
  });

  async function connectBuyer() {
    const account = privateKeyToAccount(generatePrivateKey());
    const client = createx402MCPClient({
      name: "test-buyer",
      version: "0.0.0",
      schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
      autoPayment: true,
      onPaymentRequested: async () => true,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ORIGIN}${MCP_PATH}`),
      { fetch: (url, init) => app(new Request(url, init)) },
    );
    await client.connect(transport);
    return client;
  }

  it("支払いを自動で行い、レシートを受け取れる", async () => {
    const client = await connectBuyer();
    const settleCountBefore = facilitator.log.settle.length;

    const result = await client.callTool("generate-html", {
      prompt: "x402 の往復テスト",
    });

    expect(result.paymentMade).toBe(true);
    expect(result.paymentResponse?.success).toBe(true);
    expect(facilitator.log.settle.length).toBe(settleCountBefore + 1);
    expect(converse).toHaveBeenCalled();
    await client.close();
  });

  it("決済が失敗したら成果物を受け取れない（upfront では生成も走らない）", async () => {
    const client = await connectBuyer();
    converse.mockClear();
    facilitator.failNextSettle();

    const result = await client.callTool("generate-html", {
      prompt: "決済が失敗する往復テスト",
    });

    expect(result.paymentResponse?.success).not.toBe(true);
    expect(converse).not.toHaveBeenCalled();
    await client.close();
  });
});
