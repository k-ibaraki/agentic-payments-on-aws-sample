import { describe, expect, it, vi } from "vitest";
import type { Judge } from "./judge.js";
import { PAID_TOOL_NAME, QUOTE_TTL_SECONDS, resolveQuote } from "./quote.js";
import { fingerprintArgs, openQuoteSeal } from "./quote-seal.js";
import { DEFAULT_TIER_TABLE } from "./tiers.js";

const KEY = "seal-key-for-test";
const NOW = 1_800_000_000;

const judgeReturning = (tier: "ume" | "take" | "matsu"): Judge =>
  vi.fn().mockResolvedValue({ tier });

function toolCall(args: unknown, meta?: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: PAID_TOOL_NAME,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    },
  });
}

const base = { table: DEFAULT_TIER_TABLE, key: KEY, nowSeconds: NOW };

describe("支払いの無い呼び出し", () => {
  it("判定器を呼んで段を決め、封を作る", async () => {
    const judge = judgeReturning("matsu");
    const quote = await resolveQuote(toolCall({ prompt: "予約システム" }), {
      ...base,
      judge,
    });
    expect(quote.tier).toBe("matsu");
    expect(quote.price).toBe("$0.2");
    expect(judge).toHaveBeenCalledOnce();
    expect(quote.seal).toBeDefined();
  });

  it("作った封は同じ引数でのみ開く", async () => {
    const args = { prompt: "予約システム" };
    const quote = await resolveQuote(toolCall(args), {
      ...base,
      judge: judgeReturning("take"),
    });
    const opened = openQuoteSeal(quote.seal as string, {
      toolName: PAID_TOOL_NAME,
      argsFingerprint: fingerprintArgs(args),
      key: KEY,
      nowSeconds: NOW,
    });
    expect(opened?.tier).toBe("take");
    expect(opened?.expiresAt).toBe(NOW + QUOTE_TTL_SECONDS);
  });

  it("依頼文を判定器へ渡す", async () => {
    const judge = judgeReturning("ume");
    await resolveQuote(toolCall({ prompt: "連絡先ページ" }), {
      ...base,
      judge,
    });
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({ state: "連絡先ページ" }),
    );
  });
});

describe("支払い付きの呼び出し", () => {
  async function quoteWithSeal(args: unknown, tier: "ume" | "take" | "matsu") {
    const first = await resolveQuote(toolCall(args), {
      ...base,
      judge: judgeReturning(tier),
    });
    return first.seal as string;
  }

  it("封が通れば判定器を呼ばずに同じ段を使う", async () => {
    const args = { prompt: "予約システム" };
    const seal = await quoteWithSeal(args, "matsu");
    const judge = judgeReturning("ume");
    const quote = await resolveQuote(
      toolCall(args, {
        "x402/payment": { accepted: { extra: { quote: seal } } },
      }),
      { ...base, judge },
    );
    expect(quote.tier).toBe("matsu");
    expect(judge).not.toHaveBeenCalled();
  });

  // 安い封を高い依頼に付け替える細工（決定55）
  it("封と引数が食い違えば判定し直す", async () => {
    const seal = await quoteWithSeal({ prompt: "連絡先ページ" }, "ume");
    const judge = judgeReturning("matsu");
    const quote = await resolveQuote(
      toolCall(
        { prompt: "予約システム" },
        {
          "x402/payment": { accepted: { extra: { quote: seal } } },
        },
      ),
      { ...base, judge },
    );
    expect(quote.tier).toBe("matsu");
    expect(judge).toHaveBeenCalledOnce();
  });

  it("期限切れの封なら判定し直す", async () => {
    const args = { prompt: "予約システム" };
    const seal = await quoteWithSeal(args, "matsu");
    const judge = judgeReturning("ume");
    const quote = await resolveQuote(
      toolCall(args, {
        "x402/payment": { accepted: { extra: { quote: seal } } },
      }),
      { ...base, judge, nowSeconds: NOW + QUOTE_TTL_SECONDS + 1 },
    );
    expect(quote.tier).toBe("ume");
    expect(judge).toHaveBeenCalledOnce();
  });

  it("封が壊れていても例外を投げずに判定し直す", async () => {
    const judge = judgeReturning("take");
    const quote = await resolveQuote(
      toolCall(
        { prompt: "x" },
        { "x402/payment": { accepted: { extra: { quote: "壊れた封" } } } },
      ),
      { ...base, judge },
    );
    expect(quote.tier).toBe("take");
  });
});

describe("値付けの要らない呼び出し", () => {
  it("有料ツール以外の呼び出しでは判定器を呼ばない", async () => {
    const judge = judgeReturning("matsu");
    const quote = await resolveQuote(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      { ...base, judge },
    );
    expect(judge).not.toHaveBeenCalled();
    expect(quote.seal).toBeUndefined();
  });

  it("本文が壊れていても既定の段で通す", async () => {
    const judge = judgeReturning("matsu");
    for (const body of ["", "{", "null", "[]"]) {
      const quote = await resolveQuote(body, { ...base, judge });
      expect(quote.tier).toBe("take");
    }
    expect(judge).not.toHaveBeenCalled();
  });

  it("依頼文が文字列でなければ判定器を呼ばない", async () => {
    const judge = judgeReturning("matsu");
    const quote = await resolveQuote(toolCall({ prompt: 42 }), {
      ...base,
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(quote.tier).toBe("take");
  });
});
