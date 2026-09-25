import { describe, expect, it, vi } from "vitest";
import type { Judge } from "./judge.js";
import { PAID_TOOL_NAME, resolveQuote } from "./quote.js";
import { decodeQuote } from "./quote-format.js";
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
  it("判定モデルを呼んで価格帯を決め、見積書を作る", async () => {
    const judge = judgeReturning("matsu");
    const result = await resolveQuote(toolCall("予約システム"), {
      ...base,
      judge,
    });
    expect(result.tier).toBe("matsu");
    expect(result.price).toBe("$0.2");
    expect(decodeQuote(result.quote)).toEqual({ tier: "matsu", price: "$0.2" });
  });

  // 水準の記述が効いているかを実地で観測するため、確信度は呼び出し側まで運ぶ
  it("判定モデルが確信度を返せば見積もりに載せる", async () => {
    const judge: Judge = vi
      .fn()
      .mockResolvedValue({ tier: "take", confidence: 0.73 });
    const result = await resolveQuote(toolCall("FAQページ"), {
      ...base,
      judge,
    });
    expect(result.confidence).toBe(0.73);
  });

  // 買い手の画面で「どの判定モデルが決めたか」「判定できずに既定へ落ちたか」を見せる（決定65）
  it("判定モデルの名前と、既定へ落ちたかを見積もりに載せる", async () => {
    const named = await resolveQuote(toolCall("FAQページ"), {
      ...base,
      judge: vi.fn().mockResolvedValue({ tier: "take", model: "Jev" }),
    });
    expect(named.judgedBy).toBe("Jev");
    expect(named.fellBack).toBeUndefined();

    const fallen = await resolveQuote(toolCall("FAQページ"), {
      ...base,
      judge: vi.fn().mockResolvedValue({ tier: "take", fellBack: true }),
    });
    expect(fallen.judgedBy).toBeUndefined();
    expect(fallen.fellBack).toBe(true);
  });

  it("確信度を返さない判定モデルなら載せない", async () => {
    const result = await resolveQuote(toolCall("FAQページ"), {
      ...base,
      judge: judgeReturning("take"),
    });
    expect(result.confidence).toBeUndefined();
  });

  it("依頼文を判定モデルへ渡す", async () => {
    const judge = judgeReturning("ume");
    await resolveQuote(toolCall("連絡先ページ"), { ...base, judge });
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({ state: "連絡先ページ" }),
    );
  });
});

describe("支払い付きの呼び出し", () => {
  it("見積書が読めれば判定モデルを呼ばずに同じ価格帯を使う", async () => {
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
    // 判定していない往復では、判定の出所を名乗らない
    expect(result.judgedBy).toBeUndefined();
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
  it("有料ツール以外では判定モデルを呼ばない", async () => {
    const judge = judgeReturning("matsu");
    const result = await resolveQuote(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      { ...base, judge },
    );
    expect(judge).not.toHaveBeenCalled();
    expect(result.quote).toBeUndefined();
  });

  it("本文が壊れていても既定の価格帯で通す", async () => {
    const judge = judgeReturning("matsu");
    for (const body of ["", "{", "null", "[]"]) {
      expect((await resolveQuote(body, { ...base, judge })).tier).toBe("take");
    }
    expect(judge).not.toHaveBeenCalled();
  });

  it("依頼文が文字列でなければ判定モデルを呼ばない", async () => {
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
