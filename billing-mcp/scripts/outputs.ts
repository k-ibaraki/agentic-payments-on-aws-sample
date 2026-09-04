// deploy 済みスタックの出力を読み、買い手（agent-app）に渡す値をそのまま貼れる形で出す。
// deploy 時のログを遡らずに済ませるためのもので、読み取りしかしない（describe-stacks のみ）。
//
// スタック名は parameter.ts の envName から決める（billing-mcp.ts と同じ組み立て）。
// parameter.ts は gitignore なので、名前を決め打ちにすると envName を変えた人が別のスタックを見てしまう。
//
// 実行: pnpm outputs        … parameter.ts の envName から決める
//       pnpm outputs <名前> … スタック名を直接指定する（pnpm は `--` を素通しするので付けないこと）
//
// AWS CLI を使う（この一手のために SDK の依存を増やさないため）。
import { execFileSync } from "node:child_process";
import { devParameter } from "../parameter";

const stackName = process.argv[2] ?? `BillingMcpStack-${devParameter.envName}`;
// parameter.ts では env.region を省くこともできる。省いた場合、CDK は資格情報側のリージョンへ deploy する。
// このスクリプトだけが東京と決め打ちすると、deploy 先とは違うリージョンを見てしまう。
// そのため region が無いときは --region を渡さず、AWS CLI に解決させる
const region = devParameter.env?.region;

let stack: { StackStatus?: string; Outputs?: { OutputKey?: string; OutputValue?: string }[] };
try {
  const json = execFileSync(
    "aws",
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stackName,
      ...(region ? ["--region", region] : []),
      "--output",
      "json",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  stack = JSON.parse(json).Stacks?.[0] ?? {};
} catch (error) {
  const where = region ? `${stackName}（${region}）` : stackName;
  // AWS CLI が無いのが、このスクリプトで一番分かりにくい失敗。stderr も出ないので分けて案内する
  if ((error as { code?: string }).code === "ENOENT") {
    console.error("aws コマンドが見つかりません。AWS CLI を入れて PATH を通すこと");
    process.exit(1);
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail = stderr
    ? String(stderr).trim()
    : error instanceof Error
      ? error.message
      : String(error);
  console.error(`${where}の出力を取得できませんでした。`);
  console.error(detail);
  console.error("");
  console.error("deploy 済みか、AWS の資格情報が有効か（aws sts get-caller-identity）を確認すること");
  process.exit(1);
}

const outputs = new Map(
  (stack.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""] as const),
);

console.log(`${region ? `${stackName}（${region}）` : stackName}: ${stack.StackStatus}`);
console.log("");
for (const [key, value] of outputs) {
  console.log(`  ${key} = ${value}`);
}

const endpoint = outputs.get("McpEndpointUrl");
if (endpoint) {
  console.log("");
  console.log("agent-app に渡す値（ローカルはシェル、クラウドは Amplify のブランチ環境変数）:");
  console.log(`export BILLING_MCP_URL=${endpoint}`);
  console.log("");
  console.log("PAYMENT_MANAGER_ARN / PAYMENT_INSTRUMENT_ID は agent-app 側で");
  console.log("npx tsx scripts/payments-setup.ts を実行すると出る");
}
