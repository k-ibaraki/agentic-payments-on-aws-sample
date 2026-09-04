// クラウド（Amplify の sandbox / ブランチ）に deploy した buyer API を、認証込みで UI なしに通す縦串検証。
// ローカルでエージェントを動かす buy-via-agent.ts と違い、支払いも生成もクラウドの Lambda で行われる
// （決定34〜36 の配線の実測用）。
//
// 前提:
//   - 利用者が Cognito のユーザープールに作成済み（selfSignUp は閉じている。決定36）:
//       aws cognito-idp admin-create-user --user-pool-id <id> --username <メール> \
//         --user-attributes Name=email,Value=<メール> Name=email_verified,Value=true --message-action SUPPRESS
//   - BLOCKS_API_URL … amplify_outputs.json の custom.blocks_api_url
//   - BUYER_EMAIL    … サインインするメール。OTP はそのメールに届くので、プロンプトに転記する
//   - BUYER_COOKIE_FILE … 任意。セッション Cookie の保存先（2 回目以降は OTP なしで続けられる。終わったら消す）
//   - BUYER_OTP_FILE … 任意。指定すると OTP をプロンプトではなくこのファイルから読む（無ければ現れるまで待つ。
//                      端末を対話で使えない自動実行のため）
//   - aws-blocks/client.js を生成済み（npm run blocks:client）
//
// 実行: BLOCKS_API_URL=... BUYER_EMAIL=... npx tsx -C browser scripts/buy-via-cloud.ts "作りたいページの指示"
//
// 注意: 1回の実行で実オンチェーン決済（テスト USDC）が発生する。
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { stdin, stdout } from 'node:process';

const prompt = process.argv[2] ?? '「クラウドのエージェントが x402 で購入したページ」と大きく表示するシンプルな HTML ページ';
const email = requireEnv('BUYER_EMAIL');
requireEnv('BLOCKS_API_URL');
const pollMs = 3000;
const timeoutMs = Number(process.env.BUYER_TOOL_TIMEOUT_MS ?? '600000') + 60_000;

// Node の fetch は Cookie を保持しないため、AuthCognito のセッション Cookie を最小の cookie jar で持ち回る。
// BUYER_COOKIE_FILE を指定すると保存して次回の実行で使い回す（OTP を毎回求めないため。ブラウザの Cookie と同じ扱いで秘密）
const cookieFile = process.env.BUYER_COOKIE_FILE;
const jar = new Map<string, string>();
if (cookieFile && existsSync(cookieFile)) {
  for (const [name, value] of Object.entries(JSON.parse(readFileSync(cookieFile, 'utf-8')) as Record<string, string>)) {
    jar.set(name, value);
  }
}
const baseFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (jar.size > 0) {
    headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  const response = await baseFetch(input, { ...init, headers });
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === '';
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
  if (cookieFile) writeFileSync(cookieFile, JSON.stringify(Object.fromEntries(jar)), { mode: 0o600 });
  return response;
};

// client.js は Blocks の生成物。存在しなければ npm run blocks:client
const { authApi, buyer } = await import('aws-blocks');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

const rl = createInterface({ input: stdin, output: stdout });

async function readCode(): Promise<string> {
  const file = process.env.BUYER_OTP_FILE;
  if (!file) return (await rl.question(`${email} に届いた確認コードを入力: `)).trim();
  console.log(`${email} に届いた確認コードを ${file} に書いてください（最大 10 分待ちます）`);
  for (let i = 0; i < 300; i++) {
    if (existsSync(file)) {
      const code = readFileSync(file, 'utf-8').trim();
      unlinkSync(file);
      if (code) return code;
    }
    await sleep(2000);
  }
  throw new Error('確認コードが時間内に書かれませんでした');
}

// 認証の状態機械（AuthState）を手で進める。Authenticator UI がやることと同じ:
// アクションの hidden フィールドは defaultValue を返し、code はプロンプトで受け取る
async function signIn(): Promise<void> {
  let state = await authApi.getAuthState();
  if (state.state === 'signedIn') {
    console.log(`サインイン済み: ${state.user?.username}`);
    return;
  }
  // USER_AUTH + EMAIL_OTP ではパスワードを使わないが、型は signIn に password を要求する
  state = await authApi.setAuthState({
    action: 'signIn',
    username: email,
    password: process.env.BUYER_PASSWORD ?? '',
  } as never);
  for (let step = 0; step < 5 && state.state !== 'signedIn'; step++) {
    console.log(`[auth] state=${state.state}${state.error ? ` error=${state.error}` : ''}`);
    const action =
      state.actions.find((a) => a.fields.some((f) => f.name === 'code')) ?? state.actions[0];
    if (!action) throw new Error(`進められる認証アクションがありません: ${JSON.stringify(state)}`);
    const input: Record<string, string> = { action: action.name };
    for (const field of action.fields) {
      if (field.type === 'hidden' && field.defaultValue !== undefined) {
        input[field.name] = field.defaultValue;
      } else if (field.name === 'username') {
        input.username = email;
      } else if (field.name === 'code') {
        input.code = await readCode();
      } else if (field.required) {
        input[field.name] = (await rl.question(`${field.label} (${field.name}): `)).trim();
      }
    }
    state = await authApi.setAuthState(input as never);
  }
  if (state.state !== 'signedIn') {
    throw new Error(`サインインできませんでした: ${JSON.stringify(state)}`);
  }
  console.log(`サインイン: ${state.user?.username}`);
}

await signIn();
rl.close();

// 既存の会話を覗くだけのモード（購入はしない）
if (process.env.BUYER_INSPECT_CONVERSATION) {
  const id = process.env.BUYER_INSPECT_CONVERSATION;
  console.log(JSON.stringify(await buyer.getPendingInterrupts(id), null, 2));
  console.log(JSON.stringify(await buyer.listPurchases(id), null, 2));
  console.log(JSON.stringify(await buyer.getMessages(id), null, 2));
  process.exit(0);
}

const { conversationId } = await buyer.createConversation();
console.log(`会話を開始: ${conversationId}`);
console.log(`依頼: ${prompt}`);
const started = Date.now();
await buyer.sendMessage(conversationId, `generateHtml ツールを使ってください: ${prompt}`);

// 完了の判定: 購入が記録され、その後にアシスタントの返答が付いたら終わり。
// 途中で承認待ち（決定31 の防護）が出たら内容を表示して止める（このスクリプトは自動承認しない）
let lastLog = '';
while (Date.now() - started < timeoutMs) {
  await sleep(pollMs);
  const { interrupts } = await buyer.getPendingInterrupts(conversationId);
  if (interrupts.length > 0) {
    console.log('承認待ちが発生しました（自動では承認しません）:');
    console.log(JSON.stringify(interrupts, null, 2));
    process.exit(2);
  }
  const { purchases } = await buyer.listPurchases(conversationId);
  const { messages } = await buyer.getMessages(conversationId);
  const assistant = messages.filter((m) => m.role === 'assistant' && m.content);
  const log = `購入 ${purchases.length} 件 / 返答 ${assistant.length} 件（${Math.round((Date.now() - started) / 1000)} 秒）`;
  if (log !== lastLog) {
    console.log(log);
    lastLog = log;
  }
  if (purchases.length > 0 && assistant.length > 0) {
    console.log('--- 購入 ---');
    console.log(JSON.stringify(purchases, null, 2));
    console.log('--- 返答 ---');
    console.log(assistant.at(-1)?.content);
    const resultId = (purchases.at(-1) as { resultId?: string } | undefined)?.resultId;
    if (resultId) {
      const html = await buyer.getPurchasedHtml(resultId);
      console.log(
        `--- 購入物 ${resultId}: html ${html?.html?.length ?? 0} バイト, tx ${html?.transaction ?? '(なし)'}` +
          `${html?.error ? `, error ${html.error}` : ''}`,
      );
    }
    process.exit(0);
  }
}
console.error('時間内に完了しませんでした');
process.exit(1);
