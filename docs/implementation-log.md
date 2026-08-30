# 実装記録

作業のたびに日付見出しで、やったこと・判断・つまずきを記録する。設計決定そのものは DESIGN.md へ分離。

## 2026-08-30: リポジトリ立ち上げ（技術調査・設計決定・土台作成）

### やったこと

- 参照リポジトリ3つ（html-creator-mcp-apps / ops-agent-sample-on-aws / handson-aws-blocks）の構成調査
- x402・MCP Apps・MCP 最新リビジョン・AgentCore Runtime / Payments の最新動向を Web 調査（モデルのカットオフ以降の情報を確認）
- 設計決定 1〜16 と未決論点 U1〜U5 を DESIGN.md に記録
- モノレポの土台（ディレクトリ骨格・CLAUDE.md・記録ファイル・CI 骨格・mise 設定）を作成し初回コミット

### 調査で分かった重要事実

- MCP の最新リビジョンは 2026-07-28（セッション廃止・ステートレス化の大改造）。実装 SDK は「SDK v2」という別パッケージ群（`@modelcontextprotocol/server` / `client` / `core` 等、2026-07-27 GA）。ただし MCP Apps の `ext-apps` SDK は v1 系専用のため、現時点では「MCP Apps」と「2026-07-28」は両立不可
- AgentCore Payments は 2026-08-18 に GA（プレビュー卒業）。テストネット（Base Sepolia + テスト USDC）完全対応で実マネー不要。Runtime 非依存の公開 API（boto3 / CLI から直接呼べる）で Lambda 上のエージェントからも利用可。ただし東京リージョン非対応（近場は ap-southeast-1 / ap-southeast-2）
- x402 は v2 仕様が現行。npm パッケージは `@x402/*` スコープへ世代交代済みで、旧 `x402-express` 等は deprecated。テストネット用の無料 facilitator（x402.org、API キー不要）あり
- AgentCore Runtime の CDK L2 construct は alpha（`@aws-cdk/aws-bedrock-agentcore-alpha`）から `aws-cdk-lib/aws-bedrockagentcore` 安定版へ移行済み
- 踏襲元 html-creator-mcp-apps は ext-apps（Apps 仕様 2026-01-26）は既にほぼ最新だが、ベースプロトコル側（SDK 1.29、自前 Mcp-Session-Id 管理等）が旧い

### 判断・つまずき

- 当初指示の踏襲元 URL は貼り間違いで、正しくは html-creator-mcp-apps だった（ユーザー訂正。amplify-gen2-agentcore-sample の調査結果は無駄にはならず、デプロイ構成の把握に流用）
- 「MCP の最新仕様で作る」がユーザー要望だったが、上記のとおり ext-apps と SDK v2 が両立不可と判明。ユーザーと相談し「MCP Apps 優先・2026-07-28 は ext-apps 対応後に追随」で合意（決定3）
- 決済基盤は「Base Sepolia 自前ウォレット」案と比較のうえ、GA 直後の AgentCore Payments を採用（決定9）。東京非対応のためリージョン戦略を相談し「東京主体 + Payments のみ越境」で合意（決定12）
- 今回のセッションは土台のみで着地（決定16）。実装コードは次セッション以降

### セルフレビュー（同日）

- 初回コミット後にセルフレビューを実施。指摘1件: 決定15の「全体 pnpm」が決定13「agent-app はスキャフォールド生成・手書きしない」（npm 前提）と衝突 → 決定15の pnpm 適用範囲を billing-mcp に限定し、CI 骨格の agent-app ジョブ（コメント内）と agent-app/README.md を npm 想定に修正
