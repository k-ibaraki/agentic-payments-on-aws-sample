// 購入の経過（決定65）。有料ツールの中で起きたことを、会話ごとの Realtime チャンネルで画面へ届ける。
// Agent ブロックのチャンネルは流せる種類が固定（agentStreamChunkSchema）なので、経過専用の Realtime を
// 別に持つ。WebSocket API と接続表はスタックに 1 つで、Agent のものを共有する。
// ここで送るのは「何が起きたか」だけで、画面の言葉づかいは src/ui-rules.ts が決める
import { z } from 'zod';

/** 売り手から届いた文の長さの上限。相手方の言葉なので、画面を押し流す長さは切る */
export const SELLER_MESSAGE_LIMIT = 200;

const tierSchema = z.enum(['ume', 'take', 'matsu']);

export const purchaseStepSchema = z.discriminatedUnion('step', [
  // 売り手の支払い要求（402）を受け取った。価格帯は見積書（accepts[].extra.quote）から読めたときだけ
  z.object({
    step: z.literal('quote'),
    tier: tierSchema.optional(),
    amount: z.string().optional(),
    asset: z.string().optional(),
  }),
  // 支払いの条件を確かめ、ウォレット（AgentCore Payments）に署名を頼んでいる
  z.object({ step: z.literal('paying') }),
  // 署名が返った。これから支払いの証明を付けて売り手を呼び直す
  z.object({ step: z.literal('paid'), amount: z.string().optional(), asset: z.string().optional() }),
  // 売り手の経過（MCP の notifications/progress の message）
  z.object({ step: z.literal('seller'), message: z.string() }),
  // 売り手が決済を確定し、結果とともにレシート（取引 ID）が返った
  z.object({ step: z.literal('settled'), transaction: z.string().optional() }),
  // 成果物を受け取り、保存した
  z.object({ step: z.literal('received'), htmlBytes: z.number() }),
  // 購入が失敗した（支払い済みかどうかは購入の記録と購入カードが伝える）
  z.object({ step: z.literal('failed'), message: z.string() }),
]);

export type PurchaseStep = z.infer<typeof purchaseStepSchema>;

export const progressEventSchema = z.object({
  /** 購入 1 件の ID（resultId）。一度の依頼で二回買っても、経過を購入ごとに分けられるように */
  purchaseId: z.string(),
  /** 1 回の購入の中の通し番号。届く順が入れ替わっても並べ直せるように */
  seq: z.number(),
  /** 起きた時刻（ミリ秒） */
  at: z.number(),
  event: purchaseStepSchema,
});

export type ProgressEvent = z.infer<typeof progressEventSchema>;

/** 売り手の文を経過にする。空や文字列でないものは捨てる */
export function sellerStep(message: unknown): PurchaseStep | undefined {
  if (typeof message !== 'string') return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  return { step: 'seller', message: trimmed.slice(0, SELLER_MESSAGE_LIMIT) };
}

export interface ProgressPublisher {
  /** 経過を 1 つ送る。待たない（購入の処理を経過の送信で遅らせない） */
  report(step: PurchaseStep): void;
  /** それまでに送った経過が出揃うのを待つ。失敗は飲み込む */
  flush(): Promise<void>;
}

/**
 * 経過の送り口を作る。送信は 1 つずつ順に行う（並べて投げると届く順が入れ替わり得る）。
 * 経過は飾りなので、送れなくても投げない
 */
export function createProgressPublisher(
  purchaseId: string,
  publish: (event: ProgressEvent) => Promise<void>,
  now: () => number = Date.now,
): ProgressPublisher {
  let seq = 0;
  let queue: Promise<void> = Promise.resolve();
  return {
    report(step) {
      const event: ProgressEvent = { purchaseId, seq: ++seq, at: now(), event: step };
      queue = queue.then(async () => {
        try {
          await publish(event);
        } catch (error) {
          console.warn('[progress] 経過を送れませんでした', error);
        }
      });
    },
    flush() {
      return queue;
    },
  };
}
