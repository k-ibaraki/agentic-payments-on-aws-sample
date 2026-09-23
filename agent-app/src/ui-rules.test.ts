// 画面の振る舞いのうち DOM に依存しない規則を固定する（決定44・47・48・49・50・62）。
// 新規会話の確認の要否、「内部情報」の折りたたみ状態、帯の表示と光らせる判定、失敗した購入の見出し、
// 会話の中の購入カードの並び、購入履歴の表示中の行とプレビューのホストの置き場
import { describe, expect, it } from 'vitest';
import { findLastAssistant, shouldConfirmNewConversation, readInternalsOpen, storeInternalsOpen } from './ui-rules.js';

describe('shouldConfirmNewConversation', () => {
  it('吹き出しが無ければ確認せずに捨ててよい', () => {
    expect(shouldConfirmNewConversation(0)).toBe(false);
  });

  it('吹き出しが 1 つでもあれば確認を挟む', () => {
    expect(shouldConfirmNewConversation(1)).toBe(true);
    expect(shouldConfirmNewConversation(7)).toBe(true);
  });
});

describe('内部情報の折りたたみ状態', () => {
  it('記憶が無ければ既定で開く', () => {
    expect(readInternalsOpen(null)).toBe(true);
  });

  it('閉じた記憶があるときだけ閉じる（壊れた値は既定に倒す）', () => {
    expect(readInternalsOpen('closed')).toBe(false);
    expect(readInternalsOpen('open')).toBe(true);
    expect(readInternalsOpen('garbage')).toBe(true);
  });

  it('保存する値は open / closed の 2 値', () => {
    expect(storeInternalsOpen(true)).toBe('open');
    expect(storeInternalsOpen(false)).toBe('closed');
  });
});

describe('findLastAssistant', () => {
  it('末尾が assistant ならその位置（通常の送信）', () => {
    expect(findLastAssistant([{ role: 'user' }, { role: 'assistant' }])).toBe(1);
  });

  it('承認への応答で末尾に approval が積まれても、手前の assistant を指す', () => {
    const messages = [{ role: 'user' }, { role: 'assistant' }, { role: 'approval' }];
    expect(findLastAssistant(messages)).toBe(1);
  });

  it('assistant が無ければ -1', () => {
    expect(findLastAssistant([{ role: 'user' }])).toBe(-1);
    expect(findLastAssistant([])).toBe(-1);
  });
});

// ── 依頼の枠の帯（残高と残枠）と、購入中の取り直し（決定47） ──
import {
  BALANCE_WATCH_INTERVAL_MS,
  BALANCE_WATCH_MAX_MS,
  STRIP_EMPTY,
  balanceKey,
  didBalanceChange,
  isPaidToolCall,
  stripBalance,
  stripRemaining,
  shouldContinueBalanceWatch,
  shouldFlashValue,
} from './ui-rules.js';

describe('帯の表示文字列', () => {
  const spendLimit = { maxSpendUsd: '1.00' };

  it('残高は値と通貨だけ。取れていなければ「—」', () => {
    expect(stripBalance({ display: '0.30', token: 'USDC' })).toEqual({ text: '0.30 USDC', value: '0.30' });
    expect(stripBalance(null)).toEqual({ text: STRIP_EMPTY, value: null });
  });

  it('セッションがあればその残枠', () => {
    expect(stripRemaining({ session: { availableSpendUsd: '1.90' }, sessionError: null, spendLimit })).toEqual({
      text: '1.90 USD',
      value: '1.90',
    });
  });

  it('セッションがまだ無ければ、次に切る上限を添え書き付きで出す（決定49）。光らせる判定には乗せない', () => {
    expect(stripRemaining({ session: null, sessionError: null, spendLimit })).toEqual({
      text: '1.00 USD（セッション開始前）',
      value: null,
    });
  });

  it('セッションを取得できなかった回は「—」（失敗を実値らしく見せない）', () => {
    expect(stripRemaining({ session: null, sessionError: 'セッションを取得できませんでした', spendLimit })).toEqual({
      text: STRIP_EMPTY,
      value: null,
    });
  });

  it('セッションはあるが残枠が返らない回も「—」', () => {
    expect(stripRemaining({ session: { availableSpendUsd: null }, sessionError: null, spendLimit })).toEqual({
      text: STRIP_EMPTY,
      value: null,
    });
  });
});

describe('光らせてよい変化か', () => {
  it('金額が変われば光らせる', () => {
    expect(shouldFlashValue('0.30', '0.20')).toBe(true);
  });

  it('同じ金額では光らせない（セッションが切られて添え書きが外れただけの回を含む）', () => {
    expect(shouldFlashValue('0.30', '0.30')).toBe(false);
    expect(shouldFlashValue('1.00', '1.00')).toBe(false);
  });

  it('取得できていない状態（null）との出入りでは光らせない（API の失敗を「減った」と見せない）', () => {
    expect(shouldFlashValue('0.30', null)).toBe(false);
    expect(shouldFlashValue(null, '0.30')).toBe(false);
    expect(shouldFlashValue(null, null)).toBe(false);
  });

  // 上限を変えると今のセッションは破棄され、残枠は実値から「次に切る上限」に変わる。
  // 支払いではないので光らせない（セッション開始前の残枠は value を持たない）
  it('セッションの破棄（上限の変更）では光らせない', () => {
    const spendLimit = { maxSpendUsd: '5.00' };
    const before = stripRemaining({ session: { availableSpendUsd: '0.90' }, sessionError: null, spendLimit });
    const after = stripRemaining({ session: null, sessionError: null, spendLimit });
    expect(shouldFlashValue(before.value, after.value)).toBe(false);
  });
});

describe('購入中の取り直し', () => {
  it('取り直しを始めるのは有料ツール（generateHtml）の tool-call だけ', () => {
    expect(isPaidToolCall('generateHtml')).toBe(true);
    expect(isPaidToolCall('listTools')).toBe(false);
    expect(isPaidToolCall(undefined)).toBe(false);
  });

  it('間隔は 3 秒、上限は有料ツールの待ち時間の既定（決定31）と同じ 600 秒', () => {
    expect(BALANCE_WATCH_INTERVAL_MS).toBe(3000);
    expect(BALANCE_WATCH_MAX_MS).toBe(600_000);
  });

  it('残高が動くか、ツールが返るか、上限に達したら止める', () => {
    expect(shouldContinueBalanceWatch({ balanceChanged: false, settled: false, elapsedMs: 0 })).toBe(true);
    expect(shouldContinueBalanceWatch({ balanceChanged: true, settled: false, elapsedMs: 0 })).toBe(false);
    expect(shouldContinueBalanceWatch({ balanceChanged: false, settled: true, elapsedMs: 0 })).toBe(false);
    expect(shouldContinueBalanceWatch({ balanceChanged: false, settled: false, elapsedMs: 600_000 })).toBe(false);
  });

  it('止める判定に使うのは残高だけ。残枠は署名の時点で先に減るので混ぜない', () => {
    expect(balanceKey({ balance: { display: '0.30' } })).toBe('0.30');
    expect(balanceKey({ balance: null })).toBe(null);
  });

  it('残高が取れていない回は「動いた」とみなさない（失敗で監視が終わらないように）', () => {
    expect(didBalanceChange('0.30', '0.20')).toBe(true);
    expect(didBalanceChange('0.30', '0.30')).toBe(false);
    expect(didBalanceChange('0.30', null)).toBe(false);
    expect(didBalanceChange(null, '0.20')).toBe(false);
    expect(didBalanceChange(null, null)).toBe(false);
  });
});

// ── 失敗した購入の見え方（決定48） ──
import { purchaseFailurePrefix } from './ui-rules.js';

describe('purchaseFailurePrefix', () => {
  it('支払い済みの失敗はそう見せる', () => {
    expect(purchaseFailurePrefix({ paymentMade: true })).toBe('支払い済み・');
  });

  // ProcessPayment の応答が確認できなかった購入。支払われた可能性が残るので
  // 「失敗」とだけ見せると、利用者は減った残高の理由に辿り着けない
  it('成否不明の失敗は「支払いの成否不明」と見せる', () => {
    expect(purchaseFailurePrefix({ paymentMade: false, paymentUncertain: true })).toBe(
      '支払いの成否不明・',
    );
  });

  it('支払いに至っていない失敗には何も添えない', () => {
    expect(purchaseFailurePrefix({ paymentMade: false })).toBe('');
    expect(purchaseFailurePrefix({ paymentMade: false, paymentUncertain: false })).toBe('');
  });
});

// ── チャットの中に購入したページを差し込む並び（決定50） ──
import { orderChatNodes, retargetAnchor } from './ui-rules.js';

describe('orderChatNodes', () => {
  it('購入カードは、届いた時点の末尾の吹き出しの直後に入る', () => {
    expect(
      orderChatNodes(['m1', 'm2', 'm3'], [{ resultId: 'r-1', afterMessageId: 'm2' }]),
    ).toEqual([
      { kind: 'message', id: 'm1' },
      { kind: 'message', id: 'm2' },
      { kind: 'purchase', id: 'r-1' },
      { kind: 'message', id: 'm3' },
    ]);
  });

  it('同じ位置の購入カードは届いた順に並ぶ', () => {
    expect(
      orderChatNodes(['m1'], [
        { resultId: 'r-1', afterMessageId: 'm1' },
        { resultId: 'r-2', afterMessageId: 'm1' },
      ]),
    ).toEqual([
      { kind: 'message', id: 'm1' },
      { kind: 'purchase', id: 'r-1' },
      { kind: 'purchase', id: 'r-2' },
    ]);
  });

  it('錨の吹き出しが無い（消えた・まだ無い）カードは末尾に置く', () => {
    expect(
      orderChatNodes(['m1'], [
        { resultId: 'r-1', afterMessageId: null },
        { resultId: 'r-2', afterMessageId: '消えた吹き出し' },
      ]),
    ).toEqual([
      { kind: 'message', id: 'm1' },
      { kind: 'purchase', id: 'r-1' },
      { kind: 'purchase', id: 'r-2' },
    ]);
  });

  it('吹き出しだけ・カードだけでも並ぶ', () => {
    expect(orderChatNodes(['m1'], [])).toEqual([{ kind: 'message', id: 'm1' }]);
    expect(orderChatNodes([], [{ resultId: 'r-1', afterMessageId: 'm1' }])).toEqual([
      { kind: 'purchase', id: 'r-1' },
    ]);
  });
});

describe('retargetAnchor', () => {
  it('錨の吹き出しが消えたら、直前の生き残りへ付け替える', () => {
    expect(retargetAnchor(['m1', 'm2', 'm3'], 'm2', new Set(['m1', 'm3']))).toBe('m1');
  });

  it('直前も消えていれば、さらに前の生き残りを探す', () => {
    expect(retargetAnchor(['m1', 'm2', 'm3'], 'm3', new Set(['m1']))).toBe('m1');
  });

  it('前に生き残りが無ければ null（カードは先頭側に置けないので末尾へ回る）', () => {
    expect(retargetAnchor(['m1', 'm2'], 'm1', new Set(['m2']))).toBe(null);
    expect(retargetAnchor(['m1'], '知らない吹き出し', new Set(['m1']))).toBe(null);
  });
});

// ── 購入 1 件の説明文（決定60。支払額の併記） ──
import { purchaseDetail } from './ui-rules.js';

describe('purchaseDetail', () => {
  it('成功した購入は、支払額と大きさを見せる', () => {
    expect(
      purchaseDetail({ ok: true, paymentMade: true, amountDisplay: '$0.15（150000）', htmlBytes: 3000 }),
    ).toBe('支払い済み $0.15（150000） 3000 バイト');
  });

  it('額が分からない購入は、これまでどおり支払いの状況と大きさだけ', () => {
    expect(purchaseDetail({ ok: true, paymentMade: true, htmlBytes: 3000 })).toBe('支払い済み 3000 バイト');
    expect(purchaseDetail({ ok: true, paymentMade: false })).toBe('無課金 ? バイト');
  });

  it('支払い済みの失敗は、額を添えて理由を見せる', () => {
    expect(
      purchaseDetail({ ok: false, paymentMade: true, amountDisplay: '$0.2（200000）', error: '生成に失敗' }),
    ).toBe('支払い済み $0.2（200000）・生成に失敗');
  });

  it('成否不明の失敗は、減っているかもしれない額を添える', () => {
    expect(
      purchaseDetail({
        ok: false,
        paymentMade: false,
        paymentUncertain: true,
        amountDisplay: '$0.15（150000）',
        error: '確認できませんでした',
      }),
    ).toBe('支払いの成否不明 $0.15（150000）・確認できませんでした');
  });

  it('支払いに至っていない失敗には額も接頭辞も付かない', () => {
    expect(purchaseDetail({ ok: false, paymentMade: false, error: '売り手に接続できません' })).toBe(
      '売り手に接続できません',
    );
  });
});

// ── 購入履歴の表示中の行（決定62） ──
import { isSelectedPurchase } from './ui-rules.js';

describe('isSelectedPurchase', () => {
  it('表示中の resultId と同じ成功した行だけを強調する', () => {
    expect(isSelectedPurchase({ ok: true, resultId: 'r1' }, 'r1')).toBe(true);
    expect(isSelectedPurchase({ ok: true, resultId: 'r2' }, 'r1')).toBe(false);
  });

  it('まだ何も表示していなければ、どの行も強調しない', () => {
    expect(isSelectedPurchase({ ok: true, resultId: 'r1' }, null)).toBe(false);
  });

  it('失敗の行は表示できないので、同じ resultId でも強調しない', () => {
    expect(isSelectedPurchase({ ok: false, resultId: 'r1' }, 'r1')).toBe(false);
  });
});

// ── 購入履歴のプレビューのホスト（決定62） ──
import { createHostSlot } from './ui-rules.js';

describe('createHostSlot', () => {
  // 作るたびに番号を振り、閉じたかを覚える偽のホスト。resolve は外から呼んで作り終えさせる
  function fakeFactory() {
    const made: Array<{ id: number; destroyed: boolean; destroy(): void }> = [];
    const waiting: Array<() => void> = [];
    const create = () =>
      new Promise<(typeof made)[number]>((resolve) => {
        const host = {
          id: made.length + 1,
          destroyed: false,
          destroy() {
            host.destroyed = true;
          },
        };
        made.push(host);
        waiting.push(() => resolve(host));
      });
    return { made, create, finishAll: () => waiting.splice(0).forEach((finish) => finish()) };
  }

  it('作っている途中に続けて求めても、作るのは 1 回で同じものを渡す', async () => {
    const factory = fakeFactory();
    const slot = createHostSlot(factory.create);
    const first = slot.get();
    const second = slot.get();
    await Promise.resolve();
    factory.finishAll();
    expect(await first).toBe(await second);
    expect(factory.made).toHaveLength(1);
  });

  it('出来上がった後は作り直さない', async () => {
    const factory = fakeFactory();
    const slot = createHostSlot(factory.create);
    const first = slot.get();
    await Promise.resolve();
    factory.finishAll();
    const host = await first;
    expect(await slot.get()).toBe(host);
    expect(factory.made).toHaveLength(1);
  });

  it('作っている途中に捨てたら、出来上がったものを閉じて null を渡し、次は作り直す', async () => {
    const factory = fakeFactory();
    const slot = createHostSlot(factory.create);
    const stale = slot.get();
    await Promise.resolve();
    slot.discard();
    factory.finishAll();
    expect(await stale).toBeNull();
    expect(factory.made[0]?.destroyed).toBe(true);

    const next = slot.get();
    await Promise.resolve();
    factory.finishAll();
    expect((await next)?.id).toBe(2);
  });

  it('捨てると今のものを閉じる', async () => {
    const factory = fakeFactory();
    const slot = createHostSlot(factory.create);
    const first = slot.get();
    await Promise.resolve();
    factory.finishAll();
    const host = await first;
    slot.discard();
    expect(host?.destroyed).toBe(true);
  });

  it('作るのに失敗したら、次に求めたときに作り直す', async () => {
    let calls = 0;
    const slot = createHostSlot(async () => {
      calls += 1;
      if (calls === 1) throw new Error('接続できない');
      return { destroy() {} };
    });
    await expect(slot.get()).rejects.toThrow('接続できない');
    await expect(slot.get()).resolves.not.toBeNull();
    expect(calls).toBe(2);
  });
});
