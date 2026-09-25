import { describe, expect, it, vi } from "vitest";
import {
  announceGeneration,
  announcePricing,
  pricingMessage,
  progressReporter,
  wantsProgress,
} from "./progress.js";

/** ツール呼び出しの extra を、経過の通知に要る部分だけ組む */
function extraWith(
  options: { progressToken?: string | number; payment?: unknown } = {},
) {
  const sendNotification = vi.fn().mockResolvedValue(undefined);
  const meta: Record<string, unknown> = {};
  if (options.progressToken !== undefined)
    meta.progressToken = options.progressToken;
  if (options.payment !== undefined) meta["x402/payment"] = options.payment;
  return { extra: { _meta: meta, sendNotification }, sendNotification };
}

function messagesOf(sendNotification: ReturnType<typeof vi.fn>): string[] {
  return sendNotification.mock.calls.map(([n]) => n.params.message);
}

describe("progressReporter", () => {
  it("progressToken があれば notifications/progress を送る", async () => {
    const { extra, sendNotification } = extraWith({ progressToken: "t-1" });
    await progressReporter(extra)("生成を始めます");
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: expect.objectContaining({
        progressToken: "t-1",
        message: "生成を始めます",
      }),
    });
  });

  // MCP の仕様: progress の値は同じトークンの中で増え続けなければならない
  it("progress の値は送るたびに増える", async () => {
    const { extra, sendNotification } = extraWith({ progressToken: 7 });
    const report = progressReporter(extra);
    await report("一");
    await progressReporter(extra)("二");
    const [first, second] = sendNotification.mock.calls.map(
      ([n]) => n.params.progress,
    );
    expect(second).toBeGreaterThan(first);
  });

  // 付けないクライアント（他の MCP クライアント・古い買い手）には何も流さない
  it("progressToken が無ければ何も送らない", async () => {
    const { extra, sendNotification } = extraWith();
    await progressReporter(extra)("生成を始めます");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // 経過の通知は飾り。届かなくても売り買いは止めない
  it("送れなくても投げない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const extra = {
      _meta: { progressToken: "t" },
      sendNotification: vi.fn().mockRejectedValue(new Error("closed")),
    };
    await expect(progressReporter(extra)("x")).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("wantsProgress", () => {
  const call = (meta?: Record<string, unknown>) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "generate-html",
        arguments: {},
        ...(meta ? { _meta: meta } : {}),
      },
    });

  it("依頼に progressToken があれば真", () => {
    expect(wantsProgress(call({ progressToken: "t" }))).toBe(true);
    expect(wantsProgress(call({ progressToken: 0 }))).toBe(true);
  });

  it("progressToken が無い・本文が壊れているなら偽", () => {
    expect(wantsProgress(call())).toBe(false);
    expect(wantsProgress(call({ "x402/payment": {} }))).toBe(false);
    for (const body of ["", "{", "null", "[]"])
      expect(wantsProgress(body)).toBe(false);
  });

  it("バッチのどれかに付いていれば真", () => {
    const batch = `[${call()},${call({ progressToken: "t" })}]`;
    expect(wantsProgress(batch)).toBe(true);
  });
});

describe("pricingMessage", () => {
  it("判定モデルの名前と価格帯を言う", () => {
    expect(pricingMessage({ tier: "take", judgedBy: "Jev" })).toBe(
      "判定モデル Jev が依頼を読み、価格帯を「竹」と判定しました",
    );
  });

  it("既定へ落ちたときはそう言う", () => {
    expect(pricingMessage({ tier: "take", fellBack: true })).toBe(
      "価格帯を判定できなかったため、既定の「竹」にしました",
    );
  });

  // 見積書を読んだだけの往復（判定していない）では、判定の話をしない
  it("判定していなければ何も言わない", () => {
    expect(pricingMessage({ tier: "take" })).toBeUndefined();
  });
});

describe("announcePricing", () => {
  const ok = { content: [{ type: "text" as const, text: "ok" }] };

  it("支払いの無い呼び出しでは、判定の結果を知らせてから処理へ進む", async () => {
    const { extra, sendNotification } = extraWith({ progressToken: "t" });
    const handler = vi.fn().mockResolvedValue(ok);
    const result = await announcePricing(handler, {
      tier: "matsu",
      judgedBy: "Haiku",
    })({}, extra);
    expect(result).toBe(ok);
    expect(messagesOf(sendNotification)).toEqual([
      "判定モデル Haiku が依頼を読み、価格帯を「松」と判定しました",
    ]);
  });

  it("支払い付きの呼び出しでは、署名を受け取って決済に進むことを知らせる", async () => {
    const { extra, sendNotification } = extraWith({
      progressToken: "t",
      payment: { x: 1 },
    });
    await announcePricing(vi.fn().mockResolvedValue(ok), { tier: "take" })(
      {},
      extra,
    );
    expect(messagesOf(sendNotification)).toEqual([
      "支払いの署名を受け取りました。決済を確定しています",
    ]);
  });

  it("判定の情報が無く支払いも無ければ何も知らせない", async () => {
    const { extra, sendNotification } = extraWith({ progressToken: "t" });
    await announcePricing(vi.fn().mockResolvedValue(ok), undefined)({}, extra);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("announceGeneration", () => {
  it("生成の前後を知らせる", async () => {
    const { extra, sendNotification } = extraWith({ progressToken: "t" });
    const handler = vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await announceGeneration(handler)({ prompt: "p" }, extra);
    expect(handler).toHaveBeenCalledWith({ prompt: "p" }, extra);
    expect(messagesOf(sendNotification)).toEqual([
      "決済が確定しました。ページの生成を始めます",
      "ページを生成しました",
    ]);
  });

  // @x402/mcp は内側のハンドラに { toolName, arguments, meta } しか渡さず、sendNotification が落ちる。
  // 外側の包み（announcePricing）が作った報告の口を引き継いで知らせる
  it("支払いラッパーが extra を差し替えても、外側の口で知らせる", async () => {
    const { extra, sendNotification } = extraWith({
      progressToken: "t",
      payment: { x: 1 },
    });
    const inner = announceGeneration(
      vi.fn().mockResolvedValue({ content: [] }),
    );
    const paidLike = (args: unknown, e: { _meta?: unknown }) =>
      inner(args, {
        toolName: "generate-html",
        arguments: args,
        meta: e._meta,
      });
    await announcePricing(paidLike, undefined)({}, extra);
    expect(messagesOf(sendNotification)).toEqual([
      "支払いの署名を受け取りました。決済を確定しています",
      "決済が確定しました。ページの生成を始めます",
      "ページを生成しました",
    ]);
  });

  it("生成に失敗したら、失敗したと知らせる", async () => {
    const { extra, sendNotification } = extraWith({ progressToken: "t" });
    const handler = vi.fn().mockResolvedValue({ isError: true, content: [] });
    await announceGeneration(handler)({}, extra);
    expect(messagesOf(sendNotification)).toEqual([
      "決済が確定しました。ページの生成を始めます",
      "ページの生成に失敗しました",
    ]);
  });
});
