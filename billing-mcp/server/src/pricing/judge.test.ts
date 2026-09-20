import { describe, expect, it, vi } from "vitest";
import {
  createBedrockJudge,
  createSystemOneJudge,
  TIER_CRITERIA,
} from "./judge.js";

/** Converse の戻りを、本文だけ差し替えて作る */
function converseReturning(text: string) {
  return vi.fn().mockResolvedValue({
    output: { message: { content: [{ text }] } },
  });
}

describe("Bedrock を使う判定器", () => {
  it("段の名前を答えればその段になる", async () => {
    const judge = createBedrockJudge(converseReturning("take"));
    const result = await judge({
      toolName: "generate-html",
      state: "FAQページ",
    });
    expect(result.tier).toBe("take");
  });

  it("前後に空白や改行があっても読み取れる", async () => {
    const judge = createBedrockJudge(converseReturning("  matsu\n"));
    expect((await judge({ toolName: "t", state: "s" })).tier).toBe("matsu");
  });

  // 判定を誤ったときに損を被るのは売り手なので、読み取れないときは中央の段に寄せる（決定56）
  it("読み取れない答えなら中央の段に落とす", async () => {
    const judge = createBedrockJudge(converseReturning("わかりません"));
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
  });

  it("呼び出しが失敗しても投げずに中央の段へ落とす", async () => {
    const judge = createBedrockJudge(
      vi.fn().mockRejectedValue(new Error("boom")),
    );
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
  });

  it("依頼文をそのままモデルへ渡す", async () => {
    const converse = converseReturning("ume");
    const judge = createBedrockJudge(converse);
    await judge({ toolName: "generate-html", state: "会社の連絡先ページ" });
    const input = converse.mock.calls[0][0];
    expect(JSON.stringify(input.messages)).toContain("会社の連絡先ページ");
  });
});

describe("System One（Jev 互換）を使う判定器", () => {
  // 2026-09-20 に jev_local で実地に確かめたワイヤ形式に合わせる
  function fetchReturning(body: unknown) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    } as unknown as Response);
  }

  const scoreAnswer = (score: number) => ({
    model: "jev-1.13.0",
    answers: { tier: { type: "score", score, confidence: 0.8 } },
  });

  it("順序尺度の値を段へ写す", async () => {
    const judge = createSystemOneJudge({
      url: "http://example.test/v1/systemone",
      apiKey: "k",
      fetchImpl: fetchReturning(scoreAnswer(0.2)),
    });
    expect((await judge({ toolName: "t", state: "s" })).tier).toBe("ume");
  });

  it("中ほどの値は竹になる", async () => {
    const judge = createSystemOneJudge({
      url: "http://example.test/v1/systemone",
      apiKey: "k",
      fetchImpl: fetchReturning(scoreAnswer(1.1)),
    });
    expect((await judge({ toolName: "t", state: "s" })).tier).toBe("take");
  });

  it("高い値は松になる", async () => {
    const judge = createSystemOneJudge({
      url: "http://example.test/v1/systemone",
      apiKey: "k",
      fetchImpl: fetchReturning(scoreAnswer(1.9)),
    });
    expect((await judge({ toolName: "t", state: "s" })).tier).toBe("matsu");
  });

  it("段の説明を順序どおりに criteria へ載せる", async () => {
    const fetchImpl = fetchReturning(scoreAnswer(1.0));
    const judge = createSystemOneJudge({
      url: "http://example.test/v1/systemone",
      apiKey: "k",
      fetchImpl,
    });
    await judge({ toolName: "t", state: "s" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.questions.tier.type).toBe("score");
    expect(body.questions.tier.criteria).toEqual([
      TIER_CRITERIA.ume,
      TIER_CRITERIA.take,
      TIER_CRITERIA.matsu,
    ]);
  });

  it("応答が壊れていれば中央の段へ落とす", async () => {
    const judge = createSystemOneJudge({
      url: "http://example.test/v1/systemone",
      apiKey: "k",
      fetchImpl: fetchReturning({ answers: {} }),
    });
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
  });

  it("接続に失敗しても投げずに中央の段へ落とす", async () => {
    const judge = createSystemOneJudge({
      url: "http://example.test/v1/systemone",
      apiKey: "k",
      fetchImpl: vi.fn().mockRejectedValue(new Error("unreachable")),
    });
    expect((await judge({ toolName: "t", state: "s" })).fellBack).toBe(true);
  });
});
