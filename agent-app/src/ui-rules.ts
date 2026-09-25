// 画面の振る舞いのうち DOM に依存しない規則（決定44・47・48・49・50・62）。index.ts から呼び、テストはここで固定する
import { PURCHASE_TOOL_NAME } from '../aws-blocks/purchases.js';

/** 新規会話は会話をブラウザから捨てる操作。吹き出しが 1 つでもあれば確認を挟む */
export function shouldConfirmNewConversation(messageCount: number): boolean {
  return messageCount > 0;
}

/** 「内部情報」の折りたたみは既定で開く。閉じた記憶があるときだけ閉じる（壊れた値は既定に倒す） */
export function readInternalsOpen(stored: string | null): boolean {
  return stored !== 'closed';
}

export function storeInternalsOpen(open: boolean): 'open' | 'closed' {
  return open ? 'open' : 'closed';
}

/**
 * 生成中の応答が入る吹き出しの位置（無ければ -1）。最後の assistant を指す。
 * 承認へ応答すると末尾に approval が積まれ、生成先はその手前の空プレースホルダになり得るため、
 * 「末尾」の決め打ちでは外れる（決定46）
 */
export function findLastAssistant(messages: Array<{ role: string }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

// ── 依頼の枠の帯（残高と残枠）と、購入中の取り直し（決定47） ──

/** 有料ツールの応答を待つ上限の既定（`BUYER_TOOL_TIMEOUT_MS`。決定31）。ブラウザは環境変数を知らないので既定に合わせる */
export const BALANCE_WATCH_MAX_MS = 600_000;
/** 支払いは有料ツールの呼び出しの中で起き、ツールが返るまでは何も届かない。その間はこの間隔で残高を取り直す */
export const BALANCE_WATCH_INTERVAL_MS = 3000;

/** 帯で「取得できていない」ことを表す記号。実際の値と区別するために持つ */
export const STRIP_EMPTY = '—';

/**
 * 帯の 1 マス。`text` は画面に出す文字列、`value` は光らせる判定にだけ使う金額。
 * 取れていないとき、そしてまだ枠が無い（次に切る上限を出している）ときは null。
 * 光るのは支払いによる増減の合図なので、枠の有無が変わっただけ・上限を変えただけでは光らせない。
 * 文字列で判定すると、同じ金額でも添え書きの有無で「変わった」ことになってしまうため分けている（決定49）
 */
export interface StripCell {
  text: string;
  value: string | null;
}

/** 帯の残高。説明は付けず値と通貨だけ。取れていなければ「—」 */
export function stripBalance(balance: { display: string; token: string } | null | undefined): StripCell {
  if (!balance) return { text: STRIP_EMPTY, value: null };
  return { text: `${balance.display} ${balance.token}`, value: balance.display };
}

/** セッションがまだ無いときの添え書き。次の購入でこの上限のセッションが切られる（決定49） */
const BEFORE_SESSION_NOTE = '（セッション開始前）';

/**
 * 帯の残枠（決定49。決定47 の「セッションが無ければ—」を上書き）。
 * 今のセッションがあればその残枠。まだ無ければ次に切る上限を添え書き付きで出す。
 * セッションの取得に失敗した回だけは「—」にする。`session` は「まだ無い」ときも
 * 「取れなかった」ときも null になるため、後者で上限を出すと失敗が実値らしく見えてしまう
 */
export function stripRemaining(status: {
  session: { availableSpendUsd: string | null } | null | undefined;
  sessionError: string | null | undefined;
  spendLimit: { maxSpendUsd: string };
}): StripCell {
  if (status.session) {
    const available = status.session.availableSpendUsd;
    return available ? { text: `${available} USD`, value: available } : { text: STRIP_EMPTY, value: null };
  }
  if (status.sessionError) return { text: STRIP_EMPTY, value: null };
  // 上限を出すだけで枠はまだ無い。支払いで動く値ではないので光らせる判定には乗せない
  return { text: `${status.spendLimit.maxSpendUsd} USD${BEFORE_SESSION_NOTE}`, value: null };
}

/**
 * 値が変わったことを光らせて知らせてよいか。
 * null（取れていない・まだ枠が無い）との出入りは支払いによる増減ではないので光らせない
 * （残高 API が失敗した回を「減った」と見せない。上限を変えてセッションを破棄しただけでも光らせない）。
 * 判定は金額そのもので行うので、セッションが切られて添え書きが外れただけでは光らない
 */
export function shouldFlashValue(prev: string | null, next: string | null): boolean {
  return prev !== null && next !== null && prev !== next;
}

/** 取り直しを始めるのは支払いが起きる有料ツールの呼び出しだけ */
export function isPaidToolCall(toolName: string | undefined): boolean {
  return toolName === PURCHASE_TOOL_NAME;
}

/**
 * 購入中の取り直しを続けるか。止めるのは残高が動いたときだけ。
 * 残枠は署名の時点で先に減る（`payments/payment-session.ts` の `availableSpendUsd` 参照）ので、
 * 残枠で止めると肝心の残高が古いまま残る
 */
export function shouldContinueBalanceWatch(state: { balanceChanged: boolean; settled: boolean; elapsedMs: number }): boolean {
  return !state.balanceChanged && !state.settled && state.elapsedMs < BALANCE_WATCH_MAX_MS;
}

/** 停止の判定に使う残高。取れていなければ null（サーバーは失敗を例外にせず balance: null で返す） */
export function balanceKey(status: { balance: { display: string } | null | undefined }): string | null {
  return status.balance?.display ?? null;
}

/** 残高が実際に動いたか。どちらかが取れていない回は「動いていない」とみなし、監視を続ける */
export function didBalanceChange(prev: string | null, next: string | null): boolean {
  return prev !== null && next !== null && prev !== next;
}

/**
 * 失敗した購入に添える見出し（決定48・60）。金が動いたのか、動いたかどうかも分からないのかを、
 * 分かるなら額とともに利用者に見せる。paymentUncertain は ProcessPayment の応答が確認できなかった
 * 購入で、支払われた可能性が残るため「失敗」とだけ見せてはいけない
 */
export function purchaseFailurePrefix(purchase: {
  paymentMade: boolean;
  paymentUncertain?: boolean;
  amountDisplay?: string;
}): string {
  const amount = purchase.amountDisplay ? ` ${purchase.amountDisplay}` : '';
  if (purchase.paymentMade) return `支払い済み${amount}・`;
  if (purchase.paymentUncertain) return `支払いの成否不明${amount}・`;
  return '';
}

/**
 * 購入 1 件の説明文（決定60）。売り手の価格は依頼ごとに変わるので、いくら払ったかを
 * 購入そのものに添えて見せる。額が分からない購入（古い記録・支払い前の失敗）は
 * これまでどおり支払いの状況だけを見せる
 */
export function purchaseDetail(purchase: {
  ok: boolean;
  paymentMade: boolean;
  paymentUncertain?: boolean;
  amountDisplay?: string;
  htmlBytes?: number;
  error?: string;
}): string {
  if (!purchase.ok) return `${purchaseFailurePrefix(purchase)}${purchase.error ?? '失敗'}`;
  const paid = purchase.paymentMade ? '支払い済み' : '無課金';
  const amount = purchase.amountDisplay ? ` ${purchase.amountDisplay}` : '';
  return `${paid}${amount} ${purchase.htmlBytes ?? '?'} バイト`;
}

// ── チャットの中に購入したページを差し込む並び（決定50） ──

/** チャット欄に並ぶものの識別子。吹き出しはメッセージ ID、購入カードは resultId、途中経過は依頼ごとの ID */
export type ChatNodeKey =
  | { kind: 'message'; id: string }
  | { kind: 'purchase'; id: string }
  | { kind: 'timeline'; id: string };

/**
 * 吹き出し・途中経過・購入カードの並びを決める（決定50: 購入したページはチャットの中に描く）。
 * カードは「届いた時点で末尾だった吹き出し」を錨に持ち、その直後に入る。途中経過（決定65）は
 * その依頼の吹き出しを錨に持ち、同じ錨のカードより前に入る（経過の後に成果物が来る）。
 * 錨が見つからない（承認の応答で空の吹き出しが消えた等）ものは末尾に置く。
 * この順序どおりに DOM を並べ替えると iframe が読み込み直しになるため、
 * 呼び出し側は既にある要素を動かさない差分の当て方をすること
 */
export function orderChatNodes(
  messageIds: readonly string[],
  cards: readonly { resultId: string; afterMessageId: string | null }[],
  timelines: readonly { id: string; afterMessageId: string | null }[] = [],
): ChatNodeKey[] {
  const placed = new Set<string>();
  const order: ChatNodeKey[] = [];
  for (const id of messageIds) {
    order.push({ kind: 'message', id });
    for (const timeline of timelines) {
      if (timeline.afterMessageId !== id) continue;
      placed.add(`timeline:${timeline.id}`);
      order.push({ kind: 'timeline', id: timeline.id });
    }
    for (const card of cards) {
      if (card.afterMessageId !== id) continue;
      placed.add(`purchase:${card.resultId}`);
      order.push({ kind: 'purchase', id: card.resultId });
    }
  }
  for (const timeline of timelines) {
    if (placed.has(`timeline:${timeline.id}`)) continue;
    order.push({ kind: 'timeline', id: timeline.id });
  }
  for (const card of cards) {
    if (placed.has(`purchase:${card.resultId}`)) continue;
    order.push({ kind: 'purchase', id: card.resultId });
  }
  return order;
}

/**
 * 錨にしていた吹き出しが消えたときの付け替え先（直前の生き残り。無ければ null）。
 * 付け替えないとカードが末尾へ動き、DOM の入れ直しで iframe が読み込み直しになる
 * （承認へ応答すると、生成先の空の吹き出しが消えることがある）
 */
export function retargetAnchor(
  order: readonly string[],
  removedId: string,
  alive: ReadonlySet<string>,
): string | null {
  for (let i = order.indexOf(removedId) - 1; i >= 0; i--) {
    if (alive.has(order[i])) return order[i];
  }
  return null;
}

/**
 * 購入履歴の行を「表示中」として強調するか（決定62）。強調はプレビューに描けた後に付けるので、
 * 表示できない失敗の行は resultId が同じでも強調しない
 */
export function isSelectedPurchase(purchase: { ok: boolean; resultId: string }, selected: string | null): boolean {
  return purchase.ok && purchase.resultId === selected;
}

/**
 * 1 つきりのホスト（購入履歴のプレビュー）の置き場（決定62）。
 * - 作っている途中に続けて求められたら、作り終わるのを待つ同じ Promise を渡す（同じ iframe に二重に載せない）
 * - 作っている途中に捨てられたら、出来上がったものを閉じて null を渡す（置き場には戻さない。戻すと次の表示が古いホストを使い回す）
 * - 作るのに失敗したら置き場は空のままにし、次に求められたときに作り直す
 */
export function createHostSlot<T extends { destroy(): void }>(create: () => Promise<T>) {
  let current: T | null = null;
  let pending: Promise<T | null> | null = null;
  let generation = 0;
  return {
    get(): Promise<T | null> {
      if (current) return Promise.resolve(current);
      if (pending) return pending;
      const started = generation;
      // create を次の番に回すのは、同期で投げても pending を埋めた後に片付けるため
      const task: Promise<T | null> = Promise.resolve()
        .then(create)
        .then((host) => {
          if (started !== generation) {
            host.destroy();
            return null;
          }
          current = host;
          return host;
        })
        .finally(() => {
          if (pending === task) pending = null;
        });
      pending = task;
      return task;
    },
    discard() {
      generation += 1;
      pending = null;
      current?.destroy();
      current = null;
    },
  };
}
