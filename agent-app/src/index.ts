// 買い手のブラウザ UI（決定28・29・50）。
// サインイン → 依頼の送信（useChat）→ Realtime のチャンク表示 → 買えたページを会話の中に描画 →
// 「購入履歴」タブで会話をまたいだ購入を一覧する。
// ページの描画はいずれも、売り手の MCP Apps UI（ui://）をホストとして載せ、購入済み HTML を注入する
import { api, authApi, buyer } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
import { useChat, type AgentStreamChunk, type ChatMessage } from '@aws-blocks/bb-agent/client';
import { mountPreviewHost, type PreviewHost, type SellerInfo } from './mcp-apps-host.js';
import { renderAssistantMarkdown } from './markdown.js';
import {
  BALANCE_WATCH_INTERVAL_MS,
  STRIP_EMPTY,
  balanceKey,
  didBalanceChange,
  findLastAssistant,
  isPaidToolCall,
  orderChatNodes,
  purchaseFailurePrefix,
  readInternalsOpen,
  retargetAnchor,
  shouldConfirmNewConversation,
  shouldContinueBalanceWatch,
  shouldFlashValue,
  storeInternalsOpen,
  stripBalance,
  stripRemaining,
} from './ui-rules.js';

// ── DOM ヘルパー（文字列は必ず textContent で入れる。innerHTML は
// Agent の応答の Markdown 描画だけが例外で、そこは DOMPurify を通す。決定46） ──
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
type PurchaseGroup = Awaited<ReturnType<typeof buyer.listPurchaseHistory>>['conversations'][number];

// 「購入履歴」タブのプレビュー（選んだ 1 件だけを載せる。会話の中のプレビューとは別）
let previewHost: PreviewHost | null = null;
let sellerInfo: SellerInfo | null = null;
// 画面に出ている吹き出しの数。新規会話で確認を挟むかの判断に使う（決定44）
let messageCount = 0;
// 生成中は text-delta ごとに再描画が走る。組み立て途中の Markdown（閉じていない ``` など）を
// 解釈すると後続が消えてしまうので、その間だけは素の文字列で出す（決定46）
let streamingResponse = false;
let lastMessages: ChatMessage[] = [];
// 変換の結果を本文で覚える。再描画は delta のたびに走り、そのつど過去の応答まで変換し直すため
const markdownCache = new Map<string, string>();

// 吹き出しはメッセージ ID を鍵に使い回す。毎回作り直すと、同じ chat-log に置いた
// 購入カードの iframe まで DOM から外れて読み込み直しになり、MCP Apps の接続が切れる（決定50）
const bubbles = new Map<string, { node: HTMLElement; content: string; markdown: boolean }>();
// 会話の中に描いた購入カード。resultId ごとに 1 つで、届いた時点の末尾の吹き出しを錨に持つ
const purchaseCards = new Map<
  string,
  { node: HTMLElement; afterMessageId: string | null; host: PreviewHost | null }
>();
// 会話の作り直しをまたいだ非同期処理を捨てるための世代。mount の途中で会話が変わったら片付ける
let conversationGeneration = 0;

function assistantHtml(content: string): string {
  let html = markdownCache.get(content);
  if (html === undefined) {
    html = renderAssistantMarkdown(content);
    markdownCache.set(content, html);
  }
  return html;
}

function renderMessages(messages: ChatMessage[]) {
  lastMessages = messages;
  messageCount = messages.length;
  // 生成中の応答は最後の assistant。承認へ応答すると末尾に approval が積まれ、
  // 生成先はその手前の空プレースホルダになり得るので、位置の決め打ちにはしない
  const streamingIndex = streamingResponse ? findLastAssistant(messages) : -1;
  const alive = new Set(messages.map((m) => m.id));
  const order = [...bubbles.keys()];
  for (const [id, bubble] of bubbles) {
    if (alive.has(id)) continue;
    // 消える吹き出しを錨にしているカードは、直前の生き残りへ付け替える。
    // 付け替えないとカードが末尾へ動き、載せた View（iframe）が読み込み直しになる
    const fallback = retargetAnchor(order, id, alive);
    for (const card of purchaseCards.values()) {
      if (card.afterMessageId === id) card.afterMessageId = fallback;
    }
    bubble.node.remove();
    bubbles.delete(id);
  }
  messages.forEach((message, i) => updateBubble(message, i !== streamingIndex));
  layoutChatLog(messages.map((m) => m.id));
}

// 中身が変わったときだけ書き込む（毎回書くと、選択やスクロールの位置が飛ぶ）
function updateBubble(message: ChatMessage, done: boolean) {
  const markdown = message.role === 'assistant' && done;
  const existing = bubbles.get(message.id);
  const node = existing?.node ?? document.createElement('div');
  if (!existing || existing.content !== message.content || existing.markdown !== markdown) {
    node.className = `msg ${message.role}${markdown ? ' markdown' : ''}`;
    if (markdown) node.innerHTML = assistantHtml(message.content);
    else node.textContent = message.content;
  }
  bubbles.set(message.id, { node, content: message.content, markdown });
}

// 吹き出しと購入カードを並べ直す。並びの規則は ui-rules.ts（テスト済み）。
// 吹き出しの順は会話（messages）の順であって、作った順ではない
function layoutChatLog(messageIds: readonly string[]) {
  const cards = [...purchaseCards].map(([resultId, card]) => ({ resultId, afterMessageId: card.afterMessageId }));
  const nodes = orderChatNodes(messageIds, cards)
    .map((key) => (key.kind === 'message' ? bubbles.get(key.id)?.node : purchaseCards.get(key.id)?.node))
    .filter((node): node is HTMLElement => node !== undefined);
  const log = el('chat-log');
  placeChildren(log, nodes);
  log.scrollTop = log.scrollHeight;
}

// 既にある要素は動かさずに並べる。iframe は DOM から外して入れ直すと読み込み直しになり、
// 中の View（AppBridge の接続）が切れるため、末尾への追加以外では触らない
function placeChildren(container: HTMLElement, nodes: readonly HTMLElement[]) {
  nodes.forEach((node, i) => {
    if (container.childNodes[i] !== node) container.insertBefore(node, container.childNodes[i] ?? null);
  });
  while (container.childNodes.length > nodes.length) container.lastChild?.remove();
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
      // 生成が終わった時点で、素のまま出していた最後の応答を Markdown で描き直す。
      // 送信時（loading が真になる側）に描き直すと、直前の応答が素の文字列に戻って点滅する
      streamingResponse = loading;
      if (!loading) renderMessages(lastMessages);
    },
    onChunk: (chunk) => {
      appendEvent(describeChunk(chunk));
      // 支払いは有料ツールの呼び出しの中で起きる。返るまで数秒おきに取り直し、減った瞬間を帯に出す（決定47）
      if (chunk.type === 'tool-call' && isPaidToolCall(chunk.toolName)) startBalanceWatch();
      // interrupt は決定31 の再購入確認。中断中は done も tool-result も出ないので、ここで止めないと承認待ちの間ずっと回る
      if (chunk.type === 'tool-result' || chunk.type === 'done' || chunk.type === 'error' || chunk.type === 'interrupt') {
        stopBalanceWatch();
      }
      if (chunk.type === 'tool-result' || chunk.type === 'done') {
        // 失敗は refreshPurchases が画面に出すので、ここでは再送出だけ抑える
        // 購入が増えていれば refreshPurchases が購入履歴も古い扱いにする
        refreshPurchases(true).catch(() => {});
        // 支払いの後の残高と残枠を取り直す（残高の推移はここで積み上がる。決定42）
        refreshWallet().catch(() => {});
      }
    },
    onError: (error) => {
      // ストリームが落ちるとチャンクは以後届かない。取り直しもここで止める（決定47）
      appendEvent(`エラー: ${error}`);
      stopBalanceWatch();
    },
    onInterrupt: renderInterrupts,
  });
}

let chat = createChat();

// 会話の状態（フック・画面）を捨てて新しいインスタンスにする。localStorage の会話 ID は触らない。
// 会話の中に描いたページは、その会話のものなのでここで外す（購入履歴タブには残る。決定50）
function discardConversation() {
  stopBalanceWatch();
  conversationGeneration += 1;
  chat.destroy();
  chat = createChat();
  messageCount = 0;
  lastMessages = [];
  streamingResponse = false;
  markdownCache.clear();
  bubbles.clear();
  for (const card of purchaseCards.values()) card.host?.destroy();
  purchaseCards.clear();
  el('chat-log').replaceChildren();
  el('chat-status').replaceChildren();
  el('events').replaceChildren();
  el('interrupts').replaceChildren();
  el('conversation-id').textContent = '（未作成）';
}

// ── ウォレットと支払いの枠（決定42・43） ─────────────────────────
type WalletStatus = Awaited<ReturnType<typeof buyer.getWalletStatus>>;

// 残高の推移はブラウザの中だけで持つ（取り直すたびに、値が変わっていれば行を足す）
const balanceHistory: Array<{ at: Date; display: string }> = [];
// 監視の停止判定に使う、最後に取れた残高。取得に失敗した回は捨てずに前の値を残す（決定47）
let lastBalanceKey: string | null = null;
// 取得の通し番号。更新ボタン・購入中の取り直し・購入後の再取得は互いを知らずに並行するため、
// 追い越されて遅れて返った古い応答で帯を巻き戻さないよう、最新の応答だけを画面に反映する
let walletRequestSeq = 0;
let walletRenderedSeq = 0;

// 帯の数字を書き換え、値どうしが変わったときだけ一瞬光らせる（クラスを外して付け直すと再生する）。
// 値が同じなら書き込まない（aria-live の領域なので、同じ文字列の読み上げを繰り返させない）
function renderStrip(status: WalletStatus) {
  for (const [id, cell] of [
    ['strip-balance', stripBalance(status.balance)],
    ['strip-remaining', stripRemaining(status)],
  ] as const) {
    const node = el(id);
    if (node.textContent === cell.text) continue;
    // 光らせる判定は文字列ではなく金額で行う（決定49。添え書きの有無で光らせないため）
    const prev = node.dataset.value ?? '';
    node.textContent = cell.text;
    node.dataset.value = cell.value ?? '';
    if (shouldFlashValue(prev || null, cell.value)) {
      node.classList.remove('flash');
      void node.offsetWidth;
      node.classList.add('flash');
    }
  }
}

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
async function refreshWallet(): Promise<boolean> {
  const seq = ++walletRequestSeq;
  try {
    const status = await buyer.getWalletStatus();
    // 新しい応答を既に描いていれば、この応答は古い。画面も残高の推移も触らない
    if (seq < walletRenderedSeq) return false;
    walletRenderedSeq = seq;
    const key = balanceKey(status);
    const changed = didBalanceChange(lastBalanceKey, key);
    // 取れなかった回で前の値を捨てると、復旧した回に減少を検出できなくなる
    if (key !== null) lastBalanceKey = key;
    renderStrip(status);
    renderWallet(status);
    recordBalance(status);
    return changed;
  } catch (error) {
    if (seq >= walletRenderedSeq) {
      showError(el('wallet-status'), `ウォレットの状態を取得できませんでした: ${describeError(error)}`);
    }
    throw error;
  }
}

// 購入中の取り直し（決定47）。有料ツールの tool-call から、値が変わるかツールが返るか上限に達するまで続ける。
// 取得の失敗はその回を飛ばすだけで続ける（次の回で取れれば減った値を掴める）
let balanceWatch: { timer: ReturnType<typeof setInterval>; startedAt: number; settled: boolean } | null = null;

function startBalanceWatch() {
  stopBalanceWatch();
  const watch = { timer: 0 as unknown as ReturnType<typeof setInterval>, startedAt: Date.now(), settled: false };
  let inflight = false;
  watch.timer = setInterval(() => {
    if (inflight) return;
    // 見えていないタブで課金対象の API を叩き続けない。戻ってきた回、または tool-result で取り直す
    if (document.visibilityState !== 'visible') return;
    inflight = true;
    let changed = false;
    refreshWallet()
      .then((result) => {
        changed = result;
      })
      // 取得の失敗はその回を飛ばすだけ。上限に達したかの判定は成否によらず必ず通す
      .catch(() => {})
      .finally(() => {
        inflight = false;
        if (
          !shouldContinueBalanceWatch({ balanceChanged: changed, settled: watch.settled, elapsedMs: Date.now() - watch.startedAt })
        ) {
          if (balanceWatch === watch) stopBalanceWatch();
        }
      });
  }, BALANCE_WATCH_INTERVAL_MS);
  balanceWatch = watch;
}

function stopBalanceWatch() {
  if (!balanceWatch) return;
  balanceWatch.settled = true;
  clearInterval(balanceWatch.timer);
  balanceWatch = null;
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
  stopBalanceWatch();
  balanceHistory.length = 0;
  lastBalanceKey = null;
  // 飛行中の取得の応答を捨てる。進めないと、前の利用者の残高が遅れて帯に描き戻る
  walletRenderedSeq = ++walletRequestSeq;
  for (const id of ['strip-balance', 'strip-remaining']) {
    el(id).textContent = STRIP_EMPTY;
    delete el(id).dataset.value;
    el(id).classList.remove('flash');
  }
  for (const id of ['wallet-balance', 'session-status', 'spend-limit']) el(id).textContent = '（未取得）';
  el('wallet-status').replaceChildren();
  showMessage(el('balance-history'), 'まだありません');
}

// 購入したページの表示を消す。MCP Apps の View は次の表示でまた載せ直す
function discardPreview() {
  previewHost?.destroy();
  previewHost = null;
  el('purchase-status').replaceChildren();
  const frame = el<HTMLIFrameElement>('preview-frame');
  frame.removeAttribute('srcdoc');
  frame.setAttribute('hidden', '');
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

// ── 購入物（決定50: 買えたページは会話の中に描き、履歴は会話をまたいで一覧する） ─────

// 会話の購入をカードにして会話の中に描く。
// autoShow: その場で買えた（ストリームで届いた）ものは自動で載せる。再開した会話の
// 買い置きは、開くかどうかを利用者に委ねる（売り手への接続を、見たいものだけに絞る）
async function refreshPurchases(autoShow: boolean) {
  const conversationId = chat.getConversationId();
  if (!conversationId) return;
  // 購入一覧は「支払ったのに成果物が無い」ことを利用者に伝える唯一の経路なので、
  // 取得に失敗したら黙って諦めず、必ず画面に出す
  let purchases: Purchase[];
  try {
    ({ purchases } = await buyer.listPurchases(conversationId));
  } catch (error) {
    appendEvent(`購入一覧を取得できませんでした: ${describeError(error)}`);
    showError(el('chat-status'), '購入一覧を取得できませんでした（支払いは記録されている可能性があります）');
    throw error;
  }
  el('chat-status').replaceChildren();
  let added = false;
  for (const purchase of purchases) added = addPurchaseCard(purchase, autoShow) || added;
  layoutChatLog(lastMessages.map((m) => m.id));
  // 履歴が変わるのは購入が増えたときだけ。買っていない応答で 20 会話ぶんを読み直さない
  if (added) markHistoryStale();
}

// 会話の中のカードを 1 件足す。既にあるものは作り直さない（iframe の読み込み直しを避ける）。
// 戻り値は「新しく足したか」（購入履歴を取り直すかの判断に使う）
function addPurchaseCard(purchase: Purchase, autoShow: boolean): boolean {
  if (purchaseCards.has(purchase.resultId)) return false;
  const node = document.createElement('div');
  node.className = 'purchase-card';
  const row = purchaseRow(purchase);
  node.appendChild(row);
  const status = document.createElement('div');
  status.className = 'purchase-card-status hint';
  node.appendChild(status);
  // 錨は今の末尾の吹き出し。以後に届く吹き出しはこのカードの後ろに並ぶ
  purchaseCards.set(purchase.resultId, {
    node,
    afterMessageId: lastMessages[lastMessages.length - 1]?.id ?? null,
    host: null,
  });
  if (!purchase.ok) return true;
  if (autoShow) {
    void showCardPreview(purchase.resultId, node, status);
    return true;
  }
  // 再開した会話の買い置きは自動で載せない。押されたときに載せる
  // （成果物は「購入履歴」からも開けるので、接続は見たいものにだけ開く）
  const button = document.createElement('button');
  button.textContent = '表示';
  button.addEventListener('click', async () => {
    button.disabled = true;
    // 失敗したときはボタンを残す（一時的な不調でやり直せなくならないように）
    if (await showCardPreview(purchase.resultId, node, status)) button.remove();
    else button.disabled = false;
  });
  row.insertBefore(button, row.firstChild);
  return true;
}

// 購入 1 件の見出し（resultId・支払いの状況・tx）。会話の中のカードと履歴の行で共用する
function purchaseRow(purchase: Purchase): HTMLElement {
  const row = document.createElement('div');
  row.className = 'purchase';

  const id = document.createElement('code');
  id.textContent = purchase.resultId;
  row.appendChild(id);

  const detail = document.createElement('span');
  detail.className = purchase.ok ? 'success' : 'error';
  detail.textContent = purchase.ok
    ? `${purchase.paymentMade ? '支払い済み' : '無課金'} ${purchase.htmlBytes ?? '?'} バイト`
    : `${purchaseFailurePrefix(purchase)}${purchase.error ?? '失敗'}`;
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

// 履歴の行。こちらは一覧が長くなり得るので、押されたものだけをプレビューに載せる
function renderHistoryPurchase(purchase: Purchase): HTMLElement {
  const row = purchaseRow(purchase);
  const button = document.createElement('button');
  button.textContent = purchase.ok ? '表示' : '失敗';
  button.disabled = !purchase.ok;
  button.addEventListener('click', () => void showPurchase(purchase.resultId));
  row.insertBefore(button, row.firstChild);
  return row;
}

// 会話の中のカードに、売り手の MCP Apps UI を載せて購入済み HTML を描く（決定29・50）。
// カードごとに View を 1 つ持つため、売り手への MCP 接続も載せた数だけ開く
async function showCardPreview(resultId: string, node: HTMLElement, status: HTMLElement): Promise<boolean> {
  const generation = conversationGeneration;
  showMessage(status, 'ページを読み込んでいます…');
  const frame = document.createElement('iframe');
  frame.className = 'purchase-preview';
  frame.title = `購入したページ（${resultId}）`;
  frame.setAttribute('sandbox', 'allow-scripts');
  node.insertBefore(frame, status);
  try {
    const artifact = await buyer.getPurchasedHtml(resultId);
    if (!artifact?.html) {
      frame.remove();
      showMessage(status, 'この購入には HTML がありません（支払い後の失敗）', 'error');
      // 内容が無いこと自体は変わらないので、やり直しの余地は無い（成功と同じ扱いにする）
      return true;
    }
    sellerInfo ??= await buyer.getSellerInfo();
    const host = await mountPreviewHost(frame, sellerInfo, { onDownload: downloadHtml });
    const card = purchaseCards.get(resultId);
    // 載せている間に会話が捨てられていたら、開いた接続を閉じて何も描かない
    if (generation !== conversationGeneration || !card) {
      host.destroy();
      frame.remove();
      return false;
    }
    card.host = host;
    await host.showHtml(artifact.html, artifact.filename);
    status.replaceChildren();
    return true;
  } catch (error) {
    frame.remove();
    if (generation !== conversationGeneration) return false;
    showError(status, `表示に失敗: ${describeError(error)}`);
    return false;
  }
}

// ── 購入履歴（決定50） ────────────────────────────────────────────────
// 会話をまたいだ一覧。会話の履歴を丸ごと読む API なので、購入のたびではなく
// タブを開いたときと「更新」のときだけ取る
let historyStale = true;

function historyVisible(): boolean {
  return !el('panel-history').hasAttribute('hidden');
}

// 購入が増えた・会話を捨てた。見えていれば取り直し、見えていなければ開いたときに取り直す
function markHistoryStale() {
  historyStale = true;
  if (historyVisible()) refreshHistory().catch(() => {});
}

async function refreshHistory() {
  const container = el('history');
  let conversations: PurchaseGroup[];
  try {
    ({ conversations } = await buyer.listPurchaseHistory());
  } catch (error) {
    showError(container, `購入履歴を取得できませんでした: ${describeError(error)}`);
    throw error;
  }
  historyStale = false;
  if (conversations.length === 0) {
    showMessage(container, 'まだありません');
    return;
  }
  container.replaceChildren(...conversations.map(renderHistoryGroup));
}

function renderHistoryGroup(group: PurchaseGroup): HTMLElement {
  const box = document.createElement('div');
  box.className = 'history-group';
  const heading = document.createElement('div');
  heading.className = 'history-group-heading';
  const current = group.conversationId === chat.getConversationId();
  heading.textContent = `${new Date(group.updatedAt).toLocaleString()} の会話${current ? '（いま開いている会話）' : ''}`;
  box.appendChild(heading);
  box.append(...group.purchases.map(renderHistoryPurchase));
  return box;
}

// 購入済み HTML を、売り手の MCP Apps UI（ホスト実装）に注入して描画する（決定29）。
// こちらは購入履歴タブの 1 枚きりのプレビュー
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
  el('preview-frame').removeAttribute('hidden');
  sellerInfo ??= await buyer.getSellerInfo();
  appendEvent(`ui:// を取得: ${sellerInfo.resourceUri}（${sellerInfo.mcpUrl}）`);
  previewHost = await mountPreviewHost(el<HTMLIFrameElement>('preview-frame'), sellerInfo, {
    onDownload: downloadHtml,
  });
  appendEvent('MCP Apps の View を初期化しました');
  return previewHost;
}

// View からの ui/download-file 要求。会話の中のカードでも履歴のプレビューでも同じ扱い
function downloadHtml(filename: string, html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── タブ（決定50。決定44 の「タブ部品は使わない」を上書き） ──────────────
function showTab(name: 'chat' | 'history') {
  for (const panel of ['chat', 'history'] as const) {
    const active = panel === name;
    el(`tab-${panel}`).setAttribute('aria-selected', String(active));
    el(`panel-${panel}`).toggleAttribute('hidden', !active);
  }
  if (name === 'history' && historyStale) refreshHistory().catch(() => {});
}

// 同じブラウザで別の利用者がサインインしても前の購入が見えないよう、履歴も捨てる
function discardHistory() {
  historyStale = true;
  showMessage(el('history'), 'まだありません');
  discardPreview();
  showTab('chat');
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
  // 失敗は refreshPurchases が画面に出す。再開した会話のページは自動では描かない
  await refreshPurchases(false).catch(() => {});
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
      discardHistory();
    }
  });

  el('spend-limit-btn').addEventListener('click', () => void submitSpendLimit());
  el<HTMLInputElement>('spend-limit-text').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) void submitSpendLimit();
  });
  el('wallet-refresh-btn').addEventListener('click', () => {
    refreshWallet().catch(() => {});
  });

  for (const panel of ['chat', 'history'] as const) {
    el(`tab-${panel}`).addEventListener('click', () => showTab(panel));
  }
  el('history-refresh-btn').addEventListener('click', () => {
    refreshHistory().catch(() => {});
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
      !window.confirm('今の会話は画面から消えます（買ったページは「購入履歴」に残ります）。新しい会話を始めますか？')
    ) {
      return;
    }
    // 会話を捨てて新しい ID を採番させる（次の送信時に createConversation が走る）
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    discardConversation();
    // 捨てた会話の購入は履歴でしか辿れなくなる。開いていれば取り直す
    markHistoryStale();
    appendEvent('新しい会話を始めます');
  });

  // 内部情報の折りたたみは既定で開き、閉じた状態だけをブラウザに覚えさせる
  const internals = el<HTMLDetailsElement>('internals');
  internals.open = readInternalsOpen(localStorage.getItem(INTERNALS_OPEN_KEY));
  internals.addEventListener('toggle', () => {
    localStorage.setItem(INTERNALS_OPEN_KEY, storeInternalsOpen(internals.open));
  });
});
