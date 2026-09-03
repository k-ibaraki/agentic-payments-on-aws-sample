// 会話の所有ガード。Agent BB は conversationId / channelId の認可を呼び出し側に委ねる
// 仕様（README「Authorization (caller responsibility)」）なので、会話に触れる API は
// すべてこれを通す。所有していない会話は「存在しない」と同じ文言で弾き、
// 存在の有無を推測させない
export function assertOwnedConversation(
  owned: ReadonlyArray<{ conversationId: string }>,
  conversationId: string,
): void {
  if (!owned.some((c) => c.conversationId === conversationId)) {
    throw new Error('会話が見つかりません');
  }
}
