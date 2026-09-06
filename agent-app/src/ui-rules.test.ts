// 画面の振る舞いのうち DOM に依存しない規則を固定する（決定44）。
// 新規会話の確認の要否と、「内部情報」の折りたたみ状態の読み書き
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
  formatStripBalance,
  formatStripRemaining,
  isPaidToolCall,
  shouldContinueBalanceWatch,
  shouldFlashValue,
} from './ui-rules.js';

describe('帯の表示文字列', () => {
  it('残高は値と通貨だけ。取れていなければ「—」', () => {
    expect(formatStripBalance({ display: '0.30', token: 'USDC' })).toBe('0.30 USDC');
    expect(formatStripBalance(null)).toBe(STRIP_EMPTY);
  });

  it('残枠は今のセッションの残枠。セッションが無い・値が無ければ「—」', () => {
    expect(formatStripRemaining({ availableSpendUsd: '1.90' })).toBe('1.90 USD');
    expect(formatStripRemaining({ availableSpendUsd: null })).toBe(STRIP_EMPTY);
    expect(formatStripRemaining(null)).toBe(STRIP_EMPTY);
  });
});

describe('光らせてよい変化か', () => {
  it('値どうしが変われば光らせる', () => {
    expect(shouldFlashValue('0.30 USDC', '0.20 USDC')).toBe(true);
  });

  it('同じ値では光らせない', () => {
    expect(shouldFlashValue('0.30 USDC', '0.30 USDC')).toBe(false);
  });

  it('取得できていない状態（—）との出入りでは光らせない（API の失敗を「減った」と見せない）', () => {
    expect(shouldFlashValue('0.30 USDC', STRIP_EMPTY)).toBe(false);
    expect(shouldFlashValue(STRIP_EMPTY, '0.30 USDC')).toBe(false);
    expect(shouldFlashValue('', '0.30 USDC')).toBe(true);
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
