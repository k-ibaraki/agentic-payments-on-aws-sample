// 段の判定の不具合チェック用の最小セット（DESIGN.md 決定56）。
//
// 2026-09-20 の検証では 20 件の評価セットで判定器を比べた。リポジトリには各段 1 件ずつ
// だけを残す。精度を測るためではない。判定器が段を作り分けられているかを見るためである。
// 実測では、全段が同じ答えに潰れる事故がたびたび起きた。それを捕まえる。
//
// 依頼文は、実際に生成させてトークン数を測った 20 件から採った。`measuredTokens` は
// Sonnet 4.6 に素で生成させたときの出力トークン数である。これは段の正解ではない。
// 出力量は依頼文から予測できないと分かっており、段は予測ではなく指定だからである。
import type { Tier } from "./quote-seal.js";

export interface EvalCase {
  prompt: string;
  /** 期待する段 */
  tier: Tier;
  /** 素で生成させたときの実測出力トークン数（2026-09-20） */
  measuredTokens: number;
}

export const EVAL_CASES: readonly EvalCase[] = [
  {
    prompt: "子どもの学習塾の時間割表を表示するHTMLをお願いします",
    tier: "ume",
    measuredTokens: 3_374,
  },
  {
    prompt: "ゲーム好きな友人と共有するスコアランキングページ",
    tier: "take",
    measuredTokens: 8_580,
  },
  {
    prompt: "オンライン家庭教師の授業予約サイトを構築してください",
    tier: "matsu",
    measuredTokens: 13_378,
  },
];
