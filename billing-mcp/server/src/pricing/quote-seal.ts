// 見積書（DESIGN.md 決定55）。
//
// x402 は 2 往復する。支払いの無い呼び出しに 402 で価格を提示し、買い手が署名して
// 再び呼ぶ。上流の照合（`@x402/core` の `paymentRequirementsMatchAccepted`）は `amount`
// を含む core フィールドを deepEqual で突き合わせるため、2 往復で同じ額を再現できないと
// 買い手は 402 を受け取り続ける。段の判定は決定的でなく、価格表も AppConfig で
// 差し替わり得るので、1 往復目の結果を `accepts[].extra.quote` に載せて返してもらい、
// 2 往復目は判定をやり直さずその値を使う。
//
// 中身は平文で、署名しない。署名（HMAC）が防ぐのは「安い見積書を高い依頼に付け替える」
// 細工だけだが、決定56 では段が価格と生成規模の両方を決めるため、買い手が段を下げても
// 安くて小さいページが返るだけで、実質は等級を選び直したのと変わらない。実測でも重い
// 依頼に梅の規模を指示したときの出力は 6,256 トークン（原価 $0.09 程度）で、梅の価格
// $0.1 とほぼ釣り合う。お試し実装で鍵の管理を抱える利得がないため、署名は持たない
// （2026-09-21 ユーザー判断）。実運用で段ごとの粗利差を大きく取るなら、署名を足す。
import type { TierTable } from "./tiers.js";

/** 段（DESIGN.md 決定56）。表示名は梅・竹・松だが、見積書や JSON には ASCII の鍵で載せる */
export type Tier = "ume" | "take" | "matsu";

export interface Quote {
  tier: Tier;
  /** 提示する価格（"$0.15" 形式） */
  price: string;
}

/** 見積書の書式の版。中身の並びを変えるときは上げる */
const VERSION = "v1";

/** 区切り。価格が "$0.15" のように小数点を含むため `.` は使えない */
const SEP = "|";

const PRICE_PATTERN = /^\$\d+(\.\d+)?$/;

/** 見積書を文字列にする。戻り値をそのまま `accepts[].extra.quote` に載せる */
export function encodeQuote(quote: Quote): string {
  return [VERSION, quote.tier, quote.price].join(SEP);
}

/**
 * 買い手が返してきた見積書を読む。読めなければ undefined。
 *
 * 外部入力なので例外は投げない。壊れた形も知らない段も「読めない」の一語に畳む。
 * 読めなければ呼び出し側が判定し直す
 */
export function decodeQuote(encoded: unknown): Quote | undefined {
  if (typeof encoded !== "string") return undefined;
  const parts = encoded.split(SEP);
  if (parts.length !== 3) return undefined;
  const [version, tier, price] = parts;
  if (version !== VERSION) return undefined;
  if (tier !== "ume" && tier !== "take" && tier !== "matsu") return undefined;
  if (!PRICE_PATTERN.test(price)) return undefined;
  return { tier, price };
}

/**
 * 読んだ見積書が今の価格表と整合しているか。
 *
 * 段に対する価格が表と食い違う見積書は使わない。価格表が差し替わった直後の古い
 * 見積書がこれに当たる。買い手には新しい額で 402 を返し直すことになる
 */
export function matchesTable(quote: Quote, table: TierTable): boolean {
  return table.tiers[quote.tier].price === quote.price;
}
