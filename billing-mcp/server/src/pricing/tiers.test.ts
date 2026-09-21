import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_TABLE,
  generationBudgetOf,
  parseTierTable,
  priceOf,
  quoteDisclosure,
  sizeHintOf,
  targetTokensOf,
  tierLabel,
} from "./tiers.js";

describe("既定の価格表", () => {
  it("梅・竹・松の3段を持つ", () => {
    expect(Object.keys(DEFAULT_TIER_TABLE.tiers)).toEqual([
      "ume",
      "take",
      "matsu",
    ]);
  });

  it("仮置きの価格は 0.1 / 0.15 / 0.2 ドル", () => {
    expect(priceOf(DEFAULT_TIER_TABLE, "ume")).toBe("$0.1");
    expect(priceOf(DEFAULT_TIER_TABLE, "take")).toBe("$0.15");
    expect(priceOf(DEFAULT_TIER_TABLE, "matsu")).toBe("$0.2");
  });

  it("目安トークン数は決定56 の 5000 / 8000 / 12000", () => {
    expect(targetTokensOf(DEFAULT_TIER_TABLE, "ume")).toBe(5_000);
    expect(targetTokensOf(DEFAULT_TIER_TABLE, "take")).toBe(8_000);
    expect(targetTokensOf(DEFAULT_TIER_TABLE, "matsu")).toBe(12_000);
  });

  it("表示名は日本語の梅・竹・松", () => {
    expect(tierLabel("ume")).toBe("梅");
    expect(tierLabel("take")).toBe("竹");
    expect(tierLabel("matsu")).toBe("松");
  });
});

describe("生成に添える規模の指示", () => {
  it("目安トークン数を含む", () => {
    expect(sizeHintOf(DEFAULT_TIER_TABLE, "take")).toContain("8000");
  });

  // 打ち切ると閉じタグ欠落のHTMLが黙って返るため、上限ではなく目安として伝える（決定56）
  it("上限としてではなく規模の目安として伝える", () => {
    const hint = sizeHintOf(DEFAULT_TIER_TABLE, "ume");
    expect(hint).toContain("程度");
    expect(hint).not.toContain("以内");
  });
});

describe("parseTierTable（AppConfig から読む想定）", () => {
  const valid = {
    tiers: {
      ume: { price: "$0.2", targetTokens: 4_000 },
      take: { price: "$0.3", targetTokens: 9_000 },
      matsu: { price: "$0.4", targetTokens: 15_000 },
    },
  };

  it("妥当な表を読める", () => {
    const table = parseTierTable(valid);
    expect(priceOf(table, "take")).toBe("$0.3");
    expect(targetTokensOf(table, "matsu")).toBe(15_000);
  });

  it("段が欠けていれば読まない", () => {
    const { ume, ...rest } = valid.tiers;
    expect(parseTierTable({ tiers: rest })).toBeUndefined();
  });

  it("価格の形が違えば読まない", () => {
    expect(
      parseTierTable({
        tiers: { ...valid.tiers, ume: { price: "0.2", targetTokens: 4_000 } },
      }),
    ).toBeUndefined();
  });

  it("目安トークン数が段の順に増えていなければ読まない", () => {
    expect(
      parseTierTable({
        tiers: { ...valid.tiers, take: { price: "$0.3", targetTokens: 3_000 } },
      }),
    ).toBeUndefined();
  });

  it("壊れた入力でも例外を投げずに undefined を返す", () => {
    for (const broken of [null, undefined, 1, "x", {}, { tiers: null }]) {
      expect(parseTierTable(broken)).toBeUndefined();
    }
  });
});

describe("generationBudgetOf（生成に渡す予算）", () => {
  it("規模の指示と maxTokens を一緒に返す", () => {
    const budget = generationBudgetOf(DEFAULT_TIER_TABLE, "take");
    expect(budget.sizeHint).toContain("8000");
    expect(budget.maxTokens).toBeGreaterThan(8_000);
  });

  // 打ち切ると閉じタグ欠落のHTMLが黙って返るため、目安に対して十分な余裕を確保する（決定56）
  it("maxTokens は目安の3倍以上を確保する", () => {
    for (const tier of ["ume", "take", "matsu"] as const) {
      const budget = generationBudgetOf(DEFAULT_TIER_TABLE, tier);
      expect(budget.maxTokens).toBeGreaterThanOrEqual(
        targetTokensOf(DEFAULT_TIER_TABLE, tier) * 3,
      );
    }
  });

  it("モデルの出力上限は超えない", () => {
    const huge = {
      tiers: {
        ume: { price: "$0.1", targetTokens: 30_000 },
        take: { price: "$0.15", targetTokens: 40_000 },
        matsu: { price: "$0.2", targetTokens: 50_000 },
      },
    };
    expect(generationBudgetOf(huge, "matsu").maxTokens).toBe(64_000);
  });
});

describe("買い手への根拠の開示（決定56）", () => {
  it("段と分量と価格を一文で示す", () => {
    const text = quoteDisclosure(DEFAULT_TIER_TABLE, "take");
    expect(text).toContain("竹");
    expect(text).toContain("8000");
    expect(text).toContain("$0.15");
  });

  // 品質の等級ではなく、依頼が求める規模の見立てであることを明示する
  it("値引きや簡素版とは読めない言い方にする", () => {
    const text = quoteDisclosure(DEFAULT_TIER_TABLE, "ume");
    expect(text).toContain("ご依頼の内容");
    expect(text).not.toContain("簡素");
    expect(text).not.toContain("値引き");
  });
});
