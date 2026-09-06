// 二重支払いを防ぐ買い手側の硬い防護（決定31・48）。
// 「支払い済みなのに成果物が無い」購入や「支払いの成否が不明」な購入が未解決のまま
// 残っているとき、LLM の自動再試行でもう一度支払わせないための判断。ツールハンドラは
// これが空でなければ interrupt で人の承認を要求する。
//
// 未解決の在処は2つある。
//   ①会話履歴（会話単位）… 「最後に成功した購入より後の失敗」に限る。人が承認して買い直しが
//     成功したらそれ以前の失敗は決着したものとして扱う。会話全体を対象にすると、一度事故が
//     起きた会話は以後すべての購入が承認待ちになり、決定31 が「毎回の承認を必須にする案は
//     自律性を弱めるため不採用」とした意図と食い違ってしまう
//   ②KVStore（利用者単位）… ①だけでは、事故の残る会話を離れて新しい会話を作れば承認を
//     経ずに再購入できた（決定48）。ウォレットと支払いの枠は利用者ごとで会話をまたぐのに、
//     防護だけが会話に閉じていたため。記録は購入が成功した時点で消す（承認だけでは消さない。
//     承認 → 再び失敗、で防護が外れないようにするため）
import type { PurchaseSummary } from './purchases.js';

/** 会話履歴から、この会話に残る未解決の購入を返す */
export function unresolvedPayments(purchases: readonly PurchaseSummary[]): PurchaseSummary[] {
  const lastSuccess = purchases.findLastIndex((p) => p.ok);
  return purchases
    .slice(lastSuccess + 1)
    .filter((p) => (p.paymentMade || p.paymentUncertain === true) && !p.ok);
}

/** 利用者ごとの未解決記録。TTL は付けない（期限で防護が黙って消えないように） */
export interface UnresolvedPaymentRecord {
  resultIds: string[];
  updatedAt: number;
}

/** KVStore の必要最小限。テストではメモリ実装で代える */
export interface UnresolvedPaymentStore {
  get(key: string): Promise<UnresolvedPaymentRecord | null>;
  put(
    key: string,
    value: UnresolvedPaymentRecord,
    /** 読んだ時点の記録と一致するときだけ書く（compare-and-swap） */
    options?: { ifValueEquals?: UnresolvedPaymentRecord },
  ): Promise<void>;
  /** 読んだ時点の記録と一致するときだけ消す */
  delete(key: string, options?: { ifValueEquals?: UnresolvedPaymentRecord }): Promise<void>;
}

/**
 * 記録に残す未解決 ID の上限。TTL を付けずに残すため、際限なく伸びないよう古いものから落とす。
 * 1 件でも残っていれば承認は要求されるので、古い ID が落ちても防護そのものは働く
 */
export const UNRESOLVED_CAP = 20;

/** 未解決 ID を足す（純粋関数）。重複は増やさず、上限を超えたら古いものから落とす */
export function withUnresolved(
  current: readonly string[],
  resultId: string,
  cap: number = UNRESOLVED_CAP,
): string[] {
  const next = current.includes(resultId) ? [...current] : [...current, resultId];
  return next.slice(Math.max(0, next.length - cap));
}

/**
 * 承認が要る未解決の購入 ID を返す（純粋関数）。会話単位（会話履歴）と
 * 利用者単位（KVStore）の和で、重複は除く。空でなければツールハンドラは interrupt する
 */
export function pendingApprovals(
  conversationPurchases: readonly PurchaseSummary[],
  userScoped: readonly string[],
): string[] {
  const ids = unresolvedPayments(conversationPurchases).map((p) => p.resultId);
  for (const id of userScoped) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** KVStore の条件付き書き込みが条件を満たさなかったときの名前（DynamoDB 由来） */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_CHECK_FAILED;
}

/** 利用者の未解決記録を読む。無ければ空 */
export async function loadUnresolved(
  store: UnresolvedPaymentStore,
  key: string,
): Promise<string[]> {
  return (await store.get(key))?.resultIds ?? [];
}

/**
 * 未解決の購入を記録する。読んだ記録を書き込みの条件にし、読んでから書くまでの間に
 * 別の購入が書いていたら相手を残す（記録は空にならないので、承認の要求は働き続ける）。
 * `ifNotExists` は使わない（決定35 改訂・決定40 と同じ罠。実体の有無を見るため、
 * 一度書かれた後は条件が永久に成立しない）
 */
export async function recordUnresolved(
  store: UnresolvedPaymentStore,
  key: string,
  resultId: string,
  now: () => number = Date.now,
): Promise<void> {
  const previous = await store.get(key);
  const resultIds = withUnresolved(previous?.resultIds ?? [], resultId);
  try {
    await store.put(
      key,
      { resultIds, updatedAt: now() },
      previous ? { ifValueEquals: previous } : {},
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    // 別の購入が先に書いていた。相手の記録にも未解決が残っているので承認の要求は働く
    console.warn(
      `[repurchase-guard] 未解決の記録が別の購入に書き換えられていた 利用者=${key} resultId=${resultId}`,
    );
  }
}

/**
 * 購入が成功したので未解決の記録を消す。読んだ記録を条件にし、消す間に別の購入が
 * 新たな未解決を書いていたらそれは残す（消すと承認を求められなくなる）
 */
export async function clearUnresolved(
  store: UnresolvedPaymentStore,
  key: string,
): Promise<void> {
  const previous = await store.get(key);
  if (!previous) return;
  try {
    await store.delete(key, { ifValueEquals: previous });
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    console.warn(
      `[repurchase-guard] 未解決の記録を消す間に別の購入が書き換えていたため残す 利用者=${key}`,
    );
  }
}
