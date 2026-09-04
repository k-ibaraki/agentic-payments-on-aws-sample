# agent-app（買い手: MCP を実行する Agent + 制御 Web アプリ）

AWS Blocks 製。billing-mcp の有料ツールを AgentCore Payments のウォレットで x402 支払いしながら実行するエージェントと、
その制御・MCP Apps UI（iframe）表示を行う Web アプリ。フェーズ④（結合）: ローカル売り手に対する縦串は検証済み、売り手のクラウド結合は未実施。

## 構成

- 雛形は `npx @aws-blocks/create-blocks-app --template auth-cognito` の生成物（決定13・15。npm 管理）
- 使用ブロック（確定）: Agent / AuthCognito / KVStore / ApiNamespace / Realtime（決定26）。
  Realtime は Agent ブロック内蔵の分をブラウザから `useChat`（`@aws-blocks/bb-agent/client`）で購読する
- ウォレット（AgentCore Payments）は ap-southeast-1（クロスリージョン。決定12・24）
- 買い手エージェントの配線は `aws-blocks/buyer-agent.ts`、x402 支払いは `aws-blocks/payments/`
  （@x402/mcp のラッパは structuredContent を落とすため使わず、素の callTool を2段で叩く。決定25）
- ブラウザ UI は `index.html` + `src/index.ts`（認証・チャット・購入一覧）。生成 HTML は
  `src/mcp-apps-host.ts` が売り手の `ui://` リソース（空の表示器。生成物は含まない）を無課金で直接取得し、MCP Apps のホスト（`AppBridge`）
  として sandbox iframe に描画する（決定29）
- 二重支払いの防護（決定31）: 有料ツールの待ち時間は売り手上限に合わせ（`BUYER_TOOL_TIMEOUT_MS`）、
  決済後の失敗はレシートを残し、同じ会話に未解決の支払いがあれば次の購入は人の承認（interrupt）を要求する
- クラウド deploy は Amplify Gen2 + Amplify Hosting が正（決定33。下記「クラウド deploy」）。
  CDK 直の `npm run deploy`（`BlocksStack` + `Hosting`）は退路・比較用に残している
- Block の id（`Scope('app')` / `Agent 'buyer'` / `BlocksBackend 'b'`）は AWS 上の物理名になる。
  Amplify のスタック名が長く、Agent 内蔵の S3 バケット名を 63 文字に収めるために短い。deploy 後は変えないこと

## コマンド

- `npm run dev` — ローカル起動（ポート 3000）。LLM はローカルでも Bedrock（`BUYER_LOCAL_MODEL=canned` で偽 LLM）。
  ブラウザからの依頼は**実オンチェーン決済（テスト USDC）が発生する**
- `npm run test` / `npm run typecheck` — コミット前に必ず通すこと
- `npm run test:e2e` — ローカルサーバーに対する e2e（node:test。buyer API を認証込みで通す。実費は出ない。
  自前で起動するサーバーは偽 LLM、起動済みのサーバーを再利用する場合はその LLM 設定に従う）
- `npx tsx scripts/payments-setup.ts` — AgentCore Payments のセットアップ（冪等。
  `PAYMENTS_LINK_EMAIL` と CDP の資格情報3点を `.env` に置く。`.env.example` 参照。
  前提として AWS Marketplace の Coinbase サブスクリプション加入が要る）
- ウォレット作成後、出力される WalletHub の URL でエンドユーザーが署名権限を許可するまで
  支払いは通らない（許可には有効期限がある。決定27）
- `npx tsx scripts/buy-via-agent.ts "指示"` — 縦串検証。**実オンチェーン決済（0.1 テスト USDC）が発生する**
- `npm run amplify:sandbox -- --once` — Amplify の sandbox へ deploy（AWS 資格情報が要る。課金あり）。
  `--once` を外すとファイル監視で再 deploy し続ける。`npm run amplify:sandbox:delete` で削除
- `npm run build:amplify` — Amplify Hosting 用のフロントのビルド（`client.js` 生成 → `tsc` + `vite build` →
  `amplify_outputs.json` から `dist/.blocks-sandbox/config.json`）。`amplify.yml` が呼ぶ
- sandbox の API にローカルのフロントを繋ぐ:
  `BLOCKS_API_URL=$(node -p "require('./amplify_outputs.json').custom.blocks_api_url") npm run dev`

## クラウド deploy（Amplify Gen2。決定33）

- `amplify/backend.ts` の `defineBackend({})` に `backend.createStack('blocks')` でネストスタックを切り、
  `amplify/blocks.ts` → `aws-blocks/amplify.cdk.ts` の `BlocksBackend.create()` で `aws-blocks/` を丸ごと載せる。
  Amplify 側の auth / data は使わない（認証は `AuthCognito` Block のまま）
- Block を CDK 実装に解決させるため、`ampx` は必ず `NODE_OPTIONS="--conditions=cdk"` で動かす
  （無いと黙ってモック実装に解決され、空のインフラが合成される）。npm スクリプトと `amplify.yml` が付ける
- フロント（Amplify Hosting）と API（API Gateway）は別オリジン。ブラウザは `/.blocks-sandbox/config.json` の
  `apiUrl` で API の絶対 URL を知る。Lambda には `CORS_ALLOWED_ORIGINS`（`amplify/cors-origins.ts` が
  `AWS_APP_ID` から導く。独自ドメインは Amplify の環境変数 `CORS_ALLOWED_ORIGINS` で上書き。
  Amplify Hosting 以外から `ampx pipeline-deploy` する場合はどちらかを環境変数で渡さないと合成で落ちる）と
  `BLOCKS_CROSS_DOMAIN=true`（Cookie を `SameSite=None; Secure; Partitioned` に）を渡す
- Amplify Hosting のビルド設定はリポジトリ直下の `amplify.yml`（モノレポなので `appRoot: agent-app`）。
  Amplify コンソールでアプリを作るときは GitHub 連携でモノレポの `agent-app` を選び、
  バックエンド deploy 用のサービスロール（`AmplifyBackendDeployFullAccess`）を付ける
- 名前の制約: S3 バケット名が `<Amplify のスタック名>-b-app-buyer-sn` になるため、ブランチ名は 7 文字以内
  （`main` / `develop` / `staging` は可）、sandbox の識別子（既定は OS ユーザー名。`--identifier` で指定）は 12 文字以内
- `PAYMENT_*` などの実行時設定を Lambda へ渡す配線（AppSetting 化）はまだ無い（決定28 の⑤の残論点）。
  現状の sandbox は認証と API の疎通までが検証範囲で、実決済は通らない

## 縦串検証に必要な環境変数

`scripts/payments-setup.ts` の出力から設定する（.env 等は使わず実行時に渡す）:

- `PAYMENT_MANAGER_ARN` / `PAYMENT_SESSION_ID` / `PAYMENT_INSTRUMENT_ID`
- `BILLING_MCP_URL`（既定 `http://localhost:8000/mcp`）・`PAYMENTS_USER_ID`（既定 `sample-user-1`）
- `PAYMENT_MAX_AMOUNT`（1回の支払い上限。USDC の最小単位、既定 `100000` = 0.1 USDC）・
  `PAYMENT_PAY_TO`（任意。売り手アドレスを固定する）。ネットワークと資産は Base Sepolia +
  テスト USDC に固定しており、売り手の提示がこれに合わなければ支払わない
- `BUYER_TOOL_TIMEOUT_MS`（有料ツールの待ち時間。既定 `600000`。短くすると決済後に失敗して支払いだけが残る）
