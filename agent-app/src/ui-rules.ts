// 画面の振る舞いのうち DOM に依存しない規則（決定44）。index.ts から呼び、テストはここで固定する

/** 新規会話は会話をブラウザから捨てる操作。吹き出しが 1 つでもあれば確認を挟む */
export function shouldConfirmNewConversation(messageCount: number): boolean {
  return messageCount > 0;
}

/** 「内部情報」の折りたたみは既定で開く。閉じた記憶があるときだけ閉じる（壊れた値は既定に倒す） */
export function readInternalsOpen(stored: string | null): boolean {
  return stored !== 'closed';
}

export function storeInternalsOpen(open: boolean): 'open' | 'closed' {
  return open ? 'open' : 'closed';
}
