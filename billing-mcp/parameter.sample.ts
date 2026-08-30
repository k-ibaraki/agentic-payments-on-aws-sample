// CDK のパラメータ雛形。`cp parameter.sample.ts parameter.ts` して使う
// （parameter.ts は gitignore 対象）
import type { BillingMcpStackProps } from "./stacks/billing-mcp-stack";

export type AppParameter = BillingMcpStackProps;

export const devParameter: AppParameter = {
  // 基本は東京（DESIGN.md 決定12）。account は cdk deploy 時の認証情報から解決する
  env: { region: "ap-northeast-1" },
  envName: "dev",
  // 売上の受取先ウォレット。自分のアドレスに置き換えること
  payToAddress: "0x0000000000000000000000000000000000000000",
  facilitatorUrl: "https://x402.org/facilitator",
  price: "$0.01",
  // 無認証で公開するため、損失の上限として必ず設定する（決定19）
  reservedConcurrency: 5,
  allowedModelIds: [
    "jp.anthropic.claude-sonnet-4-6",
    "jp.anthropic.claude-opus-4-8",
  ],
};
