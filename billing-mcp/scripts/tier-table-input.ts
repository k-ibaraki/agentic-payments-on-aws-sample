// pnpm set:tier-table が送る前に価格表を確かめる（DESIGN.md 決定64）。サーバーが退ける表を
// 配っても、サーバーは直前の表のまま動き（決定56）、配った側は気づけないため。
// 確かめ方はサーバーの parseTierTable をそのまま使い、同じ規則を二か所に書かない。
// スクリプトから切り出してあるのは、main を走らせずにテストするため
import {
  DEFAULT_JUDGE_KIND,
  JUDGE_KINDS,
  parseTierTable,
} from "../server/src/pricing/tiers";

/** 送る前に価格表を確かめ、詰めた JSON にする。サーバーが受け付けない表は理由を添えて投げる */
export function normalizeTierTable(text: string): string {
  let table: unknown;
  try {
    table = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON として読めません: ${error instanceof Error ? error.message : error}`);
  }
  // judge だけを配るのが最もありがちな誤りなので、先に専用の案内で止める
  const tiers = (table as { tiers?: unknown } | null)?.tiers;
  if (typeof tiers !== "object" || tiers === null) {
    throw new Error(
      "tiers がありません。価格表は丸ごと差し替えるので、judge だけを変えるときも tiers を含めること",
    );
  }
  // 読めない judge は表ごと退けられず、警告とともに既定へ戻される。配る側では止める。
  // parseTierTable より先に見るのは、そちらが出す「既定を使います」の警告と食い違わないようにするため
  const judge = (table as { judge?: unknown }).judge;
  if (judge !== undefined && !(JUDGE_KINDS as readonly unknown[]).includes(judge)) {
    throw new Error(
      `judge の値 ${JSON.stringify(judge)} をサーバーが読めません。${JUDGE_KINDS.join(" / ")} のいずれかを書くこと` +
        `（省くと ${DEFAULT_JUDGE_KIND}）`,
    );
  }
  if (!parseTierTable(table)) {
    throw new Error(
      "サーバーが受け付けない価格表です。ume / take / matsu が揃い、price は \"$0.1\" の形の正の額、" +
        "targetTokens は正の整数で、価格帯が上がるほど価格も目安も大きいこと",
    );
  }
  return JSON.stringify(table);
}
