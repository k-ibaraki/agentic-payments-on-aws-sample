// 買い手エージェント（決定26・27）。
// billing-mcp の有料ツールを AgentCore Payments のウォレットで支払いながら使う。
// HTML 本体は LLM のコンテキストに流さず KVStore に置き、ID だけを会話に返す
// （決定10 の最終形＝ブラウザへは Realtime/取得系 API で渡す、を見据えた形）。
//
// 接続設定は環境変数で受ける（ローカルはシェル、クラウドは amplify/runtime-env.ts が Lambda に写す。決定34）:
//   BILLING_MCP_URL       … 既定 http://localhost:8000/mcp
//   BUYER_LOCAL_MODEL     … ローカル実行時の LLM。既定 bedrock（決定28）。canned で決定的な偽 LLM
//   PAYMENT_MANAGER_ARN   … payments-setup.ts の出力
//   PAYMENT_INSTRUMENT_ID … 〃
//   PAYMENT_SESSION_MINUTES / PAYMENT_SESSION_MAX_USD
//                         … アプリが切る PaymentSession の期限と支出上限（既定 60 分・1.00 USD。決定35）
//   PAYMENTS_USER_ID      … 既定 sample-user-1（ウォレットの持ち主 ID。下記「支払い主体」参照）
//   PAYMENT_MAX_AMOUNT    … 1回の支払い上限（USDC の最小単位。既定 100000 = 0.1 USDC）
//   PAYMENT_PAY_TO        … 任意。指定すると売り手アドレスを固定する
//   BUYER_TOOL_TIMEOUT_MS … 有料ツールの応答を待つ上限。既定 600000（売り手の Lambda タイムアウトと同じ 600 秒。
//                            売り手は Bedrock 呼び出しを 570 秒で打ち切り、その外側の Lambda が 600 秒）。
//                            MCP SDK の既定 60 秒のままだと決済後に諦めて成果物を失う（決定31）
//
// 支払い主体について（⑤への繰り越し。決定28）:
//   ProcessPayment の userId はウォレット（PaymentInstrument）の持ち主 ID であり、
//   ③では PAYMENTS_USER_ID の単一ウォレットを全利用者で共有している。一方、購入物の
//   所有者は Cognito の userSub（ツールコンテキスト）で分けている。利用者ごとの支出上限や
//   Payments 側の監査で「誰が支払わせたか」を追うには、利用者ごとに instrument と
//   WalletHub 委任が要るため⑤で扱う（implementation-log「残していること」参照）
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { Agent, BedrockModels, KVStore, type ModelConfig, type Scope } from '@aws-blocks/blocks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buyHtml } from './payments/buy-html.js';
import { extractPurchases } from './purchases.js';
import { unresolvedPayments } from './repurchase-guard.js';
import { paymentSessionSource } from './payments/payment-session.js';
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
    maxAmount: process.env.PAYMENT_MAX_AMOUNT ?? '100000',
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
// 書式は amplify/runtime-env.ts が合成の時点で落とすので、ここへ不正な値が来るのは
// ローカル実行だけのはず。既定に戻して動かし続けるが、金額に直結するので黙って戻さない（決定37）
export function paymentSessionConfigFromEnv(): { expiryMinutes: number; maxSpendUsd: string } {
  const rawMinutes = process.env.PAYMENT_SESSION_MINUTES;
  const rawUsd = process.env.PAYMENT_SESSION_MAX_USD;
  const minutes = Number(rawMinutes ?? '60');
  const usd = rawUsd ?? '1.00';

  const validMinutes = Number.isInteger(minutes) && minutes > 0;
  const validUsd = /^\d+(\.\d{1,2})?$/.test(usd);
  if (rawMinutes !== undefined && !validMinutes) {
    console.warn(`[buyer-agent] PAYMENT_SESSION_MINUTES=${rawMinutes} は正の整数ではないため既定の 60 分を使います`);
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

export function createBuyerAgent(scope: Scope) {
  // 購入の記録。成功時は HTML 本体を、決済後に成果物を得られなかった場合も
  // レシート（tx）を残す。決定21 の upfront は「決済後の失敗リスクを買い手が負う」ため、
  // 金が出た証跡だけは失敗経路でも必ず永続化する
  const artifacts = new KVStore(scope, 'purchased-html', {
    schema: z.object({
      html: z.string().optional(),
      filename: z.string().optional(),
      transaction: z.string().optional(),
      // 支払い後に応答を得られなかった場合の手がかり（tx が無いときの代わり）
      authorizationNonce: z.string().optional(),
      purchasedAt: z.number(),
      error: z.string().optional(),
    }),
  });

  // アプリが切った PaymentSession の記録（決定35）。ウォレットの持ち主 ID をキーにアプリ全体で 1 つ。
  // 期限切れの記録は DynamoDB の TTL で消える
  const paymentSessions = new KVStore(scope, 'payment-session', {
    schema: z.object({
      paymentSessionId: z.string(),
      createdAt: z.number(),
      expiresAt: z.number(),
    }),
    ttl: true,
  });

  // id は物理名の一部。内蔵 S3 バケットは CDK 直経路では <スタック名>-app-buyer-sn、Amplify 経路では
  // <Amplify のルートスタック名>-b-app-buyer-sn になる。Amplify のスタック名の長さに合わせて
  // 短くしている（決定33）。一度 deploy したら変えないこと
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
      'ツールが失敗しても自動で再試行してはいけません。支払いが済んでいる可能性があるため、',
      '失敗の内容（paymentMade と resultId）をユーザーに報告し、指示を待ってください。',
    ].join('\n'),
    // 購入物を購入者に紐づけるため userId を、二重支払いの防護（決定31）のため
    // conversationId を、呼び出しごとに必須で受け取る
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
          // 硬い防護（決定31）: この会話に「支払い済みなのに成果物が無い」購入があれば、
          // LLM の判断だけでは次の支払いに進ませない。人の承認（interrupt）を要求する。
          // interrupt は承認前なら処理を中断し、resume 後にこのハンドラが先頭から再実行される
          const unresolved = unresolvedPayments(
            extractPurchases(await agent.getConversation(context.conversationId)),
          );
          if (unresolved.length > 0) {
            const answer = interrupt<string>({
              name: 'confirm-repurchase',
              reason: {
                message:
                  'この会話には支払い済みで成果物を受け取れなかった購入があります。もう一度支払って購入しますか？',
                unresolved: unresolved.map((u) => u.resultId),
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
          // 有効な PaymentSession は KVStore の記録から使い回し、無ければここで切る（決定35）
          const paymentSession = paymentSessionSource(paymentsClient, paymentSessions, {
            userId,
            paymentManagerArn,
            ...paymentSessionConfigFromEnv(),
          });
          const payer = createAgentCorePayer(
            paymentsClient,
            { userId, paymentManagerArn, paymentSession, paymentInstrumentId, purchaseId: resultId },
            paymentPolicyFromEnv(),
          );
          const outcome = await buyHtml(sellerInfoFromEnv().mcpUrl, input.prompt, payer, {
            timeout: toolTimeoutMsFromEnv(),
          });
          const transaction = outcome.paymentResponse?.transaction;

          if (outcome.isError || !outcome.html) {
            const message = outcome.message ?? '有料ツールの呼び出しに失敗しました';
            const summary: { [key: string]: string | number | boolean } = {
              ok: false,
              paymentMade: outcome.paymentMade,
              message,
            };
            if (outcome.paymentMade) {
              // 支払いは成立したのに成果物が無い。レシートを残し、観測可能な signal も出す
              await artifacts.put(purchasedHtmlKey(context.userId, resultId), {
                purchasedAt: Date.now(),
                error: message,
                ...(transaction ? { transaction } : {}),
                ...(outcome.authorizationNonce ? { authorizationNonce: outcome.authorizationNonce } : {}),
              });
              console.error(
                `[buyer-agent] 支払い済みだが成果物を得られなかった resultId=${resultId} tx=${transaction ?? '(なし)'} nonce=${outcome.authorizationNonce ?? '(なし)'}`,
              );
              summary.resultId = resultId;
              if (transaction) summary.transaction = transaction;
              if (outcome.authorizationNonce) summary.authorizationNonce = outcome.authorizationNonce;
            }
            return summary;
          }

          await artifacts.put(purchasedHtmlKey(context.userId, resultId), {
            html: outcome.html,
            ...(outcome.filename ? { filename: outcome.filename } : {}),
            ...(transaction ? { transaction } : {}),
            purchasedAt: Date.now(),
          });
          const summary: { [key: string]: string | number | boolean } = {
            ok: true,
            resultId,
            paymentMade: outcome.paymentMade,
            htmlBytes: outcome.html.length,
          };
          if (transaction) summary.transaction = transaction;
          return summary;
        },
      }),
    }),
  });

  return { agent, artifacts };
}
