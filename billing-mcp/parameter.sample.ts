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
  // 価格はパラメータでは決めない。段階制（決定56）の価格表が決め、既定は
  // 梅 $0.1 / 竹 $0.15 / 松 $0.2。deploy 後は pnpm set:tier-table で AppConfig に配って変える（決定64）
  // 無認証で公開するため必ず設定する（決定19・74。累積コストの上限にはならない点に注意）。
  // maxEnvironments は同時に動く実行環境の数（2 以上。1 環境が 64 件まで同時にさばく）、
  // rateLimit は秒あたりの依頼数（0 か 100〜1000 の 100 刻み、2000〜10000 の 1000 刻み）
  maxEnvironments: 2,
  rateLimit: 100,
  allowedModelIds: [
    "jp.anthropic.claude-sonnet-4-6",
    "jp.anthropic.claude-opus-4-8",
    // 価格帯の判定に使う（決定53・71）
    "jp.anthropic.claude-haiku-5-5",
  ],
  // 価格帯の判定モデル（決定58）はパラメータではなく AppConfig の価格表で切り替える（pnpm set:tier-table）。
  // Jev 用の Secret は仮の値（REPLACE_ME）で作られ、鍵は pnpm set:jev-key で入れるので、ここに書くことは無い
};
