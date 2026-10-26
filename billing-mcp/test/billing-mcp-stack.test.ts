import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  createBillingMcpStack,
  REQUEST_TIMEOUT_SECONDS,
} from "../stacks/billing-mcp-stack";
import type { AppParameter } from "../parameter.sample";

const parameter: AppParameter = {
  env: { account: "123456789012", region: "ap-northeast-1" },
  envName: "test",
  payToAddress: "0x2222222222222222222222222222222222222222",
  facilitatorUrl: "https://x402.org/facilitator",
  maxEnvironments: 2,
  rateLimit: 100,
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

// 既定のパラメータで合成した Template。合成のたびに esbuild が走るので 1 度だけ作って共有する
const template = synth();

/** 唯一の revision の環境変数 */
function revisionEnv(template: Template): Record<string, unknown> {
  const revisions = template.findResources("AWS::Lambda::WebFunctionRevision");
  expect(Object.keys(revisions)).toHaveLength(1);
  return Object.values(revisions)[0].Properties.ServiceConfig
    .EnvironmentVariables as Record<string, unknown>;
}

/** IAM ポリシー（インライン）の文を平らに集める */
function policyStatements(template: Template) {
  return Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) =>
      policy.Properties.PolicyDocument.Statement as {
        Action: string | string[];
        Resource: unknown;
      }[],
  );
}

describe("billing-mcp スタック（Lambda Web Functions。決定74）", () => {
  test("Web Function・revision・endpoint を 1 つずつ作る", () => {
    template.resourceCountIs("AWS::Lambda::WebFunction", 1);
    template.resourceCountIs("AWS::Lambda::WebFunctionRevision", 1);
    template.resourceCountIs("AWS::Lambda::WebFunctionEndpoint", 1);
    // 旧構成（Function URL の Lambda）は残さない
    template.resourceCountIs("AWS::Lambda::Url", 0);
  });

  test("revision は Node.js 24 で、依頼の時間制限は Bedrock のタイムアウトを包含する", () => {
    // server 側の BEDROCK_TIMEOUT_MS（570秒）より長くないと、Bedrock 由来の
    // 具体的なエラーが届く前に打ち切られる
    expect(REQUEST_TIMEOUT_SECONDS).toBeGreaterThan(570);
    template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
      BuildConfig: Match.objectLike({
        RuntimeConfig: { Runtime: "nodejs24.x" },
      }),
      ServiceConfig: Match.objectLike({
        TimeoutSeconds: REQUEST_TIMEOUT_SECONDS,
      }),
    });
  });

  test("endpoint は無認証で公開される（決定19）", () => {
    template.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
      AuthType: "ApplicationManaged",
      EndpointType: "HomeRegion",
      RevisionWeights: [
        { RevisionId: Match.anyValue(), Weight: 100 },
      ],
    });
  });

  // reserved concurrency の代わり。環境数は同時に動く実行環境（メモリ課金）の、
  // rateLimit は秒あたりの依頼数の上限
  test("無認証のため環境数と秒あたりの依頼数に上限を掛ける（決定19・74）", () => {
    template.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
      ScalingConfig: { MaxEnvironments: parameter.maxEnvironments },
      ThrottleConfig: { RateLimit: parameter.rateLimit },
    });
  });

  test("環境変数に売り手の設定と UI の場所が入る", () => {
    expect(revisionEnv(template)).toEqual(
      expect.objectContaining({
        NODE_OPTIONS: "--enable-source-maps",
        PAY_TO_ADDRESS: parameter.payToAddress,
        FACILITATOR_URL: parameter.facilitatorUrl,
        UI_HTML_PATH: expect.stringMatching(/preview-view\.html$/),
      }),
    );
  });

  test("実行ロールは Lambda が引き受け、Bedrock の権限は推論プロファイルと跨ぐ全リージョンの基盤モデルを含む", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "lambda.amazonaws.com" },
          }),
        ]),
      }),
    });
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

  // Lambda は `.local` のグループへ書いてから名前どおりのグループへ集める。両方を自前で作り、
  // 両方への書き込みを許す（片方だけだと何も届かない。2026-10-25 に実測）
  test("CloudWatch Logs のロググループ（本体と .local）を明示的に作り、revision に渡す", () => {
    template.resourceCountIs("AWS::Logs::LogGroup", 2);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: {
        "Fn::Join": ["", [{ Ref: Match.stringLikeRegexp("^McpFunctionLogs") }, ".local"]],
      },
    });
    template.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
      ServiceConfig: Match.objectLike({
        TelemetryConfig: {
          LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp("^McpFunctionLogs") } },
        },
      }),
    });
    const logs = policyStatements(template).find((statement) =>
      [statement.Action].flat().includes("logs:PutLogEvents"),
    );
    expect(logs).toBeDefined();
    expect([logs?.Action].flat()).toEqual(
      expect.arrayContaining(["logs:CreateLogGroup", "logs:CreateLogStream"]),
    );
    expect(JSON.stringify(logs?.Resource)).toContain("McpFunctionLocalLogs");
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

  test("エンドポイントの URL とロググループ名を出力する", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(["McpEndpointUrl", "LogGroupName"]),
    );
    expect(JSON.stringify(outputs.McpEndpointUrl.Value)).toMatch(
      /DomainName[\s\S]*\/mcp/,
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
    expect(revisionEnv(template).PRICE).toBeUndefined();
    expect(Object.keys(template.findOutputs("*"))).not.toContain("Price");
  });
});

describe("コードの置き場（決定74）", () => {
  // Web Functions は S3 の zip しか読まず、バケットはバージョニングが要る
  test("バージョニング付きの専用バケットを作る", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  // Lambda は revision を作るときにサービスプリンシパルの読み取りを検査し、無ければ拒む
  test("Lambda のサービスプリンシパルに、この関数の revision からの読み取りだけを許す", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Condition: {
              ArnLike: {
                "aws:SourceArn":
                  "arn:aws:lambda:ap-northeast-1:123456789012:web-function/billing-mcp-test/revision/*",
              },
            },
          }),
        ]),
      }),
    });
  });

  test("revision は専用バケットの zip を指し、関数・バケットポリシー・zip の配置の後に作る", () => {
    const revision = Object.values(
      template.findResources("AWS::Lambda::WebFunctionRevision"),
    )[0];
    const s3Object = revision.Properties.BuildConfig.CodeConfig.S3Object;
    const bucketId = Object.keys(template.findResources("AWS::S3::Bucket"))[0];
    expect(JSON.stringify(s3Object.Bucket)).toContain(bucketId);
    // 鍵は配置（BucketDeployment）の結果から引く。中身が変われば鍵が変わり、revision が作り直される
    expect(JSON.stringify(s3Object.Key)).toContain("SourceObjectKeys");

    const dependsOn = revision.DependsOn as string[];
    const policyId = Object.keys(
      template.findResources("AWS::S3::BucketPolicy"),
    )[0];
    const functionId = Object.keys(
      template.findResources("AWS::Lambda::WebFunction"),
    )[0];
    expect(dependsOn).toEqual(expect.arrayContaining([policyId, functionId]));
  });

  // 古い zip を消すと、それを指す revision が Failed になって戻せなくなる
  test("配置は古い zip を消さない", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      Prune: false,
      Extract: false,
    });
  });
});

describe("段階制の値付けに要る資源（決定55・56）", () => {
  it("価格表を置く AppConfig のアプリケーション・環境・設定プロファイル・展開戦略を作る", () => {
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

  // 拡張レイヤーは無くなり、サーバーが SDK で直接読む（決定74）。参照は常に配線する
  it("価格表の場所を環境変数で渡し、読み取りを許す", () => {
    expect(revisionEnv(template)).toEqual(
      expect.objectContaining({
        APPCONFIG_APPLICATION: expect.anything(),
        APPCONFIG_ENVIRONMENT: expect.anything(),
        APPCONFIG_PROFILE: expect.anything(),
      }),
    );
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            // 読み手は毎回まずセッションを開く。片方でも欠けると価格表は一度も読めず、
            // 失敗は警告で握られて既定の表で売り続ける（気づきにくい）
            Action: Match.arrayWith([
              "appconfig:StartConfigurationSession",
              "appconfig:GetLatestConfiguration",
            ]),
          }),
        ]),
      }),
    });
  });

  // 無認証で公開する関数なので、読める設定をこのスタックの価格表だけに絞る
  it("AppConfig の読み取りは、このスタックの価格表に限る", () => {
    const appConfig = policyStatements(template).find((statement) =>
      [statement.Action].flat().includes("appconfig:GetLatestConfiguration"),
    );
    expect(appConfig).toBeDefined();
    expect(appConfig?.Resource).not.toBe("*");
    const resource = JSON.stringify(appConfig?.Resource);
    expect(resource).toMatch(
      /application\/.*\/environment\/.*\/configuration\//,
    );
    const profileId = Object.keys(
      template.findResources("AWS::AppConfig::ConfigurationProfile"),
    )[0];
    expect(resource).toContain(profileId);
  });
});

describe("Jev の API キー（決定58）", () => {
  // 値は人が後から入れる。CDK に書くと CloudFormation テンプレートに平文で残る。
  // ランダム生成に任せると、出鱈目な鍵で 401 になり全件が中央の価格帯へ落ちる
  it("鍵ではなく仮の値を入れて作る", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    const props = Object.values(secrets)[0].Properties as Record<string, unknown>;
    expect(props.SecretString).toBe("REPLACE_ME");
    expect(props.GenerateSecretString).toBeUndefined();
  });

  it("Secret の場所を環境変数で渡す", () => {
    expect(revisionEnv(template).TYPESAFE_API_KEY_SECRET_ARN).toBeDefined();
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
