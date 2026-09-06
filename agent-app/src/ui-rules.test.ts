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
