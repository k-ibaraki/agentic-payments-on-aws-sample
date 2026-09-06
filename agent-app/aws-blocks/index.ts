import { ApiNamespace, AuthCognito, KVStore, Scope } from '@aws-blocks/blocks';
import { z } from 'zod';
import {
  changeSpendLimit,
  createBuyerAgent,
  purchasedHtmlKey,
  sellerInfoFromEnv,
  walletStatus,
} from './buyer-agent.js';
import { assertOwnedConversation } from './conversation-guard.js';
import { assertPendingInterrupts } from './interrupt-guard.js';
import { extractPurchases } from './purchases.js';
import { rateLimitConfigFromEnv, rateLimiter } from './rate-limit.js';

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
  // 自己サインアップは既定で閉じる（決定36）。実費 API を公開 URL で配るため、クラウドでは利用者を
  // 管理者が作る（Cognito コンソール / auth.admin.createUser）。ローカルの dev と e2e は
  // npm スクリプトが BUYER_SELF_SIGNUP=true を付けて開ける
  selfSignUp: process.env.BUYER_SELF_SIGNUP === 'true',
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
const { agent: buyerAgent, artifacts: purchasedHtml, paymentSessions, spendLimits } = createBuyerAgent(scope);
const walletStores = { paymentSessions, spendLimits };

// 利用者ごとの依頼回数の記録（決定40）。キーは「利用者/時間窓の開始」で、窓が過ぎた記録は TTL で消える。
// 支払いに至らない依頼でも Bedrock の費用は掛かるため、支出上限（決定37・@39@）とは別に数える
const requestCounts = new KVStore(scope, 'request-count', {
  schema: z.object({ count: z.number() }),
  ttl: true,
});

// エージェントの会話 API。
// Agent BB は conversationId / channelId の認可を呼び出し側に委ねる仕様なので、
// 会話に触れる経路（読み書き・購読）はすべて listConversations で所有を検証する。
// 特に sendMessage は実費（0.1 テスト USDC）を発生させる書き込み経路なので検証を省けない。
// 自己サインアップは決定36 で既定は閉じたが、利用者どうしの分離はそれとは別に要る
// （管理者が作った利用者でも、他人の会話に支払わせられてはならない）
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
    // 依頼回数の上限（決定40）。所有検証の後・エージェント起動の前に数える。
    // 環境変数は呼び出しごとに読む（他の実行時設定と同じ扱い）
    const verdict = await rateLimiter(requestCounts, rateLimitConfigFromEnv()).consume(user.userSub);
    if (!verdict.allowed) {
      throw new Error(
        `依頼が多すぎます。${verdict.retryAt.toISOString()} 以降にやり直してください（利用者ごとの回数上限。決定40）`,
      );
    }
    await buyerAgent.stream(message, {
      conversationId,
      channelId: conversationId,
      userId: user.userSub,
      // 購入物の紐づけと利用者ごとの防護の記録に使う userId と、会話単位の防護に使う conversationId（決定31・48）
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
    // resume は依頼回数に数えない。数えない代わりに、承認待ちが実在する応答だけを通す。
    // Agent BB の resume() 自体はこれを検証せず、応答さえ渡せばジョブを投入するため、
    // ここで塞がないと上限を通らずにモデルを起動できる経路が残る
    assertPendingInterrupts(await buyerAgent.getPendingInterrupts(conversationId), responses);
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

  // ウォレット残高と、この利用者の支払いの枠（決定42・43）。ウォレットは全員で共有なので
  // 残高は同じ値が見えるが、枠（セッション・上限）は利用者ごと
  async getWalletStatus() {
    const user = await auth.requireAuth(context);
    return await walletStatus(walletStores, user.userSub);
  },

  // 自分の支出上限を変える（決定43）。天井は設けず、現在のセッションを破棄して即時に効かせる。
  // 利用者は管理者が作る（決定36）ため、自分の枠を自分で上げられることは受け入れている。
  // 累積の上限は引き続きウォレット残高（決定35・39）
  async setSpendLimit(maxSpendUsd: string) {
    const user = await auth.requireAuth(context);
    return await changeSpendLimit(walletStores, user.userSub, maxSpendUsd);
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
