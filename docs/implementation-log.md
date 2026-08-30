# 実装記録

作業のたびに日付見出しで、やったこと・判断・つまずきを記録する。設計決定そのものは DESIGN.md へ分離。

## 2026-08-30: フェーズ②後半 — 売り手を Lambda へ転換し、CDK でデプロイ直前まで

### 着工前の詰め（grill-me）で崩れた前提

着工前に依頼の前提を調べ直したところ、技術的前提が3つ崩れた。

1. **「server/ は実装済み・テスト17件グリーン」が成り立たない。** AgentCore Runtime は
   `Mcp-Session-Id` を持たないリクエストにプラットフォーム側が勝手に付与する仕様
   （MCP protocol contract）だが、当時の `server.ts` は知らないセッション ID を 404 で
   弾いていた。デプロイ後の最初の `initialize` で落ちる状態だった
2. **「API Gateway は 29秒上限」は REST API には当てはまらない。** 2024年6月に統合
   タイムアウトの引き上げが可能になっており、当アカウントの L-E5AE38E3 も
   Adjustable: True だった（HTTP API の 30秒上限は引き上げ不可のまま）
3. **「AgentCore は匿名アクセス不可」は authorizer の設定項目に限った話だった。**
   Cognito Identity Pool の未認証（ゲスト）ID で AWS 一時クレデンシャルを取れば、
   実質匿名の公開も可能だった

### 設計の転換

ユーザーの指摘「IAM で絞るなら x402 で課金する必要がそもそもなくない？」が決定打になり、
売り手を **AgentCore Runtime から無認証の Lambda Function URL へ移した**（決定19）。
AgentCore の authorizer は IAM か JWT の二択で、IAM で絞ると認可の主体が「支払い」ではなく
「権限付与」になり、x402 で課金する筋書きが崩れる。買い手側の AgentCore Payments は
Runtime 非依存と調査済みだったため、売り手を AgentCore に置く必然性は残っていなかった。

検討して不採用にした構成（REST API + クォータ引き上げ / AgentCore + Identity Pool ゲスト /
AgentCore + 公開プロキシ）は理由ごと決定20 に記録した。

### やったこと

- ドキュメント更新: 決定4・5・6・10・17 を追随更新、決定19〜22 を追加、U3 を決着
- x402 の支払いフローを `upfront` に切り替え（決定21）。テストの支払いペイロードは、
  サーバーが広告した accepts の写しから組み立てる方式に変更した
- express を廃し、`WebStandardStreamableHTTPServerTransport` を素の Lambda ハンドラから
  使う形に作り替え（決定22）。MCP セッションはステートレス
- CDK（billing-mcp/ 直下、ops-agent 方式）で NodejsFunction（arm64 / Node.js 22 / zip）+
  Function URL（AuthType NONE）+ reserved concurrency + CloudWatch Logs + Bedrock IAM
- CI に billing-mcp-cdk ジョブを追加（型・テスト・合成・バンドル検証）
- テスト 17件 → 32件（サーバー）+ 7件（CDK）

### 実測で分かったこと・つまずき

- **AgentCore のデータプレーンは CORS 全開だった**（allow-origin `*`、リクエストヘッダは
  エコーで全許可、`Mcp-Session-Id` は expose 済み）。決定10 のブラウザ直接取得は IAM でも
  JWT でも成立すると分かり、U3 の判断材料が一つ減った
- **旧 express サーバーが実際に 404 を返すことを実物で確認した。** 本体チェックアウト側で
  起動しっぱなしだった旧サーバーに未知の `Mcp-Session-Id` 付きで `initialize` を投げると
  `404 {"error":"Session not found"}`。同じリクエストが新実装では 200 で通る
- **合成した Lambda バンドルをそのまま実行して、デプロイ後にしか出ない不具合を2件潰した**:
  ①`@aws-sdk/*` は NodejsFunction の既定で external になりランタイム同梱版に依存する
  → `externalModules: []` で同梱。②AWS SDK v3 は CJS 配布で動的 require を持つため、
  ESM 出力に同梱すると `Dynamic require of "node:stream" is not supported` で落ちる
  → `createRequire` バナーを追加。再発検知のため `scripts/verify-bundle.mjs` を CI に載せた
- **`jp.` 推論プロファイルは ap-northeast-1 と ap-northeast-3 に跨る**（`aws bedrock
  list-inference-profiles` で実測）。IAM はプロファイル ARN だけでは足りず、跨ぐ全リージョンの
  基盤モデル ARN も要る。片方だけだとデプロイ成功後に AccessDenied になる
- **買い手クライアントの upfront 対応を、テスト USDC を使わずに検証した。** `@x402/mcp` の
  実クライアント + 使い捨て viem 鍵（署名は本物）+ 偽 facilitator で往復を通した
- `pnpm exec tsx --env-file-if-exists=.env` は pnpm がフラグを食うため動かない。
  `./node_modules/.bin/tsx` を直接呼ぶ必要がある
- mise の設定が未信頼だと `pnpm install` が黙って失敗する（`| tail` で終了コードが隠れた）
- 支払いラッパーの構築（facilitator への `/supported` 照会）は全リクエスト経路で走るため、
  x402.org に到達できないと無課金のはずの `ui://` 取得まで 503 になる。決定11 の
  「ui:// は無課金」は価格については成り立つが、可用性については facilitator に連座する
- 認証情報なしでも `pnpm synth` が通ることを確認済み（CI ジョブは資格情報を持たない）
- 決定16（進行順 ①②③④）は今回の転換でも変わらないため、書き換えていない

### 残していること

- **デプロイは未実施**（ユーザーの判断で、公開前に一度止める着地）
- クラウド上での実オンチェーン決済検証（決定18 の仕上げ）は未実施
- ワークツリー側に `.env` が無い（本体チェックアウト側にある）。`pnpm buy:once` を
  動かすには複製が要る
- **ポート 8000 で本体チェックアウト側の旧 express サーバーが動いたまま**（PID 15052、
  22:02 起動）。`buy-once.ts` の既定接続先と衝突するので、ローカル検証の前に止めること

## 2026-08-30: フェーズ②前半 — billing-mcp サーバー実装とローカル実決済検証

### やったこと

- 着工前調査で U2・U4 を決着（決定17・18 を追加。`@x402/mcp` インプロトコル方式の採用と検証手段）
- `billing-mcp/server/` を新規実装（TDD、テスト16件）:
  - `generate-html` ツール（Bedrock Converse。呼び出しを関数注入にしてテスト可能化。踏襲元のロジックを移植）
  - `createPaymentWrapper` で generate-html だけを有料化（0.01 テスト USDC）。ui:// リソース（プレビュー UI）は無償
  - Streamable HTTP + Express（AgentCore 契約に合わせポート 8000 の /mcp）
  - テストは偽 facilitator（/supported /verify /settle を持つ express）を立てて統合的に検証
- 買い手テストスクリプト `scripts/buy-once.ts`（`createx402MCPClient` + viem 使い捨て鍵）
- 実オンチェーン検証: Circle Faucet のテスト USDC → x402.org facilitator 経由で決済 2 回成功（Base Sepolia、売り手残高が 0.01 USDC ずつ増加、トランザクション確定を確認）

### 実測で分かったこと・つまずき

- x402 v2 の照合は `accepted`（クライアントが選んだ支払い条件の完全な写し）必須。scheme/network だけでは「No matching payment requirements found」になる
- 価格 "$0.01" は SDK が Base Sepolia のテスト USDC（0x036C…）と amount 10000 に自動解決してくれる
- `@x402/mcp` クライアントは有料ツール結果の structuredContent を落とす（U6 として記録。サーバー側は正しく返している）
- 決済（settle）が `invalid_exact_evm_transaction_failed` で失敗することが 3 回中 1 回あった。一過性（facilitator 側）と判断。失敗時に買い手へ課金されないことは確認できたが、settle-after-handler フローのため Bedrock の生成コストは売り手が被る（悪意ある買い手が無効な支払いで生成だけ走らせる余地。本サンプルでは許容し、対策するなら verify 強化か前払いフロー）
- 決済直後の残高照会はブロック確定前で 0 に見えることがある（数秒待てば反映）
- Biome の `vcs.useIgnoreFile` は同ディレクトリに .gitignore が無いとエラーになるため、明示的な `files.includes` 除外に切り替えた
- 検証用ウォレットは使い捨て（`.env` に保存、gitignore 済み）。買い手 0xd98A…3Ebf / 売り手 0x833E…B94D

### セルフレビュー（同日・フェーズ②前半）

- 指摘5件を全件修正: ①settle 失敗経路のテスト追加（支払い未完了時に成果物を渡さない契約を固定）②CI に billing-mcp-server ジョブを有効化 ③ルート README のステータス更新 ④ツール説明文から価格ハードコードを除去（PRICE 可変のため）⑤buy:once を決済未完了時に exit 1 へ

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
