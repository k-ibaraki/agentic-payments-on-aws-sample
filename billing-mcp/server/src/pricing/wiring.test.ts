// 段の値付けが HTTP 層まで通っていることの確認（DESIGN.md 決定55・56）。
// facilitator だけ偽物にして、402 応答の中身と 2 往復目の挙動を見る。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpFetchHandler, MCP_PATH } from "../app.js";
import { startFakeFacilitator } from "../testing/fake-facilitator.js";
import type { Judge } from "./judge.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const ORIGIN = "https://billing-mcp.example.test";

describe("段に応じた値付けの結線", () => {
  let facilitator: Awaited<ReturnType<typeof startFakeFacilitator>>;

  beforeAll(async () => {
    facilitator = await startFakeFacilitator();
  });
  afterAll(() => facilitator.close());

  /** 支払い無しでツールを呼び、402 の accepts を取り出す */
  async function requestQuote(judge: Judge, prompt: string, meta?: unknown) {
    const app = createMcpFetchHandler({
      facilitatorUrl: facilitator.url,
      payTo: PAY_TO,
      converse: vi.fn(),
      judge,
      loadUiHtml: () => "<html></html>",
    });
    const response = await app(
      new Request(`${ORIGIN}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "generate-html",
            arguments: { prompt },
            ...(meta === undefined ? {} : { _meta: meta }),
          },
        }),
      }),
    );
    const json = (await response.json()) as {
      result?: {
        structuredContent?: { accepts?: Array<Record<string, unknown>> };
      };
    };
    return json.result?.structuredContent?.accepts?.[0];
  }

  it("松と判じれば松の価格が提示される", async () => {
    const accepted = await requestQuote(
      async () => ({ tier: "matsu" }),
      "予約システム",
    );
    // $0.2 を USDC の最小単位（6桁）で表した額
    expect(accepted?.amount).toBe("200000");
  });

  it("梅と判じれば梅の価格が提示される", async () => {
    const accepted = await requestQuote(
      async () => ({ tier: "ume" }),
      "連絡先ページ",
    );
    expect(accepted?.amount).toBe("100000");
  });

  it("提示に見積書の封が載る", async () => {
    const accepted = await requestQuote(
      async () => ({ tier: "take" }),
      "FAQページ",
    );
    const extra = accepted?.extra as Record<string, unknown> | undefined;
    expect(typeof extra?.quote).toBe("string");
    expect(extra?.quote).toContain("take");
  });

  it("402 応答に段の根拠が載る（決定56）", async () => {
    const app = createMcpFetchHandler({
      facilitatorUrl: facilitator.url,
      payTo: PAY_TO,
      converse: vi.fn(),
      judge: async () => ({ tier: "matsu" }),
      loadUiHtml: () => "<html></html>",
    });
    const response = await app(
      new Request(`${ORIGIN}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "generate-html",
            arguments: { prompt: "予約システム" },
          },
        }),
      }),
    );
    const text = await response.text();
    expect(text).toContain("12000 トークン相当");
    expect(text).toContain("松");
    expect(text).toContain("$0.2");
  });

  it("封を返せば判定器を呼ばずに同じ額が出る", async () => {
    const first = await requestQuote(
      async () => ({ tier: "matsu" }),
      "予約システム",
    );
    const seal = (first?.extra as Record<string, unknown> | undefined)
      ?.quote as string;

    const judge = vi.fn().mockResolvedValue({ tier: "ume" });
    const second = await requestQuote(judge, "予約システム", {
      "x402/payment": { accepted: { extra: { quote: seal } } },
    });
    expect(second?.amount).toBe("200000");
    expect(judge).not.toHaveBeenCalled();
  });
});
