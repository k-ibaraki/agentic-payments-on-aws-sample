// 実行時設定と IAM の配線のテスト（決定34・72）。
// Amplify 経路（amplify/blocks.ts）と cdk deploy 経路（index.cdk.ts）が同じ配線を共有していることの
// 土台になるので、設定の登録とポリシーの両方を見る
import { App, NestedStack, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { describe, expect, it } from 'vitest';
import { paymentsPolicy, wireRuntime } from './runtime.cdk.js';

const FULL_ENV = {
  PAYMENT_MANAGER_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:payment-manager/x',
  PAYMENT_INSTRUMENT_ID: 'pi-1',
  BILLING_MCP_URL: 'https://seller.example/mcp',
};

/**
 * BlocksStack / BlocksBackend の代わり。wireRuntime が使うのは構成要素としての位置（registerConfig が
 * 持ち主を探す起点）と共有ロールだけなので、その 2 つを持つ素の Construct で足りる。
 * BlocksBackend を作ると esbuild のバンドルまで走るので使わない
 */
function fakeBackend(stack: Stack) {
  const backend = new Construct(stack, 'Backend') as Construct & { executionRole: Role };
  backend.executionRole = new Role(stack, 'BlocksRole', {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  });
  return backend;
}

/**
 * registerConfig が溜めた設定を読む。持ち主が見つからなければスタックに溜まる（core の getBlocksRoot）。
 * 置き場所は core の内部（Symbol.for のキー）で公開 API ではないが、合成すると S3 へ上げる JSON の
 * 中身はテンプレートから見えないため、ここを読む。core の版上げでこのテストが落ちたら置き場所を確かめる
 */
function registeredConfig(stack: Stack): Record<string, unknown> {
  const registry = (stack as unknown as Record<symbol, { entries: Map<string, unknown> } | undefined>)[
    Symbol.for('BLOCKS_CONFIG_REGISTRY')
  ];
  return Object.fromEntries(registry?.entries ?? []);
}

function synth(env: Record<string, string | undefined>, options: { requireAll: boolean }) {
  const stack = new Stack(new App(), 'test');
  wireRuntime(fakeBackend(stack), env, options);
  return { stack, template: Template.fromStack(stack) };
}

describe('wireRuntime', () => {
  // 0.8.0 ではエージェントのループが AgentCore Runtime で動き、Lambda の環境変数は届かない。
  // 設定に登録すれば、Lambda も Runtime も起動時に process.env へ読み込む
  it('許可リストの環境変数を設定に登録する', () => {
    const { stack } = synth({ ...FULL_ENV, UNRELATED: 'x' }, { requireAll: true });

    expect(registeredConfig(stack)).toEqual(FULL_ENV);
  });

  // Runtime も同じ共有ロールで動くので、ここに付ければ支払いを行うループまで届く
  it('AgentCore Payments の権限を共有ロールに付ける', () => {
    const { template } = synth(FULL_ENV, { requireAll: true });

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

  // Amplify 経路の Blocks は backend.createStack('blocks') のネストスタックの中にある（決定33）。
  // ネストスタックは Ref が親から渡すパラメータになりうるので、アカウント ID がそこでも
  // AWS::AccountId のまま解決されることを見る（以前は Stack.of(ネストスタック) を明示的に渡していた）
  it('ネストスタックの中でもアカウント ID が解決できる', () => {
    const parent = new Stack(new App(), 'parent');
    const nested = new NestedStack(parent, 'blocks');
    wireRuntime(fakeBackend(nested), FULL_ENV, { requireAll: true });

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
