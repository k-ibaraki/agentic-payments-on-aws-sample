// 買い手のブラウザ UI（決定28・29）。
// サインイン → 依頼の送信（useChat）→ Realtime のチャンク表示 → 購入物の一覧 →
// 売り手の MCP Apps UI（ui://）をホストとして描画し、購入済み HTML を注入する
import { api, authApi, buyer } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
import { useChat, type AgentStreamChunk, type ChatMessage } from '@aws-blocks/bb-agent/client';
import { mountPreviewHost, type PreviewHost, type SellerInfo } from './mcp-apps-host.js';
import { readInternalsOpen, shouldConfirmNewConversation, storeInternalsOpen } from './ui-rules.js';

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

function showError(target: HTMLElement, text: string) {
  showMessage(target, text, 'error');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
// 画面に出ている吹き出しの数。新規会話で確認を挟むかの判断に使う（決定44）
let messageCount = 0;

function renderMessages(messages: ChatMessage[]) {
  messageCount = messages.length;
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
      return `tool-result ${chunk.toolName ?? ''}（ツールの実行が終わりました。購入一覧を更新します）`;
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

// useChat の destroy() は購読を外すだけで conversationId と messages を保持する。
// 会話を捨てる（新規会話・サインアウト・再開失敗）ときはインスタンスごと作り直す
function createChat() {
  return useChat({
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
      if (chunk.type === 'tool-result' || chunk.type === 'done') {
        // 失敗は refreshPurchases が画面に出すので、ここでは再送出だけ抑える
        refreshPurchases().catch(() => {});
        // 支払いの後の残高と残枠を取り直す（残高の推移はここで積み上がる。決定42）
        refreshWallet().catch(() => {});
      }
    },
    onError: (error) => appendEvent(`エラー: ${error}`),
    onInterrupt: renderInterrupts,
  });
}

let chat = createChat();

// 会話の状態（フック・画面）を捨てて新しいインスタンスにする。localStorage の会話 ID は触らない。
// プレビューの iframe には前の利用者が買ったページが残るため、ここで必ず外す
function discardConversation() {
  chat.destroy();
  chat = createChat();
  messageCount = 0;
  el('chat-log').replaceChildren();
  el('events').replaceChildren();
  el('interrupts').replaceChildren();
  el('conversation-id').textContent = '（未作成）';
  showMessage(el('purchases'), 'まだありません');
  discardPreview();
}

// ── ウォレットと支払いの枠（決定42・43） ─────────────────────────
type WalletStatus = Awaited<ReturnType<typeof buyer.getWalletStatus>>;

// 残高の推移はブラウザの中だけで持つ（取り直すたびに、値が変わっていれば行を足す）
const balanceHistory: Array<{ at: Date; display: string }> = [];

function renderWallet(status: WalletStatus) {
  const balance = el('wallet-balance');
  if (status.balance) {
    balance.textContent = `${status.balance.display} ${status.balance.token}（Base Sepolia）`;
  } else {
    showError(balance, status.balanceError ?? '取得できませんでした');
  }

  const session = el('session-status');
  if (status.session) {
    const s = status.session;
    session.textContent =
      `残枠 ${s.availableSpendUsd ?? '?'} / 上限 ${s.maxSpendUsd ?? '?'} USD` +
      `（期限 ${new Date(s.expiresAt).toLocaleTimeString()}、ID ${s.paymentSessionId}）`;
  } else if (status.sessionError) {
    showError(session, status.sessionError);
  } else {
    showMessage(session, `なし（次の購入で ${status.sessionMinutes} 分のセッションを切ります）`);
  }

  el('spend-limit').textContent =
    `${status.spendLimit.maxSpendUsd} USD / セッション` +
    `（${status.spendLimit.source === 'user' ? 'この画面で設定' : '既定'}）`;
}

function recordBalance(status: WalletStatus) {
  if (!status.balance) return;
  const last = balanceHistory[balanceHistory.length - 1];
  if (last && last.display === status.balance.display) return;
  balanceHistory.push({ at: new Date(), display: status.balance.display });
  const box = el('balance-history');
  box.replaceChildren(
    ...balanceHistory.map((entry, i) => {
      const line = document.createElement('div');
      const prev = balanceHistory[i - 1];
      const delta = prev ? (Number(entry.display) - Number(prev.display)).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : null;
      line.textContent =
        `${entry.at.toLocaleTimeString()} ${entry.display} USDC` +
        (delta !== null ? `（${Number(delta) >= 0 ? '+' : ''}${delta}）` : '');
      return line;
    }),
  );
  box.scrollTop = box.scrollHeight;
}

// 取得の失敗だけを #wallet-status に出す。成功時は触らない（上限変更の結果表示を消さないため）
async function refreshWallet() {
  try {
    const status = await buyer.getWalletStatus();
    renderWallet(status);
    recordBalance(status);
  } catch (error) {
    showError(el('wallet-status'), `ウォレットの状態を取得できませんでした: ${describeError(error)}`);
    throw error;
  }
}

async function submitSpendLimit() {
  const input = el<HTMLInputElement>('spend-limit-text');
  const value = input.value.trim();
  if (!value) return;
  const note = el('wallet-status');
  const button = el<HTMLButtonElement>('spend-limit-btn');
  button.disabled = true;
  try {
    const result = await buyer.setSpendLimit(value);
    input.value = '';
    showMessage(
      note,
      `上限を ${result.spendLimit.maxSpendUsd} USD にしました` +
        (result.discardedSession ? `（セッション ${result.discardedSession} を破棄）` : '（破棄するセッションはありません）'),
      'success',
    );
    appendEvent(`支出上限を変更: ${result.spendLimit.maxSpendUsd} USD`);
    await refreshWallet();
  } catch (error) {
    showError(note, `上限を変更できませんでした: ${describeError(error)}`);
  } finally {
    button.disabled = false;
  }
}

function discardWallet() {
  balanceHistory.length = 0;
  for (const id of ['wallet-balance', 'session-status', 'spend-limit']) el(id).textContent = '（未取得）';
  el('wallet-status').replaceChildren();
  showMessage(el('balance-history'), 'まだありません');
}

// 購入したページの表示を消す。MCP Apps の View は次の表示でまた載せ直す
function discardPreview() {
  previewHost?.destroy();
  previewHost = null;
  el('purchase-status').replaceChildren();
  el<HTMLIFrameElement>('preview-frame').removeAttribute('srcdoc');
}

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
// 内部情報（開発者向け）の折りたたみを閉じたままにしたいかも覚える
const INTERNALS_OPEN_KEY = 'agent-app:internals-open';

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
    appendEvent(`送信に失敗: ${describeError(error)}`);
  }
}

// ── 購入物 ────────────────────────────────────────────────────────────
async function refreshPurchases() {
  const conversationId = chat.getConversationId();
  if (!conversationId) return;
  // 購入一覧は「支払ったのに成果物が無い」ことを利用者に伝える唯一の経路なので、
  // 取得に失敗したら黙って諦めず、必ず画面に出す
  let purchases: Purchase[];
  try {
    ({ purchases } = await buyer.listPurchases(conversationId));
  } catch (error) {
    appendEvent(`購入一覧を取得できませんでした: ${describeError(error)}`);
    showError(el('purchases'), '購入一覧を取得できませんでした（支払いは記録されている可能性があります）');
    throw error;
  }
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
    showError(status, `表示に失敗: ${describeError(error)}`);
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
  } catch (error) {
    // 他の利用者の会話やサーバー再起動後の ID は所有検証で弾かれる。忘れて新規に始める。
    // loadConversation は失敗しても conversationId を保持するため、インスタンスごと捨てる
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    discardConversation();
    appendEvent(`前回の会話を再開できませんでした: ${describeError(error)}`);
    return;
  }
  el('conversation-id').textContent = conversationId;
  appendEvent(`前回の会話 ${conversationId} を再開しました`);
  // 一覧の取得に失敗しても会話は捨てない（一時的な不調で履歴を見失わせない）。
  // 失敗は refreshPurchases が画面に出す
  await refreshPurchases().catch(() => {});
}

// ── 起動 ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Authenticator はサインインのフォームとサインアウトの操作を同じ要素で描く。
  // 未サインイン時は中央のカード、サインイン後はヘッダーへ、要素ごと移して使い回す（決定44）
  const authenticator = Authenticator(authApi);
  el('auth-container').appendChild(authenticator);

  onAuthChange(authApi, (user) => {
    el('auth-status').textContent = user ? `サインイン中: ${user.username}` : '未サインイン';
    document.body.classList.toggle('signed-in', !!user);
    el(user ? 'auth-nav' : 'auth-container').appendChild(authenticator);
    if (user) {
      void resumeLastConversation();
      refreshWallet().catch(() => {});
    } else {
      // 同じブラウザで別の利用者がサインインしても前の会話とページが見えないよう、画面ごと捨てる
      discardConversation();
      discardWallet();
    }
  });

  el('spend-limit-btn').addEventListener('click', () => void submitSpendLimit());
  el<HTMLInputElement>('spend-limit-text').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) void submitSpendLimit();
  });
  el('wallet-refresh-btn').addEventListener('click', () => {
    refreshWallet().catch(() => {});
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
    // 押し直しは効かない（画面から再開する手段が無い）ので、会話があるときは確認を挟む
    if (
      shouldConfirmNewConversation(messageCount) &&
      !window.confirm('今の会話と購入一覧は画面から消えます。新しい会話を始めますか？')
    ) {
      return;
    }
    // 会話を捨てて新しい ID を採番させる（次の送信時に createConversation が走る）
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    discardConversation();
    appendEvent('新しい会話を始めます');
  });

  // 内部情報の折りたたみは既定で開き、閉じた状態だけをブラウザに覚えさせる
  const internals = el<HTMLDetailsElement>('internals');
  internals.open = readInternalsOpen(localStorage.getItem(INTERNALS_OPEN_KEY));
  internals.addEventListener('toggle', () => {
    localStorage.setItem(INTERNALS_OPEN_KEY, storeInternalsOpen(internals.open));
  });
});
