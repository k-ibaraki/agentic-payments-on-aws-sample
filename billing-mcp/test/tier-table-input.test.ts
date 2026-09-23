import { normalizeTierTable } from "../scripts/tier-table-input";

const TIERS = {
  ume: { price: "$0.1", targetTokens: 5000 },
  take: { price: "$0.15", targetTokens: 8000 },
  matsu: { price: "$0.2", targetTokens: 12000 },
};

function input(table: unknown): string {
  return JSON.stringify(table, null, 2);
}

// pnpm set:tier-table が送る前に見る（決定64）。サーバーが退ける表を配ると、サーバーは
// 直前の表のまま動き、配った側は「配りました」を見て反映されたと思い込む
describe("価格表の送る前の確認", () => {
  it("サーバーが読める表は、詰めた JSON にして返す", () => {
    const table = { tiers: TIERS, judge: "jev" };
    expect(normalizeTierTable(input(table))).toBe(JSON.stringify(table));
  });

  it("judge を省いた表も通す（サーバーは haiku で動く）", () => {
    expect(() => normalizeTierTable(input({ tiers: TIERS }))).not.toThrow();
  });

  it("JSON として読めない入力は止める", () => {
    expect(() => normalizeTierTable("{ tiers: ")).toThrow("JSON として読めません");
  });

  it("tiers の無い表は止める（judge だけを配っても表ごと退けられる）", () => {
    expect(() => normalizeTierTable(input({ judge: "jev" }))).toThrow(
      "tiers がありません",
    );
  });

  it("価格帯が欠けた表は止める", () => {
    const { matsu: _, ...withoutMatsu } = TIERS;
    expect(() =>
      normalizeTierTable(input({ tiers: withoutMatsu, judge: "jev" })),
    ).toThrow("サーバーが受け付けない価格表です");
  });

  it("価格の書式が違う表は止める", () => {
    const tiers = { ...TIERS, take: { price: "0.15", targetTokens: 8000 } };
    expect(() => normalizeTierTable(input({ tiers }))).toThrow(
      "サーバーが受け付けない価格表です",
    );
  });

  it("価格帯が上がるほど価格が上がっていない表は止める", () => {
    const tiers = { ...TIERS, matsu: { price: "$0.12", targetTokens: 12000 } };
    expect(() => normalizeTierTable(input({ tiers }))).toThrow(
      "サーバーが受け付けない価格表です",
    );
  });

  it("サーバーが読めない judge は止める（黙って haiku に戻されるため）", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        normalizeTierTable(input({ tiers: TIERS, judge: "systemone" })),
      ).toThrow('judge の値 "systemone" をサーバーが読めません');
      // サーバー側の「既定を使います」の警告は出さない（止めるのに「使います」と出ると食い違う）
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
