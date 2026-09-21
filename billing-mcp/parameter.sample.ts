// CDK のパラメータ雛形。`cp parameter.sample.ts parameter.ts` して使う
// （parameter.ts は gitignore 対象）
import type { BillingMcpStackProps } from "./stacks/billing-mcp-stack";

export type AppParameter = BillingMcpStackProps;

export const devParameter: AppParameter = {
  // 基本は東京（DESIGN.md 決定12）。account は cdk deploy 時の認証情報から解決する
  env: { region: "ap-northeast-1" },
  envName: "dev",
  // 売上の受取先ウォレット。自分のアドレスに置き換えること
  // （ゼロアドレスのままだと合成の段階でエラーにして止める）
  payToAddress: "0x0000000000000000000000000000000000000000",
  facilitatorUrl: "https://x402.org/facilitator",
  // 価格は段階制（決定56）。既定は梅 $0.1 / 竹 $0.15 / 松 $0.2 で、
  // deploy 後は AppConfig から変えられる。以下の `price` は段階制の導入前の単価で、
  // 実際の値付けには使われない（`resolveQuote` は常に価格表から価格を引く）。
  // `PRICE` 環境変数として Lambda には渡るが、現行の値付けロジックでは参照されない
  price: "$0.1",
  // 無認証で公開するため必ず設定する（決定19）。同時実行数 = 瞬間的な流量の上限であり、累積コストの上限ではない
  reservedConcurrency: 5,
  allowedModelIds: [
    "jp.anthropic.claude-sonnet-4-6",
    "jp.anthropic.claude-opus-4-8",
    // 段の判定に使う（決定53）
    "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
  ],
  // 段の判定器（決定58）はパラメータではなく AppConfig の価格表で倒す。
  // Jev 用の Secret は常に空で作られるので、ここに書くことは無い
  // 価格表を AppConfig から読むなら、AppConfig Agent Lambda extension の
  // レイヤー ARN を渡す（決定56）。省略するとサーバー側の既定の表で動く。
  // ARN はリージョンとアーキテクチャ（ここは arm64）ごとに異なる
  // appConfigExtensionLayerArn: "arn:aws:lambda:ap-northeast-1:...:layer:AWS-AppConfig-Extension-Arm64:...",
};
