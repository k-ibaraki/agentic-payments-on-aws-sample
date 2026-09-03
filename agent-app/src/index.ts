// 買い手のブラウザ UI（決定28・29）。
// サインイン → 依頼の送信（useChat）→ Realtime のチャンク表示 → 購入物の一覧 →
// 売り手の MCP Apps UI（ui://）をホストとして描画し、購入済み HTML を注入する
import { api, authApi, buyer } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
import { useChat, type AgentStreamChunk, type ChatMessage } from '@aws-blocks/bb-agent/client';
import { mountPreviewHost, type PreviewHost, type SellerInfo } from './mcp-apps-host.js';

// ── DOM ヘルパー（文字列は必ず textContent で入れ、innerHTML は使わない） ──
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`要素が見つかりません: #${id}`);
  return node as T;
}

function showMessage(target: HTMLElement, text: string, cls?: 'success' | 'error') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  target.replaceChildren(span);
}

function appendEvent(text: string) {
  const events = el('events');
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  events.appendChild(line);
  events.scrollTop = events.scrollHeight;
}

// ── チャット（useChat が購読の確立 → 履歴 → 送信の順序を担う。決定26） ──
type Purchase = Awaited<ReturnType<typeof buyer.listPurchases>>['purchases'][number];

let previewHost: PreviewHost | null = null;
let sellerInfo: SellerInfo | null = null;

function renderMessages(messages: ChatMessage[]) {
  const log = el('chat-log');
  log.replaceChildren(
    ...messages.map((m) => {
      const div = document.createElement('div');
      div.className = `msg ${m.role}`;
      div.textContent = m.content;
      return div;
    }),
  );
  log.scrollTop = log.scrollHeight;
}

function describeChunk(chunk: AgentStreamChunk): string {
  switch (chunk.type) {
    case 'tool-call':
      return `tool-call ${chunk.toolName ?? ''} ${chunk.input !== undefined ? JSON.stringify(chunk.input) : ''}`;
    case 'tool-result':
      return `tool-result ${chunk.toolName ?? ''}（支払いと生成が完了。購入一覧を更新します）`;
    case 'done':
      return `done${chunk.usage ? ` tokens=${chunk.usage.totalTokens}` : ''}`;
    case 'error':
      return `error ${chunk.error ?? ''}`;
    case 'text-delta':
      return `text-delta ${(chunk.text ?? '').length} 文字`;
    default:
      return chunk.type;
  }
}

const chat = useChat({
  api: {
    // buyer API は channelId を受け取らない（会話 ID に固定。他人の会話へのストリーム注入を防ぐ）
    sendMessage: async (conversationId, message) => {
      await buyer.sendMessage(conversationId, message);
    },
    createConversation: () => buyer.createConversation(),
    getConversation: (id) => buyer.getMessages(id),
    // 二重支払いの防護（決定31）: 人の承認待ちへの応答と、未応答の確認
    resume: async (channelId, responses) => {
      await buyer.resume(channelId, responses.map((r) => ({ interruptId: r.interruptId, approved: r.approved, ...(r.trust !== undefined ? { trust: r.trust } : {}) })));
    },
    getPendingInterrupts: (id) => buyer.getPendingInterrupts(id),
  },
  subscribe: async (channelId, handler) => {
    const channel = await buyer.getChannel(channelId);
    return channel.subscribe(handler);
  },
  onMessagesChange: renderMessages,
  onLoadingChange: (loading) => {
    (el<HTMLButtonElement>('chat-send-btn')).disabled = loading;
  },
  onChunk: (chunk) => {
    appendEvent(describeChunk(chunk));
    if (chunk.type === 'tool-result' || chunk.type === 'done') void refreshPurchases();
  },
  onError: (error) => appendEvent(`エラー: ${error}`),
  onInterrupt: renderInterrupts,
});

// エージェントが人の承認を求めてきた（決定31: 支払い済みで成果物の無い購入がある会話での再購入）
function renderInterrupts(interrupts: Array<{ id: string; name: string; reason?: any }>) {
  const box = el('interrupts');
  box.replaceChildren(
    ...interrupts.map((it) => {
      const row = document.createElement('div');
      row.className = 'interrupt';
      const text = document.createElement('span');
      const reason = it.reason as { message?: string; unresolved?: string[] } | undefined;
      text.textContent = `${reason?.message ?? it.name}${reason?.unresolved?.length ? `（未解決: ${reason.unresolved.join(', ')}）` : ''}`;
      row.appendChild(text);
      for (const [label, approved] of [['もう一度支払う', true], ['やめる', false]] as const) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', async () => {
          box.replaceChildren();
          appendEvent(`承認への応答: ${label}`);
          await chat.respondToInterrupt([{ interruptId: it.id, approved }]);
        });
        row.appendChild(button);
      }
      return row;
    }),
  );
  appendEvent(`interrupt ${interrupts.map((i) => i.name).join(', ')}（人の承認待ち）`);
}

// 直近の会話 ID をブラウザに覚えさせ、再読込後も購入一覧とプレビューへ戻れるようにする
const LAST_CONVERSATION_KEY = 'agent-app:last-conversation';

async function sendCurrentInput() {
  const input = el<HTMLInputElement>('chat-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await chat.sendMessage(text);
    const conversationId = chat.getConversationId();
    el('conversation-id').textContent = conversationId ?? '（未作成）';
    if (conversationId) localStorage.setItem(LAST_CONVERSATION_KEY, conversationId);
  } catch (error) {
    appendEvent(`送信に失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 購入物 ────────────────────────────────────────────────────────────
async function refreshPurchases() {
  const conversationId = chat.getConversationId();
  if (!conversationId) return;
  const { purchases } = await buyer.listPurchases(conversationId);
  const container = el('purchases');
  if (purchases.length === 0) {
    showMessage(container, 'まだありません');
    return;
  }
  container.replaceChildren(...purchases.map(renderPurchase));
}

function renderPurchase(purchase: Purchase): HTMLElement {
  const row = document.createElement('div');
  row.className = 'purchase';

  const button = document.createElement('button');
  button.textContent = purchase.ok ? '表示' : '失敗';
  button.disabled = !purchase.ok;
  button.addEventListener('click', () => void showPurchase(purchase.resultId));
  row.appendChild(button);

  const id = document.createElement('code');
  id.textContent = purchase.resultId;
  row.appendChild(id);

  const detail = document.createElement('span');
  detail.className = purchase.ok ? 'success' : 'error';
  detail.textContent = purchase.ok
    ? `${purchase.paymentMade ? '支払い済み' : '無課金'} ${purchase.htmlBytes ?? '?'} バイト`
    : `${purchase.paymentMade ? '支払い済み・' : ''}${purchase.error ?? '失敗'}`;
  row.appendChild(detail);

  if (purchase.transaction) {
    const tx = document.createElement('a');
    tx.href = `https://sepolia.basescan.org/tx/${purchase.transaction}`;
    tx.target = '_blank';
    tx.rel = 'noopener';
    tx.textContent = 'tx';
    row.appendChild(tx);
  }
  return row;
}

// 購入済み HTML を、売り手の MCP Apps UI（ホスト実装）に注入して描画する（決定29）
async function showPurchase(resultId: string) {
  const status = el('purchase-status');
  try {
    const artifact = await buyer.getPurchasedHtml(resultId);
    if (!artifact?.html) {
      showMessage(status, 'この購入には HTML がありません（支払い後の失敗）', 'error');
      return;
    }
    const host = await ensurePreviewHost();
    await host.showHtml(artifact.html, artifact.filename);
    showMessage(status, `resultId ${resultId} を表示中${artifact.transaction ? `（tx ${artifact.transaction}）` : ''}`, 'success');
  } catch (error) {
    showMessage(status, `表示に失敗: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

async function ensurePreviewHost(): Promise<PreviewHost> {
  if (previewHost) return previewHost;
  sellerInfo ??= await buyer.getSellerInfo();
  appendEvent(`ui:// を取得: ${sellerInfo.resourceUri}（${sellerInfo.mcpUrl}）`);
  previewHost = await mountPreviewHost(el<HTMLIFrameElement>('preview-frame'), sellerInfo, {
    onDownload: (filename, html) => {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  appendEvent('MCP Apps の View を初期化しました');
  return previewHost;
}

async function resumeLastConversation() {
  const conversationId = localStorage.getItem(LAST_CONVERSATION_KEY);
  if (!conversationId) return;
  try {
    await chat.loadConversation(conversationId);
    el('conversation-id').textContent = conversationId;
    appendEvent(`前回の会話 ${conversationId} を再開しました`);
    await refreshPurchases();
  } catch (error) {
    // 他の利用者の会話やサーバー再起動後の ID は所有検証で弾かれる。忘れて新規に始める
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    appendEvent(`前回の会話を再開できませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resetConversationUi() {
  chat.destroy();
  localStorage.removeItem(LAST_CONVERSATION_KEY);
  el('chat-log').replaceChildren();
  el('events').replaceChildren();
  el('interrupts').replaceChildren();
  el('conversation-id').textContent = '（未作成）';
  showMessage(el('purchases'), 'まだありません');
}

// ── 起動 ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  el('auth-container').appendChild(Authenticator(authApi));

  onAuthChange(authApi, (user) => {
    el('auth-status').textContent = user ? `サインイン中: ${user.username}` : '未サインイン';
    document.body.classList.toggle('signed-in', !!user);
    if (user) {
      void resumeLastConversation();
    } else {
      chat.destroy();
      previewHost?.destroy();
      previewHost = null;
    }
  });

  el('last-code-btn').addEventListener('click', async () => {
    const result = el('last-code-result');
    const last = await api.getLastCode();
    if (last) showMessage(result, `${last.purpose}: ${last.code}`, 'success');
    else showMessage(result, 'コードはまだありません（デプロイ環境では常に空）');
  });

  el('chat-send-btn').addEventListener('click', () => void sendCurrentInput());
  el<HTMLInputElement>('chat-text').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) void sendCurrentInput();
  });
  el('chat-new-btn').addEventListener('click', () => {
    // 会話を捨てて新しい ID を採番させる（次の送信時に createConversation が走る）
    resetConversationUi();
    appendEvent('新しい会話を始めます');
  });
});
