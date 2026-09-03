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
//   PAYMENTS_USER_ID      … 既定 sample-user-1
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { Agent, BedrockModels, KVStore, type Scope } from '@aws-blocks/blocks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buyHtml } from './payments/buy-html.js';
import { createAgentCorePayer } from './payments/x402-payer.js';

// AgentCore Payments は東京非対応のため ap-southeast-1 に置いている（決定12）
const PAYMENTS_REGION = 'ap-southeast-1';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が未設定です。scripts/payments-setup.ts の出力を環境変数に設定してください`);
  }
  return value;
}

// 購入物のキーは購入者で名前空間を切る。resultId は推測困難な UUID だが、
// それだけを防壁にせず「他人の resultId は取得できない」を構造で担保する
export function purchasedHtmlKey(userId: string, resultId: string): string {
  return `${userId}/${resultId}`;
}

export function createBuyerAgent(scope: Scope) {
  // 購入した HTML の置き場。会話には resultId だけを返す
  const artifacts = new KVStore(scope, 'purchased-html', {
    schema: z.object({
      html: z.string(),
      filename: z.string().optional(),
      transaction: z.string().optional(),
      purchasedAt: z.number(),
    }),
  });

  const agent = new Agent(scope, 'buyer-agent', {
    // ローカル開発時は既定の canned プロバイダ（ツール名への言及でツール呼び出しが発火する）。
    // 支払い〜有料ツール実行の縦串は本物が動く。デプロイ時は Bedrock（決定26 の Agent ブロック）
    model: { deployed: BedrockModels.BALANCED },
    systemPrompt: [
      'あなたは HTML ページの調達エージェントです。',
      'ユーザーがページの生成を求めたら generateHtml ツールを使ってください。',
      'このツールは外部の有料 MCP サービス（billing-mcp）を呼び、1回あたり 0.1 テスト USDC を',
      'あなたのウォレット（AgentCore Payments）から x402 プロトコルで支払います。',
      '結果は resultId で参照できる旨をユーザーに伝えてください。',
    ].join('\n'),
    // 購入物を購入者に紐づけるため、呼び出しごとに userId を必須で受け取る
    toolContextSchema: z.object({ userId: z.string() }),
    tools: (tool) => ({
      generateHtml: tool({
        description:
          'billing-mcp の有料ツール generate-html で HTML ページを生成する。' +
          '1回の呼び出しごとに 0.1 テスト USDC を x402 で支払う。' +
          '生成された HTML は KVStore に保存され、resultId で取得できる',
        parameters: z.object({
          prompt: z.string().describe('生成したいページの内容の指示'),
        }),
        // 戻り値は JSONValue（undefined を含む余地のある推論を避けるため明示的に組む）
        handler: async ({
          input,
          context,
        }): Promise<{ [key: string]: string | number | boolean }> => {
          const payer = createAgentCorePayer(
            new BedrockAgentCoreClient({ region: PAYMENTS_REGION }),
            {
              userId: process.env.PAYMENTS_USER_ID ?? 'sample-user-1',
              paymentManagerArn: requireEnv('PAYMENT_MANAGER_ARN'),
              paymentSessionId: requireEnv('PAYMENT_SESSION_ID'),
              paymentInstrumentId: requireEnv('PAYMENT_INSTRUMENT_ID'),
            },
          );
          const mcpUrl = process.env.BILLING_MCP_URL ?? 'http://localhost:8000/mcp';
          const outcome = await buyHtml(mcpUrl, input.prompt, payer);
          if (outcome.isError || !outcome.html) {
            return {
              ok: false,
              paymentMade: outcome.paymentMade,
              message: outcome.message ?? '有料ツールの呼び出しに失敗しました',
            };
          }
          const resultId = randomUUID();
          await artifacts.put(purchasedHtmlKey(context.userId, resultId), {
            html: outcome.html,
            ...(outcome.filename ? { filename: outcome.filename } : {}),
            ...(outcome.paymentResponse?.transaction
              ? { transaction: outcome.paymentResponse.transaction }
              : {}),
            purchasedAt: Date.now(),
          });
          const summary: { [key: string]: string | number | boolean } = {
            ok: true,
            resultId,
            paymentMade: outcome.paymentMade,
            htmlBytes: outcome.html.length,
          };
          if (outcome.paymentResponse?.transaction) {
            summary.transaction = outcome.paymentResponse.transaction;
          }
          return summary;
        },
      }),
    }),
  });

  return { agent, artifacts };
}
