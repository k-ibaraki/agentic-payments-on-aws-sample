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
- 実決済に要る実行時設定（下記「縦串検証に必要な環境変数」の `PAYMENT_*` など）は、合成時の環境変数
  （Amplify コンソールのブランチ環境変数、sandbox ではシェル）から `amplify/runtime-env.ts` の許可リストで拾い、
  共有 Lambda の環境変数に写す（決定34。AppSetting 化はしない）。ブランチ deploy では
  `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` / `BILLING_MCP_URL` が無いと合成で落ちる。sandbox では
  欠けても通る（認証と API の疎通だけを見る用途）。AgentCore Payments の IAM も同じ場所で共有 Lambda のロールに付ける
- クラウドの buyer API を認証込みで UI なしに通す縦串検証は `scripts/buy-via-cloud.ts`
  （`BLOCKS_API_URL=<custom.blocks_api_url> BUYER_EMAIL=<Cognito の利用者> npx tsx -C browser scripts/buy-via-cloud.ts "指示"`。
  OTP はプロンプトか `BUYER_OTP_FILE`、セッション Cookie は `BUYER_COOKIE_FILE` で持ち回る。実オンチェーン決済が発生する）
- 自己サインアップは既定で閉じている（決定36）。クラウドの利用者は管理者が作る（Cognito コンソールで
  ユーザーを作成。サインインはメール OTP）。ローカルの `npm run dev` / `npm run test:e2e` は
  `BUYER_SELF_SIGNUP=true` を付けて開けている

## 縦串検証に必要な環境変数

値の出どころは 2 つある（.env 等は使わず実行時に渡す）:

| 値 | 出どころ | 取り出し方 |
| --- | --- | --- |
| `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` | 買い手の AgentCore Payments | `npx tsx scripts/payments-setup.ts`（冪等。何度でも実行して確認できる）|
| `BILLING_MCP_URL` | 売り手のスタックの `McpEndpointUrl` 出力 | `billing-mcp/` で `pnpm outputs` |

`BILLING_MCP_URL` は売り手の Function URL で、**売り手を作り直すたびに変わる**。
過去のログに載っている URL をそのまま使わず、`pnpm outputs` で取り直すこと。

クラウド（Amplify のブランチ環境変数）では `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` /
`BILLING_MCP_URL` の 3 つが必須で、無いと合成で落ちる（決定34）。

残りは既定値があり、必要なときだけ渡す:

- `PAYMENT_SESSION_MINUTES` / `PAYMENT_SESSION_MAX_USD`（アプリが購入時に切る PaymentSession の期限と
  支出上限。既定 `60` / `1.00`。決定35。有効なセッションは KVStore `payment-session` に記録して使い回し、
  失効・削除で拒否されたら一度だけ作り直す。支出上限の超過では作り直さず失敗させる——作り直すと上限に当たった支払いがその場で通り、上限が上限でなくなるため。決定37）
- `BILLING_MCP_URL`（既定 `http://localhost:8000/mcp`）・`PAYMENTS_USER_ID`（既定 `sample-user-1`）
- `PAYMENT_MAX_AMOUNT`（1回の支払い上限。USDC の最小単位、既定 `100000` = 0.1 USDC）・
  `PAYMENT_PAY_TO`（任意。売り手アドレスを固定する）。ネットワークと資産は Base Sepolia +
  テスト USDC に固定しており、売り手の提示がこれに合わなければ支払わない
- `BUYER_TOOL_TIMEOUT_MS`（有料ツールの待ち時間。既定 `600000`。短くすると決済後に失敗して支払いだけが残る）
