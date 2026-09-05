// 承認待ち（interrupt）への応答のガード。
//
// Agent BB の resume() は「承認待ちが実在するか」を検証しない。応答が 1 件以上あり
// conversationId と userId が揃っていれば、そのままジョブを投入してエージェントを走らせる。
// つまり承認待ちが 1 件も無くても resume を繰り返せば、依頼回数の上限（sendMessage 側で数える）
// を通らずにモデルを何度でも起動できてしまう。承認は sendMessage が作った承認待ちへの応答に
// 限る、という前提をここで担保する。
export function assertPendingInterrupts(
  pending: ReadonlyArray<{ id: string }>,
  responses: ReadonlyArray<{ interruptId: string }>,
): void {
  const pendingIds = new Set(pending.map((i) => i.id));
  // 1 件でも承認待ちに無い ID が混ざれば全体を弾く。部分的に通すと、正当な応答に
  // でたらめな ID を紛れ込ませてジョブを起こす余地が残るため
  if (responses.length === 0 || !responses.every((r) => pendingIds.has(r.interruptId))) {
    throw new Error('承認待ちの購入がありません');
  }
}
