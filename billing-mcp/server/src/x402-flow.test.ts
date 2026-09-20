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

/** facilitator が受け取る支払いペイロードのうち、テストで壊す部分だけの形 */
interface PaymentPayloadShape {
  payload: {
    authorization: {
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
    };
    signature: string;
  };
}

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
      // 段の判定器を固定する。既定のままだと生成用の偽 Converse を判定器も使い、
      // 「生成が呼ばれていないこと」の検査が誤って落ちる（決定56 の結線後）
      judge: async () => ({ tier: "take" }),
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

  /** 実クライアントに 1 回買わせ、facilitator が受け取った支払いペイロードを控える */
  async function capturePaymentPayload(): Promise<PaymentPayloadShape> {
    const client = await connectBuyer();
    await client.callTool("generate-html", {
      prompt: "門番テストの元にする購入",
    });
    await client.close();
    const last = facilitator.log.settle.at(-1) as {
      paymentPayload: PaymentPayloadShape;
    };
    return last.paymentPayload;
  }

  /** 支払いを _meta に積んで素の JSON-RPC で叩く（実クライアントは壊れた支払いを作らない） */
  async function callToolWithPayment(payment: unknown): Promise<Response> {
    return await app(
      new Request(`${ORIGIN}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "generate-html",
            arguments: { prompt: "門番テスト" },
            _meta: { "x402/payment": payment },
          },
        }),
      }),
    );
  }

  // 上流の @x402/mcp は買い手が返す accepted ブロックしか照合せず、authorization の
  // 中身は見ずに settle へ渡す。これらが facilitator まで届くと、無認証の相手に
  // settle 往復を無制限に作らせることになる（payment-guard.ts、U9）
  it.each<[string, (p: PaymentPayloadShape) => void]>([
    [
      "有効期限切れ",
      (p) => {
        p.payload.authorization.validBefore = "1000000000";
      },
    ],
    [
      "有効期間の開始前",
      (p) => {
        p.payload.authorization.validAfter = "9999999999";
      },
    ],
    [
      "金額不足",
      (p) => {
        p.payload.authorization.value = "1";
      },
    ],
    [
      "宛先すり替え",
      (p) => {
        p.payload.authorization.to =
          "0x3333333333333333333333333333333333333333";
      },
    ],
    [
      "署名の形が違う",
      (p) => {
        p.payload.signature = "0xdead";
      },
    ],
  ])("%s の支払いは settle まで届かない", async (_label, mutate) => {
    const payment = await capturePaymentPayload();
    mutate(payment);
    converse.mockClear();
    const settleCountBefore = facilitator.log.settle.length;

    const response = await callToolWithPayment(payment);
    const body = await response.text();

    expect(facilitator.log.settle.length).toBe(settleCountBefore);
    expect(converse).not.toHaveBeenCalled();
    expect(body).toContain("支払いを受け付けられません");
  });

  // 門番の限界を実行可能な形で残す（2026-09-07 のセルフレビュー）。
  // 一度も支払わない攻撃者でも、無支払いの応答から accepts をタダで手に入れて転記し、
  // authorization を条件どおりに手書きし、署名欄に任意の 130 桁 16 進数を入れれば、
  // 門番を通過して settle まで届く。upfront では上流が /verify を呼ばないため、署名が
  // 実際に検証されるのは facilitator の /settle だけになる。
  // 塞ぐには EIP-712 署名のローカル復元（U9）が要る。塞いだときはこのテストが落ちるので、
  // そこで期待値を「settle まで届かない」へ書き換えること
  it("【未対応・U9】一度も支払わずに捏造したペイロードは門番を通過して settle まで届く", async () => {
    // 1) 無支払いで叩き、公開されている accepts をタダで手に入れる
    const probe = await callToolWithPayment(undefined);
    const accepts = JSON.parse(await probe.text()).result.structuredContent
      .accepts as Array<Record<string, string>>;
    expect(accepts[0].payTo).toBe(PAY_TO);

    // 2) ウォレットも資金も正規購入も無しに、形だけ整えて捏造する
    const nowSeconds = Math.floor(Date.now() / 1000);
    const forged = {
      x402Version: 2,
      accepted: accepts[0],
      payload: {
        authorization: {
          from: "0x9999999999999999999999999999999999999999",
          to: accepts[0].payTo,
          value: accepts[0].amount,
          validAfter: "0",
          validBefore: String(nowSeconds + 300),
          nonce: `0x${"77".repeat(32)}`,
        },
        signature: `0x${"11".repeat(65)}`, // 署名として無効な出鱈目
      },
    };

    converse.mockClear();
    const settleCountBefore = facilitator.log.settle.length;
    await callToolWithPayment(forged);

    expect(facilitator.log.settle.length).toBe(settleCountBefore + 1);
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
