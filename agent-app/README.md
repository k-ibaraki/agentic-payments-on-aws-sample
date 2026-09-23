# agent-app（買い手）

売り手（billing-mcp）の有料ツールを、ウォレットで支払いながら使うエージェントと、
その操作・表示を行う Web アプリ。AWS Blocks で書いている。

ブラウザで依頼を送ると、エージェントが有料ツールを使うと判断し、AgentCore Payments の
ウォレットで x402 の支払いに署名して呼び出し、返ってきた HTML を画面に描く。

## まず動かす

売り手を先に起動しておくこと（`billing-mcp/README.md`）。

```bash
npm install

# 1. ウォレットを作る。.env に PAYMENTS_LINK_EMAIL と CDP の資格情報3点を置いてから
#    （.env.example 参照。AWS Marketplace の Coinbase サブスクリプション加入が前提）
npx tsx scripts/payments-setup.ts
#    → 表示される WalletHub の URL を開いて署名権限を委ねる（人の操作。有効期限あり）

# 2. テスト USDC を入れる
npx tsx scripts/faucet.ts <アドレス>

# 3. 起動する。1 の出力と売り手の URL を渡す
PAYMENT_MANAGER_ARN=... PAYMENT_INSTRUMENT_ID=... BILLING_MCP_URL=http://localhost:8000/mcp \
  npm run dev   # ポート 3000
```

ブラウザから依頼を送ると、実際にオンチェーンの決済（0.1 テスト USDC）が起きる。
渡せる環境変数は下の「環境変数」にまとめてある。

## しくみ

### アーキテクチャ

- 雛形は `npx @aws-blocks/create-blocks-app --template auth-cognito` の生成物（npm 管理）
- AWS Blocks は Infrastructure from Code のフレームワーク。`aws-blocks/` に書いた Block の宣言から
  AWS CDK の構成を生成するので、AWS へ載せるときは中身が CDK になる（deploy の経路は下記「クラウド deploy」）
- 使用ブロック（確定）: Agent / AuthCognito / KVStore / ApiNamespace / Realtime の5つ。
  Realtime は Agent ブロック内蔵の分をブラウザから `useChat`（`@aws-blocks/bb-agent/client`）で購読する
- ウォレット（AgentCore Payments）は ap-southeast-1（AgentCore Payments が東京リージョン非対応のため、ここだけクロスリージョン呼び出し）
- 買い手エージェントの配線は `aws-blocks/buyer-agent.ts`、x402 支払いは `aws-blocks/payments/`
  （@x402/mcp のラッパは structuredContent を落とすため使わず、素の callTool を2段で叩く）
- ブラウザ UI は `index.html` + `src/index.ts`（認証・チャット・ウォレット・購入履歴。構成は決定44・50・51・62:
  ヘッダー → タブ 3 枚（依頼＝会話 / ウォレット＝残高と支払いの枠 / 購入履歴＝会話をまたいだ一覧と右のプレビュー）。
  内部情報の折りたたみは、広い画面では左の側面パネル、狭い画面では本文の下）。見た目は `src/style.css`
  （Pico.css を `@import` し、淡いブルーのテーマと独自要素のスタイルを重ねる）。生成 HTML は
  `src/mcp-apps-host.ts` が売り手の `ui://` リソース（空の表示器。生成物は含まない）を無課金で直接取得し、MCP Apps のホスト（`AppBridge`）
  として sandbox iframe に描画する。買えたページは会話の中のカードに描き（決定50）、再開した会話の買い置きと
  購入履歴タブの一覧は「表示」を押したものだけを載せる
- 支払額は購入 1 件ごとに見せる（決定60）。売り手の価格は依頼の規模で変わるため（売り手側 決定56）、
  購入カード・購入履歴の行・エージェントの報告に「いくら払ったか」を添える。表記は `$0.15（150000）`の形で、
  ドル表記に最小単位を併記する。桁数を知らない資産では最小単位だけを出す（`aws-blocks/payments/amount.ts`）
- Agent の応答は Markdown 表示にしている（`marked` で HTML 化し `DOMPurify` でサニタイズしてから
  `innerHTML` へ流し込む。LLM が組み立てる信頼できない入力のため、サニタイズをその代わりの防護に据えている。決定46）
- 二重支払いの防護: 有料ツールの待ち時間は売り手上限に合わせる（`BUYER_TOOL_TIMEOUT_MS`）。
  支払いが済んだのに成果物を受け取れなかった購入と、支払われたかどうか自体を確認できなかった購入
  （ウォレット API の応答が返らなかった場合。実際に払っている可能性がある）は、レシートを残して
  「未解決」として記録する。未解決が残っている間は、会話を変えても次の購入は人の承認（interrupt）を
  要求する。記録が消えるのは購入が成功したときだけで、承認しただけでは消えない
- 支出の枠は利用者ごと: ウォレットはアプリで 1 つを共有するが、支払いの枠（PaymentSession）は
  サインインした利用者ごとに切る。上限と期限は利用者 1 人あたりに効き、どのセッションで支払ったかを
  たどれば誰の依頼だったかが分かる。利用者ごとにウォレットを分けないのは、ウォレットを増やすたびに
  Coinbase 側の署名権限の委任を人が行う必要があり、サンプルの手順が重くなるため
- 依頼の回数も利用者ごとに制限する: 支払いに至らない依頼でも LLM の費用はかかるので、
  支出の枠とは別に依頼の回数を数える（`BUYER_RATE_LIMIT`）。承認への応答は回数制限の対象外にしている。ただし対象外になるのは、実際に未解決の承認待ちがある
  場合の応答だけなので、承認応答を装って回数制限を迂回することはできない
- 依頼の枠にはウォレット残高と支払いの枠の残枠を帯で表示する。支払った瞬間が分かるよう、
  有料ツール（`generateHtml`）の呼び出し中は 3 秒間隔で取り直し、値が変わるか呼び出しが終わるまで続ける（決定47）

### 運用上の注意

- クラウド deploy は Amplify Gen2 + Amplify Hosting が正（下記「クラウド deploy」）。
  手元から `cdk deploy` を走らせる経路（`npm run deploy`。以下「`cdk deploy` 経路」）は
  退路・比較用に残している。
  退路として使う前に次の 3 点を承知しておくこと:
  - `npm run destroy` / `cdk diff` / `cdk synth` は、`aws-blocks/client.js` が無いと `Hosting` の
    フロントビルド（`npm run build`）が `Failed to resolve entry for package "aws-blocks"` で落ちる。
    `client.js` は gitignore で `npm run blocks:client` が作るので、**撤収の前に生成しておくこと**。
    「deploy はできたのに畳めない」の原因になりやすい
  - `@aws-blocks/core` の `destroy()` は `cdk destroy` を sandbox 扱いせず `.env.production` も読まない
    （`deploy()` は読む）。合成時のガードを足すときは、撤収の経路も塞いでいないか確かめること。
    実行時設定の必須チェックはこの理由で deploy のときだけに絞ってある（決定34 の改訂）
  - このリポジトリを fork して `cdk deploy` 経路を使うなら、先に `.blocks/config.json` の `stackId` を
    書き換えること。スタック名は `<stackId>-prod` に固定で、Agent 内蔵の S3 バケット名もそこから決まる。
    S3 のバケット名は全 AWS アカウントを通じて一意なので、同じ `stackId` のまま別のアカウントで deploy すると
    バケットの作成で失敗する（sandbox は機械ごとの乱数が付くので衝突しない。Amplify 経路はこのファイルを読まない）
- Block の id（`Scope('app')` / `Agent 'buyer'` / `BlocksBackend 'b'`）は AWS 上の物理名になる。
  Amplify のスタック名が長く、Agent 内蔵の S3 バケット名を 63 文字に収めるために短い。deploy 後は変えないこと

## コマンド

### ローカル開発

- `npm run dev` — ローカル起動（ポート 3000）。LLM はローカルでも Bedrock（`BUYER_LOCAL_MODEL=canned` で偽 LLM）。
  ブラウザからの依頼は**実オンチェーン決済（テスト USDC）が発生する**
- `npm run test` / `npm run typecheck` — コミット前に必ず通すこと
- `npm run test:e2e` — ローカルサーバーに対する e2e（node:test。buyer API を認証込みで通す。実費は出ない。
  自前で起動するサーバーは偽 LLM、起動済みのサーバーを再利用する場合はその LLM 設定に従う）
- `npx tsx scripts/payments-setup.ts` — ウォレットのセットアップ（冪等。上の「まず動かす」を参照）
- `npx tsx scripts/faucet.ts <アドレス>` — CDP faucet でテスト USDC を供給する
- `npx tsx scripts/buy-via-agent.ts "指示"` — UI を通さずに一連の流れを検証する。
  **実オンチェーン決済（0.1 テスト USDC）が発生する**

### Amplify sandbox

- `npm run amplify:sandbox -- --once` — Amplify の sandbox へ deploy（AWS 資格情報が要る。課金あり）。
  `--once` を外すとファイル監視で再 deploy し続ける。`npm run amplify:sandbox:delete` で削除
- `npm run build:amplify` — Amplify Hosting 用のフロントのビルド（`client.js` 生成 → `tsc` + `vite build` →
  `amplify_outputs.json` から `dist/.blocks-sandbox/config.json`）。`amplify.yml` が呼ぶ
- sandbox の API にローカルのフロントを繋ぐ:
  `BLOCKS_API_URL=$(node -p "require('./amplify_outputs.json').custom.blocks_api_url") npm run dev`

## クラウド deploy（Amplify Gen2）

AWS Blocks が生成するのは CDK の構成なので、AWS へ載せる作業は結局 `cdk` の合成と deploy になる。
経路は 2 つあり、違うのは誰がそれを走らせるかだけ。

- **Amplify 経路**（正）: git push を契機に Amplify のビルドが `ampx pipeline-deploy` を走らせ、
  バックエンドを Amplify のネストスタックとして deploy する。フロントは Amplify Hosting が配信する
- **`cdk deploy` 経路**（退路・比較用）: 手元から `npm run deploy` を叩き、`aws-blocks/index.cdk.ts` が
  組む `BlocksStack` + `Hosting` を `cdk deploy` する。Amplify は関わらない。落とし穴は上記「運用上の注意」

### スタック構成

- `amplify/backend.ts` の `defineBackend({})` に `backend.createStack('blocks')` でネストスタックを切り、
  `amplify/blocks.ts` → `aws-blocks/amplify.cdk.ts` の `BlocksBackend.create()` で `aws-blocks/` を丸ごと載せる。
  Amplify 側の auth / data は使わない（認証は `AuthCognito` Block のまま）
- Block を CDK 実装に解決させるため、`ampx` は必ず `NODE_OPTIONS="--conditions=cdk"` で動かす
  （無いと黙ってモック実装に解決され、空のインフラが合成される）。npm スクリプトと `amplify.yml` が付ける

### ネットワークと命名

- フロント（Amplify Hosting）と API（API Gateway）は別オリジン。ブラウザは `/.blocks-sandbox/config.json` の
  `apiUrl` で API の絶対 URL を知る。Lambda には `CORS_ALLOWED_ORIGINS`（`amplify/cors-origins.ts` が
  `AWS_APP_ID` から導く。独自ドメインは Amplify の環境変数 `CORS_ALLOWED_ORIGINS` で上書き。
  Amplify Hosting 以外から `ampx pipeline-deploy` する場合はどちらかを環境変数で渡さないと合成で落ちる）と
  `BLOCKS_CROSS_DOMAIN=true`（Cookie を `SameSite=None; Secure; Partitioned` に）を渡す
- Amplify Hosting のビルド設定はリポジトリ直下の `amplify.yml`（モノレポなので `appRoot: agent-app`）。
  Amplify コンソールでアプリを作るときは GitHub 連携でモノレポの `agent-app` を選び、
  バックエンド deploy 用のサービスロール（`AmplifyBackendDeployFullAccess`）を付ける
- Amplify コンソールでアプリを作ると、SPA 用の書き換え規則 `/<*> → /index.html (404-200)` が自動で付き、
  どんなパスでもアプリが返ってしまう。この画面はトップページだけで動くので、規則を `/<*> → /404.html (404)` に
  差し替える（アプリ単位の設定でリポジトリでは管理できない。決定45）:
  `aws amplify update-app --region ap-northeast-1 --app-id <appId> --custom-rules '[{"source":"/<*>","target":"/404.html","status":"404"}]'`
- 名前の制約: S3 バケット名が `<Amplify のスタック名>-b-app-buyer-sn` になるため、ブランチ名は 7 文字以内
  （`main` / `develop` / `staging` は可）、sandbox の識別子（既定は OS ユーザー名。`--identifier` で指定）は 12 文字以内

### 実行時設定と検証

- 実決済に要る実行時設定（下記「環境変数」の `PAYMENT_*` など）は、合成時の環境変数
  （Amplify 経路はコンソールのアプリまたはブランチの環境変数、`cdk deploy` 経路はシェルと `.env.production`、sandbox はシェル）から
  `aws-blocks/runtime-env.ts` の許可リストで拾い、
  共有 Lambda の環境変数に写す（AppSetting 化はしない）。AgentCore Payments の IAM も同じ場所で共有 Lambda のロールに付ける。
  写す処理は `aws-blocks/runtime.cdk.ts` の `wireRuntime` にまとめてあり、Amplify 経路（`amplify/blocks.ts`）と
  `cdk deploy` 経路（`aws-blocks/index.cdk.ts`）の両方が呼ぶ。deploy のときは
  `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` / `BILLING_MCP_URL` が無いと合成で落ちる。sandbox と、
  deploy を伴わない合成（`npm run destroy` / `cdk diff`）では欠けても通る——値が手元に無いと
  スタックを畳めない、という状態を作らないため
- クラウドの buyer API を認証込みで UI なしに通す縦串検証は `scripts/buy-via-cloud.ts`
  （`BLOCKS_API_URL=<custom.blocks_api_url> BUYER_EMAIL=<Cognito の利用者> npx tsx -C browser scripts/buy-via-cloud.ts "指示"`。
  OTP はプロンプトか `BUYER_OTP_FILE`、セッション Cookie は `BUYER_COOKIE_FILE` で持ち回る。実オンチェーン決済が発生する）
- 自己サインアップは既定で閉じている。クラウドの利用者は管理者が作る（Cognito コンソールで
  ユーザーを作成。サインインはメール OTP）。ローカルの `npm run dev` / `npm run test:e2e` は
  `BUYER_SELF_SIGNUP=true` を付けて開けている

## 環境変数

実決済に要る値は `.env` に置かず、実行時に環境変数で渡す。出どころは 2 つある。

| 値 | 出どころ | 取り出し方 |
| --- | --- | --- |
| `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` | 買い手の AgentCore Payments | `npx tsx scripts/payments-setup.ts`（冪等。何度でも実行して確認できる）|
| `PAYMENT_CONNECTOR_ID` | 〃。画面のウォレット残高（`GetPaymentInstrumentBalance`）にだけ要る。無くても決済は通る | 同上 |
| `BILLING_MCP_URL` | 売り手のスタックの `McpEndpointUrl` 出力 | `billing-mcp/` で `pnpm outputs` |

`BILLING_MCP_URL` は売り手の Function URL で、**売り手を作り直すたびに変わる**。
過去のログに載っている URL をそのまま使わず、`pnpm outputs` で取り直すこと。

Coinbase CDP の資格情報 3 点（`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET`）は
**クラウドには渡さない**。`payments-setup.ts` が初回に AgentCore Identity の credential provider として預け、
以後の決済では AWS 側がそこから引くため、Lambda にも Amplify の環境変数にも要らない。手元の `.env` に
残す用途は、provider の作り直しと `scripts/faucet.ts` での入金だけ。なお AgentCore コンソールの
「支払い」画面は言語設定が English (US) 以外だと白画面になるので、目で確かめるときは言語を切り替えるか
`aws bedrock-agentcore-control list-payment-credential-providers --region ap-southeast-1` を使う。

クラウド（Amplify の環境変数。アプリ単位・ブランチ単位のどちらでもビルドに届く）では
`PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` / `BILLING_MCP_URL` の 3 つが必須で、無いと合成で落ちる。
値は形まで見ずに「あるか」だけを見るので、コンソールへ貼るときは 1 行だけを正確に貼ること
（`payments-setup.ts` の出力は表形式なので、3 行まとめて貼ると気づかないまま deploy が通ってしまう）。

残りは既定値があり、必要なときだけ渡す:

- `PAYMENT_SESSION_MINUTES` / `PAYMENT_SESSION_MAX_USD`（アプリが購入時に切る PaymentSession の期限と
  支出上限。既定 `60` / `1.00`。上限は利用者が画面の「ウォレットと支払いの枠」で自分の分を変えられ、
  変えた値（KVStore `spend-limit`）が環境変数より優先される。変えると今のセッションは破棄され、次の購入で
  新しい上限のセッションが切られる。AgentCore Payments にセッションの上限を後から変える API は無いため。
  天井は無い。期限は 15 分以上でなければ AgentCore Payments 側が受け付けない。
  値は**利用者 1 人・1 セッションあたり**で、セッションは利用者ごとに切る。有効なセッションは
  KVStore `payment-session` に利用者をキーに記録して使い回し、失効・削除で拒否されたら一度だけ作り直す。
  支出上限の超過では作り直さず失敗させる——作り直すと上限に当たった支払いがその場で通り、上限が上限でなくなるため）
- `BILLING_MCP_URL`（既定 `http://localhost:8000/mcp`）・`PAYMENTS_USER_ID`（既定 `sample-user-1`）
- `PAYMENT_MAX_AMOUNT`（1回の支払い上限。USDC の最小単位、既定 `100000` = 0.1 USDC）・
  `PAYMENT_PAY_TO`（任意。売り手アドレスを固定する）。ネットワークと資産は Base Sepolia +
  テスト USDC に固定しており、売り手の提示がこれに合わなければ支払わない
- `BUYER_TOOL_TIMEOUT_MS`（有料ツールの待ち時間。既定 `600000`。短くすると決済後に失敗して支払いだけが残る）
- `BUYER_RATE_LIMIT` / `BUYER_RATE_WINDOW_MINUTES`（利用者 1 人が依頼を出せる回数と、その時間窓。
  既定 `10` 回 / `60` 分。支払いに至らない依頼でも LLM の費用はかかるので、支出上限とは別に数える。
  超えた依頼は受け付けず、窓が明ける時刻を返す。記録は KVStore `request-count`）
