// 共有 Lambda への実行時設定と IAM の配線のテスト（決定34）。
// Amplify 経路（amplify/blocks.ts）と CDK 直経路（index.cdk.ts）が同じ配線を共有していることの
// 土台になるので、合成後のテンプレートで環境変数とポリシーの両方を見る
import { App, NestedStack, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { paymentsPolicy, wireRuntime } from './runtime.cdk.js';

const FULL_ENV = {
  PAYMENT_MANAGER_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/x',
  PAYMENT_INSTRUMENT_ID: 'pi-1',
  BILLING_MCP_URL: 'https://seller.example/mcp',
};

/** 共有 Lambda の代わり。bundling を走らせたくないので素の Function を使う */
function synth(env: Record<string, string | undefined>, options: { requireAll: boolean }) {
  const stack = new Stack(new App(), 'test');
  const handler = new LambdaFunction(stack, 'Handler', {
    runtime: Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = () => {};'),
  });
  wireRuntime(handler, env, options);
  return Template.fromStack(stack);
}

describe('wireRuntime', () => {
  it('許可リストの環境変数を共有 Lambda に写す', () => {
    const template = synth({ ...FULL_ENV, UNRELATED: 'x' }, { requireAll: true });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: FULL_ENV },
    });
    expect(JSON.stringify(template.toJSON())).not.toContain('UNRELATED');
  });

  it('AgentCore Payments の権限を関数のロールに付ける', () => {
    const template = synth(FULL_ENV, { requireAll: true });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: [
              'bedrock-agentcore:CreatePaymentSession',
              'bedrock-agentcore:GetPaymentSession',
              'bedrock-agentcore:ProcessPayment',
              'bedrock-agentcore:GetPaymentInstrumentBalance',
              'bedrock-agentcore:DeletePaymentSession',
            ],
            Effect: 'Allow',
          },
        ],
      },
    });
  });

  // 必須値が欠けた deploy は決済のできない Lambda を作ってしまうので、合成の時点で落とす。
  // 判定そのものは runtime-env.test.ts が網羅する
  it('必須にすると環境変数の欠落で合成が落ちる', () => {
    expect(() => synth({}, { requireAll: true })).toThrow(/PAYMENT_MANAGER_ARN/);
  });

  it('必須にしなければ環境変数が欠けていても通る', () => {
    expect(() => synth({}, { requireAll: false })).not.toThrow();
  });

  // Amplify 経路の共有 Lambda は backend.createStack('blocks') のネストスタックの中にある（決定33）。
  // ネストスタックは Ref が親から渡すパラメータになりうるので、アカウント ID がそこでも
  // AWS::AccountId のまま解決されることを見る（以前は Stack.of(ネストスタック) を明示的に渡していた）
  it('ネストスタックの中でもアカウント ID が解決できる', () => {
    const parent = new Stack(new App(), 'parent');
    const nested = new NestedStack(parent, 'blocks');
    const handler = new LambdaFunction(nested, 'Handler', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = () => {};'),
    });
    wireRuntime(handler, FULL_ENV, { requireAll: true });

    const statements = Template.fromStack(nested).toJSON().Resources as Record<
      string,
      { Type: string; Properties: { PolicyDocument?: { Statement: Array<{ Resource?: unknown }> } } }
    >;
    const resources = Object.values(statements)
      .filter((r) => r.Type === 'AWS::IAM::Policy')
      .flatMap((r) => r.Properties.PolicyDocument?.Statement ?? [])
      .filter((s) => JSON.stringify(s).includes('CreatePaymentSession'))
      .map((s) => s.Resource);

    expect(resources).toEqual([
      { 'Fn::Join': ['', ['arn:aws:bedrock-agentcore:*:', { Ref: 'AWS::AccountId' }, ':payment-manager/*']] },
    ]);
  });
});

describe('paymentsPolicy', () => {
  // リソースは AWS のリファレンスポリシーに合わせて payment-manager 配下に絞る（決定34・37）。
  // リージョンはクロスリージョン呼び出し（決定12）のため * のまま
  it('payment-manager 配下だけを許す', () => {
    expect(paymentsPolicy('111122223333').toStatementJson().Resource).toBe(
      'arn:aws:bedrock-agentcore:*:111122223333:payment-manager/*',
    );
  });
});
