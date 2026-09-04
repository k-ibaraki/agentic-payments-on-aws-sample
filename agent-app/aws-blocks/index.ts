import { ApiNamespace, Scope, AuthCognito } from '@aws-blocks/blocks';
import { createBuyerAgent, purchasedHtmlKey, sellerInfoFromEnv } from './buyer-agent.js';
import { assertOwnedConversation } from './conversation-guard.js';
import { extractPurchases } from './purchases.js';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
// id は AWS 上の物理名（DynamoDB 表・S3 バケット等）の一部になる。Amplify Gen2 のスタック名が
// 長く、Agent ブロック内蔵の S3 バケット名を 63 文字に収めるため短くしている（決定33）。
// 一度 deploy したら変えないこと（変えると資源が作り直され、データが失われる）
const scope = new Scope('app');

// ── 認証（AuthCognito、パスワードレスのメール OTP） ──────────────────────
// ローカル（mock）では OTP を codeDelivery フックで捕まえ、getLastCode で画面に出す。
// デプロイ環境では BLOCKS_STACK_NAME が入るため捕まえず、Cognito がメールで配信する。
let lastCode: { username: string; code: string; purpose: string } | null = null;

const auth = new AuthCognito(scope, 'auth', {
  // フロントと API が別オリジンのとき（CDK の sandbox、Amplify Hosting からの呼び出し。決定33）は
  // Cookie を SameSite=None; Secure; Partitioned にする
  crossDomain: process.env.BLOCKS_SANDBOX === 'true' || process.env.BLOCKS_CROSS_DOMAIN === 'true',
  passwordPolicy: { minLength: 8, requireDigits: true },
  signInWith: 'email' as const,
  authFlowType: 'USER_AUTH' as const,
  preferredChallenge: 'EMAIL_OTP' as const,
  mfa: 'off' as const,
  // 自己サインアップは④（ローカル限定）では許す。実費 API と組み合わせてクラウドへ出す前に
  // 塞ぐこと（決定28 で⑤へ繰り越し）
  selfSignUp: true,
  codeDelivery: async (username, code, purpose) => {
    if (!process.env.BLOCKS_STACK_NAME) {
      lastCode = { username, code, purpose };
      console.log(`[auth] ${purpose} code for "${username}": ${code}`);
    }
  },
});

// ── 買い手エージェント（決定26・27・28） ────────────────────────────────
// billing-mcp の有料ツールを AgentCore Payments で支払いながら使う。
// 構成と配線は buyer-agent.ts 参照
const { agent: buyerAgent, artifacts: purchasedHtml } = createBuyerAgent(scope);

// エージェントの会話 API。
// Agent BB は conversationId / channelId の認可を呼び出し側に委ねる仕様なので、
// 会話に触れる経路（読み書き・購読）はすべて listConversations で所有を検証する。
// 特に sendMessage は実費（0.1 テスト USDC）を発生させる書き込み経路であり、
// 本アプリは自己サインアップを許しているため検証を省けない
export const buyer = new ApiNamespace(scope, 'buyer', (context) => ({
  async createConversation() {
    const user = await auth.requireAuth(context);
    return { conversationId: await buyerAgent.createConversationId(user.userSub) };
  },

  // チャンネルは会話 ID と同一に固定する（Agent BB の既定）。別の channelId を受け付けると
  // 他人の会話へストリームを注入できてしまうため、引数として受け取らない
  async sendMessage(conversationId: string, message: string) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.userSub, conversationId);
    await buyerAgent.stream(message, {
      conversationId,
      channelId: conversationId,
      userId: user.userSub,
      // 購入物を購入者に紐づける userId と、二重支払いの防護（決定31）に使う conversationId
      context: { userId: user.userSub, conversationId },
    });
    return { accepted: true, channelId: conversationId };
  },

  // 人の承認待ち（interrupt）への応答。決定31 の防護は、承認が無ければ再購入に進まない
  async resume(
    conversationId: string,
    responses: Array<{ interruptId: string; approved: boolean; trust?: boolean }>,
  ) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.userSub, conversationId);
    await buyerAgent.resume(conversationId, responses, {
      conversationId,
      userId: user.userSub,
      context: { userId: user.userSub, conversationId },
    });
    return { accepted: true };
  },

  async getPendingInterrupts(conversationId: string) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.userSub, conversationId);
    return { interrupts: await buyerAgent.getPendingInterrupts(conversationId) };
  },

  async getMessages(conversationId: string) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.userSub, conversationId);
    return { messages: await buyerAgent.getConversation(conversationId) };
  },

  // チャンネルは会話 ID と同一（sendMessage 参照）。他人の会話のストリームを
  // 購読できないよう、同じ所有検証を通す
  async getChannel(conversationId: string) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.userSub, conversationId);
    return buyerAgent.getChannel(conversationId);
  },

  // 会話中の購入一覧（決定29）。tool-result チャンクは toolName しか運ばないため、
  // ブラウザは done を受けた後にこれで resultId を知る
  async listPurchases(conversationId: string) {
    const user = await auth.requireAuth(context);
    await requireOwnedConversation(user.userSub, conversationId);
    return { purchases: extractPurchases(await buyerAgent.getConversation(conversationId)) };
  },

  // 購入済み HTML の取得（決定10・29: HTML 本体はエージェント経由でブラウザへ渡す）。
  // キーが購入者で名前空間を切られているため、他人の resultId では引けない
  async getPurchasedHtml(resultId: string) {
    const user = await auth.requireAuth(context);
    return await purchasedHtml.get(purchasedHtmlKey(user.userSub, resultId));
  },

  // ブラウザが ui:// リソースを無課金で直接取りに行く先（決定10・29）。
  // 売り手は無認証の公開エンドポイントなので秘密ではないが、経路の対称性のため認証後に返す
  async getSellerInfo() {
    await auth.requireAuth(context);
    return sellerInfoFromEnv();
  },
}));

// 会話の所有者でなければ弾く（判定の規則は conversation-guard.ts でテスト済み）
async function requireOwnedConversation(userSub: string, conversationId: string): Promise<void> {
  assertOwnedConversation(await buyerAgent.listConversations(userSub), conversationId);
}

// <Authenticator> UI を駆動する状態機械
export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async whoAmI() {
    const user = await auth.requireAuth(context);
    return { username: user.username, userSub: user.userSub };
  },

  // ── ローカル（mock）専用 ────────────────────────────────────────────
  /**
   * 直近に発行された確認コード（signUp / sign-in / reset）を返す。
   * デプロイ環境では BLOCKS_STACK_NAME により常に null（本物の OTP は漏れない）。
   * `@blocksSkipCodegen` により OpenRPC の仕様からは落とされる。
   *
   * @blocksSkipCodegen
   */
  async getLastCode() {
    return !process.env.BLOCKS_STACK_NAME ? lastCode : null;
  },
}));
