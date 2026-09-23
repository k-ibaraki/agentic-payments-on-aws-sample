// 価格帯の判定処理（DESIGN.md 決定53・56）。
//
// 判定モデルの仕事は「モデルが何トークン書くか」を当てることではない。それは 2026-09-20 の
// 実測で予測できないと分かった（実生成ラベルに対する的中 10/20、最頻クラス基準線 9/20）。
// ここで判定するのは「この依頼に見合う規模はどれか」で、判定した価格帯の目安が生成の指示に
// 織り込まれる。すなわち価格帯は予測ではなく指定である。
//
// 既定は Bedrock の Haiku（決定53）。ただし境界は System One の形（順序尺度で価格帯と
// 確信度を返す）に合わせてあり、Jev や互換サーバーへ差し替えられる。2026-09-20 に
// ローカルの Jev 互換実装 5 種を実測した結果、判定の形は choice より score が全基盤で
// 優れていたため、System One 側は score を使う。
//
// score は水準ごとの確率の期待値なので、判定が割れるほど値は中央へ寄り、中央の価格帯
// （竹）に着地する。すなわち確信度で分岐させずとも、迷いはフォールバック先へ流れる。
// 確信度は判断には使わず、水準の記述が効いているかを見るために記録だけする。
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { APIError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Tier } from "./quote-format.js";
import { TIER_ORDER } from "./tiers.js";

/** 判定に迷ったときに寄せる価格帯。誤りの向きを一方に固定しないため中央を選ぶ */
const FALLBACK_TIER: Tier = "take";

export interface JudgeRequest {
  /** 判定する対象のツール名 */
  toolName: string;
  /** 依頼文（System One の state に相当） */
  state: string;
}

export interface JudgeResult {
  tier: Tier;
  /** 判定できず既定へ落としたか。記録と監視のために残す */
  fellBack?: boolean;
  /** 判定モデルが確信度を返す場合のみ */
  confidence?: number;
}

export type Judge = (request: JudgeRequest) => Promise<JudgeResult>;

/**
 * 価格帯の説明。順序尺度の水準として、軽いものから並べる。
 *
 * 分量の目安（行数やトークン数）は書かない。2026-09-20 の実測で、数量の手がかりは
 * 小型モデルには効かず、かえって判定を乱したため。ここでは依頼の性質だけを述べる
 */
export const TIER_CRITERIA: Record<Tier, string> = {
  ume: "単一の用途に絞られ、一つの画面で足りるページ",
  take: "複数の機能や区画があり、一覧や入力を伴うページ",
  matsu: "機能が多岐にわたり、画面の切り替えや状態の管理を伴うページ",
};

/** 判定する内容そのもの */
export const TIER_QUESTION = "この依頼で作るべきページの規模を評価する";

/**
 * 判定の土台に置く前置き。
 *
 * 水準の記述だけでは、扱う品揃えがどのあたりに集まっているのかが伝わらない。
 * どちらの判定モデルにも同じものを渡し、同じ土台で判定させる
 */
export const TIER_CONTEXT =
  "扱うのはいずれも相応に作り込まれたページです。極端に短いページは出てきません。";

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
  TIER_CONTEXT,
  "",
  `ume: ${TIER_CRITERIA.ume}`,
  `take: ${TIER_CRITERIA.take}`,
  `matsu: ${TIER_CRITERIA.matsu}`,
  "",
  "ume / take / matsu のいずれか1語だけを出力してください。説明は不要です。",
].join("\n");

/**
 * 答えの中の価格帯の名前。語の切れ目で拾い、`document` の中の `ume` を掴まない。
 *
 * 価格帯を増減しても書き直さずに済むよう `TIER_ORDER` から組む
 */
const TIER_WORD = new RegExp(`\\b(${TIER_ORDER.join("|")})\\b`, "g");

/**
 * モデルの答えから価格帯を読む。
 *
 * 完全一致で照らすと `take。` や `` `take` `` のような些細な飾りで読めなくなり、
 * 黙って中央の価格帯へ落ちて価格に響く。語として含まれるかで拾う。価格帯が複数混じって
 * いれば選べていないということなので、読めない扱いにする
 */
function readTier(text: string | undefined): Tier | undefined {
  if (!text) return undefined;
  const found = new Set<Tier>(
    [...text.toLowerCase().matchAll(TIER_WORD)].map(([, word]) => word as Tier),
  );
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Bedrock で価格帯を判定する処理を作る。
 *
 * 失敗しても投げない。判定できないことで売り買いを止めるより、中央の価格帯で売るほうが
 * 害が小さい。落としたことは `fellBack` で呼び出し側に伝える
 */
export function createBedrockJudge(converse: ConverseFn): Judge {
  return async ({ state }) => {
    try {
      const response = await converse({
        modelId: JUDGE_MODEL_ID,
        system: [{ text: BEDROCK_SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: state }] }],
        // 1 語で足りるが、前置きを添えられたときに語が途中で切れないよう余裕を持たせる
        inferenceConfig: { maxTokens: 16, temperature: 0 },
      });
      const tier = readTier(
        response.output?.message?.content
          ?.map((block) => block.text ?? "")
          .join(" "),
      );
      if (!tier) {
        console.warn(
          "[pricing] 価格帯を読み取れなかったため既定の価格帯に落とします",
        );
        return { tier: FALLBACK_TIER, fellBack: true };
      }
      return { tier };
    } catch (error) {
      console.warn(
        "[pricing] 価格帯の判定に失敗したため既定の価格帯に落とします",
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
  /** Jev の API キー。Secrets Manager から取り出したもの（決定58） */
  apiKey: string;
  /** API の根。既定は https://api.typesafe.ai。System One 互換サーバーを指すときに使う */
  baseURL?: string;
  /** 判定に使うモデル名。既定は Jev の最新 */
  model?: string;
  /** 1 回あたりの待ちの上限 */
  timeoutMs?: number;
  /** 再送の回数 */
  maxRetries?: number;
  /** テストで差し替えるための fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 1 回あたりの待ちの上限。
 *
 * ここは 402 を返す経路、すなわち買い手が待たされる区間である（決定57 のコメント参照）。
 * 2026-09-21 の実測で本物の Jev は 1 件あたり 540ms 前後だったので、5 倍の余裕を取る。
 * SDK の既定（10 秒）をそのまま使うと、詰まったときに待ちが目立つ
 */
export const SYSTEM_ONE_TIMEOUT_MS = 3_000;

/**
 * 再送の回数。
 *
 * docs は 429 / 529 にバックオフを案内しているが、SDK の既定（2 回）では最悪の待ちが
 * 30 秒を超える。判定に失敗しても中央の価格帯で売れる以上、粘る利が無いので 1 回に抑える。
 * 最悪でも 3 秒 + 待ち + 3 秒に収まる
 */
export const SYSTEM_ONE_MAX_RETRIES = 1;

/** 価格帯の判定に使う質問の名前。応答はこの名前で返る */
const QUESTION_NAME = "tier";

/**
 * 順序尺度の値を価格帯へ写す。
 *
 * 水準は 0 から始まり、価格帯の数だけある。各価格帯の中心は水準の番号そのものなので、
 * 四捨五入すれば最も近い価格帯になる（価格帯が 3 つなら境は 0.5 と 1.5）。価格帯を増減しても
 * 境を書き直さずに済むよう、水準の数から導く。範囲の外に出た値は端へ収める
 */
export function scoreToTier(score: number): Tier {
  // 呼び出し側でも検めているが、export した関数が `Tier` を名乗って undefined を
  // 返すことのないよう、ここでも塞ぐ
  if (!Number.isFinite(score)) return FALLBACK_TIER;
  const level = Math.min(Math.max(Math.round(score), 0), TIER_ORDER.length - 1);
  return TIER_ORDER[level];
}

/**
 * System One（Jev および互換サーバー）で価格帯を判定する処理を作る。
 *
 * 公式 SDK（`@typesafe-ai/sdk`）に乗る。型・リトライ・`retry-after` の尊重を自前で
 * 抱えないため。待ちと再送の既定だけは、買い手を待たせない値に締め直す。
 *
 * 判定の形に `score`（順序尺度）を採るのは、2026-09-20 にローカルの互換実装 5 種で
 * 測った際、choice より score が全基盤で優れていたため。
 */
export function createSystemOneJudge(options: SystemOneOptions): Judge {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    defaultModel: options.model ?? "jev-latest",
    timeout: options.timeoutMs ?? SYSTEM_ONE_TIMEOUT_MS,
    retry: { maxRetries: options.maxRetries ?? SYSTEM_ONE_MAX_RETRIES },
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });

  return async ({ state }) => {
    try {
      const { answers } = await client.systemOne({
        state,
        questions: {
          [QUESTION_NAME]: {
            type: "score",
            // 問いと前置きは別の欄に分ける。混ぜると互いに滲み、コード側から
            // 前置きだけを差し替えられなくなる（docs「構造化した質問定義」）
            instructions: { question: TIER_QUESTION, context: TIER_CONTEXT },
            criteria: TIER_ORDER.map((tier) => TIER_CRITERIA[tier]) as [
              string,
              string,
              ...string[],
            ],
          },
        },
      });
      const answer = answers[QUESTION_NAME];
      if (answer?.type !== "score" || !Number.isFinite(answer.score)) {
        console.warn(
          "[pricing] System One の応答から価格帯を読み取れませんでした",
        );
        return { tier: FALLBACK_TIER, fellBack: true };
      }
      return {
        tier: scoreToTier(answer.score),
        ...(typeof answer.confidence === "number"
          ? { confidence: answer.confidence }
          : {}),
      };
    } catch (error) {
      // 鍵切れ・過負荷・繋がらないを同じ一行に潰さない。HTTP まで届いたなら
      // ステータスを添える（APIError だけが status を持つ）
      const status =
        error instanceof APIError ? `（HTTP ${error.status}）` : "";
      console.warn(
        `[pricing] System One への問い合わせに失敗しました${status}`,
        error,
      );
      return { tier: FALLBACK_TIER, fellBack: true };
    }
  };
}
