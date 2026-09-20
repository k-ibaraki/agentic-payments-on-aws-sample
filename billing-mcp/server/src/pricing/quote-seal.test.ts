import { describe, expect, it } from "vitest";
import {
  fingerprintArgs,
  openQuoteSeal,
  type SealedQuote,
  sealQuote,
} from "./quote-seal.js";

const KEY = "test-key-0123456789";
const OTHER_KEY = "another-key-9876543210";

const QUOTE: SealedQuote = {
  toolName: "generate-html",
  argsFingerprint: "a".repeat(64),
  tier: "take",
  price: "$0.15",
  expiresAt: 2_000_000_000,
};

describe("fingerprintArgs", () => {
  it("キーの並び順が違っても同じ指紋になる", () => {
    const a = fingerprintArgs({ prompt: "こんにちは", modelId: "m" });
    const b = fingerprintArgs({ modelId: "m", prompt: "こんにちは" });
    expect(a).toBe(b);
  });

  it("値が1文字でも違えば指紋が変わる", () => {
    const a = fingerprintArgs({ prompt: "ページを作って" });
    const b = fingerprintArgs({ prompt: "ページを作つて" });
    expect(a).not.toBe(b);
  });

  it("未定義の項目がある場合と無い場合を区別する", () => {
    const a = fingerprintArgs({ prompt: "x" });
    const b = fingerprintArgs({ prompt: "x", previousHtml: "" });
    expect(a).not.toBe(b);
  });
});

describe("sealQuote / openQuoteSeal", () => {
  it("封をして開くと同じ見積もりが戻る", () => {
    const sealed = sealQuote(QUOTE, KEY);
    const opened = openQuoteSeal(sealed, {
      toolName: QUOTE.toolName,
      argsFingerprint: QUOTE.argsFingerprint,
      key: KEY,
      nowSeconds: 1_999_999_000,
    });
    expect(opened).toEqual(QUOTE);
  });

  it("鍵が違えば開かない", () => {
    const sealed = sealQuote(QUOTE, KEY);
    const opened = openQuoteSeal(sealed, {
      toolName: QUOTE.toolName,
      argsFingerprint: QUOTE.argsFingerprint,
      key: OTHER_KEY,
      nowSeconds: 1_999_999_000,
    });
    expect(opened).toBeUndefined();
  });

  it("有効期限を過ぎていれば開かない", () => {
    const sealed = sealQuote(QUOTE, KEY);
    const opened = openQuoteSeal(sealed, {
      toolName: QUOTE.toolName,
      argsFingerprint: QUOTE.argsFingerprint,
      key: KEY,
      nowSeconds: QUOTE.expiresAt + 1,
    });
    expect(opened).toBeUndefined();
  });

  // 安い見積書を高い依頼に付け替える細工を防ぐ（決定55）
  it("引数の指紋が一致しなければ開かない", () => {
    const sealed = sealQuote(QUOTE, KEY);
    const opened = openQuoteSeal(sealed, {
      toolName: QUOTE.toolName,
      argsFingerprint: "b".repeat(64),
      key: KEY,
      nowSeconds: 1_999_999_000,
    });
    expect(opened).toBeUndefined();
  });

  it("別のツールの見積書は開かない", () => {
    const sealed = sealQuote(QUOTE, KEY);
    const opened = openQuoteSeal(sealed, {
      toolName: "other-tool",
      argsFingerprint: QUOTE.argsFingerprint,
      key: KEY,
      nowSeconds: 1_999_999_000,
    });
    expect(opened).toBeUndefined();
  });

  it("額を書き換えた封は開かない", () => {
    const sealed = sealQuote(QUOTE, KEY);
    const tampered = sealed.replace("$0.15", "$0.01");
    expect(tampered).not.toBe(sealed);
    const opened = openQuoteSeal(tampered, {
      toolName: QUOTE.toolName,
      argsFingerprint: QUOTE.argsFingerprint,
      key: KEY,
      nowSeconds: 1_999_999_000,
    });
    expect(opened).toBeUndefined();
  });

  it("形が壊れていても例外を投げずに開かないとだけ答える", () => {
    for (const broken of ["", "v1", "v1.x.y", "..", "not-a-seal"]) {
      const opened = openQuoteSeal(broken, {
        toolName: QUOTE.toolName,
        argsFingerprint: QUOTE.argsFingerprint,
        key: KEY,
        nowSeconds: 1_999_999_000,
      });
      expect(opened).toBeUndefined();
    }
  });
});
