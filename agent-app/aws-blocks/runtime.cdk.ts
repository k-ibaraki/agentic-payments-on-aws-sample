/**
 * 共有 Lambda への実行時設定と IAM の配線（決定34）。
 *
 * Blocks の Lambda は BlocksBackend / BlocksStack が作る 1 本きりで、Block の側には
 * 「任意の環境変数を足す」「任意の IAM を足す」ための API が無い。`Scope` は条件付き
 * exports で二重に解決され、実行時側（`@aws-blocks/core` の `common/index.js`）の `Scope` は
 * `handler` も `executionRole` も持たないため、この配線は index.ts には書けず CDK 層
 * （`*.cdk.ts`）にしか置けない。`handler.addEnvironment` は `@aws-blocks/core` の README が
 * CORS の例で示している公式の手順。
 *
 * Amplify 経路（amplify/blocks.ts）と cdk deploy 経路（index.cdk.ts）の両方から呼ぶ。以前は
 * amplify/ にだけ置いていたため、cdk deploy 経路（決定33 の退路）では決済のできない
 * Lambda が出来上がっていた。
 */
import { Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { runtimeEnvironment } from './runtime-env.js';

/**
 * 実決済の実行時設定と IAM を共有 Lambda に載せる。
 *
 * @param handler  BlocksBackend / BlocksStack が作った共有 Lambda（NodejsFunction は Function の派生。
 *                 テストで束ねる関数を差し替えられるよう、広い方の型で受ける）
 * @param env      合成時のプロセス環境変数（Amplify はコンソールのビルド環境変数、cdk deploy 経路はシェルと
 *                 .env.production）
 * @param options.requireAll  必須値の欠落を合成で落とすか。決済のできる Lambda を作ろうとしている
 *                 場面（deploy）でだけ true にする。判定の理由は呼び出し側のコメントを参照
 */
export function wireRuntime(
  handler: LambdaFunction,
  env: Record<string, string | undefined>,
  options: { requireAll: boolean },
): void {
  // 実決済の実行時設定（決定34）。Amplify コンソールの環境変数はビルドにしか届かないので、
  // 合成時の process.env から許可リストで拾って共有 Lambda に写す。BUYER_TOOL_TIMEOUT_MS の超過
  // （決定31 の注記）などの書式の検証は requireAll に関わらず常に効く
  const applied = runtimeEnvironment(env, options);
  for (const [key, value] of Object.entries(applied)) {
    handler.addEnvironment(key, value);
  }

  // 何を載せたのかを合成の記録に残す（決定34 の改訂）。取得元が対話シェルにもなったため、
  // 検証用に export したままの値が黙って焼き込まれるのを気づけるようにする。値は出さない
  // （秘密ではないが、ログを読む人が確かめたいのは「どのキーが載ったか」なので）。
  // stderr に出すのは、CDK CLI がアプリの stdout をそのまま流すため——stdout だと
  // `cdk synth > template.yaml` の中身にこの行が混ざる
  const keys = Object.keys(applied);
  console.error(
    keys.length > 0
      ? `[wireRuntime] 共有 Lambda に載せた実行時設定: ${keys.join(', ')}`
      : '[wireRuntime] 共有 Lambda に載せた実行時設定: なし',
  );

  handler.addToRolePolicy(paymentsPolicy(Stack.of(handler).account));
}

/**
 * AgentCore Payments（ap-southeast-1。決定12）の権限。Agent ブロックが付けるのは Bedrock の
 * モデル呼び出しだけなので、セッション作成と支払い（決定35）の権限をここで足す。リソースは AWS の
 * リファレンスポリシーに合わせて payment-manager 配下に絞る（リージョンは決定12 のクロスリージョン
 * 呼び出しのため * のまま）。
 *
 * 注意（決定37）: AWS の AgentCore Payments IAM ガイドは CreatePaymentSession と ProcessPayment を
 * 同一ロールに置かないよう求めている（新しいセッションを切って上限を迂回できるため）。本アプリは
 * 共有 Lambda 1 つがセッション作成と支払いの両方を実行するため、ロールを分けても同じ identity が
 * 双方を握ることに変わりはなく、ロール分離では要件を満たせない。上限の担保はアプリ側で行う
 * （x402-payer.ts が上限超過での作り直しを拒む）。構造での分離は U8 として残す
 */
export function paymentsPolicy(account: string): PolicyStatement {
  return new PolicyStatement({
    actions: [
      'bedrock-agentcore:CreatePaymentSession',
      'bedrock-agentcore:GetPaymentSession',
      'bedrock-agentcore:ProcessPayment',
      // 残高の表示（決定42）と、上限変更に伴うセッションの破棄（決定43）
      'bedrock-agentcore:GetPaymentInstrumentBalance',
      'bedrock-agentcore:DeletePaymentSession',
    ],
    resources: [`arn:aws:bedrock-agentcore:*:${account}:payment-manager/*`],
  });
}
