# 実装記録

作業のたびに日付見出しで、やったこと・判断・つまずきを記録する。設計決定そのものは DESIGN.md へ分離。

## 2026-08-31: フェーズ③着工 — 前提検証（grill-me）と方針決定

### 着工前の詰め（grill-me）で崩れた前提

- 「PR #1 をマージするか判断」→ **既にマージ済み**（163a161、08:58 UTC）。main から
  新ブランチ `feat/agent-app` を切って着工
- 「作業 worktree は plush-breeze」→ 実際は **teal-linden**（main と同一コミットの
  detached HEAD だった）。`billing-mcp/server/.env` も無かったため plush-breeze から複製
- 「U1 は未検証」→ **事実確認だけで決着**（下記）。SigV4 直呼び・Python 薄層の検討は不要に

### U1 の検証（決定24 に昇格）

`@aws-sdk/client-bedrock-agentcore` 3.1121.0 を一時ディレクトリへ実インストールして
型定義を検分。データプレーンに ProcessPayment / CreatePaymentSession /
CreatePaymentInstrument / GetResourcePaymentToken 等 **Payments 系 11 コマンド**、
`-control` に PaymentManager / PaymentConnector / PaymentCredentialProvider の CRUD を確認。
`PaymentType.CRYPTO_X402` + `CryptoX402PaymentInput/Output` で x402 ペイロードを
そのまま搬送できる。JS SDK だけで完結する。

あわせて実測した周辺事実:

- ap-southeast-1 の PaymentManager は**ゼロ件**。セットアップは完全にゼロから
- Coinbase コネクタの provision は `MANUAL`（CDP の API キー持参）か
  `QUICK_CREATE`（サービスが OAuth 同意を仲介）の二択
- `@x402/mcp` は 2.24.0 のまま。U6（structuredContent 欠落）の上流修正は出ていない

### ユーザー決定（grill-me の問答）

1. ③の完了条件は**売り手ローカルで縦串**（billing-mcp は pnpm dev、agent-app もローカル、
   Payments のみクラウド実物で実オンチェーン決済まで）→ 決定27
2. Coinbase コネクタは **QUICK_CREATE**（OAuth 同意はユーザーが実施）→ 決定27
3. U6 は**低レベル API で回避** → 決定25
4. U6 の上流 issue 報告は**③完了後に改めて判断**（保留）→ 決定25 理由欄
5. 使用ブロックは想定4つに **Realtime を加えた5つ**で確定（配線は④）→ 決定26

### 段取り

ブランチ作成・.env 複製・本記録 → AWS Blocks スキャフォールド → TDD で
支払いクライアント〜有料ツール呼び出し → Payments セットアップ（QUICK_CREATE）→
旧買い手ウォレットから新ウォレットへテスト USDC 送金 → 実オンチェーン決済で縦串検証 →
CI の agent-app ジョブ有効化。push はユーザー指示があるまでしない。

### 同日の実装（縦串の買い手側まで完了、決済検証はブロック中）

- **スキャフォールド生成**: `npx @aws-blocks/create-blocks-app agent-app --template auth-cognito`。
  生成物そのままを基線コミットし、以後の差分を追えるようにした（決定13・15。npm 管理）
- **Payments セットアップスクリプト**（`agent-app/scripts/payments-setup.ts`、冪等）を実装し、
  ap-southeast-1 に IAM サービスロールと PaymentManager（`agenticpaymentssample-btbtr1e6q9`、READY）
  を作成した。実測で公式ドキュメントと食い違った点が2つ:
  - 信頼ポリシーはグローバルの `bedrock-agentcore.amazonaws.com` だけでは
    `Role validation failed` になり、**リージョン付き `bedrock-agentcore.ap-southeast-1.amazonaws.com`
    の併記が必要**だった
  - PaymentManager / Connector の name は**英数字のみ**（`[a-zA-Z][a-zA-Z0-9]{0,47}`）。
    ARN では小文字化される（信頼ポリシーの ArnLike に影響）
- **Coinbase コネクタ作成は `SubscriptionRequiredException` でブロック中**。AWS Marketplace の
  「Coinbase Wallets for AgentCore Payments」への加入（ユーザー操作）が前提と判明。
  加入後に同スクリプトを再実行 → OAuth 同意（QUICK_CREATE、URL 有効期限約10分）→
  ウォレット作成・委任 → 送金 → 縦串検証、の順で再開する
- **x402 支払いモジュールを TDD で実装**（`agent-app/aws-blocks/payments/`。unit 12件グリーン）:
  - `x402-payer`: ProcessPayment(CRYPTO_X402) に「受諾した支払い条件」を渡して
    支払い証明を得る。PaymentStatus は `PROOF_GENERATED` のみで、**清算は売り手側
    facilitator の仕事**（署名だけウォレットが行う）という分担も型から確認
  - `paid-tool-caller`: 素の callTool を「要求受領 → 支払い → `_meta["x402/payment"]` 付き
    再呼び出し」の2段で叩く。structuredContent が欠けないことをテストで固定（U6 回避）
- **買い手エージェント配線**（`aws-blocks/buyer-agent.ts`）: generateHtml ツールで購入し、
  HTML 本体は KVStore へ、会話には resultId だけ返す（決定10 の最終形を見据えた設計）。
  ローカルの LLM は canned プロバイダで、支払い・売り手側生成・決済は本物が動く
- スキャフォールド由来の todos デモ（DistributedTable）はフロントが強く依存しているため
  ③では残置し、④の UI 置き換えと同時に撤去する
- CI に agent-app ジョブを追加（npm ci + typecheck + unit テスト）
- つまずき: `aws login` の資格情報が途中でローテーション失敗の一時エラーを出した
  （数分後に自走回復）。IAM の Description は Latin-1 のみで日本語不可

## 2026-08-31: フェーズ②完了 — クラウドへデプロイし実オンチェーン決済を検証

### やったこと

- 価格を 0.01 → **0.1 テスト USDC / 呼び出し**へ引き上げ（決定18 更新）。記録と実物が
  ずれないよう DEFAULT_PRICE・parameter.sample.ts・.env.example・テスト期待額を揃えた
- `cdk deploy` を実行し、無認証の Function URL を公開
  - エンドポイント: `https://aadgxm2l6a6n77igxsqrdeelja0ivxmo.lambda-url.ap-northeast-1.on.aws/mcp`
  - ロググループ: `BillingMcpStack-dev-McpFunctionLogsDE22E4A3-qqKrCgVjY6cX`
- **実オンチェーン決済を 2 回成功**（Base Sepolia、各 0.1 テスト USDC）
  - 1回目: [0x1f05b837…39221](https://sepolia.basescan.org/tx/0x1f05b837dd19da8a8c10928766afeaf05146a0efc9f313b2de958a8479939221)
  - 2回目: [0xbe8f1bdf…90f4](https://sepolia.basescan.org/tx/0xbe8f1bdfa1040c9998a81d8b91e0ed010f8ae08e86f2557800c4a2ac795590f4)
  - 売り手 0.02 → 0.12 → 0.22 USDC（1回あたり +0.1）／買い手 19.98 → 19.88 USDC
- これでフェーズ②（billing-mcp 単独での動作確認）は完了

### 実測値

- **コールドスタート**: INIT 363.81ms + 初回実行 1,530ms（facilitator への `/supported`
  照会を含む）。遅延構築にした判断（決定22）が効いており、INIT の 10 秒制限には遠い
- **ウォームの MCP 往復**: 4〜95ms（initialize / tools/list / 支払い要求）
- **有料ツール呼び出し**: 7,013ms（Bedrock の HTML 生成込み）。タイムアウト 600 秒に対し十分
- **メモリ**: 1,024MB 中 132〜143MB しか使っていない。削れる余地あり
- クラウド初回の疎通は 2.2 秒（コールドスタート込みの initialize）

### 見つけて直した不具合: GET（SSE ストリーム要求）で Lambda が落ちる

初回の実決済は成功したが、CloudWatch に `Runtime.NodeJsExit`
（"a Promise that was never settled"）が 1 件記録されていた。

- **原因**: MCP クライアントが initialize 後に開く単独の SSE ストリーム要求（GET）。
  ステートレス + enableJsonResponse では SSE を提供しないが、GET をそのまま SDK に
  渡すと終わらないストリームが返り、それを `response.text()` でバッファしようとして
  Promise が永久に未解決になっていた
- **再現**: ローカルで GET を投げると 5 秒待っても応答が返らないことを確認
- **対処**: GET は SDK へ渡さず 405（Allow: POST, DELETE, OPTIONS）を返す。加えて
  万一ストリーミング応答が来ても待ち続けないよう `isStreamingResponse` で防護し、
  body を cancel して 500 を返す。両方をテストで固定（決定22 に追記）
- **確認**: 再デプロイ後に 2 回目の実決済を通し、6 回の実行でエラーゼロ

決済フロー自体は最初から成功しており、この不具合は副次的な GET 経路にのみ現れていた。
ローカルのテストでは MCP クライアントの `fetch` を差し替えていたため GET 経路を
踏んでおらず、クラウドのログを読んで初めて露見した。

### 後片付け

検証が済んだので `cdk destroy` でスタックを削除し、公開エンドポイントを閉じた
（スタック不存在とエンドポイントの 403 応答を確認）。フェーズ④で結合検証をする際は
`cdk deploy` で作り直す（URL は変わる）。

### 残していること

- フェーズ③（agent-app）着工。着工前に U1（JS SDK から AgentCore Payments を
  呼べるか）の検証と、U6（x402MCPClient が structuredContent を落とす）の
  対処方針決めが必要
- Lambda のメモリは 1,024MB 中 143MB しか使っていない。コスト最適化の余地があるが、
  コールドスタートとのトレードオフなので結合検証まで様子を見る

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

### セルフレビュー（同日・フェーズ②後半）

指摘5件を全件修正した。あわせて添付ファイルの上限をユーザー判断で最大1件に変更（決定23）。

1. 添付上限の退行: 旧 express の 25mb 上限が消え、ツールは「3件まで」と広告したまま
   Function URL の 6MB に当たる状態だった → 上限を1件に絞り、サイズの目安を説明文に明記
2. Bedrock クライアントの作り捨て: ステートレス化の副作用で毎リクエスト
   `new BedrockRuntimeClient` が走っていた → fetch ハンドラ生成時に1度だけ解決して共有
3. 「損失の上限」の誇張: reserved concurrency が押さえるのは瞬間的な流量であって
   累積コストではない → 4箇所の文言を修正し、累積の上限には AWS Budgets 等を併用と明記
4. ゼロアドレスの罠: 雛形のまま deploy すると売上が焼却される（settle は成功しレシートも
   返るため無音）→ 合成の段階でゼロアドレスを弾くガードを追加（テスト付き）。
   CI は合成のみなので、雛形コピー後に検証用ダミーへ sed 置換して通す
5. commandHooks の cp が未引用: 空白を含むパスで bundling が壊れる → 引用を追加

### 残していること（次回セッションの作業）

フェーズ②の完了に向けて、上から順に:

1. **デプロイ実施**: `billing-mcp/` で `pnpm cdk diff` を再確認して `pnpm cdk deploy`。
   無認証の公開エンドポイントが出るため、parameter.ts の `payToAddress`（設定済み:
   0x833E…B94D）と `reservedConcurrency` を確認してから。出力の `McpEndpointUrl` を控える
2. **クラウド実オンチェーン決済**（決定18 の仕上げ・upfront の実地初検証）:
   ワークツリーに `.env` が無いので本体チェックアウト側から複製し、
   `MCP_SERVER_URL=<McpEndpointUrl> pnpm buy:once`。買い手 0xd98A…3Ebf に
   約19.98 テスト USDC 残あり。売り手残高の増分とトランザクション確定を確認
3. **検証結果の記録**: CloudWatch Logs（出力 `LogGroupName`）でコールドスタートと
   facilitator 疎通を確認し、結果を DESIGN.md（決定18・21 の理由欄）と本記録に反映。
   検証が済んだらフェーズ②完了
4. **フェーズ③着工（agent-app）**: AWS Blocks のスキャフォールド生成から。着工前に
   U1（JS SDK から AgentCore Payments を呼べるか）の検証と、U6（x402MCPClient が
   structuredContent を落とす）の対処方針決めが必要
5. 小物: PR マージ後に CI（billing-mcp-cdk ジョブ初回実行）がグリーンか確認

注意事項:

- **ポート 8000 で本体チェックアウト側の旧 express サーバーが動いたまま**（PID 15052、
  2026-08-30 22:02 起動）。`buy-once.ts` の既定接続先と衝突するので、ローカル検証の前に
  止めること
- デプロイ後の売り手は誰でも叩ける。検証が長引く場合も出しっぱなしにせず、
  終わったら `pnpm cdk destroy` で片付けるか、残す判断を記録すること

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
