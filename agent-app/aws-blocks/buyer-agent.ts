// 買い手エージェント（決定26・27）。
// billing-mcp の有料ツールを AgentCore Payments のウォレットで支払いながら使う。
// HTML 本体は LLM のコンテキストに流さず KVStore に置き、ID だけを会話に返す
// （決定10 の最終形（ブラウザへは Realtime・取得系 API で渡す）を見据えた設計）。
//
// 接続設定は環境変数で受ける（ローカルはシェル、クラウドは aws-blocks/runtime-env.ts が Lambda に写す。決定34）:
//   BILLING_MCP_URL       … 既定 http://localhost:8000/mcp
//   BUYER_LOCAL_MODEL     … ローカル実行時の LLM。既定 bedrock（決定28）。canned で決定的な偽 LLM
//   PAYMENT_MANAGER_ARN   … payments-setup.ts の出力
//   PAYMENT_INSTRUMENT_ID … 〃
//   PAYMENT_CONNECTOR_ID  … 〃。残高の表示（GetPaymentInstrumentBalance。決定42）にだけ要る
//   PAYMENT_SESSION_MINUTES / PAYMENT_SESSION_MAX_USD
//                         … アプリが切る PaymentSession の期限と支出上限（既定 60 分・1.00 USD。決定35）。
//                            利用者 1 人・1 セッションあたりの値（決定39）。期限の下限は 15 分。
//                            上限は利用者が画面で変えられ、変えた値が KVStore にあればそちらが勝つ（決定43）
//   PAYMENTS_USER_ID      … 既定 sample-user-1（ウォレットの持ち主 ID。下記「支払い主体」参照）
//   PAYMENT_MAX_AMOUNT    … 1回の支払い上限（USDC の最小単位。既定 150000 = 0.15 USDC。決定59）
//   PAYMENT_PAY_TO        … 任意。指定すると売り手アドレスを固定する
//   BUYER_TOOL_TIMEOUT_MS … 有料ツールの応答を待つ上限。既定 600000（決定31。根拠は
//                            payments/paid-tool-caller.ts の CallOptions.timeout 参照）
//
// 支払い主体はウォレット（共有・1つ）と PaymentSession（利用者=Cognito subごと）で分けている。
// 詳細と代替案を採らなかった理由は決定39 参照
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { Agent, BedrockModels, KVStore, type ModelConfig, Realtime, type Scope } from '@aws-blocks/blocks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { amountFields } from './payments/amount.js';
import { buyHtml } from './payments/buy-html.js';
import { createProgressPublisher, failedStep, progressEventSchema } from './progress.js';
import { extractPurchases } from './purchases.js';
import {
  clearUnresolved,
  loadUnresolved,
  pendingApprovals,
  recordUnresolved,
} from './repurchase-guard.js';
import {
  MIN_SESSION_MINUTES,
  describePaymentSession,
  discardPaymentSession,
  paymentSessionSource,
  type PaymentSessionStatus,
} from './payments/payment-session.js';
import { spendLimitSource, type SpendLimit } from './payments/spend-limit.js';
import { getWalletBalance, type WalletBalance } from './payments/wallet-balance.js';
import { createAgentCorePayer } from './payments/x402-payer.js';
import type { PaymentPolicy } from './payments/x402-types.js';

// AgentCore Payments は東京非対応のため ap-southeast-1 に置いている（決定12）
const PAYMENTS_REGION = 'ap-southeast-1';

// 決定8: Base Sepolia + テスト USDC。売り手の提示がこれ以外なら支払わない
const BASE_SEPOLIA = 'eip155:84532';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// SDK クライアントは資格情報チェーンの解決と接続プールを持つため、
// 呼び出しごとに作り捨てにしない（billing-mcp 側 app.ts と同じ方針）
const paymentsClient = new BedrockAgentCoreClient({ region: PAYMENTS_REGION });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が未設定です。scripts/payments-setup.ts の出力を環境変数に設定してください`);
  }
  return value;
}

// 支払いポリシー。上限は環境変数で緩められるが、ネットワークと資産は決定8 に固定する
export function paymentPolicyFromEnv(): PaymentPolicy {
  const payTo = process.env.PAYMENT_PAY_TO;
  return {
    network: BASE_SEPOLIA,
    asset: USDC_BASE_SEPOLIA,
    maxAmount: process.env.PAYMENT_MAX_AMOUNT ?? '150000',
    ...(payTo ? { payTo } : {}),
  };
}

/** ui:// で配信される MCP Apps の UI。売り手（billing-mcp-server.ts の PREVIEW_VIEW_RESOURCE_URI）と一致させる */
export const PREVIEW_VIEW_RESOURCE_URI = 'ui://billing-mcp/preview-view.html';

// ブラウザが ui:// リソースを直接取りに行く先（決定10・29）
export function sellerInfoFromEnv(): { mcpUrl: string; resourceUri: string } {
  return {
    mcpUrl: process.env.BILLING_MCP_URL ?? 'http://localhost:8000/mcp',
    resourceUri: PREVIEW_VIEW_RESOURCE_URI,
  };
}

// アプリが切る PaymentSession の期限と支出上限（決定35）。
// 書式は runtime-env.ts が合成の時点で落とすので、ここへ不正な値が来るのは
// ローカル実行だけのはず。既定に戻して動かし続けるが、金額に直結するので黙って戻さない（決定37）
export function paymentSessionConfigFromEnv(): { expiryMinutes: number; maxSpendUsd: string } {
  const rawMinutes = process.env.PAYMENT_SESSION_MINUTES;
  const rawUsd = process.env.PAYMENT_SESSION_MAX_USD;
  const minutes = Number(rawMinutes ?? '60');
  const usd = rawUsd ?? '1.00';

  const validMinutes = Number.isInteger(minutes) && minutes >= MIN_SESSION_MINUTES;
  const validUsd = /^\d+(\.\d{1,2})?$/.test(usd);
  if (rawMinutes !== undefined && !validMinutes) {
    console.warn(`[buyer-agent] PAYMENT_SESSION_MINUTES=${rawMinutes} は ${MIN_SESSION_MINUTES} 以上の整数ではないため既定の 60 分を使います`);
  }
  if (rawUsd !== undefined && !validUsd) {
    console.warn(`[buyer-agent] PAYMENT_SESSION_MAX_USD=${rawUsd} は金額の書式でないため既定の 1.00 USD を使います`);
  }

  return {
    expiryMinutes: validMinutes ? minutes : 60,
    maxSpendUsd: validUsd ? usd : '1.00',
  };
}

// ローカル実行時の LLM（決定28）。canned は「依頼文にツール名を含めると発火」する偽 LLM で、
// e2e のような決定的な検証に使う。既定は Bedrock（AWS 資格情報が要る。無ければ canned に落ちる）
export function localModelFromEnv(): ModelConfig | undefined {
  return process.env.BUYER_LOCAL_MODEL === 'canned' ? undefined : BedrockModels.BALANCED;
}

// 有料ツールの応答を待つ上限（決定31）
export function toolTimeoutMsFromEnv(): number {
  const value = Number(process.env.BUYER_TOOL_TIMEOUT_MS ?? '600000');
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}

// 購入物のキーは購入者で名前空間を切る。resultId は推測困難な UUID だが、
// それだけを防壁にせず「他人の resultId は取得できない」を構造で担保する
export function purchasedHtmlKey(userId: string, resultId: string): string {
  return `${userId}/${resultId}`;
}

/** 購入のレシートの保存先。KVStore の必要最小限（テストではメモリ実装で代える） */
export interface PurchaseArtifactStore {
  put(
    key: string,
    value: {
      purchasedAt: number;
      error?: string;
      transaction?: string;
      authorizationNonce?: string;
      paymentUncertain?: boolean;
      /** 支払った額（最小単位）と資産（決定60） */
      amount?: string;
      asset?: string;
    },
  ): Promise<void>;
}

export interface FailedPurchaseStores {
  artifacts: PurchaseArtifactStore;
  unresolvedPurchases: Parameters<typeof recordUnresolved>[0];
}

/**
 * 金が動いた、または動いたかもしれない失敗を記録する（決定31・48）。
 *
 * **例外を外に出さない**。ここで投げるとツールが要約を返せず、tool-result が会話に残らない。
 * すると利用者単位の記録（KVStore）と会話単位の判定（会話履歴）が同時に失われ、
 * 次の購入が承認を求められないまま通ってしまう。書けなかったことはログに残す。
 *
 * 書く順は防護の記録が先、レシートが後。レシートは後から辿るための証跡なので、
 * 片方しか残らないなら残すべきは次の支払いを止める側
 */
export async function recordFailedPurchase(
  stores: FailedPurchaseStores,
  purchase: {
    userId: string;
    resultId: string;
    message: string;
    paymentUncertain?: boolean;
    transaction?: string;
    authorizationNonce?: string;
    /** 支払った（支払おうとした）額。最小単位と資産をそのまま残す（決定60） */
    amount?: string;
    asset?: string;
  },
): Promise<void> {
  const { userId, resultId, message, paymentUncertain, transaction, authorizationNonce, amount, asset } =
    purchase;
  console.error(
    paymentUncertain
      ? `[buyer-agent] 支払いの成否を確認できなかった resultId=${resultId}（ProcessPayment の clientToken と同じ値。Payments 側の記録と突き合わせること）`
      : `[buyer-agent] 支払い済みだが成果物を得られなかった resultId=${resultId} tx=${transaction ?? '(なし)'} nonce=${authorizationNonce ?? '(なし)'}`,
  );
  try {
    await recordUnresolved(stores.unresolvedPurchases, userId, resultId);
  } catch (error) {
    console.error(
      `[buyer-agent] 未解決の記録に失敗した resultId=${resultId}（会話単位の防護に委ねる）`,
      error,
    );
  }
  try {
    await stores.artifacts.put(purchasedHtmlKey(userId, resultId), {
      purchasedAt: Date.now(),
      error: message,
      ...(transaction ? { transaction } : {}),
      ...(authorizationNonce ? { authorizationNonce } : {}),
      ...(paymentUncertain ? { paymentUncertain: true } : {}),
      ...(amount ? { amount } : {}),
      ...(asset ? { asset } : {}),
    });
  } catch (error) {
    console.error(`[buyer-agent] レシートの保存に失敗した resultId=${resultId}`, error);
  }
}

export function createBuyerAgent(scope: Scope) {
  // 購入の記録。成功時は HTML 本体を、決済後に成果物を得られなかった場合も
  // レシート（tx）を残す。決定21 の upfront は「決済後の失敗リスクを買い手が負う」ため、
  // 金が出た証跡だけは失敗経路でも必ず永続化する
  const artifacts = new KVStore(scope, 'purchased-html', {
    schema: z.object({
      html: z.string().optional(),
      filename: z.string().optional(),
      transaction: z.string().optional(),
      // 支払った（支払おうとした）額。最小単位の整数と資産のアドレス（決定60）。
      // 後から履歴やオンチェーンの記録と突き合わせるために生の値で残す
      amount: z.string().optional(),
      asset: z.string().optional(),
      // 支払い後に応答を得られなかった場合の手がかり（tx が無いときの代わり）
      authorizationNonce: z.string().optional(),
      // 支払いの成否そのものを確認できなかった（決定48）。tx も nonce も無く、
      // 突き合わせの手がかりは resultId（= ProcessPayment の clientToken）だけ
      paymentUncertain: z.boolean().optional(),
      purchasedAt: z.number(),
      error: z.string().optional(),
    }),
  });

  // 利用者ごとに残る「未解決の支払い」の記録（決定48。理由は repurchase-guard.ts 参照）。
  // TTL は付けない（期限切れで防護が黙って外れるのを避ける。購入の成功時に消す）
  const unresolvedPurchases = new KVStore(scope, 'unresolved-payment', {
    schema: z.object({
      resultIds: z.array(z.string()),
      updatedAt: z.number(),
    }),
  });

  // アプリが切った PaymentSession の記録（決定35）。利用者（Cognito の sub）をキーに利用者ごとに 1 つ（決定39）。
  // 期限切れの記録は DynamoDB の TTL で消える
  const paymentSessions = new KVStore(scope, 'payment-session', {
    schema: z.object({
      paymentSessionId: z.string(),
      createdAt: z.number(),
      expiresAt: z.number(),
    }),
    ttl: true,
  });

  // 利用者が画面で変えた支出上限（決定43）。無ければ環境変数の既定。TTL は無し（利用者の設定として残す）
  const spendLimits = new KVStore(scope, 'spend-limit', {
    schema: z.object({
      maxSpendUsd: z.string(),
      updatedAt: z.number(),
    }),
  });

  // 購入の経過（決定65。progress.ts 参照）。チャンネルは会話 ID ごと。購読の取っ手は
  // buyer API が会話の所有を検証してから返す（index.ts の getProgressChannel）。
  // 共有の接続表とトークンの秘密値は最初に作られた Realtime が持つので、Agent（内蔵の Realtime）より先に
  // 作るこの順は deploy 後に変えない。変えると作り直される（決定26 の訂正）
  const progress = new Realtime(scope, 'progress', {
    namespaces: { steps: Realtime.namespace(progressEventSchema) },
  });

  // id は物理名の一部で、内蔵 S3 バケット名は cdk deploy 経路では <スタック名>-app-buyer-sn、
  // Amplify 経路では <Amplify のルートスタック名>-b-app-buyer-sn になる（決定33。理由は index.ts の Scope 定義参照）
  const agent = new Agent(scope, 'buyer', {
    // ローカルでも Bedrock を使う（決定28。BUYER_LOCAL_MODEL=canned で偽 LLM に切替）。
    // 支払い〜有料ツール実行の縦串はどちらでも本物が動く
    model: { deployed: BedrockModels.BALANCED, local: localModelFromEnv() },
    systemPrompt: [
      'あなたは HTML ページの調達エージェントです。',
      'ユーザーがページの生成を求めたら generateHtml ツールを使ってください。',
      'このツールは外部の有料 MCP サービス（billing-mcp）を呼び、売り手が提示する金額を',
      'あなたのウォレット（AgentCore Payments）から x402 プロトコルで支払います。',
      '金額は売り手の提示によりますが、1回あたりの上限を超える提示には応じません。',
      '結果は resultId で参照できる旨をユーザーに伝えてください。',
      '購入できたら、支払った金額（ツールが返す amountDisplay）を必ず添えて報告してください。',
      'ツールが失敗しても自動で再試行してはいけません。支払いが済んでいる可能性があるため、',
      '失敗の内容（paymentMade・paymentUncertain と resultId）をユーザーに報告し、指示を待ってください。',
      'paymentUncertain が真の場合は、支払われたかどうか自体が分かっていません。',
    ].join('\n'),
    // 購入物の紐づけと利用者ごとの防護の記録に userId を、会話単位の防護に
    // conversationId を、呼び出しごとに必須で受け取る（決定31・48）
    toolContextSchema: z.object({ userId: z.string(), conversationId: z.string() }),
    tools: (tool) => ({
      generateHtml: tool({
        description:
          'billing-mcp の有料ツール generate-html で HTML ページを生成する。' +
          '売り手が提示する金額（テスト USDC）を1回の呼び出しごとに x402 で支払う。' +
          '生成された HTML は KVStore に保存され、resultId で取得できる',
        parameters: z.object({
          prompt: z.string().describe('生成したいページの内容の指示'),
        }),
        // 戻り値は JSONValue（undefined を含む余地のある推論を避けるため明示的に組む）
        handler: async ({
          input,
          context,
          interrupt,
        }): Promise<{ [key: string]: string | number | boolean }> => {
          // 硬い防護（決定31・48、理由は repurchase-guard.ts 参照）: 未解決の購入が残っていれば
          // LLM の判断だけでは次の支払いに進ませず、人の承認（interrupt）を要求する。interrupt
          // は承認前なら処理を中断し、resume 後にこのハンドラが先頭から再実行される
          const unresolved = pendingApprovals(
            extractPurchases(await agent.getConversation(context.conversationId)),
            await loadUnresolved(unresolvedPurchases, context.userId),
          );
          if (unresolved.length > 0) {
            const answer = interrupt<string>({
              name: 'confirm-repurchase',
              reason: {
                message:
                  'この会話には支払い済み、または支払いの成否が確認できていない購入があります。もう一度支払って購入しますか？',
                unresolved,
                prompt: input.prompt,
              },
            });
            if (answer !== 'yes' && answer !== 'trust') {
              return {
                ok: false,
                paymentMade: false,
                message: 'ユーザーの承認が得られなかったため購入しませんでした',
              };
            }
          }

          // 購入 1 件の ID を先に採番し、KVStore のキーと ProcessPayment の冪等キーに共用する（決定30）
          const resultId = randomUUID();
          // 環境変数は呼び出しごとに読む（未設定なら支払いに進む前にここで止まる）
          const userId = process.env.PAYMENTS_USER_ID ?? 'sample-user-1';
          const paymentManagerArn = requireEnv('PAYMENT_MANAGER_ARN');
          const paymentInstrumentId = requireEnv('PAYMENT_INSTRUMENT_ID');
          // 有効な PaymentSession は KVStore の記録から使い回し、無ければここで切る（決定35）。
          // 記録と枠は利用者（Cognito の sub）ごと。ウォレットは共有のまま（決定39）
          const sessionConfig = paymentSessionConfigFromEnv();
          const paymentSession = paymentSessionSource(paymentsClient, paymentSessions, {
            userId,
            storeKey: context.userId,
            paymentManagerArn,
            expiryMinutes: sessionConfig.expiryMinutes,
            // 上限は作成のたびに解決する。利用者が画面で変えた値（決定43）があればそれ、無ければ既定
            maxSpendUsd: async () =>
              (await spendLimitSource(spendLimits, sessionConfig.maxSpendUsd).get(context.userId)).maxSpendUsd,
          });
          const payer = createAgentCorePayer(
            paymentsClient,
            { userId, paymentManagerArn, paymentSession, paymentInstrumentId, purchaseId: resultId },
            paymentPolicyFromEnv(),
          );
          // 購入の経過を画面へ流す（決定65）。送信は待たずに順に行い、ツールを返す前に出揃うのを待つ
          const publisher = createProgressPublisher(resultId, (event) =>
            progress.publish('steps', context.conversationId, event),
          );
          try {
            const outcome = await buyHtml(sellerInfoFromEnv().mcpUrl, input.prompt, payer, {
              timeout: toolTimeoutMsFromEnv(),
              progress: publisher,
            });
            const transaction = outcome.paymentResponse?.transaction;
            // 支払った額。要約（LLM と画面が読む）とレシートの双方に載せる（決定60）
            const amount = amountFields(outcome.paidAmount);

            if (outcome.isError || !outcome.html) {
              const message = outcome.message ?? '有料ツールの呼び出しに失敗しました';
              const summary: { [key: string]: string | number | boolean } = {
                ok: false,
                paymentMade: outcome.paymentMade,
                message,
              };
              // 金が動いた、または動いたかもしれない失敗（決定31・48）。記録は投げない
              // （recordFailedPurchase 参照）ので、summary は必ず返る
              if (outcome.paymentMade || outcome.paymentUncertain) {
                summary.resultId = resultId;
                if (outcome.paymentUncertain) summary.paymentUncertain = true;
                if (transaction) summary.transaction = transaction;
                if (outcome.authorizationNonce) summary.authorizationNonce = outcome.authorizationNonce;
                if (amount) Object.assign(summary, amount);
                await recordFailedPurchase(
                  { artifacts, unresolvedPurchases },
                  {
                    userId: context.userId,
                    resultId,
                    message,
                    ...(outcome.paymentUncertain ? { paymentUncertain: true } : {}),
                    ...(transaction ? { transaction } : {}),
                    ...(outcome.authorizationNonce
                      ? { authorizationNonce: outcome.authorizationNonce }
                      : {}),
                    ...(outcome.paidAmount ?? {}),
                  },
                );
              }
              publisher.report(failedStep(message));
              return summary;
            }

            await artifacts.put(purchasedHtmlKey(context.userId, resultId), {
              html: outcome.html,
              ...(outcome.filename ? { filename: outcome.filename } : {}),
              ...(transaction ? { transaction } : {}),
              ...(outcome.paidAmount ?? {}),
              purchasedAt: Date.now(),
            });
            // 買えたので、この利用者の未解決は決着とみなして記録を消す（決定48）。
            // 承認だけでは消さない（承認 → 再び失敗、で防護が外れてしまうため）
            await clearUnresolved(unresolvedPurchases, context.userId);
            const summary: { [key: string]: string | number | boolean } = {
              ok: true,
              resultId,
              paymentMade: outcome.paymentMade,
              htmlBytes: outcome.html.length,
            };
            if (transaction) summary.transaction = transaction;
            if (amount) Object.assign(summary, amount);
            publisher.report({ step: 'received', htmlBytes: outcome.html.length });
            return summary;
          } catch (error) {
            // buyHtml が投げた失敗（設定の欠け・ProcessPayment の拒否など。支払いの記録は購入の側が持つ）と、
            // 決済の後の成果物の保存・未解決の消去の失敗。後者は決済済みだが、ここでは記録せずに投げ直す
            publisher.report(failedStep(error instanceof Error ? error.message : String(error)));
            throw error;
          } finally {
            await publisher.flush();
          }
        },
      }),
    }),
  });

  return { agent, artifacts, paymentSessions, spendLimits, unresolvedPurchases, progress };
}

// ── ウォレットと支払いの枠（決定42・43）。buyer API から利用者ごとに呼ぶ ──────────────

export interface WalletStatus {
  /** ウォレット残高。PAYMENT_CONNECTOR_ID が無い・取得に失敗したときは null と理由 */
  balance: WalletBalance | null;
  balanceError: string | null;
  /** 次に切るセッションの上限（利用者の設定か既定） */
  spendLimit: SpendLimit;
  /** 現在のセッション（無ければ null。次の購入で切られる） */
  session: PaymentSessionStatus | null;
  sessionError: string | null;
  /** セッションの期限（分。作成時の設定） */
  sessionMinutes: number;
}

/** KVStore の必要最小限（payments/ の Store 型と同じ）。テストではメモリ実装で代える */
export interface WalletStores {
  paymentSessions: Parameters<typeof describePaymentSession>[1];
  spendLimits: Parameters<typeof spendLimitSource>[0];
}

interface AwsClientLike {
  send(command: unknown): Promise<unknown>;
}

// 画面の表示は決済の経路と違い、環境変数の欠落や API の失敗で全体を落とさず、理由を添えて返す。
// client はテストで差し替えるための引数（既定は共有の SDK クライアント）。
// API の例外文は ARN や ID を含み得るので画面には出さず、原文はログに残して一般化した理由を返す
// （この取得はサインイン時・購入後・更新のたびに走り、全利用者の目に触れるため）
export async function walletStatus(
  stores: WalletStores,
  userSub: string,
  client: AwsClientLike = paymentsClient,
): Promise<WalletStatus> {
  const userId = process.env.PAYMENTS_USER_ID ?? 'sample-user-1';
  const sessionConfig = paymentSessionConfigFromEnv();
  const spendLimit = await spendLimitSource(stores.spendLimits, sessionConfig.maxSpendUsd).get(userSub);
  const paymentManagerArn = process.env.PAYMENT_MANAGER_ARN;
  const paymentInstrumentId = process.env.PAYMENT_INSTRUMENT_ID;
  const paymentConnectorId = process.env.PAYMENT_CONNECTOR_ID;

  const status: WalletStatus = {
    balance: null,
    balanceError: null,
    spendLimit,
    session: null,
    sessionError: null,
    sessionMinutes: sessionConfig.expiryMinutes,
  };

  if (!paymentManagerArn || !paymentInstrumentId) {
    status.balanceError = 'PAYMENT_MANAGER_ARN / PAYMENT_INSTRUMENT_ID が未設定です';
    status.sessionError = status.balanceError;
    return status;
  }

  if (!paymentConnectorId) {
    status.balanceError = 'PAYMENT_CONNECTOR_ID が未設定です（payments-setup.ts の出力を設定してください）';
  } else {
    try {
      status.balance = await getWalletBalance(client, {
        userId,
        paymentManagerArn,
        paymentConnectorId,
        paymentInstrumentId,
      });
    } catch (error) {
      status.balanceError = describeApiFailure('残高', 'GetPaymentInstrumentBalance', userSub, error);
    }
  }

  try {
    status.session = await describePaymentSession(client, stores.paymentSessions, {
      userId,
      storeKey: userSub,
      paymentManagerArn,
    });
  } catch (error) {
    status.sessionError = describeApiFailure('セッション', 'GetPaymentSession', userSub, error);
  }
  return status;
}

// 原文（例外名とメッセージ）はサーバーのログへ。画面には例外名だけを添えた一般化した文を返す
function describeApiFailure(what: string, api: string, userSub: string, error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[buyer-agent] ${what}の取得に失敗 利用者=${userSub} api=${api} ${name}: ${message}`);
  return `${what}を取得できませんでした（${name}。詳細はサーバーのログを参照）`;
}

/**
 * 利用者の支出上限を変え、現在のセッションを破棄して即時に効かせる（決定43）。
 * 破棄に失敗したら上限の保存は済んだまま投げる（次の作り直しでは新しい上限になる）
 */
export async function changeSpendLimit(
  stores: WalletStores,
  userSub: string,
  maxSpendUsd: string,
  client: AwsClientLike = paymentsClient,
): Promise<{ spendLimit: SpendLimit; discardedSession: string | null }> {
  const sessionConfig = paymentSessionConfigFromEnv();
  const spendLimit = await spendLimitSource(stores.spendLimits, sessionConfig.maxSpendUsd).set(userSub, maxSpendUsd);
  const paymentManagerArn = process.env.PAYMENT_MANAGER_ARN;
  if (!paymentManagerArn) return { spendLimit, discardedSession: null };
  const { discarded } = await discardPaymentSession(client, stores.paymentSessions, {
    userId: process.env.PAYMENTS_USER_ID ?? 'sample-user-1',
    storeKey: userSub,
    paymentManagerArn,
  });
  return { spendLimit, discardedSession: discarded };
}
