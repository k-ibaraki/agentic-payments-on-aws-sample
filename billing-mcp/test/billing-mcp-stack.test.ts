import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  createBillingMcpStack,
  LAMBDA_TIMEOUT,
} from "../stacks/billing-mcp-stack";
import type { AppParameter } from "../parameter.sample";

const parameter: AppParameter = {
  env: { account: "123456789012", region: "ap-northeast-1" },
  envName: "test",
  payToAddress: "0x2222222222222222222222222222222222222222",
  facilitatorUrl: "https://x402.org/facilitator",
  reservedConcurrency: 5,
  allowedModelIds: ["jp.anthropic.claude-sonnet-4-6"],
};

function synth(overrides: Partial<AppParameter> = {}): Template {
  const app = new App();
  const stack = createBillingMcpStack(app, "BillingMcpStackTest", {
    ...parameter,
    ...overrides,
    env: parameter.env,
  });
  return Template.fromStack(stack);
}

describe("billing-mcp スタック", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  test("Lambda 関数は arm64・Node.js 22 で、Bedrock のタイムアウトを包含する", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      Runtime: Match.stringLikeRegexp("^nodejs22"),
    });
    // server 側の BEDROCK_TIMEOUT_MS（570秒）より長くないと、Bedrock 由来の
    // 具体的なエラーが届く前に Lambda が切れる
    expect(LAMBDA_TIMEOUT.toSeconds()).toBeGreaterThan(570);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: LAMBDA_TIMEOUT.toSeconds(),
    });
  });

  test("Function URL は無認証で公開される（決定19）", () => {
    template.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "NONE",
    });
  });

  test("環境変数に売り手の設定と UI の場所が入る", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          PAY_TO_ADDRESS: parameter.payToAddress,
          FACILITATOR_URL: parameter.facilitatorUrl,
          UI_HTML_PATH: Match.stringLikeRegexp("preview-view\\.html$"),
        }),
      },
    });
  });

  test("無認証のため同時実行数に上限を掛ける（決定19）", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: parameter.reservedConcurrency,
    });
  });

  test("Bedrock の権限は推論プロファイルと跨ぐ全リージョンの基盤モデルを含む", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["bedrock:InvokeModel"]),
            Resource: Match.arrayWith([
              "arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/jp.anthropic.claude-sonnet-4-6",
              "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6",
              "arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-sonnet-4-6",
            ]),
          }),
        ]),
      }),
    });
  });

  test("CloudWatch Logs のロググループを明示的に作る（初回デプロイから追える）", () => {
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });

  test("payToAddress がゼロアドレスのままなら合成で落とす（売上が焼却されるため）", () => {
    const app = new App();
    expect(() =>
      createBillingMcpStack(app, "BillingMcpStackZero", {
        ...parameter,
        payToAddress: "0x0000000000000000000000000000000000000000",
      }),
    ).toThrow(/ゼロアドレス/);
  });

  test("Function URL とロググループ名を出力する", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(["McpEndpointUrl", "LogGroupName"]),
    );
  });

  // 買い手（agent-app）が突き合わせる値。deploy 後に describe-stacks だけで揃うようにする
  test("買い手に引き継ぐ受取先を出力する", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toContain("PayToAddress");
    expect(outputs.PayToAddress?.Value).toBe(parameter.payToAddress);
  });

  // 価格は段階制の価格表が決める（決定56）。単価を環境変数や出力に載せると、
  // 値付けに効かない値を買い手の上限の目安として案内してしまう
  test("単価を環境変数にも出力にも載せない", () => {
    const functions = template.findResources("AWS::Lambda::Function");
    const variables = Object.values(functions)[0].Properties.Environment
      .Variables as Record<string, unknown>;
    expect(variables.PRICE).toBeUndefined();
    expect(Object.keys(template.findOutputs("*"))).not.toContain("Price");
  });
});

describe("段階制の値付けに要る資源（決定55・56）", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  it("価格表を置く AppConfig の器を作る", () => {
    template.resourceCountIs("AWS::AppConfig::Application", 1);
    template.resourceCountIs("AWS::AppConfig::Environment", 1);
    template.resourceCountIs("AWS::AppConfig::ConfigurationProfile", 1);
    template.resourceCountIs("AWS::AppConfig::DeploymentStrategy", 1);
  });

  // 中身を CDK が配ると、deploy のたびに人が入れた価格表を巻き戻す（決定64）
  it("価格表の中身（版と配信）は CDK では持たない", () => {
    template.resourceCountIs("AWS::AppConfig::HostedConfigurationVersion", 0);
    template.resourceCountIs("AWS::AppConfig::Deployment", 0);
  });

  // 価格表を配る手順（pnpm set:tier-table）が配り先を引けること
  it("価格表の配り先を出力に出す", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining([
        "PricingApplicationId",
        "PricingEnvironmentId",
        "PricingProfileId",
        "PricingDeploymentStrategyId",
      ]),
    );
  });

  it("拡張レイヤーを渡さなければ AppConfig は参照しない", () => {
    const functions = template.findResources("AWS::Lambda::Function");
    const variables = Object.values(functions)[0].Properties.Environment
      .Variables as Record<string, unknown>;
    expect(variables.APPCONFIG_APPLICATION).toBeUndefined();
  });

  it("拡張レイヤーを渡せば AppConfig を参照し、読み取りを許す", () => {
    const layerArn =
      "arn:aws:lambda:ap-northeast-1:111111111111:layer:AWS-AppConfig-Extension-Arm64:1";
    const withLayer = synth({ appConfigExtensionLayerArn: layerArn });
    withLayer.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          APPCONFIG_APPLICATION: Match.anyValue(),
        }),
      },
      Layers: Match.arrayWith([layerArn]),
    });
    withLayer.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["appconfig:GetLatestConfiguration"]),
          }),
        ]),
      }),
    });
  });

  // 無認証で公開する関数なので、読める設定をこのスタックの価格表だけに絞る
  it("AppConfig の読み取りは、このスタックの価格表に限る", () => {
    const withLayer = synth({
      appConfigExtensionLayerArn:
        "arn:aws:lambda:ap-northeast-1:111111111111:layer:AWS-AppConfig-Extension-Arm64:1",
    });
    const statements = Object.values(
      withLayer.findResources("AWS::IAM::Policy"),
    ).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as {
          Action: string | string[];
          Resource: unknown;
        }[],
    );
    const appConfig = statements.find((statement) =>
      [statement.Action]
        .flat()
        .includes("appconfig:GetLatestConfiguration"),
    );
    expect(appConfig).toBeDefined();
    expect(appConfig?.Resource).not.toBe("*");
    const resource = JSON.stringify(appConfig?.Resource);
    expect(resource).toMatch(
      /application\/.*\/environment\/.*\/configuration\//,
    );
    const profileId = Object.keys(
      withLayer.findResources("AWS::AppConfig::ConfigurationProfile"),
    )[0];
    expect(resource).toContain(profileId);
  });
});

describe("Jev の API キー（決定58）", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  // 値は人が後から入れる。CDK に書くと CloudFormation テンプレートに平文で残る。
  // ランダム生成に任せると、出鱈目な鍵で 401 になり全件が中央の価格帯へ落ちる
  it("鍵ではなく仮の値を入れて作る", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    const props = Object.values(secrets)[0].Properties as Record<string, unknown>;
    expect(props.SecretString).toBe("REPLACE_ME");
    expect(props.GenerateSecretString).toBeUndefined();
  });

  it("Secret の場所を Lambda に環境変数で渡す", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          TYPESAFE_API_KEY_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it("その Secret だけを読める権限を与える", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["secretsmanager:GetSecretValue"]),
            Resource: Match.anyValue(),
          }),
        ]),
      }),
    });
  });

  // 鍵を入れる手順（pnpm set:jev-key）が ARN を引けること
  it("Secret の ARN を出力に出す", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toContain("TypesafeApiKeySecretArn");
  });
});
