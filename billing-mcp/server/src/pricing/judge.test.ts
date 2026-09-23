import { describe, expect, it, vi } from "vitest";
import {
  createBedrockJudge,
  createSystemOneJudge,
  SYSTEM_ONE_MAX_RETRIES,
  SYSTEM_ONE_TIMEOUT_MS,
  scoreToTier,
  TIER_CONTEXT,
  TIER_CRITERIA,
  TIER_QUESTION,
} from "./judge.js";
import type { Tier } from "./quote-format.js";

/** Converse の戻りを、本文だけ差し替えて作る */
function converseReturning(text: string) {
  return vi.fn().mockResolvedValue({
    output: { message: { content: [{ text }] } },
  });
}

describe("Bedrock を使う判定処理", () => {
  it("価格帯の名前を答えればその価格帯になる", async () => {
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

  // 判定を誤ったときに損を被るのは売り手なので、読み取れないときは中央の価格帯に寄せる（決定56）
  it("読み取れない答えなら中央の価格帯に落とす", async () => {
    const judge = createBedrockJudge(converseReturning("わかりません"));
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
  });

  it("呼び出しが失敗しても投げずに中央の価格帯へ落とす", async () => {
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

describe("System One（Jev）を使う判定処理", () => {
  /** api.typesafe.ai が返す形の応答を作る（docs の API リファレンスどおり） */
  function systemOneResponse(score: number, confidence = 0.8) {
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          tier: {
            type: "score",
            score,
            legend: { "0": "梅", "1": "竹", "2": "松" },
            probabilities: { "0": 0, "1": 1, "2": 0 },
            confidence,
          },
        },
        usage: { input_tokens: 300, output_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /** SDK に渡す fetch。呼ばれた回数と本文を後から検められる */
  function fetchReturning(...responses: Response[]) {
    const queue = [...responses];
    return vi.fn(async () => queue.shift() ?? systemOneResponse(1));
  }

  it("順序尺度の値を価格帯に写す", async () => {
    const judge = createSystemOneJudge({
      apiKey: "k",
      fetchImpl: fetchReturning(systemOneResponse(2.0)),
    });
    expect((await judge({ toolName: "t", state: "s" })).tier).toBe("matsu");
  });

  it("依頼文を state として送る", async () => {
    const fetchImpl = fetchReturning(systemOneResponse(0.0));
    const judge = createSystemOneJudge({ apiKey: "k", fetchImpl });
    await judge({ toolName: "generate-html", state: "会社の連絡先ページ" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.state).toBe("会社の連絡先ページ");
    expect(body.model).toBe("jev-latest");
  });

  // Bedrock 側の前置きと同じ土台で判定させる（docs「構造化した質問定義」）
  it("問いと前置きを instructions の別の欄に分け、水準は価格帯の順に並べる", async () => {
    const fetchImpl = fetchReturning(systemOneResponse(1.0));
    const judge = createSystemOneJudge({ apiKey: "k", fetchImpl });
    await judge({ toolName: "t", state: "s" });
    const question = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
      .questions.tier;
    expect(question.type).toBe("score");
    expect(question.instructions.question).toBe(TIER_QUESTION);
    expect(question.instructions.context).toBe(TIER_CONTEXT);
    expect(question.criteria).toEqual([
      TIER_CRITERIA.ume,
      TIER_CRITERIA.take,
      TIER_CRITERIA.matsu,
    ]);
  });

  it("鍵を Authorization ヘッダに載せる", async () => {
    const fetchImpl = fetchReturning(systemOneResponse(1.0));
    const judge = createSystemOneJudge({ apiKey: "ts-secret-1", fetchImpl });
    await judge({ toolName: "t", state: "s" });
    const headers = new Headers(fetchImpl.mock.calls[0][1].headers);
    expect(headers.get("authorization")).toBe("Bearer ts-secret-1");
  });

  it("確信度をそのまま返す", async () => {
    const judge = createSystemOneJudge({
      apiKey: "k",
      fetchImpl: fetchReturning(systemOneResponse(1.0, 0.42)),
    });
    expect((await judge({ toolName: "t", state: "s" })).confidence).toBe(0.42);
  });

  // 鍵切れと過負荷を同じ一行に潰さない
  it("HTTP エラーならその旨を残して中央の価格帯へ落とす", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = createSystemOneJudge({
      apiKey: "k",
      maxRetries: 0,
      fetchImpl: fetchReturning(
        new Response(JSON.stringify({ error: "bad key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toContain("401");
    warn.mockRestore();
  });

  // docs の案内どおり、過負荷は一度だけ待って投げ直す
  it("429 は再送し、通れば価格帯を返す", async () => {
    const fetchImpl = fetchReturning(
      new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } }),
      systemOneResponse(0.0),
    );
    const judge = createSystemOneJudge({ apiKey: "k", fetchImpl });
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("ume");
    expect(result.fellBack).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("繋がらなくても投げずに中央の価格帯へ落とす", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = createSystemOneJudge({
      apiKey: "k",
      maxRetries: 0,
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
    warn.mockRestore();
  });

  // 402 の経路は買い手が待つ区間なので、待ちに天井が要る
  it("待ちと再送の既定は控えめにする", () => {
    expect(SYSTEM_ONE_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    expect(SYSTEM_ONE_MAX_RETRIES).toBeLessThanOrEqual(1);
  });
});

describe("価格帯の読み取りの寛容さ", () => {
  // 完全一致だと `take。` のような些細な飾りで中央へ落ち、静かに価格へ響く
  it("飾りが付いていても価格帯を読み取れる", async () => {
    const cases: Array<[string, Tier]> = [
      ["take。", "take"],
      ["`matsu`", "matsu"],
      ["答え: ume", "ume"],
      ["TAKE\n", "take"],
    ];
    for (const [text, tier] of cases) {
      const judge = createBedrockJudge(converseReturning(text));
      expect((await judge({ toolName: "t", state: "s" })).tier).toBe(tier);
    }
  });

  it("複数の価格帯が混ざっていれば読み取れない扱いにする", async () => {
    const judge = createBedrockJudge(converseReturning("ume か matsu で迷う"));
    const result = await judge({ toolName: "t", state: "s" });
    expect(result.tier).toBe("take");
    expect(result.fellBack).toBe(true);
  });

  // "document" は部分文字列として "ume" を含む。語の切れ目で拾う
  it("別の語の一部に価格帯の名前が紛れても拾わない", async () => {
    const judge = createBedrockJudge(converseReturning("document"));
    expect((await judge({ toolName: "t", state: "s" })).fellBack).toBe(true);
  });

  it("答えが複数のブロックに分かれていても読み取れる", async () => {
    const judge = createBedrockJudge(
      vi.fn().mockResolvedValue({
        output: { message: { content: [{ text: "" }, { text: "matsu" }] } },
      }),
    );
    expect((await judge({ toolName: "t", state: "s" })).tier).toBe("matsu");
  });
});

describe("順序尺度から価格帯への写し", () => {
  it("水準の中間が境になる", () => {
    expect(scoreToTier(0.49)).toBe("ume");
    expect(scoreToTier(0.5)).toBe("take");
    expect(scoreToTier(1.49)).toBe("take");
    expect(scoreToTier(1.5)).toBe("matsu");
  });

  it("範囲の外に出た値は端の価格帯に収める", () => {
    expect(scoreToTier(-1)).toBe("ume");
    expect(scoreToTier(9)).toBe("matsu");
  });

  // export した関数が `Tier` を名乗って undefined を返さないこと
  it("有限でない値は中央の価格帯に収める", () => {
    expect(scoreToTier(Number.NaN)).toBe("take");
    expect(scoreToTier(Number.POSITIVE_INFINITY)).toBe("take");
  });
});
