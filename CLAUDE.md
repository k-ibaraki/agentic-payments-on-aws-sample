# CLAUDE.md

## プロジェクト概要

AWS 上で Agentic Payments を試すサンプル。モノレポに2アプリ:

- `billing-mcp/` — 売り手。x402 課金付き MCP Apps を CDK で Lambda（Function URL・無認証）にデプロイ
- `agent-app/` — 買い手。AWS Blocks 製のエージェント + 制御 Web アプリ

## 必ず守ること（作業記録）

サンプルの目的の半分は「経緯を残すこと」にある。以下を怠ったまま作業を終えない。

- 設計判断をしたら `docs/DESIGN.md` の設計決定録に番号付きで追記・更新する（行は消さず、変更経緯は理由欄に残す）
- 作業のたびに `docs/implementation-log.md` へ日付見出しで記録する（やったこと・判断・つまずき）
- 未決論点（U 番号）に触れる実装は、先に検証して結果を DESIGN.md に反映してから進める

## 言語

- ドキュメント・コードコメント・コミットメッセージは日本語

## 開発の進め方

- TDD（レッド→グリーン）で進める
- 実装前に DESIGN.md の決定・未決論点と、参照リポジトリの該当箇所を確認する
- 進行順は DESIGN.md 決定16（①土台 → ②billing-mcp → ③agent-app → ④結合）

## 各アプリの規約

### billing-mcp/

- CDK は ops-agent-sample-on-aws 方式: 関数ベースのスタック定義、`parameter.ts`（gitignore、`parameter.sample.ts` をコミット）、jest + @swc/jest で Template テスト、cdk.json は tsx 実行
- サーバー実装は Biome（lint / format）+ Vitest
- MCP は `@modelcontextprotocol/sdk` 1.30 系 + `@modelcontextprotocol/ext-apps` 1.7 系に固定。SDK v2（`@modelcontextprotocol/server` 等）へは ext-apps の v2 対応後に移行（DESIGN.md 決定3）
- サーバーは express を使わず、`WebStandardStreamableHTTPServerTransport` を素の Lambda ハンドラから使う。MCP セッションはステートレス（DESIGN.md 決定22）
- 売り手は無認証の公開エンドポイント。認可は x402 の支払いのみが担う（DESIGN.md 決定19・21）
- x402 は `@x402/*`（v2 系）のみ使用。旧 `x402-express` 等の v1 パッケージは deprecated のため使わない

### agent-app/

- AWS Blocks を使用（aws-blocks スキルと、スキャフォールドが生成する AGENTS.md に従う）
- 雛形はスキャフォールドで生成し、手書きで模倣しない。例外は `amplify/` と `aws-blocks/amplify.cdk.ts` で、
  公式 CLI（`@aws-blocks/create-blocks-app`）の Amplify 用テンプレートの写し（DESIGN.md 決定33）
- クラウド deploy は Amplify Gen2 + Amplify Hosting が正（決定33）。`ampx` は必ず
  `NODE_OPTIONS="--conditions=cdk"` で動かす（npm スクリプトが付ける）。CDK 直の `npm run deploy` は退路として残す
- Block の id（`Scope('app')` / `Agent 'buyer'` / `BlocksBackend 'b'`）は AWS 上の物理名。S3 の 63 文字制限に
  合わせて短くしてあり、deploy 後は変えない（変えると資源が作り直されデータが消える）

## リージョン

- 基本: ap-northeast-1（東京）
- AgentCore Payments 関連リソースのみ: ap-southeast-1（クロスリージョン呼び出し。DESIGN.md 決定12参照）

## コマンド

### billing-mcp/server/

- `pnpm dev` — UI ビルド + ローカル起動（ポート 8000。`.env` の `PAY_TO_ADDRESS` が必要）
- `pnpm test` / `pnpm typecheck` / `pnpm lint` — コミット前に必ず全て通すこと
- `pnpm buy:once` — 使い捨てウォレットで実オンチェーン決済テスト（`.env` の `BUYER_PRIVATE_KEY`。未設定なら鍵を生成して表示）。`MCP_SERVER_URL` で接続先を差し替えられる

### billing-mcp/

- `pnpm test` / `pnpm typecheck` — CDK の Template テストと型検査
- `pnpm synth` — 合成。`server` 側で先に `pnpm build:ui` が必要
- `pnpm verify:bundle` — 合成したバンドルが実際に読み込めるかの検証（synth の後に実行）
- `pnpm outputs` — deploy 済みスタックの出力を取り出す（読み取りのみ。`McpEndpointUrl` は作り直すたびに変わるので、
  記録の値を使わずここで取り直す）
- `pnpm cdk diff` / `pnpm cdk deploy` — **deploy は無認証の公開エンドポイントを出す。実行前に必ず確認を取ること**

### agent-app/

- `npm run dev` — ローカル起動（ポート 3000）。ローカルでも LLM は Bedrock（`BUYER_LOCAL_MODEL=canned` で偽 LLM）。
  実決済を通すには `payments-setup.ts` が出力する `PAYMENT_*` を環境変数で渡す。売り手は `BILLING_MCP_URL`
  （既定 localhost:8000）。有料ツールの待ち時間は `BUYER_TOOL_TIMEOUT_MS`（既定 600 秒。短くすると決済後に
  失敗して支払いだけが残る。DESIGN.md 決定31）
- ブラウザからの依頼は**実オンチェーン決済（テスト USDC）が発生する**。検証で送る前に確認を取ること
- `npm run test` / `npm run typecheck` — コミット前に必ず全て通すこと（unit は vitest、`aws-blocks/` `src/` `amplify/` `scripts/` 配下）
- `npm run amplify:sandbox -- --once` / `npm run amplify:sandbox:delete` — Amplify の sandbox へ deploy・削除。
  **AWS 上に資源を作り課金が発生する。実行前に必ず確認を取ること**。ローカルのフロントを繋ぐには
  `BLOCKS_API_URL=$(node -p "require('./amplify_outputs.json').custom.blocks_api_url") npm run dev`
- `npm run build:amplify` — Amplify Hosting 用ビルド（`amplify.yml` が呼ぶ。`amplify_outputs.json` が要る）
- `npm run test:e2e` — ローカルサーバーに対する e2e（node:test。CI では回さない）
- `npx tsx scripts/payments-setup.ts` — AgentCore Payments のセットアップ（冪等。`.env` に CDP 資格情報と
  `PAYMENTS_LINK_EMAIL`。AWS Marketplace の Coinbase サブスクリプション加入が前提。出力される WalletHub の
  URL で署名権限の委任を人間が行う。PaymentSession は作らず、アプリが購入時に切る。DESIGN.md 決定35）
- 自己サインアップは既定で閉じている（決定36）。`npm run dev` / `npm run test:e2e` は `BUYER_SELF_SIGNUP=true` を
  付けて開ける。クラウドの利用者は Cognito コンソールで作る
- クラウドの実行時設定（`PAYMENT_*` / `BILLING_MCP_URL` など）は Amplify のブランチ環境変数（sandbox はシェル）から
  `amplify/runtime-env.ts` の許可リストで Lambda に写す（決定34）。ブランチ deploy では必須値が無いと合成で落ちる
- `npx tsx scripts/faucet.ts <アドレス>` — CDP faucet でテスト USDC を供給
- `npx tsx scripts/buy-via-agent.ts "指示"` — 縦串検証（ローカルのエージェント）。**実オンチェーン決済（テスト USDC）が発生する。実行前に確認を取ること**
- `BLOCKS_API_URL=... BUYER_EMAIL=... npx tsx -C browser scripts/buy-via-cloud.ts "指示"` — クラウドの buyer API を認証込みで通す縦串検証。
  利用者は Cognito に管理者が作る。**実オンチェーン決済が発生する。実行前に確認を取ること**
