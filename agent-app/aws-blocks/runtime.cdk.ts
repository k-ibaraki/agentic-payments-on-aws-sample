/**
 * 実行時設定と IAM の配線（決定34・72）。
 *
 * Block の側には「任意の設定を足す」「任意の IAM を足す」ための API が無い。`Scope` は条件付き
 * exports で二重に解決され、実行時側（`@aws-blocks/core` の `common/index.js`）の `Scope` は
 * `executionRole` を持たないため、この配線は index.ts には書けず CDK 層（`*.cdk.ts`）にしか置けない。
 *
 * 設定は `registerConfig` で登録する（core の `config-registry` が `handler.addEnvironment` の後継として
 * 示す公式の手順。公式テンプレートの Amplify 用 amplify-blocks.ts も同じ）。登録した値は S3 の JSON に
 * 入り、共有 Lambda も AgentCore Runtime（エージェントのループ。0.8.0 から）も起動時に `process.env` へ
 * 読み込む。Lambda の環境変数に載せても Runtime には届かない（決定70 で版上げを止めた理由）。
 * IAM は共有ロールに付ける。Runtime も同じロールで動くので、支払いを行うループまで届く。
 *
 * Amplify 経路（amplify/blocks.ts）と cdk deploy 経路（index.cdk.ts）の両方から呼ぶ
 * （呼び忘れると決済のできない Lambda になっていた経緯は wiring.test.ts 参照）。
 */
import { registerConfig } from '@aws-blocks/blocks/cdk';
import { Stack } from 'aws-cdk-lib';
import { type IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { runtimeEnvironment } from './runtime-env.js';

/**
 * 実決済の実行時設定と IAM を Blocks のバックエンドに載せる。
 *
 * @param backend  BlocksBackend / BlocksStack。使うのは構成要素としての位置（registerConfig が
 *                 持ち主を探す起点）と共有ロール（executionRole）だけなので、その形で受ける
 * @param env      合成時のプロセス環境変数（Amplify はコンソールのビルド環境変数、cdk deploy 経路はシェルと
 *                 .env.production）
 * @param options.requireAll  必須値の欠落を合成で落とすか。決済のできる構成を作ろうとしている
 *                 場面（deploy）でだけ true にする。判定の理由は呼び出し側のコメントを参照
 */
export function wireRuntime(
  backend: Construct & { executionRole: IRole },
  env: Record<string, string | undefined>,
  options: { requireAll: boolean },
): void {
  // 実決済の実行時設定（決定34）。Amplify コンソールの環境変数はビルドにしか届かないので、
  // 合成時の process.env から許可リストで拾って設定に登録する。BUYER_TOOL_TIMEOUT_MS の超過
  // （決定31 の注記）などの書式の検証は requireAll に関わらず常に効く
  const applied = runtimeEnvironment(env, options);
  for (const [key, value] of Object.entries(applied)) {
    registerConfig(backend, key, value);
  }

  // 何を載せたのかを合成の記録に残す（決定34 の改訂）。取得元が対話シェルにもなったため、
  // 検証用に export したままの値が黙って焼き込まれるのを気づけるようにする。値は出さない
  // （秘密ではないが、ログを読む人が確かめたいのは「どのキーが載ったか」なので）。
  // stderr に出すのは、CDK CLI がアプリの stdout をそのまま流すため——stdout だと
  // `cdk synth > template.yaml` の中身にこの行が混ざる
  const keys = Object.keys(applied);
  console.error(
    keys.length > 0
      ? `[wireRuntime] 登録した実行時設定: ${keys.join(', ')}`
      : '[wireRuntime] 登録した実行時設定: なし',
  );

  backend.executionRole.addToPrincipalPolicy(paymentsPolicy(Stack.of(backend).account));
}

/**
 * AgentCore Payments（ap-southeast-1。決定12）の権限。Agent ブロックが付けるのは Bedrock の
 * モデル呼び出しだけなので、セッション作成と支払い（決定35）の権限をここで足す。リソースは AWS の
 * リファレンスポリシーに合わせて payment-manager 配下に絞る（リージョンは決定12 のクロスリージョン
 * 呼び出しのため * のまま）。
 *
 * 注意（決定37）: AWS の AgentCore Payments IAM ガイドは CreatePaymentSession と ProcessPayment を
 * 同一ロールに置かないよう求めている（新しいセッションを切って上限を迂回できるため）。本アプリは
 * 共有ロール 1 つ（共有 Lambda と AgentCore Runtime が使う）がセッション作成と支払いの両方を
 * 実行するため、ロールを分けても同じ identity が双方を握ることに変わりはなく、ロール分離では要件を
 * 満たせない。上限の担保はアプリ側で行う
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
