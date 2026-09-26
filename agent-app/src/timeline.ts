// 依頼 1 回の途中経過（決定65）。チャット欄の依頼の直後に置く折りたたみの中身を、DOM に依存せずに組み立てる。
// 材料は 2 つ: Agent のチャンク（エージェントの動き）と、経過専用の Realtime が運ぶ購入の経過
// （aws-blocks/progress.ts）。開発者向けの「内部情報」とは別に、専門知識の無い人が読める文にする。
// 本文は平易に書き、行末に小さく用語を添える
import type { AgentStreamChunk } from '@aws-blocks/bb-agent/client';
import { assetInfo, formatTokenAmount } from '../aws-blocks/payments/amount.js';
import type { ProgressEvent, PurchaseStep } from '../aws-blocks/progress.js';
import { PURCHASE_TOOL_NAME } from '../aws-blocks/purchases.js';

/** 行の主語。画面では小さな札で出す */
export type TimelineActor = 'agent' | 'wallet' | 'seller' | 'chain';

export interface TimelineRow {
  actor: TimelineActor;
  text: string;
  /** 行末に小さく添える用語 */
  term?: string;
  link?: { href: string; label: string };
  tone?: 'error';
}

export interface Timeline {
  rows: TimelineRow[];
  startedAt: number;
  /** 依頼への応答が終わった時刻（done / error）。終わるまで null */
  endedAt: number | null;
  /** 支払いの証明を送ってから結果が返るまでの、待ち始めの時刻。待っていなければ null */
  waitingSince: number | null;
  /** 署名した額の表記（要約に出す） */
  paid: string | null;
  failed: boolean;
  /** 画面への受信が途中で切れて打ち切ったか（決定69）。成否は分からないので failed とは分ける */
  cut: boolean;
  /** 「返事を書いています」を出したか（text-delta ごとに行を足さない） */
  writing: boolean;
  /** 届いた購入の経過（購入 ID と通し番号。二重配信を捨てる） */
  seen: Set<string>;
  /** 購入の経過の行を、購入ごとに通し番号の順に並べるための控え（rows の添字） */
  progressRows: Array<{ purchaseId: string; seq: number; index: number }>;
}

const TIER_LABELS = { ume: '梅', take: '竹', matsu: '松' } as const;

const ACTOR_LABELS: Record<TimelineActor, string> = {
  agent: 'エージェント',
  wallet: 'ウォレット',
  seller: '売り手',
  chain: 'ブロックチェーン',
};

/** 札の文字（画面で使う） */
export function actorLabel(actor: TimelineActor): string {
  return ACTOR_LABELS[actor];
}

/** 最小単位の額を「0.1 USDC」の形にする。桁数を知らない資産は推量しない */
export function plainAmount(amount: string | undefined, asset: string | undefined): string | null {
  if (amount === undefined) return null;
  const info = assetInfo(asset);
  if (!info || !/^\d+$/.test(amount)) return `${amount}（最小単位）`;
  return `${formatTokenAmount(amount, info.decimals)} ${info.symbol}`;
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
}

/** 購入の経過 1 つを、画面の 1 行にする */
export function describeStep(step: PurchaseStep): TimelineRow {
  switch (step.step) {
    case 'quote': {
      const amount = plainAmount(step.amount, step.asset) ?? '価格';
      const text = step.tier
        ? `売り手が「${TIER_LABELS[step.tier]}」の価格として ${amount} を提示しました`
        : `売り手が ${amount} を提示しました`;
      return { actor: 'seller', text, term: 'x402 の支払い要求（402）' };
    }
    case 'paying':
      return { actor: 'agent', text: '上限の内か確かめ、ウォレットで支払いの署名をしています', term: 'AgentCore Payments' };
    case 'paid': {
      const amount = plainAmount(step.amount, step.asset);
      return {
        actor: 'wallet',
        // 「42（最小単位）の」は詰め、「0.1 USDC の」は空ける
        text: `${amount ? `${amount}${amount.endsWith('）') ? '' : ' '}の支払いに署名しました` : '支払いに署名しました'}。支払いの証明を付けて売り手に依頼し直します`,
        term: 'EIP-3009 の署名',
      };
    }
    case 'seller':
      return { actor: 'seller', text: step.message, term: 'MCP の経過通知' };
    case 'settled':
      return {
        actor: 'chain',
        text: '決済がブロックチェーン上で確定しました',
        term: 'Base Sepolia',
        ...(step.transaction
          ? { link: { href: `https://sepolia.basescan.org/tx/${step.transaction}`, label: '取引を見る' } }
          : {}),
      };
    case 'received':
      return { actor: 'agent', text: `ページ（${kilobytes(step.htmlBytes)}）を受け取り、保存しました` };
    case 'failed':
      return { actor: 'agent', text: `購入に失敗しました: ${step.message}`, tone: 'error' };
  }
}

/** 依頼を送った時点の経過 */
export function startTimeline(now: number): Timeline {
  return {
    rows: [{ actor: 'agent', text: 'エージェントに依頼を送りました', term: 'AWS Blocks の Agent' }],
    startedAt: now,
    endedAt: null,
    waitingSince: null,
    paid: null,
    failed: false,
    cut: false,
    writing: false,
    seen: new Set(),
    progressRows: [],
  };
}

function stopWaiting(timeline: Timeline) {
  timeline.waitingSince = null;
}

/** Agent のチャンクを経過に足す */
export function applyChunk(
  timeline: Timeline,
  chunk: Pick<AgentStreamChunk, 'type'> & Partial<AgentStreamChunk>,
  now: number,
) {
  switch (chunk.type) {
    case 'tool-call':
      timeline.rows.push(
        chunk.toolName === PURCHASE_TOOL_NAME
          ? { actor: 'agent', text: '有料ツール（ページの生成）を使うと決めました', term: 'MCP の tools/call' }
          : { actor: 'agent', text: `ツール「${chunk.toolName ?? '?'}」を使います`, term: 'MCP の tools/call' },
      );
      // 次の返事は、ツールの結果を読んでから書き直す
      timeline.writing = false;
      return;
    case 'text-delta':
      if (timeline.writing) return;
      timeline.writing = true;
      timeline.rows.push({ actor: 'agent', text: '返事を書いています', term: 'Amazon Bedrock' });
      return;
    case 'interrupt':
      stopWaiting(timeline);
      timeline.rows.push({ actor: 'agent', text: '支払いを続けるかどうか、あなたの確認を待っています' });
      return;
    case 'error':
      timeline.rows.push({ actor: 'agent', text: `エラーで止まりました: ${chunk.error ?? '理由不明'}`, tone: 'error' });
      timeline.failed = true;
      stopWaiting(timeline);
      timeline.endedAt = now;
      return;
    case 'done':
      stopWaiting(timeline);
      timeline.endedAt = now;
      return;
    default:
      return;
  }
}

/**
 * 画面への受信が途中で切れた（決定69）。以後のチャンクと経過は届かないので、そう書いて打ち切る。
 * エージェントは動き続けている見込みが高く、成否は分からないため失敗の印は付けない
 */
export function applyDisconnect(timeline: Timeline, now: number) {
  timeline.rows.push({
    actor: 'agent',
    text: '画面への受信が途中で切れたため、ここから先の経過は出せません。応答は会話を読み直して表示します',
    term: 'Realtime（WebSocket）',
  });
  timeline.cut = true;
  stopWaiting(timeline);
  timeline.endedAt = now;
}

/**
 * 購入の経過を足す。購入ごとに通し番号で並べ、二重に届いたものは捨てる。
 * 並べ替えは同じ購入の行どうしの中だけで行う（エージェントの行や別の購入との前後は届いた順）
 */
export function applyProgress(timeline: Timeline, progress: ProgressEvent, now: number) {
  const key = `${progress.purchaseId}:${progress.seq}`;
  if (timeline.seen.has(key)) return;
  timeline.seen.add(key);

  const row = describeStep(progress.event);
  // 同じ購入で自分より大きい通し番号の行が既にあれば、その最初の行の位置に差し込む
  const later = timeline.progressRows
    .filter((r) => r.purchaseId === progress.purchaseId && r.seq > progress.seq)
    .sort((a, b) => a.index - b.index)[0];
  const index = later ? later.index : timeline.rows.length;
  timeline.rows.splice(index, 0, row);
  for (const r of timeline.progressRows) if (r.index >= index) r.index += 1;
  timeline.progressRows.push({ purchaseId: progress.purchaseId, seq: progress.seq, index });

  const step = progress.event;
  if (step.step === 'paid') {
    timeline.paid = plainAmount(step.amount, step.asset);
    // 以後は売り手が決済を確定し、ページを生成して返すのを待つ
    timeline.waitingSince = now;
  }
  // 待っている間に売り手の経過（「ページの生成を始めます」など）が届いたら、そこから数え直す。
  // 画面が数えるのは売り手が最後に何か言ってからの時間で、生成が始まってからはその待ち時間になる
  if (step.step === 'seller' && timeline.waitingSince !== null) timeline.waitingSince = now;
  if (step.step === 'settled' || step.step === 'received' || step.step === 'failed') stopWaiting(timeline);
  if (step.step === 'failed') timeline.failed = true;
}

/** 待ち時間の表示。支払いの署名から、または売り手が最後に経過を知らせてから数える。待っていなければ null */
export function waitingLabel(timeline: Timeline, now: number): string | null {
  if (timeline.waitingSince === null) return null;
  return `売り手の応答を待っています… ${Math.floor((now - timeline.waitingSince) / 1000)} 秒`;
}

/** 折りたたみの見出し。進行中は経過秒、終われば件数・所要・支払額 */
export function timelineSummary(timeline: Timeline, now: number): string {
  if (timeline.endedAt === null) {
    return `途中経過（進行中・${Math.floor((now - timeline.startedAt) / 1000)} 秒）`;
  }
  const parts = [
    `${timeline.rows.length} 件`,
    // 切れた時点までの秒数は所要ではないので出さない
    timeline.cut ? '受信が途中で切れました' : `所要 ${Math.round((timeline.endedAt - timeline.startedAt) / 1000)} 秒`,
  ];
  if (timeline.paid) parts.push(`支払い ${timeline.paid}`);
  if (timeline.failed) parts.push('失敗あり');
  return `途中経過（${parts.join('・')}）`;
}
