// 判定モデルの選択（DESIGN.md 決定58）。
//
// どの判定モデルで価格帯を判定するかは、価格表と同じ AppConfig の profile から来る。すなわち
// 運用中に再デプロイなしで切り替えられるので、選択はコンテナの起動時ではなくリクエストごとに
// 行う。作り直しが高くつくもの（Bedrock クライアント、Jev の HTTP クライアント）は
// 使い回す。
//
// 鍵が無いまま jev を指された場合は既定（Bedrock の Haiku）に留まる。設定に忠実に
// 従って全件をフォールバックの価格帯に落とすより、価格の判定品質を保つほうが害が小さい。
// ただし黙って無視すると運用者が気づけないので、警告は必ず出す。
import type { Judge } from "./judge.js";
import { createSystemOneJudge } from "./judge.js";
import type { JudgeKind } from "./tiers.js";
import type { ApiKeyLoader } from "./typesafe-key.js";

export interface JudgeSelectorOptions {
  /** 既定の判定処理（Bedrock の Haiku を使う） */
  bedrock: Judge;
  /** Jev の API キーの読み手 */
  loadApiKey: ApiKeyLoader;
  /** System One を使う判定処理の作り手。テストで差し替える */
  createSystemOne?: (apiKey: string) => Judge;
}

export type JudgeSelector = (kind: JudgeKind) => Promise<Judge>;

/** 価格表の指定から判定モデルを選ぶ */
export function createJudgeSelector(
  options: JudgeSelectorOptions,
): JudgeSelector {
  const create =
    options.createSystemOne ??
    ((apiKey: string) => createSystemOneJudge({ apiKey }));

  let cachedKey: string | undefined;
  let cachedJudge: Judge | undefined;

  return async (kind) => {
    if (kind !== "jev") return options.bedrock;

    const apiKey = await options.loadApiKey();
    if (!apiKey) {
      console.warn(
        "[pricing] 判定モデルに jev が指定されていますが API キーがありません。既定の判定モデルで応じます（決定58）",
      );
      return options.bedrock;
    }

    if (!cachedJudge || cachedKey !== apiKey) {
      cachedJudge = create(apiKey);
      cachedKey = apiKey;
    }
    return cachedJudge;
  };
}
