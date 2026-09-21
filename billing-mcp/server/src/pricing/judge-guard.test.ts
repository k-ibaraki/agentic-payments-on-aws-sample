import { describe, expect, it, vi } from "vitest";
import {
  createJudgeBudget,
  JUDGE_STATE_LIMIT,
  withJudgeBudget,
} from "./judge-guard.js";

const ok = () => vi.fn().mockResolvedValue({ tier: "matsu" as const });

describe("判定器の呼び出し予算（U12）", () => {
  it("予算のうちは素通しする", async () => {
    const inner = ok();
    const judge = withJudgeBudget(inner, { capacity: 3, refillPerSecond: 0 });
    for (let i = 0; i < 3; i++) {
      expect((await judge({ toolName: "t", state: "s" })).tier).toBe("matsu");
    }
    expect(inner).toHaveBeenCalledTimes(3);
  });

  // 無認証の公開エンドポイントでは、支払う気のない相手が見積もりだけを繰り返せる
  it("予算を使い切ったら判定器を呼ばずに既定の段へ落とす", async () => {
    const inner = ok();
    const judge = withJudgeBudget(inner, { capacity: 2, refillPerSecond: 0 });
    await judge({ toolName: "t", state: "s" });
    await judge({ toolName: "t", state: "s" });
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("時間が経てば予算が戻る", async () => {
    const inner = ok();
    let now = 0;
    const judge = withJudgeBudget(inner, {
      capacity: 1,
      refillPerSecond: 1,
      now: () => now,
    });
    await judge({ toolName: "t", state: "s" });
    expect((await judge({ toolName: "t", state: "s" })).fellBack).toBe(true);
    now += 1_000;
    expect(
      (await judge({ toolName: "t", state: "s" })).fellBack,
    ).toBeUndefined();
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("予算は容量を超えて溜まらない", async () => {
    const inner = ok();
    let now = 0;
    const judge = withJudgeBudget(inner, {
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
    });
    now += 60_000;
    await judge({ toolName: "t", state: "s" });
    await judge({ toolName: "t", state: "s" });
    expect((await judge({ toolName: "t", state: "s" })).fellBack).toBe(true);
  });
});

describe("判定器へ渡す依頼文の長さ", () => {
  // 長い依頼文をそのまま渡すと、1回あたりの入力トークンで費用が伸びる
  it("上限を超える依頼文は切り詰めて渡す", async () => {
    const inner = ok();
    const judge = withJudgeBudget(inner, { capacity: 10, refillPerSecond: 0 });
    await judge({ toolName: "t", state: "あ".repeat(JUDGE_STATE_LIMIT + 500) });
    const passed = inner.mock.calls[0][0].state as string;
    expect(passed).toHaveLength(JUDGE_STATE_LIMIT);
  });

  it("上限以下ならそのまま渡す", async () => {
    const inner = ok();
    const judge = withJudgeBudget(inner, { capacity: 10, refillPerSecond: 0 });
    await judge({ toolName: "t", state: "短い依頼" });
    expect(inner.mock.calls[0][0].state).toBe("短い依頼");
  });
});

describe("予算の共有（決定58）", () => {
  // 判定器は価格表の指定で毎リクエスト選び直すが、バケツはコンテナに 1 つでなければ
  // 予算が毎回満タンに戻り、防護が無くなる
  it("同じ予算から包んだ判定器どうしはバケツを共有する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const budget = createJudgeBudget({
      capacity: 1,
      refillPerSecond: 0,
      now: () => 0,
    });
    const called = vi.fn().mockResolvedValue({ tier: "ume" });
    const first = budget.wrap(called);
    const second = budget.wrap(called);

    expect((await first({ toolName: "t", state: "s" })).tier).toBe("ume");
    const result = await second({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
    expect(called).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
