// 依頼 1 回の経過（決定65）の規則のテスト。言葉づかいと、開閉・待ち時間・要約を固定する
import { describe, expect, it } from 'vitest';
import {
  applyChunk,
  applyProgress,
  describeStep,
  startTimeline,
  timelineSummary,
  waitingLabel,
} from './timeline.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function progress(seq: number, event: Parameters<typeof describeStep>[0], purchaseId = 'p-1') {
  return { purchaseId, seq, at: 0, event };
}

describe('describeStep（購入の経過を平易な文にする）', () => {
  it('見積もりは価格帯と額を言い、用語を添える', () => {
    expect(describeStep({ step: 'quote', tier: 'take', amount: '100000', asset: USDC })).toEqual({
      actor: 'seller',
      text: '売り手が「竹」の価格として 0.1 USDC を提示しました',
      term: 'x402 の支払い要求（402）',
    });
  });

  it('価格帯が分からなければ額だけ言う', () => {
    expect(describeStep({ step: 'quote', amount: '150000', asset: USDC }).text).toBe(
      '売り手が 0.15 USDC を提示しました',
    );
  });

  it('知らない資産は桁を推量しない', () => {
    expect(describeStep({ step: 'paid', amount: '42', asset: '0xunknown' }).text).toBe(
      '42（最小単位）の支払いに署名しました。支払いの証明を付けて売り手に依頼し直します',
    );
  });

  it('署名した額を言う', () => {
    expect(describeStep({ step: 'paid', amount: '100000', asset: USDC })).toEqual({
      actor: 'wallet',
      text: '0.1 USDC の支払いに署名しました。支払いの証明を付けて売り手に依頼し直します',
      term: 'EIP-3009 の署名',
    });
  });

  it('売り手の経過は売り手の言葉のまま出す', () => {
    expect(describeStep({ step: 'seller', message: '決済が確定しました。ページの生成を始めます' })).toEqual({
      actor: 'seller',
      text: '決済が確定しました。ページの生成を始めます',
      term: 'MCP の経過通知',
    });
  });

  it('決済の確定は取引をエクスプローラーで開けるようにする', () => {
    expect(describeStep({ step: 'settled', transaction: '0xabc' })).toEqual({
      actor: 'chain',
      text: '決済がブロックチェーン上で確定しました',
      term: 'Base Sepolia',
      link: { href: 'https://sepolia.basescan.org/tx/0xabc', label: '取引を見る' },
    });
  });

  it('失敗は目立たせる', () => {
    expect(describeStep({ step: 'failed', message: '支払い後の再呼び出しに失敗しました' })).toMatchObject({
      tone: 'error',
      text: '購入に失敗しました: 支払い後の再呼び出しに失敗しました',
    });
  });

  it('受け取りは大きさを添える', () => {
    expect(describeStep({ step: 'received', htmlBytes: 12_800 }).text).toBe('ページ（12.5 KB）を受け取り、保存しました');
  });
});

describe('依頼 1 回の経過', () => {
  it('送った時点で 1 行目が立ち、開いている', () => {
    const t = startTimeline(1000);
    expect(t.rows.map((r) => r.text)).toEqual(['エージェントに依頼を送りました']);
    expect(t.endedAt).toBeNull();
  });

  it('エージェントの動きをチャンクから組み立てる', () => {
    const t = startTimeline(0);
    applyChunk(t, { type: 'tool-call', toolName: 'generateHtml' }, 1);
    applyChunk(t, { type: 'text-delta', text: 'で' }, 2);
    applyChunk(t, { type: 'text-delta', text: 'きました' }, 3);
    applyChunk(t, { type: 'done' }, 4);
    expect(t.rows.map((r) => r.text)).toEqual([
      'エージェントに依頼を送りました',
      '有料ツール（ページの生成）を使うと決めました',
      '返事を書いています',
    ]);
    expect(t.endedAt).toBe(4);
  });

  it('有料でないツールは名前で言う', () => {
    const t = startTimeline(0);
    applyChunk(t, { type: 'tool-call', toolName: 'lookup' }, 1);
    expect(t.rows[1].text).toBe('ツール「lookup」を使います');
  });

  it('人の承認待ちを言う', () => {
    const t = startTimeline(0);
    applyChunk(t, { type: 'interrupt' }, 1);
    expect(t.rows[1].text).toBe('支払いを続けるかどうか、あなたの確認を待っています');
  });

  it('エラーで終わる', () => {
    const t = startTimeline(0);
    applyChunk(t, { type: 'error', error: 'boom' }, 5);
    expect(t.rows[1]).toMatchObject({ tone: 'error', text: 'エラーで止まりました: boom' });
    expect(t.endedAt).toBe(5);
  });

  // Realtime の配信は二重に届くことも、順が入れ替わることもある
  it('購入の経過は通し番号で並べ、二重に届いたものは捨てる', () => {
    const t = startTimeline(0);
    applyProgress(t, progress(2, { step: 'paying' }), 2);
    applyProgress(t, progress(1, { step: 'quote', amount: '100000', asset: USDC }), 2);
    applyProgress(t, progress(2, { step: 'paying' }), 3);
    expect(t.rows.slice(1).map((r) => r.text)).toEqual([
      '売り手が 0.1 USDC を提示しました',
      '上限の内か確かめ、ウォレットで支払いの署名をしています',
    ]);
  });

  // 一度の依頼で二回買うと、通し番号は購入ごとに 1 から振り直される
  it('購入が二つあっても、どちらの経過も捨てずに購入ごとに並べる', () => {
    const t = startTimeline(0);
    applyProgress(t, progress(1, { step: 'paying' }, 'p-1'), 1);
    applyProgress(t, progress(2, { step: 'paid' }, 'p-1'), 2);
    applyProgress(t, progress(2, { step: 'paid' }, 'p-2'), 3);
    applyProgress(t, progress(1, { step: 'paying' }, 'p-2'), 3);
    applyProgress(t, progress(1, { step: 'paying' }, 'p-2'), 4);
    expect(t.rows.slice(1).map((r) => r.actor)).toEqual(['agent', 'wallet', 'agent', 'wallet']);
  });

  it('支払いの証明を送ってから結果が返るまで、待ち時間を数える', () => {
    const t = startTimeline(0);
    expect(waitingLabel(t, 0)).toBeNull();
    applyProgress(t, progress(1, { step: 'paid', amount: '100000', asset: USDC }), 10_000);
    expect(waitingLabel(t, 33_400)).toBe('売り手の応答を待っています… 23 秒');
    // 売り手の経過（「ページの生成を始めます」など）が届いたら、そこから数え直す
    applyProgress(t, progress(2, { step: 'seller', message: '決済が確定しました。ページの生成を始めます' }), 34_000);
    expect(waitingLabel(t, 39_000)).toBe('売り手の応答を待っています… 5 秒');
    applyProgress(t, progress(3, { step: 'settled', transaction: '0x1' }), 40_000);
    expect(waitingLabel(t, 41_000)).toBeNull();
  });

  it('失敗や終わりでも待ち時間を止める', () => {
    const t = startTimeline(0);
    applyProgress(t, progress(1, { step: 'paid' }), 1000);
    applyChunk(t, { type: 'done' }, 2000);
    expect(waitingLabel(t, 5000)).toBeNull();
  });

  it('要約は進行中なら件数と経過秒、終われば所要と支払額', () => {
    const t = startTimeline(0);
    applyProgress(t, progress(1, { step: 'paid', amount: '100000', asset: USDC }), 1000);
    expect(timelineSummary(t, 12_300)).toBe('途中経過（進行中・12 秒）');
    applyProgress(t, progress(2, { step: 'settled' }), 40_000);
    applyChunk(t, { type: 'done' }, 48_000);
    expect(timelineSummary(t, 99_000)).toBe('途中経過（3 件・所要 48 秒・支払い 0.1 USDC）');
  });

  it('支払いの無い依頼の要約は支払いに触れない', () => {
    const t = startTimeline(0);
    applyChunk(t, { type: 'done' }, 3000);
    expect(timelineSummary(t, 3000)).toBe('途中経過（1 件・所要 3 秒）');
  });

  it('失敗した依頼の要約はそう言う', () => {
    const t = startTimeline(0);
    applyProgress(t, progress(1, { step: 'failed', message: 'x' }), 1000);
    applyChunk(t, { type: 'done' }, 2000);
    expect(timelineSummary(t, 2000)).toBe('途中経過（2 件・所要 2 秒・失敗あり）');
  });
});
