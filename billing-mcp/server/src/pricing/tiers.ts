// 段と価格表（DESIGN.md 決定56）。
//
// 段は依頼に見合う規模の見立てであり、品質の等級ではない。売り手が段を判じ、
// 段に応じた目安トークン数を生成の指示に織り込み、段に対応する価格を提示する。
// 買い手には「ご依頼の内容ではおよそ N トークン相当の分量になるため梅（$X）です」と
// 根拠を添えて示す。
//
// 価格と目安は AppConfig から差し替える前提で、ここに置くのは既定値。
// 差し替えが飛行中の取引を壊さないのは、提示済みの価格が見積書の封（決定55）に
// 封じられており、有効期限まではその値で通るため。
import type { Tier } from "./quote-seal.js";

export const TIER_ORDER = ["ume", "take", "matsu"] as const;

export interface TierEntry {
  /** 提示する価格（"$0.15" 形式） */
  price: string;
  /** 生成に伝える規模の目安（トークン数） */
  targetTokens: number;
}

export interface TierTable {
  tiers: Record<Tier, TierEntry>;
}

/**
 * 既定の価格表。価格は 2026-09-21 の仮置き（ユーザー判断）。
 *
 * 目安トークン数は決定56 のとおり。実測原価は Sonnet 4.6 の出力を $15/1M として
 * 梅 ≒ $0.075 / 竹 ≒ $0.12 / 松 ≒ $0.18 で、いずれも価格が原価を上回る
 */
export const DEFAULT_TIER_TABLE: TierTable = {
  tiers: {
    ume: { price: "$0.1", targetTokens: 5_000 },
    take: { price: "$0.15", targetTokens: 8_000 },
    matsu: { price: "$0.2", targetTokens: 12_000 },
  },
};

const LABELS: Record<Tier, string> = { ume: "梅", take: "竹", matsu: "松" };

/** 段の表示名。買い手への提示と記録に使う */
export function tierLabel(tier: Tier): string {
  return LABELS[tier];
}

export function priceOf(table: TierTable, tier: Tier): string {
  return table.tiers[tier].price;
}

export function targetTokensOf(table: TierTable, tier: Tier): number {
  return table.tiers[tier].targetTokens;
}

/**
 * 生成のシステムプロンプトに足す規模の指示。
 *
 * 上限ではなく目安として伝える。上限として渡して打ち切ると、閉じタグを欠いた HTML が
 * 黙って返る（`tools/generate-html.ts` の `maxTokens` のコメント参照）。`maxTokens` は
 * 別途、目安に対して十分な余裕を確保する
 */
export function sizeHintOf(table: TierTable, tier: Tier): string {
  const target = targetTokensOf(table, tier);
  return (
    `このページは概ね ${target} トークン程度（HTML・CSS・JavaScript の合計）の規模が適切です。` +
    "その規模感で、過不足なく作ってください。"
  );
}

/** "$0.1" のような価格の形 */
const PRICE_PATTERN = /^\$\d+(\.\d+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEntry(value: unknown): TierEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { price, targetTokens } = value;
  if (typeof price !== "string" || !PRICE_PATTERN.test(price)) return undefined;
  if (typeof targetTokens !== "number" || !Number.isInteger(targetTokens))
    return undefined;
  if (targetTokens <= 0) return undefined;
  return { price, targetTokens };
}

/**
 * 外から来た価格表を読む（AppConfig の設定値を想定）。
 *
 * 読めなければ undefined を返し、呼び出し側は既定値を使い続ける。設定の書き損じで
 * 売り手が止まるより、古い表で売り続けるほうが害が小さい。例外は投げない
 */
export function parseTierTable(value: unknown): TierTable | undefined {
  if (!isRecord(value) || !isRecord(value.tiers)) return undefined;
  const source = value.tiers;

  const entries: Partial<Record<Tier, TierEntry>> = {};
  for (const tier of TIER_ORDER) {
    const entry = parseEntry(source[tier]);
    if (!entry) return undefined;
    entries[tier] = entry;
  }
  const tiers = entries as Record<Tier, TierEntry>;

  // 段が上がるほど規模が大きくなっていること。逆転した表は設定の書き損じとみなす
  for (let i = 1; i < TIER_ORDER.length; i++) {
    if (
      tiers[TIER_ORDER[i]].targetTokens <= tiers[TIER_ORDER[i - 1]].targetTokens
    ) {
      return undefined;
    }
  }

  return { tiers };
}
