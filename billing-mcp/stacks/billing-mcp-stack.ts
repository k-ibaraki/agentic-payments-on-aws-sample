import * as path from "node:path";
import {
  CfnOutput,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as appconfig from "aws-cdk-lib/aws-appconfig";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  CfnWebFunction,
  CfnWebFunctionEndpoint,
  CfnWebFunctionRevision,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { bundleServer, UI_HTML_BUNDLED_NAME } from "./bundle";

/** パラメータ（parameter.ts / parameter.sample.ts が満たす形） */
export interface BillingMcpStackProps extends StackProps {
  /** 環境名。スタック名やリソース名に使う */
  readonly envName: string;
  /** 売上の受取先ウォレット（EVM アドレス） */
  readonly payToAddress: string;
  /** x402 facilitator の URL。省略時はサーバー側の既定（x402.org） */
  readonly facilitatorUrl?: string;
  /**
   * 同時に動かす実行環境の数の上限（2 以上）。
   * 無認証で公開する（決定19）ため必ず設定する。1 つの実行環境は既定で 64 件の依頼を
   * 同時にさばくので、同時実行数の上限ではなくメモリ課金の上限と読む。累積コストの
   * 上限ではない（上限が要るなら AWS Budgets 等を併用）
   */
  readonly maxEnvironments: number;
  /**
   * endpoint が受け付ける秒あたりの依頼数の上限。
   * 取れる値は 0（全部拒む）、100〜1000（100 刻み）、2000〜10000（1000 刻み）
   */
  readonly rateLimit: number;
  /** 呼び出しを許可する Bedrock 推論プロファイル ID（jp. プレフィックス） */
  readonly allowedModelIds: string[];
}

/**
 * 鍵が未投入であることを表す仮の値。
 * server 側の `pricing/typesafe-key.ts` の UNSET_API_KEY と揃える（決定58）
 */
const UNSET_TYPESAFE_API_KEY = "REPLACE_ME";

/**
 * 依頼 1 件の時間制限（秒）。server 側の BEDROCK_TIMEOUT_MS（570 秒）より長くしないと、
 * Bedrock 由来の具体的なエラーが届く前に打ち切られてしまう。
 * Web Functions の上限は 900 秒（決定20）
 */
export const REQUEST_TIMEOUT_SECONDS = 600;

/** Web Functions の実行環境でコードが展開される場所 */
const LAMBDA_TASK_ROOT = "/var/task";

/**
 * jp. 推論プロファイルが跨ぐリージョン。
 * `aws bedrock list-inference-profiles` で実測（2026-08-30）。
 * 推論プロファイル ARN だけでは足りず、跨ぐ全リージョンの基盤モデル ARN も要る
 */
const JP_INFERENCE_REGIONS = ["ap-northeast-1", "ap-northeast-3"];

/**
 * 推論プロファイル ID から、必要な Bedrock リソース ARN を組み立てる。
 * 本サンプルは ap-northeast-1（決定12）に閉じるため、パーティションは aws 固定。
 * トークンにすると合成後のポリシーが読みづらくなるのを避ける意図もある
 */
function bedrockResourceArns(
  modelIds: string[],
  account: string,
  region: string,
): string[] {
  const arns: string[] = [];
  for (const modelId of modelIds) {
    if (!modelId.startsWith("jp.")) {
      throw new Error(
        `未対応の推論プロファイル ID です: ${modelId}（jp. プレフィックスのみ対応）`,
      );
    }
    const foundationModelId = modelId.slice("jp.".length);
    arns.push(`arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`);
    for (const modelRegion of JP_INFERENCE_REGIONS) {
      arns.push(
        `arn:aws:bedrock:${modelRegion}::foundation-model/${foundationModelId}`,
      );
    }
  }
  return arns;
}

/** billing-mcp（売り手）のスタックを作る */
export function createBillingMcpStack(
  scope: Construct,
  id: string,
  props: BillingMcpStackProps,
): Stack {
  const stack = new Stack(scope, id, props);

  // ゼロアドレスは雛形（parameter.sample.ts）の初期値。このままデプロイすると
  // 売上がゼロアドレスへ送られて焼却される。settle 自体は成功しレシートも返る
  // ため、エラーが出ないまま資金だけが消える。合成の段階で止める
  if (/^0x0{40}$/i.test(props.payToAddress)) {
    throw new Error(
      "payToAddress がゼロアドレスのままです。parameter.ts で自分の受取アドレスに書き換えてください（このままデプロイすると売上が焼却されます）",
    );
  }

  const projectRoot = path.join(__dirname, "..");

  // Web Function の名前。アカウント内の全リージョンで一意でなければならない。
  // バケットポリシーの条件（revision の ARN）に使うので、トークンではなく文字列で決める
  const functionName = `billing-mcp-${props.envName}`;

  // ロググループは明示的に作る。初回デプロイから CloudWatch で追えないと、
  // facilitator への疎通失敗などが原因不明のまま終わる。
  // Web Functions の既定は /aws/lambda/web/<関数名> だが、名前を revision に渡して自前のものを使わせる。
  // Lambda はまず同じ名前に `.local` を付けたグループへ書き、そこから名前どおりのグループへ集める。
  // `.local` も自前で作っておく（残骸にしないため。書き込み権限は両方に要る。2026-10-25 に実測）
  const logGroup = new LogGroup(stack, "McpFunctionLogs", {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const localLogGroup = new LogGroup(stack, "McpFunctionLocalLogs", {
    logGroupName: `${logGroup.logGroupName}.local`,
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  // 価格表（決定56）。運用中に価格を変えられるよう AppConfig に置く
  // （差し替えが進行中の取引を壊さない理由は server/pricing/tiers.ts 参照）。
  // 作るのは器（以下の Application / Environment / ConfigurationProfile / DeploymentStrategy）
  // だけで、中身（版と配信）は持たない。持つと deploy のたびに運用中の表が既定値へ巻き戻る
  // （決定64）。中身は `pnpm set:tier-table` で配る
  const application = new appconfig.CfnApplication(stack, "PricingApp", {
    name: `billing-mcp-pricing-${props.envName}`,
  });
  const environment = new appconfig.CfnEnvironment(stack, "PricingEnv", {
    applicationId: application.ref,
    name: props.envName,
  });
  const profile = new appconfig.CfnConfigurationProfile(stack, "PricingProfile", {
    applicationId: application.ref,
    name: "tier-table",
    locationUri: "hosted",
  });
  // 段階的な展開は不要。設定は小さく、戻すのも同じ手順で足りる
  const strategy = new appconfig.CfnDeploymentStrategy(stack, "PricingStrategy", {
    name: `billing-mcp-pricing-${props.envName}`,
    deploymentDurationInMinutes: 0,
    growthFactor: 100,
    finalBakeTimeInMinutes: 0,
    replicateTo: "NONE",
  });

  // Jev の API キー（決定58）。仮の値を入れたシークレットだけ作り、鍵は人が後から入れる
  // （`pnpm set:jev-key`）。API キーを CDK に書くと CloudFormation テンプレートに平文で
  // 残るため。仮の値にする理由は server 側 pricing/typesafe-key.ts の UNSET_API_KEY 参照
  const typesafeApiKeySecret = new Secret(stack, "TypesafeApiKey", {
    secretStringValue: SecretValue.unsafePlainText(UNSET_TYPESAFE_API_KEY),
    secretName: `billing-mcp/typesafe-api-key-${props.envName}`,
    description:
      "TypeSafe（Jev）の API キー。判定モデルを jev に切り替えるときに使う（決定58）",
    // 作り直しの余地を残す。鍵は外部サービスの発行物で、消えても再発行できる
    removalPolicy: RemovalPolicy.DESTROY,
  });

  // コードの置き場（決定74）。Web Functions は S3 の zip しか読まず、バケットには
  // バージョニングと「Lambda のサービスプリンシパルが読める」バケットポリシーが要る。
  // CDK の bootstrap バケットはポリシーを足せないので専用に作る。
  // 消すときに中身ごと消す（残すと destroy が止まる）
  const codeBucket = new s3.Bucket(stack, "CodeBucket", {
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });
  // Lambda は revision を作るときにこの許可を検査し、無ければ拒む。
  // 読めるのはこの関数の revision からだけ
  codeBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
      actions: ["s3:GetObject", "s3:GetObjectVersion"],
      resources: [codeBucket.arnForObjects("*")],
      conditions: {
        ArnLike: {
          "aws:SourceArn": `arn:aws:lambda:${stack.region}:${stack.account}:web-function/${functionName}/revision/*`,
        },
      },
    }),
  );

  // サーバーを束ねて zip にし、専用バケットへ置く。鍵はアセットのハッシュなので、
  // 中身が変われば鍵が変わり、revision が作り直される。古い zip は消さない
  // （消すとそれを指す revision が Failed になり、戻せなくなる）
  const codeDeployment = new BucketDeployment(stack, "CodeDeployment", {
    sources: [Source.asset(bundleServer(projectRoot))],
    destinationBucket: codeBucket,
    extract: false,
    prune: false,
  });

  // 実行ロール。Web Functions の L1 はロールを作ってくれないので自前で作る
  const role = new iam.Role(stack, "McpFunctionRole", {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
  });
  // ログの書き込み。Web Functions の権限の案内（CreateLogGroup を含む 3 つ）に合わせ、
  // 対象は自前の 2 つのグループに限る
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: [logGroup.logGroupArn, localLogGroup.logGroupArn],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: bedrockResourceArns(
        props.allowedModelIds,
        stack.account,
        stack.region,
      ),
    }),
  );
  // 読めるのはこの Secret だけ。鍵は初めて使うときに読み、読めれば実行環境内に保持する
  typesafeApiKeySecret.grantRead(role);
  // 価格表はサーバーが AppConfigData の API を直接読む（決定74）。無認証で公開する関数なので、
  // 読めるのはこのスタックの価格表だけに絞る（パーティションは Bedrock と同じく aws 固定）
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        "appconfig:StartConfigurationSession",
        "appconfig:GetLatestConfiguration",
      ],
      resources: [
        `arn:aws:appconfig:${stack.region}:${stack.account}:application/${application.ref}` +
          `/environment/${environment.ref}/configuration/${profile.ref}`,
      ],
    }),
  );

  const webFunction = new CfnWebFunction(stack, "McpFunction", {
    functionName,
  });

  // revision はコードと設定の不変の組。変えるたびに作り直され、endpoint が新しい方へ向く
  const revision = new CfnWebFunctionRevision(stack, "McpFunctionRevision", {
    // 関数名は素の名前で渡す（ARN を渡すと endpoint の属性が読めなくなる）
    functionName,
    buildConfig: {
      codeConfig: {
        s3Object: {
          bucket: codeBucket.bucketName,
          key: Fn.select(0, codeDeployment.objectKeys),
        },
      },
      runtimeConfig: { runtime: "nodejs24.x" },
    },
    serviceConfig: {
      executionRoleArn: role.roleArn,
      timeoutSeconds: REQUEST_TIMEOUT_SECONDS,
      telemetryConfig: {
        loggingConfig: { logGroup: logGroup.logGroupName },
      },
      environmentVariables: {
        // 同梱した source map でスタックトレースを元のファイル行に戻す（NodejsFunction が付けていたものと同じ）
        NODE_OPTIONS: "--enable-source-maps",
        PAY_TO_ADDRESS: props.payToAddress,
        ...(props.facilitatorUrl ? { FACILITATOR_URL: props.facilitatorUrl } : {}),
        // 束ねた後は import.meta.dirname が変わるため、場所を推測させず明示する
        UI_HTML_PATH: `${LAMBDA_TASK_ROOT}/${UI_HTML_BUNDLED_NAME}`,
        // 判定モデルに jev が指定されたときだけ読みに行く（決定58）
        TYPESAFE_API_KEY_SECRET_ARN: typesafeApiKeySecret.secretArn,
        // 価格表の場所（決定56・74）
        APPCONFIG_APPLICATION: application.ref,
        APPCONFIG_ENVIRONMENT: environment.ref,
        APPCONFIG_PROFILE: profile.ref,
      },
    },
  });
  // 関数名を素の名前で渡すと参照が生まれないので、順序は自分で宣言する。
  // バケットポリシーは revision 作成時の検査に要るので、これも先に作らせる
  revision.node.addDependency(webFunction);
  if (codeBucket.policy) revision.node.addDependency(codeBucket.policy);

  // 認証は掛けない。認可は x402 の支払いが単独で担う（決定19）。
  // 応答は Node の HTTP サーバーがそのまま流すので、経過の通知（SSE。決定65）も途中で届く。
  // 無認証で公開するため、環境数と秒あたりの依頼数に上限を掛ける
  const endpoint = new CfnWebFunctionEndpoint(stack, "McpFunctionEndpoint", {
    functionName,
    endpointName: "default",
    endpointType: "HomeRegion",
    authType: "ApplicationManaged",
    revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
    scalingConfig: { maxEnvironments: props.maxEnvironments },
    throttleConfig: { rateLimit: props.rateLimit },
  });
  endpoint.node.addDependency(webFunction);

  // 出力は、deploy 後に describe-stacks だけで要る値が揃うようにする（README「デプロイ後に値を取り出す」）。
  // 買い手（agent-app）に引き継ぐ値（McpEndpointUrl・PayToAddress）と、売り手の運用で使う値
  // （鍵の Secret・価格表の配り先・ロググループ）がある
  new CfnOutput(stack, "McpEndpointUrl", {
    value: `https://${endpoint.attrDomainName}/mcp`,
    description:
      "MCP エンドポイント（無認証。認可は x402 の支払いのみ）。agent-app の BILLING_MCP_URL に設定する。作り直すと変わる",
  });
  new CfnOutput(stack, "TypesafeApiKeySecretArn", {
    value: typesafeApiKeySecret.secretArn,
    description:
      "Jev の API キーを入れる Secret の ARN（決定58）。仮の値（REPLACE_ME）で作られるので、使うなら pnpm set:jev-key で入れる",
  });
  // 価格表の配り先（決定64）。`pnpm set:tier-table` がここから引く
  new CfnOutput(stack, "PricingApplicationId", {
    value: application.ref,
    description: "価格表（AppConfig）のアプリケーション ID",
  });
  new CfnOutput(stack, "PricingEnvironmentId", {
    value: environment.ref,
    description: "価格表（AppConfig）の環境 ID",
  });
  new CfnOutput(stack, "PricingProfileId", {
    value: profile.ref,
    description: "価格表（AppConfig）の設定プロファイル ID",
  });
  new CfnOutput(stack, "PricingDeploymentStrategyId", {
    value: strategy.ref,
    description: "価格表（AppConfig）の展開戦略 ID",
  });
  new CfnOutput(stack, "LogGroupName", {
    value: logGroup.logGroupName,
    description: "Web Function のロググループ名",
  });
  new CfnOutput(stack, "PayToAddress", {
    value: props.payToAddress,
    description:
      "売上の受取先。agent-app の PAYMENT_PAY_TO（任意。売り手アドレスを固定する）と突き合わせる",
  });

  return stack;
}
