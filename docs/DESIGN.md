# 設計決定録（Design Decisions）

このプロジェクトの設計判断を記録する。決定を変更する場合も行は消さず、決定・理由を更新して経緯を理由欄に残す。

## 決定事項

| # | 論点 | 決定 | 理由 |
| --- | --- | --- | --- |
| 1 | リポジトリ構成 | モノレポ。`billing-mcp/`（売り手）と `agent-app/`（買い手）をディレクトリで分離。ルートは記録・共通設定のみ | 課金サービスと利用側を独立にデプロイ・検証できる。ops-agent 同様、workspace 統合はせずアプリ別ツールチェーンで運用 |
| 2 | billing-mcp の機能 | html-creator-mcp-apps を踏襲（generate-html ツール + プレビュー UI）。コードは流用せず最新 SDK で書き直す | 踏襲元は SDK 1.29 + 自前セッション管理など旧プロトコル前提の箇所が多く、部分改修より作り直しが安い |
| 3 | MCP 仕様の線 | `@modelcontextprotocol/sdk` 1.30 系（プロトコル 2025-11-25）+ `ext-apps` 1.7 系（MCP Apps 2026-01-26 正式版）。最新リビジョン 2026-07-28 には今回は追随しない | MCP Apps SDK（ext-apps）が v1 系専用で、2026-07-28 実装の SDK v2（`@modelcontextprotocol/server` 等）と併用不可（2026-08-30 時点。移植 PR 未マージ、適合性違反 issue 10件 open）。UI 配信を優先し、ext-apps の v2 対応後にアップグレード（U5） |
| 4 | トランスポート | Streamable HTTP。Lambda Function URL の POST `/mcp` で待受（ローカル開発も同じパス） | 当初は AgentCore Runtime の MCP ホスティング契約（コンテナ 0.0.0.0:8000 の /mcp）に合わせていた。決定19 で売り手を Lambda へ移したため、待受はコンテナのポートではなく Function URL 上のパスになった（2026-08-30 更新） |
| 5 | billing-mcp のデプロイ | CDK（Amplify 不使用）。ops-agent 方式: 関数ベーススタック、parameter.ts（gitignore + sample コミット）、jest + @swc/jest、cdk.json は tsx 実行。デプロイ先は Lambda（zip・arm64）+ Function URL | ユーザー要件（MCP 部分を切り出して CDK デプロイ）。参考元の規約に合わせて学習コストを下げる。デプロイ先は当初 AgentCore Runtime だったが決定19 で Lambda へ変更（2026-08-30 更新） |
| 6 | AgentCore Runtime の構成方法 | 不採用。当初は `aws-cdk-lib/aws-bedrockagentcore` の安定版 L2（Runtime + AgentRuntimeArtifact.fromAsset、linux/arm64）を使う予定だった | 着工前調査で L2 の実在（aws-cdk-lib 2.267.0 に environmentVariables / ProtocolType / authorizerConfiguration / fromAsset がすべて存在）、東京リージョンでの稼働、CDK bootstrap v32 の導入済みを確認していた。しかし決定19 で AgentCore Runtime 自体をやめたため本決定は失効。将来 AgentCore へ戻す場合はこの構成でよい（2026-08-30 更新） |
| 7 | x402 売り手実装 | `@x402/*` v2 系 SDK。facilitator は x402.org（Coinbase 運営・API キー不要） | x402 は v2 が現行仕様。旧 `x402-express` 等 v1 パッケージは deprecated。テストネットなら無料 facilitator で完結 |
| 8 | 決済ネットワーク | Base Sepolia（eip155:84532）+ テスト USDC（Circle Faucet で入手） | サンプルのため実マネーゼロで全フローを検証する |
| 9 | 買い手ウォレット | AgentCore Payments（2026-08-18 GA）。Coinbase コネクタ + Quick Create、PaymentSession の maxSpendAmount で支出上限 | AWS マネージドウォレットを試すこと自体が本サンプルの狙いに合致。テストネット対応・Runtime 非依存の公開 API であることを調査で確認済み。自前ウォレット（viem + 秘密鍵）案は不採用 |
| 10 | 支払い主体と UI 経路 | ハイブリッド。agent-app の Agent（サーバー側）が支払って有料ツールを実行。ブラウザは ui:// リソースを無課金で直接取得して iframe 描画し、ツール結果は Realtime 経由で受領 | エージェントが自律的に支払う筋書きを保ちつつ、MCP Apps の UI はブラウザでしか描画できない制約と両立させる。ブラウザ側ウォレット案・Agent 全中継案は不採用。ブラウザ直接取得の成立性は着工前に実測で確認済み（AgentCore データプレーンは CORS 全開だった）。決定19 で Lambda へ移したため CORS は自前で設定する（2026-08-30 補足） |
| 11 | 課金の粒度 | 有料はツール呼び出しのみ。ui:// リソース取得・初期化等は無課金 | 決定10の前提。UI 取得に支払いを要求すると描画経路が破綻する |
| 12 | リージョン | 基本 ap-northeast-1（東京）。AgentCore Payments 一式のみ ap-southeast-1 に作成しクロスリージョン呼び出し | Payments は東京非対応。リスク: クロスリージョン利用は公式に禁止も保証もされていない。支障が出たら全リソースを ap-southeast-1 に集約する切替案を用意 |
| 13 | agent-app の実装 | AWS Blocks。Agent Building Block + AuthCognito 等、handson-aws-blocks を参考。雛形はスキャフォールド生成 | ユーザー要件 |
| 14 | 作業記録 | 本書（設計決定録）+ implementation-log.md（日付別記録）+ CLAUDE.md で更新義務化 | ユーザー要件（経緯を必ず残す）。ops-agent の運用を踏襲。Issue/PR 駆動は今回は採らない |
| 15 | ツールチェーン | mise（node 24 / pnpm 10）。pnpm の適用は billing-mcp のみ。agent-app はスキャフォールドが採用するパッケージマネージャ（npm 想定）に従う。billing-mcp サーバーは Biome + Vitest、CDK テストは jest + @swc/jest | 参照元2リポジトリの選定の折衷（CDK 側は ops-agent、サーバー側は html-creator の系譜）。当初は全体 pnpm としていたが、決定13「雛形はスキャフォールド生成・手書きしない」と衝突するためセルフレビューで適用範囲を限定（2026-08-30） |
| 16 | 進行順 | ①土台のみ → ②billing-mcp 単独で動作確認 → ③agent-app → ④結合（Agent が支払って UI が出る） | 一気通貫で作るより手戻りが小さい。各段階の区切りで implementation-log.md に記録 |
| 17 | x402 の MCP バインディング | `@x402/mcp`（2.24 系）のインプロトコル方式を採用。支払い要求はツール結果（isError + structuredContent の PaymentRequired）、支払い証明は tools/call の `_meta["x402/payment"]`、レシートは結果の `_meta["x402/payment-response"]`。HTTP 402 ステータス・ヘッダは使わない | 当初の理由は「AgentCore Runtime はレスポンスの 402 ステータスやカスタムヘッダを返せない（U2 の調査結果）ため HTTP レイヤの x402 は成立しない」だった。決定19 で Lambda へ移りこの制約は消えたが、インプロトコル方式は維持する。HTTP レイヤの x402 だと `/mcp` へのリクエスト全体が有料になり、ui:// リソースを無課金にする決定11 と衝突するため。`createPaymentWrapper` なら有料ツールと無償リソースを同居できる。MCP 公式の支払い拡張 SEP-2007 はまだ Draft のため今回は採らない（2026-08-30 更新） |
| 18 | フェーズ②の検証手段 | TDD は facilitator を偽 HTTP サーバーで差し替えて進め、仕上げに使い捨てウォレット（viem 鍵 + Circle Faucet のテスト USDC + x402.org facilitator）で実オンチェーン決済を 1 回流す。価格は 0.01 テスト USDC / 呼び出し（exact スキーム）を仮決め | テストの安定性と実決済の証拠取りを両立。買い手本命（AgentCore Payments）の検証はフェーズ③以降 |
| 19 | 売り手（billing-mcp）のホスティング | AgentCore Runtime をやめ、Lambda（zip・arm64）+ Function URL（AuthType NONE = 無認証）に置く。無認証で公開するため、reserved concurrency と関数タイムアウトで瞬間的な流量に上限を掛ける（同時実行数は累積コストの上限にはならない。累積の上限が要るなら AWS Budgets 等を併用）。Lambda の制限（リクエスト 6MB / 実行 15分）を超えたくなった場合は ECS へ移す | AgentCore Runtime は匿名インバウンドを許さず、authorizer は IAM（SigV4）か JWT の二択しかない（aws-cdk-lib 2.267.0 の L2 にも CFN にも無認証は無い）。IAM で絞ると認可の主体が「支払い」ではなく「権限付与」になり、x402 で課金する意味が消える（「IAM で絞るなら x402 は不要では」というユーザーの指摘）。買い手側の AgentCore Payments（決定9）は Runtime 非依存と調査済みで、売り手を AgentCore に置く必然性は「AgentCore Runtime を試すこと」以外に無かった。x402 を唯一のゲートに戻すことを優先し、2026-08-30 に転換 |
| 20 | 検討して不採用にした売り手構成 | ①API Gateway（REST / HTTP）②AgentCore + Cognito Identity Pool のゲスト資格情報 ③AgentCore + 公開プロキシ（CloudFront + Lambda@Edge） | ①HTTP API は統合タイムアウト 30秒上限で最初から不可。REST API は統合タイムアウトを 29秒超へ引き上げ可能（Regional / Private のみ、Service Quotas の L-E5AE38E3。当アカウントは Adjustable: True / 現在値 29000ms）だが、`Idle connection timeout` 310秒は引き上げ不可で生成上限 570秒が通らず、引き上げにはアカウント・リージョン全体の API Gateway スロットル削減が伴い、さらにクォータ申請が `cdk deploy` の外に出て再現性を損なう。②未認証（ゲスト）ID の AWS 一時クレデンシャルで SigV4 署名すれば実質匿名公開は可能（Identity Pool ID は公開値でよい。※IAM の意味論からの推論で実地検証はしていない）だが、買い手に「ゲスト資格情報の取得と SigV4 署名」という AWS 固有の作法を強い、「事前の関係なしに HTTP と決済だけで買える」という x402 の売りが消える。③は前段が無認証の公開 Lambda になるため、後段の AgentCore が余剰になる |
| 21 | x402 の支払いフロー | `upfront`（settle をハンドラ実行前に実行）。`@x402/core` の `PaymentFlowName` は `authorization` / `upfront` / `escrow` の3種 | 既定の `authorization` は verify → ハンドラ → settle の順のため、署名は有効だが決済が通らない支払いを送りつけると Bedrock の生成コストだけ売り手が負担する。実装記録 2026-08-30 のとおり settle 失敗は 3回中 1回 実際に発生しており、無認証の公開エンドポイント（決定19）では机上の話ではなくなる。`upfront` なら決済確定後に生成するためこの穴が塞がる。代償として、決済後に生成が失敗した場合のリスクは買い手側へ移る |
| 22 | サーバーの実行形態 | express を廃し、`WebStandardStreamableHTTPServerTransport` を素の Lambda ハンドラから使う。zip デプロイ（Docker・ECR 不使用）。MCP セッションはステートレス（`sessionIdGenerator: undefined`）。ローカル開発用に `node:http` の薄いエントリポイントを別に置く | Lambda では実行環境が毎回同じとは限らず、インメモリのセッション Map は温まっているときだけ動く不安定な実装になる（MCP SDK 1.30 のステートレスモードはセッション検証を一切行わない）。express + Lambda Web Adapter でも動くが、素のハンドラなら Docker が一切不要で CDK は NodejsFunction だけで済み、コールドスタートも小さい。なお facilitator への `/supported` 照会は Lambda の INIT フェーズ（10秒制限）を避けるため初回呼び出しへ遅延させる |
| 23 | 添付ファイルの上限 | 最大1件（ツールのスキーマで強制）。リクエスト全体で base64 後 6MB 以内 | 旧実装は express の 25mb 上限で「3件 × 4.5MB」を受けていたが、Lambda Function URL のリクエスト上限は 6MB（引き上げ不可）で、3件の広告は掲げても受け取れない。上限に収まる1件へ絞り、サイズの目安（元データ約4.4MB）をツールの説明文に明記した（2026-08-30、セルフレビュー指摘の対応でユーザーが決定） |

## 未決論点

検証してから決定に昇格させる。実装で触れる前に必ずここを確認すること。

| # | 論点 | 現状 | 検証方法 |
| --- | --- | --- | --- |
| U1 | TypeScript から AgentCore Payments API を呼べるか | Python SDK（bedrock-agentcore + Strands プラグイン）には統合があるが、JS SDK の GA API 追随は未確認 | `@aws-sdk/client-bedrock-agentcore` に ProcessPayment / CreatePaymentSession 等があるか実装冒頭で確認。無ければ SigV4 直呼びか Python 薄層 Lambda を検討 |
| U2 | X-PAYMENT ヘッダの搬送方法 | 決着（2026-08-30）: ヘッダ搬送そのものを不要化。リクエストヘッダは requestHeaderAllowlist で透過できるが、レスポンスの 402 ステータス・カスタムヘッダは返せないことが判明（aws-samples が売り手を CloudFront + Lambda@Edge に置くのはこのため）。インプロトコル方式（決定17）を採用して回避 | - |
| U3 | 認証の共有 | 決着（2026-08-30）: 論点消滅。決定19 で売り手を無認証の Lambda Function URL に置いたため、インバウンド認証そのものが無くなり、agent-app の User Pool と共有する必要も消えた。認可は x402 の支払いが単独で担う。検討過程で「AgentCore のデータプレーンは CORS 全開（allow-origin `*`、リクエストヘッダはエコーで全許可、`Mcp-Session-Id` は expose 済み）」を実測しており、決定10 のブラウザ直接取得は IAM・JWT いずれでも成立することは確認できていた | - |
| U4 | 402 応答（payment-required）の MCP 上の表現 | 決着（2026-08-30）: x402 公式モノレポの `@x402/mcp` を採用（決定17）。Cloudflare（HTTP レイヤ寄り）・Vercel x402-mcp（停滞中）・SEP-2007（Draft）と比較のうえ、公式 SDK かつインプロトコルの同パッケージが最適と判断 | - |
| U5 | ext-apps の SDK v2 対応時期 | 移植 PR（Port to SDK v2）は未完了で closed。2026-07-28 適合性違反 issue が open | 実装フェーズの節目で ext-apps のリリースを確認し、対応したら決定3を更新 |
| U6 | 有料ツール結果の structuredContent 搬送 | `@x402/mcp` の x402MCPClient は有料ツールの結果から content / isError / _meta のみを写し、structuredContent（HTML 本体）を落とすことが実測で判明（2026-08-30）。billing-mcp 側は正しく返している | agent-app（買い手）実装時に対処。候補: 低レベル API（PaymentClient で支払いペイロードを作り素の mcpClient.callTool に _meta を積む）／上流への issue・PR |
