// フェーズ③の縦串検証（決定27）: 買い手エージェントが AgentCore Payments で
// 支払いながら billing-mcp の有料ツールを使えることを、UI なしで通す。
//
// 前提:
//   - billing-mcp をローカル起動しておく（billing-mcp/server で pnpm dev。ポート 8000）
//   - scripts/payments-setup.ts が完了し、ウォレットに残高があること
//   - 環境変数: PAYMENT_MANAGER_ARN / PAYMENT_SESSION_ID / PAYMENT_INSTRUMENT_ID
//     （BILLING_MCP_URL・PAYMENTS_USER_ID は任意）
//
// 実行: npx tsx scripts/buy-via-agent.ts "作りたいページの指示"
//
// 注意: 1回の実行で実オンチェーン決済（0.1 テスト USDC）が発生する。
// ローカルの LLM は既定で canned プロバイダ（モック）だが、
// 支払い・billing-mcp 側の Bedrock 生成・オンチェーン決済はすべて本物が動く
import { type AgentStreamChunk, Scope } from '@aws-blocks/blocks';
import { createBuyerAgent, purchasedHtmlKey } from '../aws-blocks/buyer-agent.js';

const prompt =
  process.argv[2] ??
  '「エージェントが x402 で購入したページ」と大きく表示するシンプルな HTML ページ';

// index.ts を読み込むと全ブロックが立ち上がるため、検証に必要な分だけ別スコープで組む
const scope = new Scope('agent-app-headless');
const { agent, artifacts } = createBuyerAgent(scope);

const userId = process.env.PAYMENTS_USER_ID ?? 'sample-user-1';
const conversationId = await agent.createConversationId(userId);

console.log(`会話を開始: ${conversationId}`);
console.log(`エージェントへの依頼: generateHtml ツールで ${prompt}`);

// canned プロバイダはツール名への言及でツール呼び出しを発火させるため、
// 依頼文にツール名を含めている
const result = await agent.stream(`generateHtml ツールを使ってください: ${prompt}`, {
  conversationId,
  userId,
  // toolContextSchema が userId を必須にしている（購入物を購入者に紐づけるため）
  context: { userId },
});

const channel = await result.channel;
const sub = channel.subscribe((chunk: AgentStreamChunk) => {
  if (chunk.type === 'tool-call') console.log(`ツール呼び出し: ${chunk.toolName}`);
  if (chunk.type === 'tool-result') console.log(`ツール結果: ${chunk.text}`);
  if (chunk.type === 'error') console.error(`エラー: ${chunk.error}`);
});
await sub.established;

const done = await result.complete();
console.log('');
console.log(`エージェントの応答: ${done.text}`);

// ツール結果から resultId を拾い、KVStore に HTML が本当に置かれたか確かめる。
// content は実装によって文字列（JSON）にもオブジェクトにもなり得るため防御的に読む
const messages = await agent.getConversation(conversationId);
const toolResult = messages.find((m: { role: string }) => m.role === 'tool-result') as
  | { content?: unknown }
  | undefined;
let body: { resultId?: string; transaction?: string } = {};
let raw: unknown = toolResult?.content;
if (typeof raw === 'string' && raw.length > 0) {
  const text = raw;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`ツール結果を JSON として読めませんでした: ${text.slice(0, 200)}`);
  }
}
if (raw && typeof raw === 'object') {
  // Strands はツール結果を { json: {...} } に包むことがある（実測）ため一段ほどく
  const unwrapped = 'json' in raw ? (raw as { json: unknown }).json : raw;
  if (unwrapped && typeof unwrapped === 'object') body = unwrapped as typeof body;
}
// 会話履歴から拾えない場合の保険: 最終応答テキストに埋まった JSON からも試みる
if (!body.resultId) {
  const match = done.text?.match(/"resultId"\s*:\s*"([0-9a-f-]{36})"/);
  if (match) {
    body.resultId = match[1];
    body.transaction = done.text?.match(/"transaction"\s*:\s*"(0x[0-9a-fA-F]+)"/)?.[1];
  }
}
if (body.resultId) {
  const stored = await artifacts.get(purchasedHtmlKey(userId, body.resultId));
  console.log('');
  console.log(`resultId: ${body.resultId}`);
  console.log(`決済トランザクション: ${body.transaction ?? '(なし)'}`);
  console.log(`保存された HTML: ${stored?.html?.slice(0, 120) ?? '(なし)'}...`);
  if (stored?.html) {
    console.log('');
    console.log('縦串検証 成功: エージェントが支払い、HTML を受領・保存した');
    process.exit(0);
  }
}
console.error('縦串検証 失敗: 購入済み HTML を確認できなかった');
process.exit(1);
