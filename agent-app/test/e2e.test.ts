// buyer API を認証込みで通す e2e（決定28。③の「検証が変更面を迂回している」失敗形への手当て）。
// ローカルの開発サーバー（mock 認証・偽 LLM）に対して、会話の作成 → 送信 → 履歴 →
// 購入一覧 → 売り手情報 と、他人の会話・未認証の拒否を実際の API 経路で確かめる。
// サーバーを自分で起動する場合は LLM を BUYER_LOCAL_MODEL=canned に固定する。起動済みのサーバーを
// 再利用する場合はその設定（既定は Bedrock）に従う。実費が出ないよう、エージェントに届く依頼には
// ツール名を含めない（他人の会話への発注は所有検証で弾かれるため、そちらには含めてよい）
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as apiType, authApi as authApiType, buyer as buyerType } from 'aws-blocks';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof apiType;
let authApi: typeof authApiType;
let buyer: typeof buyerType;

const PASSWORD = 'Passw0rd-e2e';

test.before(async () => {
  if (!await isServerRunning()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '', BUYER_LOCAL_MODEL: 'canned' },
    });
    server.unref();
  }

  // ブラウザ向けの API プロキシ（aws-blocks/client.js）は開発サーバーが生成する。
  // 生成前に import すると ERR_MODULE_NOT_FOUND になるため、出来るまで待つ
  for (let i = 0; i < 60 && !existsSync('aws-blocks/client.js'); i++) {
    await setTimeout(1000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;
  buyer = mod.buyer;

  for (let i = 0; i < 60; i++) {
    try { await api.getLastCode(); return; } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Server not ready');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// メール OTP でサインアップしてサインイン済みにする（コードは mock の getLastCode から取る）
async function signUpAndSignIn(email: string): Promise<void> {
  let state = await authApi.setAuthState({ action: 'signUp', username: email, password: PASSWORD });
  assert.strictEqual(state.state, 'confirmingSignUp', JSON.stringify(state));
  const code = (await api.getLastCode())?.code;
  assert.ok(code, 'サインアップの確認コードが取れない');
  state = await authApi.setAuthState({ action: 'confirmSignUp', username: email, code, password: PASSWORD });
  if (state.state !== 'signedIn') {
    state = await authApi.setAuthState({ action: 'autoSignIn', username: email });
  }
  assert.strictEqual(state.state, 'signedIn', JSON.stringify(state));
}

async function signOut(): Promise<void> {
  const state = await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual(state.state, 'signedOut');
}

async function waitForAssistantReply(conversationId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const { messages } = await buyer.getMessages(conversationId);
    const reply = messages.find((m) => m.role === 'assistant' && m.content);
    if (reply) return reply.content;
    await setTimeout(500);
  }
  throw new Error('エージェントの返答が届かない');
}

const userA = `e2e-a-${Date.now()}@example.com`;
const userB = `e2e-b-${Date.now()}@example.com`;
let conversationA = '';

test('未認証では会話を作れない', async () => {
  await assert.rejects(buyer.createConversation());
  await assert.rejects(buyer.getWalletStatus());
  await assert.rejects(buyer.setSpendLimit('1.00'));
  await assert.rejects(buyer.listPurchaseHistory());
});

test('サインインした利用者は会話を作り、依頼を送り、履歴・購入一覧・売り手情報を取れる', async () => {
  await signUpAndSignIn(userA);
  const me = await api.whoAmI();
  assert.strictEqual(me.username, userA);

  ({ conversationId: conversationA } = await buyer.createConversation());
  assert.ok(conversationA);

  const sent = await buyer.sendMessage(conversationA, 'こんにちは');
  assert.deepStrictEqual(sent, { accepted: true, channelId: conversationA });
  const reply = await waitForAssistantReply(conversationA);
  assert.ok(reply.length > 0);

  const { purchases } = await buyer.listPurchases(conversationA);
  assert.deepStrictEqual(purchases, []);

  // 購入履歴は会話をまたいだ一覧（決定50）。購入が無ければ会話も並ばない
  assert.deepStrictEqual((await buyer.listPurchaseHistory()).conversations, []);

  const seller = await buyer.getSellerInfo();
  assert.match(seller.mcpUrl, /\/mcp$/);
  assert.strictEqual(seller.resourceUri, 'ui://billing-mcp/preview-view.html');

  // 会話の Realtime チャンネルは所有者なら取れる
  const channel = await buyer.getChannel(conversationA);
  assert.ok(channel);
  // 途中経過（決定65）のチャンネルも所有者なら取れる
  assert.ok(await buyer.getProgressChannel(conversationA));

  // 存在しない購入物は null
  assert.strictEqual(await buyer.getPurchasedHtml('no-such-result'), null);
});

// ウォレットの状態と、利用者ごとの支出上限（決定42・43）。ローカルの開発サーバーは PAYMENT_* を
// 持たないので残高とセッションは理由つきで null になり、上限の保存と検証だけを本物の経路で確かめる
test('ウォレットの状態を取れ、自分の支出上限を変えられる', async () => {
  const before = await buyer.getWalletStatus();
  assert.deepStrictEqual(before.spendLimit, { maxSpendUsd: '1.00', source: 'default' });
  assert.strictEqual(before.balance, null);
  assert.match(before.balanceError ?? '', /PAYMENT_/);
  assert.strictEqual(before.session, null);
  assert.strictEqual(before.sessionMinutes, 60);

  const changed = await buyer.setSpendLimit('2.5');
  assert.deepStrictEqual(changed, {
    spendLimit: { maxSpendUsd: '2.50', source: 'user' },
    discardedSession: null,
  });
  const after = await buyer.getWalletStatus();
  assert.deepStrictEqual(after.spendLimit, { maxSpendUsd: '2.50', source: 'user' });

  // 書式外と 0 は拒み、保存した値は変わらない
  await assert.rejects(buyer.setSpendLimit('abc'));
  await assert.rejects(buyer.setSpendLimit('0'));
  assert.strictEqual((await buyer.getWalletStatus()).spendLimit.maxSpendUsd, '2.50');
});

test('他人の会話には発注・閲覧・購読・購入一覧・承認のいずれもできない', async () => {
  await signOut();
  await signUpAndSignIn(userB);

  // 支出上限は利用者ごと。A が変えた値は B には見えない（決定43）
  assert.deepStrictEqual((await buyer.getWalletStatus()).spendLimit, { maxSpendUsd: '1.00', source: 'default' });

  await assert.rejects(buyer.sendMessage(conversationA, 'generateHtml で何か作って'));
  await assert.rejects(buyer.getMessages(conversationA));
  await assert.rejects(buyer.getChannel(conversationA));
  // 途中経過（決定65）のチャンネルも同じ所有検証を通す
  await assert.rejects(buyer.getProgressChannel(conversationA));
  await assert.rejects(buyer.listPurchases(conversationA));
  // 再購入の承認（決定31）は実費に直結するため、読み取り系と同じく所有者に限る
  await assert.rejects(
    buyer.resume(conversationA, [{ interruptId: 'no-such-interrupt', approved: true }]),
  );
  await assert.rejects(buyer.getPendingInterrupts(conversationA));

  // 購入履歴は自分の会話だけを見る（A の会話は B の履歴に出ない）
  assert.deepStrictEqual((await buyer.listPurchaseHistory()).conversations, []);

  // 自分の会話は問題なく作れる
  const { conversationId } = await buyer.createConversation();
  assert.notStrictEqual(conversationId, conversationA);
  await signOut();
});
