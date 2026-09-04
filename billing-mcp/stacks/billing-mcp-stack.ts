import * as path from "node:path";
import * as fs from "node:fs";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/** パラメータ（parameter.ts / parameter.sample.ts が満たす形） */
export interface BillingMcpStackProps extends StackProps {
  /** 環境名。スタック名やリソース名に使う */
  readonly envName: string;
  /** 売上の受取先ウォレット（EVM アドレス） */
  readonly payToAddress: string;
  /** x402 facilitator の URL。省略時はサーバー側の既定（x402.org） */
  readonly facilitatorUrl?: string;
  /** 価格（"$0.01" 形式）。省略時はサーバー側の既定 */
  readonly price?: string;
  /**
   * Lambda の同時実行数の上限。
   * 無認証で公開する（決定19）ため必ず設定する。押さえられるのは瞬間的な
   * 流量であって累積コストではない（上限が要るなら AWS Budgets 等を併用）
   */
  readonly reservedConcurrency: number;
  /** 呼び出しを許可する Bedrock 推論プロファイル ID（jp. プレフィックス） */
  readonly allowedModelIds: string[];
}

/**
 * Lambda のタイムアウト。server 側の BEDROCK_TIMEOUT_MS（570 秒）より長くしないと、
 * Bedrock 由来の具体的なエラーが届く前に Lambda が切れてしまう。
 * Function URL の上限は Lambda と同じ 15 分（決定20）
 */
export const LAMBDA_TIMEOUT = Duration.seconds(600);

/**
 * ESM 出力に require / __filename / __dirname を用意するバナー。
 * CJS 配布のまま動的 require を使う依存（AWS SDK v3 等）を同梱するために要る
 */
const BUNDLE_BANNER = [
  "import { createRequire as topLevelCreateRequire } from 'module';",
  "const require = topLevelCreateRequire(import.meta.url);",
  "import { fileURLToPath as topLevelFileUrlToPath, URL as topLevelURL } from 'url';",
  "const __filename = topLevelFileUrlToPath(import.meta.url);",
  "const __dirname = topLevelFileUrlToPath(new topLevelURL('.', import.meta.url));",
].join("\n");

/** Lambda の実行環境でコードが展開される場所 */
const LAMBDA_TASK_ROOT = "/var/task";

/** ui:// で配信する HTML（vite singlefile の出力）の、リポジトリ内での場所 */
const UI_HTML_RELATIVE_PATH = "server/dist/ui/src/ui/preview-view.html";

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
  const uiHtmlPath = path.join(projectRoot, UI_HTML_RELATIVE_PATH);
  if (!fs.existsSync(uiHtmlPath)) {
    throw new Error(
      `ui:// で配信する HTML が見つかりません: ${uiHtmlPath}\n` +
        "先に billing-mcp/server で pnpm build:ui を実行してください",
    );
  }

  // ロググループは明示的に作る。初回デプロイから CloudWatch で追えないと、
  // facilitator への疎通失敗などが原因不明のまま終わる
  const logGroup = new LogGroup(stack, "McpFunctionLogs", {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const mcpFunction = new NodejsFunction(stack, "McpFunction", {
    entry: path.join(projectRoot, "server/src/handler.ts"),
    handler: "handler",
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    timeout: LAMBDA_TIMEOUT,
    memorySize: 1024,
    // 無認証の公開エンドポイントなので、瞬間的な流量を同時実行数で押さえる
    reservedConcurrentExecutions: props.reservedConcurrency,
    logGroup,
    projectRoot,
    depsLockFilePath: path.join(projectRoot, "server/pnpm-lock.yaml"),
    environment: {
      PAY_TO_ADDRESS: props.payToAddress,
      ...(props.facilitatorUrl ? { FACILITATOR_URL: props.facilitatorUrl } : {}),
      ...(props.price ? { PRICE: props.price } : {}),
      // バンドル後は import.meta.dirname が変わるため、場所を推測させず明示する
      UI_HTML_PATH: `${LAMBDA_TASK_ROOT}/preview-view.html`,
    },
    bundling: {
      // server の package.json は type: module。import.meta を使うため ESM で出す
      format: OutputFormat.ESM,
      target: "node22",
      // 既定では @aws-sdk/* が external になり、Lambda ランタイム同梱の
      // バージョンに依存する。サンプルとして再現性を優先し、また合成した
      // 成果物をそのままローカルで実行して確かめられるよう、全て同梱する
      externalModules: [],
      // AWS SDK v3 は CJS 配布で内部に動的 require を持つ。ESM 出力にそのまま
      // 同梱すると実行時に「Dynamic require of "node:stream" is not supported」で
      // 落ちるため、ESM 側に require / __dirname を用意する（CDK 公式の案内どおり）
      banner: BUNDLE_BANNER,
      sourceMap: true,
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        // vite singlefile の出力を zip に同梱する（UI_HTML_PATH が指す先）
        afterBundling: (inputDir: string, outputDir: string) => [
          // パスに空白が入っても壊れないよう引用する
          `cp "${path.join(inputDir, UI_HTML_RELATIVE_PATH)}" "${outputDir}/preview-view.html"`,
        ],
      },
    },
  });

  mcpFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: bedrockResourceArns(
        props.allowedModelIds,
        stack.account,
        stack.region,
      ),
    }),
  );

  // 認証は掛けない。認可は x402 の支払いが単独で担う（決定19）
  const functionUrl = mcpFunction.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
  });

  // 出力は「買い手（agent-app）に引き継ぐ値」を揃えることを狙う。deploy 後に
  // describe-stacks だけで設定に必要な値が出るようにしておく（README「デプロイ後に値を取り出す」）
  new CfnOutput(stack, "McpEndpointUrl", {
    value: `${functionUrl.url}mcp`,
    description:
      "MCP エンドポイント（無認証。認可は x402 の支払いのみ）。agent-app の BILLING_MCP_URL に設定する。作り直すと変わる",
  });
  new CfnOutput(stack, "LogGroupName", {
    value: logGroup.logGroupName,
    description: "Lambda のロググループ名",
  });
  new CfnOutput(stack, "PayToAddress", {
    value: props.payToAddress,
    description:
      "売上の受取先。agent-app の PAYMENT_PAY_TO（任意。売り手アドレスを固定する）と突き合わせる",
  });
  // price は省略可で、省いた場合はサーバー側の既定額が効く。ここで既定値を書くと
  // 定数が二重になるため出力しない（環境変数の渡し方と同じ扱い）
  if (props.price) {
    new CfnOutput(stack, "Price", {
      value: props.price,
      description:
        "1 回あたりの価格。agent-app の PAYMENT_MAX_AMOUNT（USDC の最小単位。0.1 USDC = 100000）がこれを賄えるか確認する",
    });
  }

  return stack;
}
