// 見積もり要求の乱発への防護（DESIGN.md 決定57、U12 の決着）。
// 呼び出し予算（バケツ）で判定モデルの呼び出し回数を制限し、尽きたら既定の価格帯に
// 落として売買は止めない。依頼文も文字数の上限で切り詰める。予算はコンテナ単位で
// 持つため、Lambda の同時実行数（reservedConcurrency）と併せて全体の天井は
// 「同時実行数 × 予算」になる。
import type { Judge, JudgeResult } from "./judge.js";

/** 判定モデルへ渡す依頼文の上限（文字数）。超えた分は切り詰める */
export const JUDGE_STATE_LIMIT = 2_000;

/** 予算を使い切ったときに返す価格帯。判定処理の fallback と揃える */
const FALLBACK: JudgeResult = { tier: "take", fellBack: true };

export interface JudgeBudgetOptions {
  /** 溜められる呼び出し回数の上限 */
  capacity: number;
  /** 1 秒あたりに戻る回数 */
  refillPerSecond: number;
  /** 現在時刻（ミリ秒）。テストで差し替える */
  now?: () => number;
}

export interface JudgeBudget {
  /** 判定処理をこの予算で包む。同じ予算から包んだものはバケツを共有する */
  wrap(judge: Judge): Judge;
}

/**
 * 呼び出し予算を作る。
 *
 * バケツは予算そのものが持つ。判定モデルは価格表の指定で毎リクエスト選び直す（決定58）
 * ため、包むたびにバケツができる造りだと予算が毎回満タンに戻り、防護が消える
 */
export function createJudgeBudget(options: JudgeBudgetOptions): JudgeBudget {
  const now = options.now ?? Date.now;
  let tokens = options.capacity;
  let lastRefill = now();

  /** 1 回ぶんの予算を取る。取れなければ false */
  const take = (): boolean => {
    const current = now();
    const refilled = ((current - lastRefill) / 1_000) * options.refillPerSecond;
    if (refilled > 0) {
      tokens = Math.min(options.capacity, tokens + refilled);
      lastRefill = current;
    }
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  return {
    wrap(judge) {
      return async (request) => {
        if (!take()) {
          console.warn(
            "[pricing] 見積もりの呼び出し予算を使い切りました。既定の価格帯で応じます（決定57）",
          );
          return FALLBACK;
        }
        const state =
          request.state.length > JUDGE_STATE_LIMIT
            ? request.state.slice(0, JUDGE_STATE_LIMIT)
            : request.state;
        return judge({ ...request, state });
      };
    },
  };
}

/**
 * 判定処理を呼び出し予算で包む。
 *
 * 予算が尽きているあいだは判定モデルを呼ばず、既定の価格帯で売る。売り買いは止めない。
 * 見積もりの精度は落ちるが、止めると乱発する側の狙いどおりになる
 */
export function withJudgeBudget(
  judge: Judge,
  options: JudgeBudgetOptions,
): Judge {
  return createJudgeBudget(options).wrap(judge);
}
