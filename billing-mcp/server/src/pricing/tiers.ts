// 価格帯と価格表（DESIGN.md 決定56）。
//
// 価格帯は依頼に見合う規模の見立てであり、品質の等級ではない。売り手が価格帯を判定し、
// 価格帯に応じた目安トークン数を生成の指示に織り込み、価格帯に対応する価格を提示する。
// 買い手には「ご依頼の内容ではおよそ N トークン相当の分量になるため梅（$X）です」と
// 根拠を添えて示す。
//
// 価格と目安は AppConfig から差し替える前提で、ここに置くのは既定値。
// 差し替えが飛行中の取引を壊さないのは、提示済みの価格が見積書（`accepts[].extra.quote`、
// 決定55）としてそのまま往復し、価格表と食い違えば使わずに判定し直すため。
import type { Tier } from "./quote-format.js";

export const TIER_ORDER = ["ume", "take", "matsu"] as const;

export interface TierEntry {
  /** 提示する価格（"$0.15" 形式） */
  price: string;
  /** 生成に伝える規模の目安（トークン数） */
  targetTokens: number;
}

/**
 * 価格帯の判定モデルの種類（決定58）。
 *
 * 既定は Bedrock の Haiku。`jev` は TypeSafe の Jev（および System One 互換の
 * サーバー）を指す。価格表と同じ profile に置くので、運用中に再デプロイなしで切り替えられる
 */
export const JUDGE_KINDS = ["haiku", "jev"] as const;

export type JudgeKind = (typeof JUDGE_KINDS)[number];

export const DEFAULT_JUDGE_KIND: JudgeKind = "haiku";

export interface TierTable {
  tiers: Record<Tier, TierEntry>;
  /** 価格帯の判定モデル（決定58） */
  judge: JudgeKind;
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
  judge: DEFAULT_JUDGE_KIND,
};

const LABELS: Record<Tier, string> = { ume: "梅", take: "竹", matsu: "松" };

/** 価格帯の表示名。買い手への提示と記録に使う */
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

/** 価格の額。形を検めたあとにだけ呼ぶ */
function priceValue(price: string): number {
  return Number(price.slice(1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEntry(value: unknown): TierEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { price, targetTokens } = value;
  if (typeof price !== "string" || !PRICE_PATTERN.test(price)) return undefined;
  // 0 ドルの表は書き損じとみなす。ただで売る意図があるなら価格表ではなく決定で示す
  if (priceValue(price) <= 0) return undefined;
  if (typeof targetTokens !== "number" || !Number.isInteger(targetTokens))
    return undefined;
  if (targetTokens <= 0) return undefined;
  return { price, targetTokens };
}

/**
 * 判定モデルの指定を読む（決定58）。
 *
 * 読めなければ既定（Bedrock）へ戻す。価格表ごと退けないのは、判定モデルの書き損じで
 * 価格まで巻き添えにしないため。黙って戻すと気づけないので警告は残す
 */
function parseJudgeKind(value: unknown): JudgeKind {
  if (value === undefined) return DEFAULT_JUDGE_KIND;
  if (
    typeof value === "string" &&
    (JUDGE_KINDS as readonly string[]).includes(value)
  )
    return value as JudgeKind;
  console.warn(
    `[pricing] 判定モデルの指定を読み取れませんでした（${JSON.stringify(value)}）。${DEFAULT_JUDGE_KIND} を使います`,
  );
  return DEFAULT_JUDGE_KIND;
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

  // 価格帯が上がるほど規模も価格も大きくなっていること。逆転した表は設定の書き損じとみなす
  for (let i = 1; i < TIER_ORDER.length; i++) {
    const lower = tiers[TIER_ORDER[i - 1]];
    const upper = tiers[TIER_ORDER[i]];
    if (upper.targetTokens <= lower.targetTokens) return undefined;
    if (priceValue(upper.price) <= priceValue(lower.price)) return undefined;
  }

  return { tiers, judge: parseJudgeKind(value.judge) };
}

/** モデルの出力上限。これを超える maxTokens は指定できない */
const MODEL_OUTPUT_CEILING = 64_000;

/** 目安に対して確保する余裕の倍率。打ち切りを避けるため厚めに取る */
const HEADROOM = 3;

export interface GenerationBudget {
  /** 生成のシステムプロンプトに足す規模の指示 */
  sizeHint: string;
  /** Converse に渡す maxTokens。目安ではなく打ち切りを避けるための天井 */
  maxTokens: number;
}

/**
 * 価格帯から生成側の予算を作る。
 *
 * `maxTokens` は目安そのものではなく、その 3 倍を確保する。目安は引き寄せる力であって
 * 固定する力ではなく（決定56 の実測）、指示を超えて書かれることがあるため。打ち切ると
 * 閉じタグを欠いた HTML が黙って返る
 */
export function generationBudgetOf(
  table: TierTable,
  tier: Tier,
): GenerationBudget {
  const target = targetTokensOf(table, tier);
  return {
    sizeHint: sizeHintOf(table, tier),
    maxTokens: Math.min(MODEL_OUTPUT_CEILING, target * HEADROOM),
  };
}

/**
 * 買い手への根拠の開示（決定56）。402 応答の資源説明に載せる。
 *
 * 価格帯は品質の等級ではなく、依頼が求める規模の見立てである。「簡素版」や「値引き」と
 * 読める言い方は避け、「この依頼ならこの分量になるので、この価格帯の価格です」と示す。
 *
 * 資源説明は支払い条件の照合対象ではないため、価格表が差し替わっても 2 往復目の
 * 照合を壊さない
 */
export function quoteDisclosure(table: TierTable, tier: Tier): string {
  const target = targetTokensOf(table, tier);
  return (
    `ご依頼の内容では、およそ ${target} トークン相当の分量のページになります。` +
    `このため ${tierLabel(tier)}（${priceOf(table, tier)}）でのご提供です。`
  );
}
