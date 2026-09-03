// 買い手エージェント（決定26・27）。
// billing-mcp の有料ツールを AgentCore Payments のウォレットで支払いながら使う。
// HTML 本体は LLM のコンテキストに流さず KVStore に置き、ID だけを会話に返す
// （決定10 の最終形＝ブラウザへは Realtime/取得系 API で渡す、を見据えた形）。
//
// 接続設定は環境変数で受ける（③はローカル実行。④のデプロイ時に AppSetting 化を検討）:
//   BILLING_MCP_URL       … 既定 http://localhost:8000/mcp
//   PAYMENT_MANAGER_ARN   … payments-setup.ts の出力
//   PAYMENT_SESSION_ID    … 〃（セッションは有効期限つき。切れたら作り直す）
//   PAYMENT_INSTRUMENT_ID … 〃
//   PAYMENTS_USER_ID      … 既定 sample-user-1（ウォレットの持ち主 ID。下記「支払い主体」参照）
//   PAYMENT_MAX_AMOUNT    … 1回の支払い上限（USDC の最小単位。既定 100000 = 0.1 USDC）
//   PAYMENT_PAY_TO        … 任意。指定すると売り手アドレスを固定する
//
// 支払い主体について（④への繰り越し）:
//   ProcessPayment の userId はウォレット（PaymentInstrument）の持ち主 ID であり、
//   ③では PAYMENTS_USER_ID の単一ウォレットを全利用者で共有している。一方、購入物の
//   所有者は Cognito の userSub（ツールコンテキスト）で分けている。利用者ごとの支出上限や
//   Payments 側の監査で「誰が支払わせたか」を追うには、利用者ごとに instrument と
//   WalletHub 委任が要るため④で扱う（implementation-log「残していること」参照）
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { Agent, BedrockModels, KVStore, type Scope } from '@aws-blocks/blocks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buyHtml } from './payments/buy-html.js';
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
      purchasedAt: z.number(),
      error: z.string().optional(),
    }),
  });

  const agent = new Agent(scope, 'buyer-agent', {
    // ローカル開発時は既定の canned プロバイダ（ツール名への言及でツール呼び出しが発火する）。
    // 支払い〜有料ツール実行の縦串は本物が動く。デプロイ時は Bedrock（決定26 の Agent ブロック）
    model: { deployed: BedrockModels.BALANCED },
    systemPrompt: [
      'あなたは HTML ページの調達エージェントです。',
      'ユーザーがページの生成を求めたら generateHtml ツールを使ってください。',
      'このツールは外部の有料 MCP サービス（billing-mcp）を呼び、売り手が提示する金額を',
      'あなたのウォレット（AgentCore Payments）から x402 プロトコルで支払います。',
      '金額は売り手の提示によりますが、1回あたりの上限を超える提示には応じません。',
      '結果は resultId で参照できる旨をユーザーに伝えてください。',
    ].join('\n'),
    // 購入物を購入者に紐づけるため、呼び出しごとに userId を必須で受け取る
    toolContextSchema: z.object({ userId: z.string() }),
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
        }): Promise<{ [key: string]: string | number | boolean }> => {
          // セッションは期限切れで作り直される前提なので、環境変数は呼び出しごとに読む
          const payer = createAgentCorePayer(
            paymentsClient,
            {
              userId: process.env.PAYMENTS_USER_ID ?? 'sample-user-1',
              paymentManagerArn: requireEnv('PAYMENT_MANAGER_ARN'),
              paymentSessionId: requireEnv('PAYMENT_SESSION_ID'),
              paymentInstrumentId: requireEnv('PAYMENT_INSTRUMENT_ID'),
            },
            paymentPolicyFromEnv(),
          );
          const mcpUrl = process.env.BILLING_MCP_URL ?? 'http://localhost:8000/mcp';
          const outcome = await buyHtml(mcpUrl, input.prompt, payer);
          const resultId = randomUUID();
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
              });
              console.error(
                `[buyer-agent] 支払い済みだが成果物を得られなかった resultId=${resultId} tx=${transaction ?? '(なし)'}`,
              );
              summary.resultId = resultId;
              if (transaction) summary.transaction = transaction;
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
