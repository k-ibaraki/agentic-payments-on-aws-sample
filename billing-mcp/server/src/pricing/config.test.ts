import { describe, expect, it, vi } from "vitest";
import {
  APPCONFIG_EXTENSION_PORT,
  appConfigEndpoint,
  createTierTableLoader,
} from "./config.js";
import { DEFAULT_TIER_TABLE, priceOf } from "./tiers.js";

const VALID = {
  tiers: {
    ume: { price: "$0.2", targetTokens: 4_000 },
    take: { price: "$0.3", targetTokens: 9_000 },
    matsu: { price: "$0.4", targetTokens: 15_000 },
  },
};

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as unknown as Response);
}

describe("appConfigEndpoint", () => {
  it("Lambda 拡張の待ち受け先を組み立てる", () => {
    const url = appConfigEndpoint({
      application: "billing-mcp",
      environment: "prod",
      profile: "pricing",
    });
    expect(url).toBe(
      `http://localhost:${APPCONFIG_EXTENSION_PORT}` +
        "/applications/billing-mcp/environments/prod/configurations/pricing",
    );
  });
});

describe("価格表の読み込み", () => {
  const options = { endpoint: "http://localhost:2772/x", ttlMs: 1_000 };

  it("妥当な設定を読む", async () => {
    const load = createTierTableLoader({
      ...options,
      fetchImpl: fetchReturning(VALID),
    });
    expect(priceOf(await load(), "take")).toBe("$0.3");
  });

  // 設定の書き損じで売り手が止まるより、既定の表で売り続けるほうが害が小さい
  it("設定が壊れていれば既定の表を使う", async () => {
    const load = createTierTableLoader({
      ...options,
      fetchImpl: fetchReturning({ tiers: { ume: { price: "0.2" } } }),
    });
    expect(await load()).toEqual(DEFAULT_TIER_TABLE);
  });

  it("取得に失敗しても既定の表を使う", async () => {
    const load = createTierTableLoader({
      ...options,
      fetchImpl: vi.fn().mockRejectedValue(new Error("unreachable")),
    });
    expect(await load()).toEqual(DEFAULT_TIER_TABLE);
  });

  it("応答が 200 でなければ既定の表を使う", async () => {
    const load = createTierTableLoader({
      ...options,
      fetchImpl: fetchReturning(VALID, false),
    });
    expect(await load()).toEqual(DEFAULT_TIER_TABLE);
  });

  it("有効期間のうちは取得し直さない", async () => {
    const fetchImpl = fetchReturning(VALID);
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      fetchImpl,
      now: () => now,
    });
    await load();
    await load();
    now += 500;
    await load();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("有効期間を過ぎたら取得し直す", async () => {
    const fetchImpl = fetchReturning(VALID);
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      fetchImpl,
      now: () => now,
    });
    await load();
    now += 1_001;
    await load();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // 一度読めた表は、その後の取得が失敗しても使い続ける
  it("取得に失敗したら直前に読めた表を保つ", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => VALID } as Response)
      .mockRejectedValue(new Error("unreachable"));
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      fetchImpl,
      now: () => now,
    });
    expect(priceOf(await load(), "take")).toBe("$0.3");
    now += 1_001;
    expect(priceOf(await load(), "take")).toBe("$0.3");
  });
});
