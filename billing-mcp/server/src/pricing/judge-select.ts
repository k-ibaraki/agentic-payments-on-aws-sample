// 判定器の選択（DESIGN.md 決定58）。
//
// どの判定器で段を判ずるかは、価格表と同じ AppConfig の profile から来る。すなわち
// 運用中に再 deploy なしで倒せるので、選択はコンテナの起動時ではなくリクエストごとに
// 行う。作り直しが高くつくもの（Bedrock クライアント、Jev の HTTP クライアント）は
// 使い回す。
//
// 鍵が無いまま systemone を指された場合は既定（Bedrock）に留まる。設定に忠実に
// 従って全件をフォールバックの段に落とすより、価格の判定品質を保つほうが害が小さい。
// ただし黙って無視すると運用者が気づけないので、警告は必ず出す。
import type { Judge } from "./judge.js";
import { createSystemOneJudge } from "./judge.js";
import type { JudgeKind } from "./tiers.js";
import type { ApiKeyLoader } from "./typesafe-key.js";

export interface JudgeSelectorOptions {
  /** 既定の判定器（Bedrock の Haiku） */
  bedrock: Judge;
  /** Jev の API キーの読み手 */
  loadApiKey: ApiKeyLoader;
  /** System One の判定器の作り手。テストで差し替える */
  createSystemOne?: (apiKey: string) => Judge;
}

export type JudgeSelector = (kind: JudgeKind) => Promise<Judge>;

/** 価格表の指定から判定器を選ぶ */
export function createJudgeSelector(
  options: JudgeSelectorOptions,
): JudgeSelector {
  const create =
    options.createSystemOne ??
    ((apiKey: string) => createSystemOneJudge({ apiKey }));

  let cachedKey: string | undefined;
  let cachedJudge: Judge | undefined;

  return async (kind) => {
    if (kind !== "systemone") return options.bedrock;

    const apiKey = await options.loadApiKey();
    if (!apiKey) {
      console.warn(
        "[pricing] 判定器に systemone が指定されていますが API キーがありません。既定の判定器で応じます（決定58）",
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
