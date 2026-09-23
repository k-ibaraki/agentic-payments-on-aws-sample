import { describe, expect, it } from "vitest";
import {
  decodeQuote,
  encodeQuote,
  matchesTable,
  type Quote,
} from "./quote-format.js";
import { DEFAULT_TIER_TABLE } from "./tiers.js";

const QUOTE: Quote = { tier: "take", price: "$0.15" };

describe("見積書の往復", () => {
  it("書き出して読み戻すと同じ中身になる", () => {
    expect(decodeQuote(encodeQuote(QUOTE))).toEqual(QUOTE);
  });

  it("3つの価格帯のいずれも往復できる", () => {
    for (const tier of ["ume", "take", "matsu"] as const) {
      const quote = { tier, price: "$0.1" };
      expect(decodeQuote(encodeQuote(quote))).toEqual(quote);
    }
  });

  // 価格は "$0.15" のように小数点を含むので、区切りに `.` を使うと割れる
  it("小数点を含む価格でも壊れない", () => {
    expect(decodeQuote(encodeQuote({ tier: "ume", price: "$0.125" }))).toEqual({
      tier: "ume",
      price: "$0.125",
    });
  });
});

describe("読めない見積書", () => {
  it("形が壊れていれば読まない", () => {
    for (const broken of ["", "v1", "v1|take", "||", "not-a-quote"]) {
      expect(decodeQuote(broken)).toBeUndefined();
    }
  });

  it("知らない価格帯は読まない", () => {
    expect(decodeQuote("v1|gold|$0.15")).toBeUndefined();
  });

  it("価格の形が違えば読まない", () => {
    expect(decodeQuote("v1|take|0.15")).toBeUndefined();
  });

  it("版が違えば読まない", () => {
    expect(decodeQuote("v0|take|$0.15")).toBeUndefined();
  });

  it("文字列でなければ読まない", () => {
    for (const value of [undefined, null, 1, {}, []]) {
      expect(decodeQuote(value)).toBeUndefined();
    }
  });
});

describe("価格表との整合", () => {
  it("表どおりの価格なら使う", () => {
    expect(matchesTable(QUOTE, DEFAULT_TIER_TABLE)).toBe(true);
  });

  // 価格表が差し替わった直後の古い見積書を弾く
  it("表と食い違う価格は使わない", () => {
    expect(
      matchesTable({ tier: "take", price: "$9.99" }, DEFAULT_TIER_TABLE),
    ).toBe(false);
  });
});
