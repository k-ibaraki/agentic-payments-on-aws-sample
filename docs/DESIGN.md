# 設計決定録（Design Decisions）

このプロジェクトの設計判断を記録する。決定を変更する場合も行は消さず、決定・理由を更新して経緯を理由欄に残す。

## 決定事項

| # | 論点 | 決定 | 理由 |
| --- | --- | --- | --- |
| 1 | リポジトリ構成 | モノレポ。`billing-mcp/`（売り手）と `agent-app/`（買い手）をディレクトリで分離。ルートは記録・共通設定のみ | 課金サービスと利用側を独立にデプロイ・検証できる。ops-agent 同様、workspace 統合はせずアプリ別ツールチェーンで運用 |
| 2 | billing-mcp の機能 | html-creator-mcp-apps を踏襲（generate-html ツール + プレビュー UI）。コードは流用せず最新 SDK で書き直す | 踏襲元は SDK 1.29 + 自前セッション管理など旧プロトコル前提の箇所が多く、部分改修より作り直しが安い |
| 3 | MCP 仕様の線 | `@modelcontextprotocol/sdk` 1.30 系（プロトコル 2025-11-25）+ `ext-apps` 1.7 系（MCP Apps 2026-01-26 正式版）。最新リビジョン 2026-07-28 には今回は追随しない | MCP Apps SDK（ext-apps）が v1 系専用で、2026-07-28 実装の SDK v2（`@modelcontextprotocol/server` 等）と併用不可（2026-08-30 時点。移植 PR 未マージ、適合性違反 issue 10件 open）。UI 配信を優先し、ext-apps の v2 対応後にアップグレード（U5） |
| 4 | トランスポート | Streamable HTTP。コンテナは 0.0.0.0:8000 の /mcp で待受 | AgentCore Runtime の MCP ホスティング契約 |
| 5 | billing-mcp のデプロイ | CDK（Amplify 不使用）。ops-agent 方式: 関数ベーススタック、parameter.ts（gitignore + sample コミット）、jest + @swc/jest、cdk.json は tsx 実行 | ユーザー要件（MCP 部分を切り出して CDK デプロイ）。参考元の規約に合わせて学習コストを下げる |
| 6 | AgentCore Runtime の構成方法 | `aws-cdk-lib/aws-bedrockagentcore` の安定版 L2（Runtime + AgentRuntimeArtifact.fromAsset、linux/arm64） | alpha モジュールは安定版へ移行済み。踏襲元の alpha 固定は引き継がない |
| 7 | x402 売り手実装 | `@x402/*` v2 系 SDK。facilitator は x402.org（Coinbase 運営・API キー不要） | x402 は v2 が現行仕様。旧 `x402-express` 等 v1 パッケージは deprecated。テストネットなら無料 facilitator で完結 |
| 8 | 決済ネットワーク | Base Sepolia（eip155:84532）+ テスト USDC（Circle Faucet で入手） | サンプルのため実マネーゼロで全フローを検証する |
| 9 | 買い手ウォレット | AgentCore Payments（2026-08-18 GA）。Coinbase コネクタ + Quick Create、PaymentSession の maxSpendAmount で支出上限 | AWS マネージドウォレットを試すこと自体が本サンプルの狙いに合致。テストネット対応・Runtime 非依存の公開 API であることを調査で確認済み。自前ウォレット（viem + 秘密鍵）案は不採用 |
| 10 | 支払い主体と UI 経路 | ハイブリッド。agent-app の Agent（サーバー側）が支払って有料ツールを実行。ブラウザは ui:// リソースを無課金で直接取得して iframe 描画し、ツール結果は Realtime 経由で受領 | エージェントが自律的に支払う筋書きを保ちつつ、MCP Apps の UI はブラウザでしか描画できない制約と両立させる。ブラウザ側ウォレット案・Agent 全中継案は不採用 |
| 11 | 課金の粒度 | 有料はツール呼び出しのみ。ui:// リソース取得・初期化等は無課金 | 決定10の前提。UI 取得に支払いを要求すると描画経路が破綻する |
| 12 | リージョン | 基本 ap-northeast-1（東京）。AgentCore Payments 一式のみ ap-southeast-1 に作成しクロスリージョン呼び出し | Payments は東京非対応。リスク: クロスリージョン利用は公式に禁止も保証もされていない。支障が出たら全リソースを ap-southeast-1 に集約する切替案を用意 |
| 13 | agent-app の実装 | AWS Blocks。Agent Building Block + AuthCognito 等、handson-aws-blocks を参考。雛形はスキャフォールド生成 | ユーザー要件 |
| 14 | 作業記録 | 本書（設計決定録）+ implementation-log.md（日付別記録）+ CLAUDE.md で更新義務化 | ユーザー要件（経緯を必ず残す）。ops-agent の運用を踏襲。Issue/PR 駆動は今回は採らない |
| 15 | ツールチェーン | mise（node 24 / pnpm 10）、pnpm。billing-mcp サーバーは Biome + Vitest、CDK テストは jest + @swc/jest | 参照元2リポジトリの選定の折衷（CDK 側は ops-agent、サーバー側は html-creator の系譜） |
| 16 | 進行順 | ①土台のみ → ②billing-mcp 単独で動作確認 → ③agent-app → ④結合（Agent が支払って UI が出る） | 一気通貫で作るより手戻りが小さい。各段階の区切りで implementation-log.md に記録 |

## 未決論点

検証してから決定に昇格させる。実装で触れる前に必ずここを確認すること。

| # | 論点 | 現状 | 検証方法 |
| --- | --- | --- | --- |
| U1 | TypeScript から AgentCore Payments API を呼べるか | Python SDK（bedrock-agentcore + Strands プラグイン）には統合があるが、JS SDK の GA API 追随は未確認 | `@aws-sdk/client-bedrock-agentcore` に ProcessPayment / CreatePaymentSession 等があるか実装冒頭で確認。無ければ SigV4 直呼びか Python 薄層 Lambda を検討 |
| U2 | X-PAYMENT ヘッダの搬送方法 | InvokeAgentRuntime（bedrock-agentcore エンドポイント経由）がカスタム HTTP ヘッダを透過するか未確認 | 実測する。不可ならツール引数または _meta で支払いペイロードを運ぶ（Cloudflare paidTool 型） |
| U3 | 認証の共有 | MCP Runtime のインバウンド JWT authorizer に agent-app（AWS Blocks）の User Pool を使えるか。Agent（Lambda）がユーザーの JWT を取得できるか | AWS Blocks の認可コンテキスト仕様を確認。不可なら Runtime を IAM 認可にし、ブラウザの ui:// 取得は別経路を検討 |
| U4 | 402 応答（payment-required）の MCP 上の表現 | x402 の MCP バインディングに標準・確立した慣行があるか未調査 | 実装時に Cloudflare paidTool / Vercel x402-mcp / Coinbase Bazaar の実装を再調査して決める |
| U5 | ext-apps の SDK v2 対応時期 | 移植 PR（Port to SDK v2）は未完了で closed。2026-07-28 適合性違反 issue が open | 実装フェーズの節目で ext-apps のリリースを確認し、対応したら決定3を更新 |
