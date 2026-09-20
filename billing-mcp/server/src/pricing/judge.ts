// 段の判定器（DESIGN.md 決定53・56）。
//
// 判定器の仕事は「モデルが何トークン書くか」を当てることではない。それは 2026-09-20 の
// 実測で予測できないと分かった（実生成ラベルに対する的中 10/20、最頻クラス基準線 9/20）。
// ここで判ずるのは「この依頼に見合う規模はどれか」で、判じた段の目安が生成の指示に
// 織り込まれる。すなわち段は予測ではなく指定である。
//
// 既定は Bedrock の Haiku（決定53）。ただし境界は System One の形（順序尺度で段と
// 確信度を返す）に合わせてあり、Jev や互換サーバーへ差し替えられる。2026-09-20 に
// ローカルの Jev 互換実装 5 種を実測した結果、判定の形は choice より score が全基盤で
// 優れていたため、System One 側は score を使う。
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { Tier } from "./quote-seal.js";
import { TIER_ORDER } from "./tiers.js";

/** 判定に迷ったときに寄せる段。誤りの向きを一方に固定しないため中央を選ぶ */
const FALLBACK_TIER: Tier = "take";

export interface JudgeRequest {
  /** 判ずる対象のツール名 */
  toolName: string;
  /** 依頼文（System One の state に相当） */
  state: string;
}

export interface JudgeResult {
  tier: Tier;
  /** 判定できず既定へ落としたか。記録と監視のために残す */
  fellBack?: boolean;
  /** 判定器が確信度を返す場合のみ */
  confidence?: number;
}

export type Judge = (request: JudgeRequest) => Promise<JudgeResult>;

/**
 * 段の説明。順序尺度の水準として、軽いものから並べる。
 *
 * 分量の目安（行数やトークン数）は書かない。2026-09-20 の実測で、数量の手がかりは
 * 小型モデルには効かず、かえって判定を乱したため。ここでは依頼の性質だけを述べる
 */
export const TIER_CRITERIA: Record<Tier, string> = {
  ume: "単一の用途に絞られ、一つの画面で足りるページ",
  take: "複数の機能や区画があり、一覧や入力を伴うページ",
  matsu: "機能が多岐にわたり、画面の切り替えや状態の管理を伴うページ",
};

// ---------------------------------------------------------------------------
// Bedrock（既定）
// ---------------------------------------------------------------------------

export type ConverseFn = (
  input: ConverseCommandInput,
) => Promise<ConverseCommandOutput>;

/** 判定に使うモデル。生成側（決定56 の対象）とは別に、安く速いものを選ぶ */
export const JUDGE_MODEL_ID = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";

const BEDROCK_SYSTEM_PROMPT = [
  "あなたはHTML生成サービスの見積もり係です。依頼文を読み、作るべきページの規模を3段から1つ選びます。",
  "扱うのはいずれも相応に作り込まれたページです。極端に短いページは出てきません。",
  "",
  `ume: ${TIER_CRITERIA.ume}`,
  `take: ${TIER_CRITERIA.take}`,
  `matsu: ${TIER_CRITERIA.matsu}`,
  "",
  "ume / take / matsu のいずれか1語だけを出力してください。説明は不要です。",
].join("\n");

function readTier(text: string | undefined): Tier | undefined {
  const found = text?.trim().toLowerCase();
  return TIER_ORDER.find((tier) => tier === found);
}

/**
 * Bedrock で判ずる判定器を作る。
 *
 * 失敗しても投げない。判定できないことで売り買いを止めるより、中央の段で売るほうが
 * 害が小さい。落としたことは `fellBack` で呼び出し側に伝える
 */
export function createBedrockJudge(converse: ConverseFn): Judge {
  return async ({ state }) => {
    try {
      const response = await converse({
        modelId: JUDGE_MODEL_ID,
        system: [{ text: BEDROCK_SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: state }] }],
        inferenceConfig: { maxTokens: 8, temperature: 0 },
      });
      const tier = readTier(response.output?.message?.content?.[0]?.text);
      if (!tier) {
        console.warn("[pricing] 段を読み取れなかったため既定の段に落とします");
        return { tier: FALLBACK_TIER, fellBack: true };
      }
      return { tier };
    } catch (error) {
      console.warn(
        "[pricing] 段の判定に失敗したため既定の段に落とします",
        error,
      );
      return { tier: FALLBACK_TIER, fellBack: true };
    }
  };
}

// ---------------------------------------------------------------------------
// System One（Jev 互換）
// ---------------------------------------------------------------------------

export interface SystemOneOptions {
  /** `/v1/systemone` のエンドポイント */
  url: string;
  apiKey: string;
  /** 判定に使うモデル名。既定は Jev の最新 */
  model?: string;
  /** テストで差し替えるための fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 順序尺度の値を段へ写す。水準は 0 から始まるので、境は水準の中間に置く。
 *
 * 3 水準なら 0 / 1 / 2 が各段の中心で、0.5 と 1.5 が境になる
 */
export function scoreToTier(score: number): Tier {
  if (score < 0.5) return "ume";
  if (score < 1.5) return "take";
  return "matsu";
}

/**
 * System One 互換の API で判ずる判定器を作る。
 *
 * ワイヤ形式は 2026-09-20 に `jev_local` に対して実地に確かめたもの。`state` と
 * 型付きの質問を渡すと、質問ごとに型付きの答えが返る。ここでは `score`（順序尺度）を
 * 一問だけ投げる
 */
export function createSystemOneJudge(options: SystemOneOptions): Judge {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? "jev-latest";
  return async ({ state }) => {
    try {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          state,
          questions: {
            tier: {
              type: "score",
              instructions: "この依頼で作るべきページの規模を評価する",
              criteria: TIER_ORDER.map((tier) => TIER_CRITERIA[tier]),
            },
          },
        }),
      });
      const body = (await response.json()) as {
        answers?: { tier?: { score?: number; confidence?: number } };
      };
      const score = body.answers?.tier?.score;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        console.warn("[pricing] System One の応答から段を読み取れませんでした");
        return { tier: FALLBACK_TIER, fellBack: true };
      }
      const confidence = body.answers?.tier?.confidence;
      return {
        tier: scoreToTier(score),
        ...(typeof confidence === "number" ? { confidence } : {}),
      };
    } catch (error) {
      console.warn("[pricing] System One への問い合わせに失敗しました", error);
      return { tier: FALLBACK_TIER, fellBack: true };
    }
  };
}
