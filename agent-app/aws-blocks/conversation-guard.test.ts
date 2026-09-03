// 会話の所有ガードのテスト（PR #2 レビュー指摘6 の対処）。
// Agent BB は conversationId の認可を呼び出し側に委ねるため、
// 「所有していない会話は存在しないものとして扱う」規則をここで固定する
import { describe, expect, it } from 'vitest';
import { assertOwnedConversation } from './conversation-guard.js';

const OWNED = [{ conversationId: 'conv-a' }, { conversationId: 'conv-b' }];

describe('assertOwnedConversation', () => {
  it('所有している会話なら通す', () => {
    expect(() => assertOwnedConversation(OWNED, 'conv-a')).not.toThrow();
  });

  it('所有していない会話は「見つかりません」で弾く（存在の有無を漏らさない）', () => {
    expect(() => assertOwnedConversation(OWNED, 'conv-zzz')).toThrow('会話が見つかりません');
  });

  it('所有会話が空でも同じ文言で弾く', () => {
    expect(() => assertOwnedConversation([], 'conv-a')).toThrow('会話が見つかりません');
  });

  it('空文字や前後の空白付きの ID は一致させない', () => {
    expect(() => assertOwnedConversation(OWNED, '')).toThrow('会話が見つかりません');
    expect(() => assertOwnedConversation(OWNED, ' conv-a')).toThrow('会話が見つかりません');
  });
});
