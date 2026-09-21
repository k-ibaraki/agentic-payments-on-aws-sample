import { describe, expect, it, vi } from "vitest";
import { EVAL_CASES } from "./eval-cases.js";
import { createBedrockJudge, createSystemOneJudge } from "./judge.js";
import { TIER_ORDER } from "./tiers.js";

// 判定器を実際のモデルに繋がずに確かめる。見るのは精度ではなく、評価セットの段が
// 判定器の出口まで結線されているかどうかである。実モデルが全件を同じ段に潰す事故
// （実測でたびたび起きた）は、モデルを差し替えているここでは捕まらない
describe("不具合チェック用の評価セット", () => {
  it("各段がちょうど1件ずつある", () => {
    const tiers = EVAL_CASES.map((c) => c.tier);
    expect([...tiers].sort()).toEqual([...TIER_ORDER].sort());
  });

  it("実測トークン数は段の順に増えている", () => {
    const byTier = new Map(EVAL_CASES.map((c) => [c.tier, c.measuredTokens]));
    for (let i = 1; i < TIER_ORDER.length; i++) {
      expect(byTier.get(TIER_ORDER[i])).toBeGreaterThan(
        byTier.get(TIER_ORDER[i - 1]) as number,
      );
    }
  });

  it("Bedrock の判定器が段どおりに答えれば全件一致する", async () => {
    const converse = vi.fn().mockImplementation((input) => {
      const state = JSON.stringify(input.messages);
      const hit = EVAL_CASES.find((c) => state.includes(c.prompt));
      return Promise.resolve({
        output: { message: { content: [{ text: hit?.tier ?? "take" }] } },
      });
    });
    const judge = createBedrockJudge(converse);
    for (const c of EVAL_CASES) {
      const result = await judge({
        toolName: "generate-html",
        state: c.prompt,
      });
      expect(result.tier).toBe(c.tier);
    }
  });

  it("System One の判定器でも順序尺度から同じ段に至る", async () => {
    const scores = { ume: 0.1, take: 1.0, matsu: 1.9 };
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: unknown }) => {
      const state = JSON.parse(String(init.body)).state as string;
      const hit = EVAL_CASES.find((c) => c.prompt === state);
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            tier: {
              type: "score",
              score: scores[hit?.tier ?? "take"],
              legend: {},
              probabilities: {},
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const judge = createSystemOneJudge({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for (const c of EVAL_CASES) {
      const result = await judge({
        toolName: "generate-html",
        state: c.prompt,
      });
      expect(result.tier).toBe(c.tier);
    }
  });

  // 全件を同じ段に潰す判定器を、テストが捕まえられること自体の確認
  it("段を作り分けない判定器は見逃さない", async () => {
    const judge = createBedrockJudge(
      vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: "ume" }] } },
      }),
    );
    const answers = await Promise.all(
      EVAL_CASES.map((c) =>
        judge({ toolName: "generate-html", state: c.prompt }).then(
          (r) => r.tier,
        ),
      ),
    );
    expect(new Set(answers).size).toBe(1);
    expect(answers).not.toEqual(EVAL_CASES.map((c) => c.tier));
  });
});
