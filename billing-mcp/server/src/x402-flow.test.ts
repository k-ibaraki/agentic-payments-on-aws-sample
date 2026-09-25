// 買い手（@x402/mcp の実クライアント）から売り手までを通す統合テスト。
// 署名は本物の EIP-3009 署名を作り、facilitator だけ偽物に差し替えるので、
// テスト USDC を消費せずに upfront フロー全体を検証できる。
// buy-once.ts と同じ経路を通るため、実決済の前段の確認になる
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
      // 価格帯の判定処理を固定する。既定のままだと生成用の偽 Converse を判定処理も使い、
      // 「生成が呼ばれていないこと」の検査が誤って落ちる（決定56 の結線後）
      judge: async () => ({ tier: "take", model: "Haiku" }),
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

  // これらの捏造が facilitator まで届くのを防ぐのが門番（payment-guard.ts、U9）の役目
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

  // 門番の限界を実行可能な形で残す（payment-guard.ts の説明、U9 参照）。
  // 塞いだら（EIP-712 署名のローカル復元）このテストが落ちるので、
  // 期待値を「settle まで届かない」へ書き換えること
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

  // 決定65: 買い手が progressToken を付けたときだけ、売り手の中の経過を SSE で途中に流す
  describe("経過の通知（notifications/progress）", () => {
    async function connectPlain() {
      const client = new Client({ name: "progress-buyer", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${ORIGIN}${MCP_PATH}`),
        { fetch: (url, init) => app(new Request(url, init)) },
      );
      await client.connect(transport);
      return client;
    }

    async function callWithProgress(meta?: Record<string, unknown>) {
      const client = await connectPlain();
      const messages: string[] = [];
      const result = await client.callTool(
        {
          name: "generate-html",
          arguments: { prompt: "門番テストの元にする購入" },
          ...(meta ? { _meta: meta } : {}),
        },
        undefined,
        { onprogress: (p) => messages.push(p.message ?? "") },
      );
      await client.close();
      return { result, messages };
    }

    it("1 往復目は判定の結果を、402 より先に知らせる", async () => {
      const { result, messages } = await callWithProgress();
      expect(result.isError).toBe(true);
      expect(messages).toEqual([
        "判定モデル Haiku が依頼を読み、価格帯を「竹」と判定しました",
      ]);
    });

    it("2 往復目は決済と生成の経過を知らせ、レシートは結果に載る", async () => {
      const payment = await capturePaymentPayload();
      const { result, messages } = await callWithProgress({
        "x402/payment": payment,
      });
      expect(messages).toEqual([
        "支払いの署名を受け取りました。中身を確かめています",
        "決済が確定しました。ページの生成を始めます",
        "ページを生成しました",
      ]);
      expect(
        (result._meta as Record<string, { success?: boolean }>)[
          "x402/payment-response"
        ]?.success,
      ).toBe(true);
    });

    it("決済が失敗したら生成の経過は流れない", async () => {
      const payment = await capturePaymentPayload();
      facilitator.failNextSettle();
      const { messages } = await callWithProgress({ "x402/payment": payment });
      expect(messages).toEqual([
        "支払いの署名を受け取りました。中身を確かめています",
      ]);
    });

    // 支払い付きの呼び出しで最初に流す通知（announcePricing）は、門番の検査より先に送られる。
    // そのため、門番が弾く支払いにも届くこの通知では、決済が確定したとは言わない
    it("門番が弾いた支払いには、決済の確定を知らせない", async () => {
      const payment = await capturePaymentPayload();
      payment.payload.authorization.validBefore = "1000000000";
      const { result, messages } = await callWithProgress({
        "x402/payment": payment,
      });
      expect(result.isError).toBe(true);
      expect(messages).toEqual([
        "支払いの署名を受け取りました。中身を確かめています",
      ]);
    });

    it("progressToken を付けなければ応答は従来どおり JSON", async () => {
      const response = await callToolWithPayment(await capturePaymentPayload());
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    });
  });
});
