// 会話メッセージから購入記録を抜き出す（決定29・30）。
// Agent ブロックの tool-result チャンクは toolName しか運ばないため、ブラウザが
// resultId を知る経路として、会話履歴の tool-result メッセージ（metadata.toolOutput）を読む。
// toolOutput は Strands のツール結果 content（JsonBlock は { json }、TextBlock は { text }）が
// JSON 化されたもの。形は上流の都合で変わり得るので、いずれの形でも拾い、壊れていれば無視する。
// このファイルは src/ui-rules.ts（ブラウザ）からも PURCHASE_TOOL_NAME を読む。
// import を足すとブラウザの束にサーバー用の依存が入るので、依存を増やさないこと

/** ブラウザへ返す購入 1 件分。HTML 本体は含めない（getPurchasedHtml で取る） */
export interface PurchaseSummary {
  resultId: string;
  ok: boolean;
  paymentMade: boolean;
  /**
   * 支払いの成否が確認できなかった（決定48）。ProcessPayment がタイムアウト等で応答を
   * 返さず、支払いが成立したかどうか買い手からは判別できない状態。paymentMade とは
   * 別に持ち、未解決の購入として承認の要求に数える
   */
  paymentUncertain?: boolean;
  transaction?: string;
  htmlBytes?: number;
  error?: string;
  /**
   * 支払った額の表記（決定60。例 `$0.15（150000）`）。売り手の価格が変動するため、
   * いくら払ったかは購入ごとに違う。生の額ではなく人が読む形で運ぶ
   */
  amountDisplay?: string;
}

/** 購入ツールの名前（buyer-agent.ts の tools のキーと一致させる） */
export const PURCHASE_TOOL_NAME = 'generateHtml';

interface MessageLike {
  role: string;
  metadata?: { toolName?: string; toolOutput?: unknown } | undefined;
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// content ブロック（{ json } / { text }）または素のオブジェクトから、ツールの返した要約を取り出す
function summariesFrom(value: unknown): Record<string, unknown>[] {
  const parsed = typeof value === 'string' ? parseJsonSafely(value) : value;
  if (parsed === undefined || parsed === null) return [];
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const out: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (typeof b.json === 'object' && b.json !== null) {
      out.push(b.json as Record<string, unknown>);
    } else if (typeof b.text === 'string') {
      const inner = parseJsonSafely(b.text);
      if (typeof inner === 'object' && inner !== null) out.push(inner as Record<string, unknown>);
    } else if ('resultId' in b) {
      out.push(b);
    }
  }
  return out;
}

function toPurchase(summary: Record<string, unknown>): PurchaseSummary | undefined {
  if (typeof summary.resultId !== 'string') return undefined;
  return {
    resultId: summary.resultId,
    ok: summary.ok === true,
    paymentMade: summary.paymentMade === true,
    ...(summary.paymentUncertain === true ? { paymentUncertain: true } : {}),
    ...(typeof summary.transaction === 'string' ? { transaction: summary.transaction } : {}),
    ...(typeof summary.htmlBytes === 'number' ? { htmlBytes: summary.htmlBytes } : {}),
    ...(typeof summary.amountDisplay === 'string' ? { amountDisplay: summary.amountDisplay } : {}),
    ...(summary.ok !== true && typeof summary.message === 'string' ? { error: summary.message } : {}),
  };
}

export function extractPurchases(messages: readonly MessageLike[]): PurchaseSummary[] {
  const purchases: PurchaseSummary[] = [];
  for (const message of messages) {
    if (message.role !== 'tool-result') continue;
    if (message.metadata?.toolName !== PURCHASE_TOOL_NAME) continue;
    for (const summary of summariesFrom(message.metadata?.toolOutput)) {
      const purchase = toPurchase(summary);
      if (purchase) purchases.push(purchase);
    }
  }
  return purchases;
}

// ── 利用者ごとの購入履歴（決定50） ──

/** 履歴として返す会話（購入のあるもの）の数の上限 */
export const PURCHASE_HISTORY_CONVERSATIONS = 20;
/**
 * 1 回の呼び出しで読む会話の数の天井。会話 1 件ぶんの履歴を丸ごと読むため、購入の無い会話が
 * 続いても際限なく古い方へ読みに行かないよう、返す数とは別に読む数を有界にする
 */
export const PURCHASE_HISTORY_SCAN_LIMIT = 100;
/** 同時に読む会話の数。Lambda が一度に抱える履歴の量を抑える */
const PURCHASE_HISTORY_BATCH = 5;

/** 会話 1 件ぶんの購入。並びは会話の中の順序を保つ */
export interface ConversationPurchases {
  conversationId: string;
  updatedAt: number;
  purchases: PurchaseSummary[];
}

export interface PurchaseHistory {
  /** 購入のある会話。新しい順 */
  conversations: ConversationPurchases[];
  /** 読んだ会話の数。`total` より少なければ、それより古い会話は読んでいない（画面で伝える） */
  scanned: number;
  /** 利用者の会話の総数 */
  total: number;
  /** 取得に失敗して飛ばした会話の数。読めた分だけを返す */
  failed: number;
}

/**
 * 利用者の会話を新しい順にたどり、購入のある会話を集める（決定50）。
 * 会話の所有は呼び出し側（`listConversations(userSub)`）で解決済みであることを前提にする。
 * 購入物そのものは利用者ごとの KVStore にあるため、会話をまたいでも `getPurchasedHtml` で開ける。
 *
 * 購入のある会話が `limit` 件そろうか、`scanLimit` 件読むか、会話が尽きるまで、
 * `batch` 件ずつ読み進める。購入の無い会話は新規会話を押して 1 度送るたびに残るので、
 * 読む数で切ると古い購入が黙って消える。1 会話の取得失敗は飛ばして数だけ伝える
 * （この索引は支払い済みの成果物へ辿る唯一の経路なので、1 件の失敗で全体を落とさない）
 */
export async function purchaseHistory(
  conversations: readonly { conversationId: string; updatedAt: number }[],
  getMessages: (conversationId: string) => Promise<readonly MessageLike[]>,
  options: { limit?: number; scanLimit?: number; batch?: number } = {},
): Promise<PurchaseHistory> {
  const limit = options.limit ?? PURCHASE_HISTORY_CONVERSATIONS;
  const scanLimit = options.scanLimit ?? PURCHASE_HISTORY_SCAN_LIMIT;
  const batch = options.batch ?? PURCHASE_HISTORY_BATCH;
  const recent = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, scanLimit);
  const found: ConversationPurchases[] = [];
  let scanned = 0;
  let failed = 0;
  while (scanned < recent.length && found.length < limit) {
    const chunk = recent.slice(scanned, scanned + batch);
    const results = await Promise.allSettled(chunk.map((c) => getMessages(c.conversationId)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        failed += 1;
        return;
      }
      const purchases = extractPurchases(result.value);
      if (purchases.length > 0) {
        found.push({ conversationId: chunk[i].conversationId, updatedAt: chunk[i].updatedAt, purchases });
      }
    });
    scanned += chunk.length;
  }
  return { conversations: found.slice(0, limit), scanned, total: conversations.length, failed };
}
