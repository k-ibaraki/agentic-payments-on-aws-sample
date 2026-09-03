// 会話メッセージから購入記録を抜き出す（決定29・30）。
// Agent ブロックの tool-result チャンクは toolName しか運ばないため、ブラウザが
// resultId を知る経路として、会話履歴の tool-result メッセージ（metadata.toolOutput）を読む。
// toolOutput は Strands のツール結果 content（JsonBlock は { json }、TextBlock は { text }）が
// JSON 化されたもの。形は上流の都合で変わり得るので、いずれの形でも拾い、壊れていれば無視する

/** ブラウザへ返す購入 1 件分。HTML 本体は含めない（getPurchasedHtml で取る） */
export interface PurchaseSummary {
  resultId: string;
  ok: boolean;
  paymentMade: boolean;
  transaction?: string;
  htmlBytes?: number;
  error?: string;
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
    ...(typeof summary.transaction === 'string' ? { transaction: summary.transaction } : {}),
    ...(typeof summary.htmlBytes === 'number' ? { htmlBytes: summary.htmlBytes } : {}),
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
