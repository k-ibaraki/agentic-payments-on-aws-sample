import { describe, expect, it, vi } from "vitest";
import type { Judge } from "./judge.js";
import { PAID_TOOL_NAME, resolveQuote } from "./quote.js";
import { decodeQuote } from "./quote-seal.js";
import { DEFAULT_TIER_TABLE } from "./tiers.js";

const judgeReturning = (tier: "ume" | "take" | "matsu"): Judge =>
  vi.fn().mockResolvedValue({ tier });

function toolCall(prompt: string, quote?: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: PAID_TOOL_NAME,
      arguments: { prompt },
      ...(quote === undefined
        ? {}
        : { _meta: { "x402/payment": { accepted: { extra: { quote } } } } }),
    },
  });
}

const base = { table: DEFAULT_TIER_TABLE };

describe("支払いの無い呼び出し", () => {
  it("判定器を呼んで段を決め、見積書を作る", async () => {
    const judge = judgeReturning("matsu");
    const result = await resolveQuote(toolCall("予約システム"), {
      ...base,
      judge,
    });
    expect(result.tier).toBe("matsu");
    expect(result.price).toBe("$0.2");
    expect(decodeQuote(result.quote)).toEqual({ tier: "matsu", price: "$0.2" });
  });

  it("依頼文を判定器へ渡す", async () => {
    const judge = judgeReturning("ume");
    await resolveQuote(toolCall("連絡先ページ"), { ...base, judge });
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({ state: "連絡先ページ" }),
    );
  });
});

describe("支払い付きの呼び出し", () => {
  it("見積書が読めれば判定器を呼ばずに同じ段を使う", async () => {
    const judge = judgeReturning("ume");
    const result = await resolveQuote(
      toolCall("予約システム", "v1|matsu|$0.2"),
      {
        ...base,
        judge,
      },
    );
    expect(result.tier).toBe("matsu");
    expect(result.price).toBe("$0.2");
    expect(judge).not.toHaveBeenCalled();
  });

  // 価格表を差し替えた直後の古い見積書
  it("価格表と食い違う見積書なら判定し直す", async () => {
    const judge = judgeReturning("ume");
    const result = await resolveQuote(toolCall("連絡先", "v1|matsu|$9.99"), {
      ...base,
      judge,
    });
    expect(result.tier).toBe("ume");
    expect(judge).toHaveBeenCalledOnce();
  });

  it("見積書が壊れていても例外を投げずに判定し直す", async () => {
    const judge = judgeReturning("take");
    const result = await resolveQuote(toolCall("x", "壊れた見積書"), {
      ...base,
      judge,
    });
    expect(result.tier).toBe("take");
    expect(judge).toHaveBeenCalledOnce();
  });
});

describe("値付けの要らない呼び出し", () => {
  it("有料ツール以外では判定器を呼ばない", async () => {
    const judge = judgeReturning("matsu");
    const result = await resolveQuote(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      { ...base, judge },
    );
    expect(judge).not.toHaveBeenCalled();
    expect(result.quote).toBeUndefined();
  });

  it("本文が壊れていても既定の段で通す", async () => {
    const judge = judgeReturning("matsu");
    for (const body of ["", "{", "null", "[]"]) {
      expect((await resolveQuote(body, { ...base, judge })).tier).toBe("take");
    }
    expect(judge).not.toHaveBeenCalled();
  });

  it("依頼文が文字列でなければ判定器を呼ばない", async () => {
    const judge = judgeReturning("matsu");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: PAID_TOOL_NAME, arguments: { prompt: 42 } },
    });
    expect((await resolveQuote(body, { ...base, judge })).tier).toBe("take");
    expect(judge).not.toHaveBeenCalled();
  });
});
