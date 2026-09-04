# 実装記録

作業のたびに日付見出しで、やったこと・判断・つまずきを記録する。設計決定そのものは DESIGN.md へ分離。

## 2026-09-04: フェーズ⑤の土台 — Amplify Gen2 への deploy 経路（決定33）

### やったこと

- ユーザー要望「開発は AWS Blocks のまま、deploy は Amplify へ（agent-app のみ）」を grill-me で確認。
  動機は「Amplify コンソールでバックエンドとフロントを一元管理し、git push で deploy」。既存の CDK 直経路
  （`npm run deploy`）は退路として残す、完了条件は sandbox への実デプロイまで、で合意（決定33）
- 追加したもの: `amplify/backend.ts`（`defineBackend({})` + `initBlocks`）、`amplify/blocks.ts`
  （`createStack('blocks')` の上に `BlocksBackend.create()`。CORS とクロスドメイン Cookie の環境変数、
  `custom.blocks_api_url` の出力）、`amplify/cors-origins.ts`（`AWS_APP_ID` から amplifyapp.com の
  正規表現を導く。テスト付き）、`amplify/package.json` / `amplify/tsconfig.json`（`npm create amplify`
  が書く内容の写し）、`aws-blocks/amplify.cdk.ts`（Amplify 用の CDK 入口。`index.cdk.ts` は単独 CDK アプリで
  読み込むだけでスタックと `Hosting` のビルドが走るため分けた）、`scripts/generate-blocks-client.ts`
  （`client.js` 生成。CDK 直経路と dev サーバーが内部でやっている処理を Amplify のビルド用に露出）、
  `scripts/blocks-config.ts` + `scripts/amplify-blocks-config.ts`（`amplify_outputs.json` →
  `dist/.blocks-sandbox/config.json`。テスト付き）、リポジトリ直下の `amplify.yml`（モノレポなので
  `applications[].appRoot: agent-app`）
- `package.json` に `amplify:sandbox` / `amplify:sandbox:delete` / `blocks:client` / `build:amplify` を追加し、
  vitest の対象に `amplify` と `scripts` を加えた。`tsconfig.json` の include に `amplify/**/*`、
  `.gitignore` に `.amplify` と `amplify_outputs*`
- 依存: `@aws-amplify/backend` 1.24.0 / `@aws-amplify/backend-cli` 1.9.0 / `cross-env` 7.0.3（手動で追加。
  `npm create amplify` は `aws-cdk-lib@2.244.0` を固定で入れ、Blocks 側の 2.267 と衝突するため使わなかった）
- `aws-blocks/index.ts` の `AuthCognito` に `BLOCKS_CROSS_DOMAIN` を足し、Block の id を短縮
  （`Scope 'app'` / `Agent 'buyer'` / `BlocksBackend 'b'`。後述）
- TDD: `corsAllowedOrigins` と `blocksConfigFromOutputs` の2モジュールを赤（モジュール未作成で import 失敗）→
  緑。`npm run test` / `typecheck` / `build` を通し、AWS 資格情報なしで `CDK_CONTEXT_JSON` を与えて
  `amplify/backend.ts` を `--conditions=cdk` で直接実行し、Lambda のバンドルまで到達することを確認した
- README（ルート・agent-app）と CLAUDE.md を更新

### 調査で分かった重要事実

- AWS Blocks は AWS 公式（2026-06-16 に public preview 公開、`docs.aws.amazon.com/blocks` に devguide）。
  devguide は Amplify を「補完関係（Amplify = hosting / CI/CD / マネージド体験、Blocks = IfC）」と位置づける
- `BlocksBackend.create()` は devguide「Integrating with existing infrastructure」Pattern 1 の公式 API。
  `@aws-blocks/core` 0.3.1 の `blocks-backend.ts` は `fullId` の説明で「Amplify Gen2 の
  `backend.createStack('blocks')` のネストスタック」を想定ケースとして明記している
- 公式 CLI `@aws-blocks/create-blocks-app` 0.1.21 には `templates/amplify/` があり、`amplify/backend.ts` を
  検出すると `amplify/blocks.ts`・`createBlocksBackend`・`NODE_OPTIONS="--conditions=cdk"` 付きの
  `amplify.yml`・`cross-env` のスクリプトを生成する。ただし `aws-blocks/` を雛形で上書きするため、
  既に Blocks で作ったプロジェクトには当てられない。今回の実装はこの生成物を写した
- CLI は「Blocks 主体で Amplify Hosting は CI/CD と配信だけ」の構成（`amplify.yml` から
  `cdk deploy --app="npx tsx -C cdk aws-blocks/index.cdk.ts"`）も案内している。今回は一元管理の要望で
  Amplify 主体（ネストスタック）を採った
- ブラウザの Blocks クライアント（`@aws-blocks/core` `client/index.js`）は API の URL を
  「`{ url }` 指定 → SSR の環境変数 → Node の `.blocks-sandbox/config.json` → ブラウザは同一オリジンの
  `/.blocks-sandbox/config.json` を fetch」の順で解決する。CDK 直経路では `Hosting` construct が
  相対 URL（`/aws-blocks/api`）を書いた config.json を配り CloudFront で API をプロキシするが、
  Amplify Hosting にはその層が無いので、絶対 URL を書いた config.json をビルドで置き、越境で呼ぶ
- dev サーバーは `BLOCKS_API_URL` があるとその API へプロキシする（sandbox 用）。Amplify の sandbox に
  ローカルのフロントを繋ぐのもこの経路で足りる
- `--conditions=cdk` が無いと Block がモック実装に解決され空のインフラが合成される。
  `BlocksBackend.create()` の冒頭で `assertCdkConditionActive()` が検査して落とす（黙って通りはしない）
- `ampx` は `amplify/backend.ts` を `tsx` の `tsImport` で直接読み込む。`cdk.json` の `app` は使われないので、
  CDK 直経路用の `cdk.json` と共存できる
- Amplify のルートスタック名は `amplify-<namespace>-<name>-<type>-<hash10>`。sandbox は
  namespace = `package.json` の name（英数字のみ、`agentapp`）、name = `--identifier`（既定は OS ユーザー名）。
  ブランチは namespace = appId（14 文字）、name = ブランチ名

### 判断・つまずき

- 参照記事（Zenn）を最初「公式ドキュメント未掲載の非公式ハック」と扱い、その懸念を前提に問いを組んだ。
  ユーザーの指摘で公式 devguide・CLI・ソースまで当たり直し、記事は公式機能のみで組まれていると確認して撤回した。
  下調べは一次資料まで当たってから問いを立てる、が教訓
- フロントと API を別オリジンにした理由: Amplify Hosting の rewrite（200 プロキシ）はアプリ単位の設定で
  ブランチごとの API URL に追随できず、Cookie 転送の挙動も未確認。別オリジン構成は `AuthCognito` の
  `crossDomain` と core の `CORS_ALLOWED_ORIGINS` に公式手順があり、現行 sandbox（localhost + API Gateway）と同じ形
- **S3 バケット名の 63 文字制限**: ローカル合成で `…-blocks-agent-app-buyer-agent-sn`（78 文字）が
  `ValidationFailed` で落ちた。Blocks は S3 名をスコープ id の連結で決め、短縮もハッシュ化も意図的にしない。
  Agent が内蔵する `FileBucket 'sn'` は既存バケットの指定もできない。Amplify のスタック名（36 + 識別子 /
  41 + ブランチ名）の下では id を縮める以外に手が無く、`b` / `app` / `buyer` に短縮（ユーザー決定。
  ブランチ名 7 文字以内・sandbox 識別子 12 文字以内が制約として残る）。予算の計算は決定33 の追記
- `npm run build` が `build-temp/` に `tsc` の出力を吐き、その中の `*.test.js` を vitest が拾って
  テスト件数が倍（10 ファイル 55 件 → 20 ファイル 110 件）になる。今回の変更で生じたものではなく
  以前からの挙動（`build-temp` は gitignore 済みで CI はビルド前にテストするため影響なし）。未修正、要判断
- この worktree は `mise.toml` が未信頼で `node` が起動できず、`mise trust` が要った
- `client.js` 生成時の `[Realtime] BLOCKS_RT_WS_URL not set` 警告は生成には無害（実行時の環境変数）

### sandbox 検証（同日）

- `npm run amplify:sandbox -- --once`（ap-northeast-1、識別子は既定の OS ユーザー名 12 文字）が 193 秒で完了。
  ルートスタック `amplify-agentapp-<識別子>-sandbox-<hash>` の下にネストスタック `blocks` ができ、
  Agent 内蔵の S3 バケット（`…-b-app-buyer-sn`、ちょうど 63 文字）も作成された。`amplify_outputs.json` に
  `custom.blocks_api_url`（API Gateway の `/prod/aws-blocks/api`）が出た
- API Gateway を直接叩いた結果: `api.whoAmI` / `buyer.getSellerInfo` は `401 NotAuthenticatedException`
  （認証が効いている）、`api.getLastCode` は `null`（`BLOCKS_STACK_NAME` によるクラウド判定でローカル専用の
  OTP 漏洩口が閉じている）。localhost オリジンからの preflight は `access-control-allow-origin` と
  `allow-credentials: true` を返した（sandbox モードの CORS）
- `npm run build:amplify` が `client.js` 生成 → `tsc` + `vite build` → `dist/.blocks-sandbox/config.json`
  （絶対 URL）まで通った
- `BLOCKS_API_URL=<blocks_api_url> npm run dev` でローカルの dev サーバーが `/.blocks-sandbox/config.json` を
  `{ apiUrl: "http://localhost:3000/aws-blocks/api", environment: "sandbox" }` で配り、RPC を sandbox の
  Lambda へプロキシした（同じ 401 が返る）。CDK 直の sandbox と同じ手順で Amplify の sandbox にも繋がる
- 検証後に `npm run amplify:sandbox:delete` で削除（187 秒）。ルートとネストの両スタックが
  `DELETE_COMPLETE` になり、`amplify-agentapp-*` は残っていない。ブラウザでのサインアップ（OTP）は
  ユーザー判断で省略し、疎通確認までで締めた
- 未検証: Amplify Hosting 上での配信（`.blocks-sandbox/` の成果物指定・ブランチ deploy の CORS・
  クロスドメイン Cookie）。コンソールでの GitHub 接続を伴うため次回、ユーザー操作で行う

### セルフレビュー（同日）

ブランチ `feat/amplify-deploy` の2コミット後にセルフレビューを実施し、指摘4件を全件修正した:

1. `build-temp/` の `*.test.js` が vitest に拾われ二重に走る（上記「判断・つまずき」の件。今回
   `amplify` / `scripts` を対象に加えて範囲が広がった）→ `vite.config.ts` に `test.exclude: build-temp/**`
2. `AGENTS.md` の deploy 節が CDK 直経路のみで決定33 と食い違う → Amplify のコマンドを正として追記
3. 決定32 の追記に Block id の変更が無く、構成図のラベルが旧 id のまま → 追記を補い、図の差し替え時に直すと明記
4. Amplify Hosting の外から `ampx pipeline-deploy` すると `AWS_APP_ID` が無く CORS 未設定のまま deploy
   される → `requireCorsAllowedOrigins`（テスト付き）で合成時に落とすようにし、README に明記

### PR #5 の CI 失敗と修正（同日）

- agent-app ジョブの `npm ci` が「lock と package.json が不整合」で失敗。`npm install --save-dev` で Amplify の
  依存を足したときに書かれた `package-lock.json` に、`@aws-amplify/backend-cli` 配下が要求する
  `zod@3.25.17` や `@aws-cdk/toolkit-lib` などが記録されていなかった（`node_modules` には入っていたため
  手元のテストは通っていた。`npm ci --dry-run` で再現）
- `npm install` の再実行では直らず、いったん `node_modules` と lock を消して作り直したところ、
  `@aws-blocks/blocks` の指定が `"*"` のため AWS Blocks が 0.3.1 → 0.4.0 に、`aws-cdk-lib` が
  2.267 → 2.268 に上がった。sandbox で検証した版から動かしたくないので採らず、HEAD の lock を戻して
  `npm install --package-lock-only` で不足分だけ補った（+1,556 行。`@aws-blocks/*` と `aws-cdk-lib` は据え置き）。
  `npm ci` で入れ直して test / typecheck を確認
- 教訓: `@aws-blocks/blocks` が `"*"` である限り、lock の全体再生成は框架の版を黙って動かす。
  lock を直すときは `--package-lock-only` で差分に留めること（版を上げるときは意図して行う）

## 2026-09-03: AWS 構成図の作成（docs/architecture.drawio.png）

### やったこと

- アプリが②〜④で膨らんだので、全体を 1 枚で見渡せる AWS 構成図を起こした。成果物は
  `docs/architecture.drawio.png`（draw.io の XML を埋め込んだ PNG。決定32）
- 構成の裏取りは想像ではなく合成結果で行った。`agent-app` で `npx cdk synth` を通し、
  出来上がった CloudFormation テンプレートからリソース種別と論理 ID を数え上げた。
  売り手側は `billing-mcp/stacks/billing-mcp-stack.ts` を直接読んだ
- 図には有料経路（赤の実線）と無課金経路（青の破線）、補助の経路（灰色）を色で分けて引き、
  ①〜⑪ の番号を振って図の下に「処理の流れ」を並べた。決定10・11・29 の二経路が図の主題になる

### `cdk synth` で分かったこと（ブロックのドキュメントだけでは分からなかった）

- **AWS Blocks の Lambda は 1 本しか出ない**。`Handler`（900 秒 / 2048 MB）が API Gateway（REST）の
  統合・WebSocket の 3 ルート・SQS のイベントソースをすべて兼ねる。ブロックごとに関数が分かれるのだと
  思い込んでいたが、テンプレート上は `Handler886CB40B` 一つに全部ぶら下がっていた
- Realtime の実体は **API Gateway WebSocket（ApiGatewayV2）**。`bb-agent` のドキュメントには
  「AppSync Events」と書いてあるが、合成結果には AppSync が一切出てこない。ドキュメントの方が古い
- DynamoDB は 5 表（`auth-sessions` / `purchased-html` / `buyer-agent-convos` /
  `buyer-agent-messages` / `buyer-agent-rt-connections`）、S3 は 4 バケット
  （Hosting / アクセスログ / blocks-config / `buyer-agent-sn`）、SQS は本キューと DLQ の 2 本
- CloudFront のオリジンは 2 つ（S3 と API Gateway REST の `/aws-blocks/api`）。
  ブラウザは API Gateway を直接叩かず、必ず CloudFront を経由する
- Bedrock は買い手（`BedrockModels.BALANCED`）と売り手（`jp.` 推論プロファイル）で
  呼び出し元が別。同じサービスだが役割が違うので図でも別のアイコンに分けた

### 判断・つまずき

- 図が示すのは**フェーズ⑤の deploy 時にできる構成**で、④時点の実際の姿ではない。
  買い手はローカル実行、売り手は検証後にスタック削除済み。黙って「動いている構成図」に
  見せるのは嘘になるので、図の中に「現況」の枠を置いて両方を明記した
- 買い手と売り手のまとまりは CloudFormation スタック単位ではなく**役割単位**で囲った。
  Bedrock と AgentCore Payments はスタックの持ち物ではないが、どちらが呼ぶかを図で示したかったため
- draw.io のアイコン名は当てずっぽうだと無言で空箱になる。desktop アプリの `app.asar` を展開して
  `stencils/aws4.xml` の `name` 属性を実際に引き当ててから使った
  （名前は「空白を `_` に置換して小文字化」でスタイル名になる）。`Bedrock AgentCore` のアイコンも存在した
- 配線が図形のラベル文字を貫く問題が 2 回出た。Handler のラベルは 4 行あって左右に広く、
  真下に線を引くと必ず文字を横切る。SQS との往復を 1 本の双方向エッジにまとめ、
  ラベルの外側（`x=970`）を通す経路に変えて解消した
- 中間ファイルの `.drawio` は残していない。PNG から XML を取り出せることを確認済み
  （62 セル・33,031 文字が往復した）

### ユーザーレビューでの手戻り（同日）

- 指摘は 3 点。(a) 線が黒くて見づらい、(b) 交差が多い、(c) AgentCore Payments が買い手側なのに
  売り手の右に置かれていて分かりにくい。左右でなく上下を使えないか
- (c) は配置の組み替えで応えた。ap-southeast-1 の枠を**買い手の真下**に置き、④ を Handler から
  真下に落とす 1 本の縦線にした。外部サービスもそれぞれの呼び出し元の真下（Coinbase は Identity の下、
  facilitator は売り手の下）に並べ、幅を 2,140 → 1,780 に縮めた
- (b) は「通路を先に決めてから線を引く」やり方で交差をゼロにした。Handler のラベルを上側へ移して
  下辺を空け、右辺の出口を ③ ⑤ ④ ⑨ の順に 15 px 刻みで並べ、縦の通路（x=1000 / 1150 / 1180 / 1010）を
  互いに跨がないよう配った。⑤ と ⑪ が McpFunction で交差する問題は、⑤ を左辺・⑪ を上辺に入れて解消
- (a) は取り違えた。枠線の色だと思い込んで `light-dark(明,暗)` 記法（59 箇所）を入れたが、指摘は
  **AWS アイコン内部の絵柄**が黒いことだった。`shapes/mxAWS4.js` を読むと `resourceIcon` は絵柄を
  `strokeColor` で塗り、無指定なら `#000000` に落ちる。初版は `strokeColor=none` としていたのが原因で、
  公式どおり `#ffffff` に直した（15 個）。`light-dark()` は暗い背景で開いたときの見やすさとして残した
- 修正は PNG に埋め込まれた XML を取り出して行った。取り出した中身は既に `<mxfile>` 付きで、
  それをもう一度 `<mxfile>` で包んだところ 52×52 の空 PNG が出た（draw.io は黙って空を返す）。
  埋め込み XML を編集するときは包み直さない
- ⑤ の矢印が「上がって右へ、また下りて右へ」と不自然に曲がっていた。DynamoDB が Handler の右隣に
  あった頃の迂回路が、DynamoDB を下段へ移した後も残っていただけで、今は真っ直ぐ引いても何も貫かない。
  グループの隙間で一度だけ曲がる L 字にした（交差は増えない）
- 図中の「決定N」（23 箇所）は全て外した。図だけ見る人には読み取れない番号だという指摘。
  設計録への導線はタイトル欄の docs/DESIGN.md への言及だけにした
- 無課金経路の青い破線は実線に改めた。「破線」に意味を持たせても伝わらないので、有料＝赤・無課金＝青と
  色だけで区別する（凡例の見本も合わせて実線に）
- 「ui:// が無課金なら中身を無料で掠め取られないか」という問いに、コードを読んで「取られる中身が無い」と答えた
  （静的な空の表示器を返すだけ。生成は upfront の決済後にしか起きない）。ただ「無課金」の一語では中身が
  無料に読めるため、図の凡例・⑪・売り手ノート・手順パネル、README の略図、決定11 の補足を
  「空の表示器の取得（生成物は含まない）」に揃えた。サーバーコードのリソース説明文は据え置き
- DynamoDB のラベル「5 表」は「5 テーブル」に改めた。字数を詰めるための略が日本語として不自然だった
- 買い手側を **Block のインスタンス単位** で囲み直した（ユーザー指摘）。最初は Realtime や Hosting も
  独立した囲みにしようとしたが、「コードで宣言している Block 単位」と正された。宣言は `AuthCognito('auth')` /
  `Agent('buyer-agent')` / `KVStore('purchased-html')` / `ApiNamespace('buyer')` / `ApiNamespace('api')` の 5 つで、
  2 つの ApiNamespace は 1 本の REST API を共有するので囲みは 1 つにした。Realtime（WebSocket と
  rt-connections 表）は Agent の内側、CloudFront と S3 は `Hosting` construct なので「Block ではない」と注記、
  `Handler` は全 Block 共有なので囲みの外の中央に置いた
- 囲みを入れると題字と縦線がぶつかる。ApiNamespace は題を 2 行に割ってアイコンを右に寄せ、Agent は
  題を短くして内蔵要素の列挙を箱の右下に小さく移した。Handler からの扇状の配線は「遠い列ほど高い y で
  曲がる」規則で交差を避けた（交差ゼロのまま）

## 2026-09-03: フェーズ④着工 — 前提検証（grill-me）と方針決定

### 着工前の詰め（grill-me）で崩れた前提

- worktree は 3 つではなく **4 つ**（`glacial-salmon` が detached HEAD で増えていた）。作業は本体 worktree で
  `main` から `feat/integration` を切って行うことにした
- `.env` は本体 worktree に**既に両方あり**、複製は不要だった。一方 `agent-app/node_modules` が無く
  `npm install` が要った。`billing-mcp/parameter.ts` は本体にも teal-linden にも無く、②の
  worktree（plush-breeze）からのみ複製できた
- **CORS は③時点で実装済み**（`billing-mcp/server/src/app.ts` が allow-origin `*` と OPTIONS 応答を
  自前で返す）。依頼文の「設定が要る」は「クラウド上でブラウザから未検証」が正確
- 依頼文が見落としていた重い事実: 売り手の preview-view は `app.ontoolresult` を待つだけの作りで、
  ui:// を iframe に入れただけでは何も映らない。ブラウザが MCP Apps の**ホスト**（`AppBridge`）を
  実装し、`getPurchasedHtml` で取った HTML を `sendToolResult` で注入して初めて描画される（決定29）
- `tool-result` チャンクは `toolName` しか運ばない（bb-agent 0.3.1 の実装を読んで確認）。
  ブラウザが resultId を知るには会話メッセージの `metadata.toolOutput` を読む経路が要る

### 裏が取れた前提

- PaymentManager READY / Connector READY / Instrument ACTIVE。ウォレット残高 0.7 テスト USDC
  （Base Sepolia の RPC で `balanceOf` を実測）。WalletHub 委任の期限は API から読めず未検証
- `BillingMcpStack-dev` は DELETE_COMPLETE で AWS 上に無い
- `useChat`（`@aws-blocks/bb-agent/client`）は React 非依存で、雛形の vanilla DOM のまま使える

### 節目の確認事項

- **U5**: ext-apps の npm 最新は 1.7.5（2026-07-23 公開）、peer は sdk ^1.29 のまま。v2 対応は無く
  決定3 は据え置き（DESIGN.md U5 に追記）
- **Coinbase の課金**: Cost Explorer の AWS Marketplace 明細（8/25〜9/2）に Coinbase の行は**ゼロ**。
  表示されるのは Bedrock の Claude（Marketplace 経由）のみ。9/3 分は反映待ちで後日再確認する

### ユーザー決定（grill-me の問答）

1. ④の完了条件は agent-app ローカル + 売り手クラウド。クラウド deploy は⑤へ（決定28）
2. 描画経路は「ui:// ホスト実装 + getPurchasedHtml 注入」（決定29）
3. ローカルの LLM は `model.local` に Bedrock を指定（決定28）
4. ④で扱う繰り越し課題は「buyer API を通る e2e」と「購入単位の冪等キー」（決定30）。
   支払い主体の二重化・selfSignUp とレート制限は⑤へ
5. 売り手の再デプロイは UI がローカル売り手で通ってから。deploy と destroy の直前に確認を取る
6. 作業場所は本体 worktree の新ブランチ

### 段取り

1. 決定録・実装記録の追記（本エントリ）
2. バックエンド: todos デモと雛形 API の撤去、`model.local`、冪等キー、購入一覧 API、
   売り手情報 API（ブラウザが ui:// を取りに行く先）。TDD
3. フロント: 認証 + チャット（useChat）+ チャンク表示 + MCP Apps ホスト（AppBridge）
4. buyer API を通る e2e（認証込み・所有検証込み）
5. ローカル売り手で縦串 → 売り手をクラウドへ（確認）→ CORS・CloudWatch を実測 → destroy（確認）

## 2026-09-02〜03: フェーズ③ 縦串検証成功 — Agent が AgentCore Payments で実決済

### 結果

**Agent が AgentCore Payments のウォレットで 0.1 テスト USDC を支払い、billing-mcp の
有料ツールを実行して HTML を受領・保存する縦串が通った**（決定27 の検証完了）。

- 決済: tx `0xa0e35a61…29ca5`（Base Sepolia、成功）。買い手 1.0 → 0.9 / 売り手 0.22 → 0.32 USDC
- 成果物: HTML 3,149 バイトが structuredContent のまま欠損なく届き、KVStore に保存
  （U6 回避＝決定25 の実地確認）。会話には resultId のみが返る（決定10 の形）
- 経路: Agent（ローカル、LLM は canned）→ ProcessPayment(CRYPTO_X402) で支払い証明
  → `_meta["x402/payment"]` 付き再呼び出し → 売り手が x402.org facilitator で清算（upfront）
  → Bedrock 生成 → 成果物返却。支払い・清算・生成はすべて本物

### セットアップで実測した事実（ドキュメントに無い・薄いもの）

- Coinbase コネクタは AWS Marketplace サブスクリプション加入後も、QUICK_CREATE（OAuth）が
  AWS コンソールの支払い画面の白画面（描画不能）で3回失敗。**MANUAL（CDP キー持参）へ切替**して解決。
  CDP の API キー発行時、IP allowlist は空にする（キーを使うのは AWS 側サービスのため）
- サービスロールの許可ポリシーの workload-identity パターンも **PaymentManager 名の小文字化**の
  影響を受ける（camelCase のままだと GetWorkloadAccessToken が拒否され
  「Failed to obtain workload access token」で CreatePaymentInstrument が落ちる）
- ウォレットは作成直後から status ACTIVE だが、**WalletHub での Delegated signing 許可
  （エンドユーザー操作・有効期限つき）が済むまで ProcessPayment は
  「Delegated signing grant is not active」で拒否される**。ステータスでは判別できない
- WalletHub のログインには CDP プロジェクトの Domains 許可リストへの
  `https://hub.cdp.coinbase.com` 追加が必要（無いと OAuth が CORS エラー）。
  ④のブラウザ UI 用に `http://localhost:3000` も追加済み
- 旧使い捨て買い手はガス用 ETH ゼロで ERC-20 送金不可（フェーズ②は EIP-3009 の
  gasless 署名のみだったため）。資金供給は **CDP faucet**（`agent-app/scripts/faucet.ts`）へ切替
- ProcessPayment の応答 status は `PROOF_GENERATED` のみ。清算（settle）は売り手側
  facilitator の仕事で、AgentCore は署名だけを担う分担が API 面からも確認できた
- `aws login` の資格情報は12時間で切れる。切れた際の再認証はユーザー操作

### 不手際と対処（詳細はリポジトリ外に記録）

ウォレットの紐づけメールアドレスを、ユーザーの明示的な事前許可なく設定して作成する
不手際があった。当該ウォレットは削除し（リポジトリ・git 履歴への個人情報の混入が
無いことも全域検査で確認）、ユーザー指定のアドレスで再作成した。再発防止策は
リポジトリ外のグローバル設定に記録した（個人情報に類する値は、明示的な事前承認なく
外部サービス・コマンド・リポジトリ内ファイルに一切使わない）。

### セルフレビュー（2026-09-03、PR 作成前）

4件を指摘して修正した。

1. buyer API の所有検証が `getMessages` にしか無く、他人の会話へ発注（実費が発生）・
   ストリーム購読・購入物の取得ができた → `sendMessage` / `getChannel` にも検証を追加し、
   購入物のキーを `${userSub}/${resultId}` で名前空間分離
2. 決定9 が Quick Create のまま → MANUAL への変更経緯を追記
3. QUICK_CREATE 前提のコメント3箇所と README → MANUAL の実態に是正
4. `@smithy/types` が未宣言 → dependencies へ

修正後に縦串を再実行し、決済〜受領が通ることを確認（tx `0x539952ca…ce8b9`、0.1 テスト USDC）。
ただしこの再検証は `buy-via-agent.ts` が Agent を直接叩くため、修正した buyer API 自体は
通っていなかった（下記 PR レビューで指摘）。

### PR #2 レビュー（2026-09-03、9観点の並列レビュー）

26件の指摘のうち上位21件を修正した。自分のセルフレビューを素通りした指摘が複数あり、
「**検証が変更面を迂回している**」という失敗形（フェーズ②の GET/SSE と同型）が再発していた。

修正した主なもの:

- **`sendMessage` の channelId が未検証**（セルフレビューの修正漏れ）→ channelId 引数を廃し
  会話 ID に固定。`getChannel` も会話 ID で受ける
- **支払い条件の未検証** → 支払いポリシー（ネットワーク・資産・1回上限・任意で宛先）を
  `x402-payer` に入れ、合致しない提示には署名を求めない。上限は `PAYMENT_MAX_AMOUNT`
- **決定25 の記述が着工前の見込みのまま**（`PaymentClient` / `@x402/*` 依存）→ 実装に合わせて更新
- **委任 URL が ACTIVE 時に表示されない**（決定27 が記録した失敗モードそのもの）→ 常に表示
- **支払い済みで成果物を得られない経路で tx を捨てていた** → レシートを KVStore に残し signal を出す
- **`tsconfig` の include に `scripts/` が無く CI 未検査** → 追加したところ型エラー3件が即座に露出
- パース失敗と「支払い要求でない」の混同 → `accepts` があるのに解釈できなければ例外。
  上流に合わせ extra は任意、未知フィールドは通す（passthrough）
- 所有ガードを純関数に切り出してテスト、SDK クライアントの作り捨て解消、
  `loadEnvFile` の `fileURLToPath` 化、Secrets Manager の絞り込み、fund-wallet の revert 判定、
  価格のハードコード除去、CLAUDE.md のコマンド節、決定9/26 の補足、など

修正後に縦串を再実行し、支払いポリシーが本物の売り手提示（Base Sepolia / テスト USDC /
100000 = 0.1 USDC）を受け入れて決済〜受領が通ることを確認した
（tx `0x05bdf33e…b986d`、HTML 3,079 バイト）。`tsconfig` に `scripts/` を含めた
ことで露出した型エラー3件（`PaymentInstrumentStatus` に無い `INACTIVE` との比較など）も
同時に修正した。

### 残していること（フェーズ④へ）

- **支払い主体の二重化**: ProcessPayment の userId はウォレットの持ち主（`PAYMENTS_USER_ID`、
  全利用者で共有）で、購入物の所有者は Cognito の userSub。利用者ごとの支出上限や
  Payments 側の監査で「誰が支払わせたか」を追うには、利用者ごとの instrument 発行と
  WalletHub 委任が要る。自己サインアップ + 実費 API の組み合わせにレート制限も無い
- **buyer API を通る自動テストが無い**: 所有ガードの規則は純関数でテストしたが、API 経路
  （認証込み）は e2e で押さえていない。④の UI 実装と合わせて e2e を足す
- 検証用 PaymentSession は60分で失効する。④の結合検証時は `payments-setup.ts` を再実行して作り直す
- WalletHub の Delegated signing 許可は7日で失効する（切れたら redirectUrl から再許可）
- ローカル LLM は canned プロバイダのまま。④はデプロイ（Bedrock）で実施
- スキャフォールド由来の todos デモの撤去と UI 置き換え、Realtime 配線、売り手の再デプロイ

### 実装（同日）

- バックエンド: todos デモ・DistributedTable・雛形 API を撤去し、`buyer` 名前空間に
  `listPurchases` / `getSellerInfo` / `resume` / `getPendingInterrupts` を追加。`model.local` を Bedrock に
  （`BUYER_LOCAL_MODEL=canned` で偽 LLM）。購入単位の冪等キー（決定30）
- フロント: 認証 + チャット（`useChat`）+ チャンク表示 + MCP Apps ホスト（`src/mcp-apps-host.ts`。
  `AppBridge` + `PostMessageTransport`、sandbox iframe + srcdoc）。決定29
- buyer API を通る e2e（`test/e2e.test.ts`）: サインアップ → 会話 → 送信 → 履歴 → 購入一覧 →
  売り手情報、他人の会話の拒否、未認証の拒否。3 件通過。開発サーバーが生成する
  `aws-blocks/client.js` を待ってから import する必要があった（無いと ERR_MODULE_NOT_FOUND）
- Realtime 配線の実測（決定26 の補足）: ブラウザから `useChat` で購読し、Bedrock（ローカル）の
  返答が `text-delta` → `done` で届いた。`tool-call` / `tool-result` も届く（後述）

### 事故: タイムアウトで決済後に諦め、LLM が自動再試行して二重に支払った

ブラウザから「猫カフェの紹介ページを作って」と依頼したところ、ツール呼び出しが 2 回走り、
どちらも成果物なしで終わった。オンチェーンでは 20:01〜20:03 に 0.1 USDC の送金が 4 件
（うち 2 件は並行して行われた別セッションの操作分）。買い手残高 0.7 → 0.3。

- 原因1: MCP SDK の `callTool` 既定タイムアウトが 60 秒で、売り手の Bedrock 生成（今回 60 秒超）
  より短い。売り手は upfront で決済済みのまま生成を続け、買い手だけが諦めた。③では生成が
  短く露見しなかった
- 原因2: 例外は決済後に起きるのに「支払い済み」の情報を持たず、レシートも残らず、
  LLM は「失敗」と見て自動で再購入した
- 原因3（記録の不手際）: 両サーバーの標準出力を `head` / `grep` のパイプで受けていたため、
  決定的な場面のログが残らなかった。ファイルへのリダイレクトに改めた
- 対処: 決定31（タイムアウト 600 秒、`PaidToolError`、会話に未解決の支払いがあれば
  `interrupt` で人の承認、プロンプトでも再試行禁止）。ユーザー決定

### 防護を入れて再検証（同日）

- 通常のタイムアウト（600 秒）で再度ブラウザから依頼: ツール呼び出し 1 回、支払い 1 回
  （tx `0x095937df…66520`、0.1 USDC）、HTML 9,667 バイトを受領。購入一覧に表示され、
  「表示」で **ブラウザが売り手の ui:// を取得（別オリジン、CORS 実証）→ AppBridge で初期化 →
  HTML を注入 → 二重の sandbox iframe に描画**まで通った（決定29 の実地確認）。
  ブラウザのコンソールに 405 が 1 件出るが、MCP クライアントが単独 SSE（GET）を試みて
  売り手が仕様どおり 405 を返すもの（決定22）で無害
- 決定31 の防護を実地で検証: `BUYER_TOOL_TIMEOUT_MS=4000` で決済後の失敗を故意に起こし
  （0.1 USDC、成果物なし）、①レシート（resultId・nonce）が購入一覧に「失敗・支払い済み」で出る
  ②LLM は自動再試行せず報告する ③同じ会話で再依頼すると `interrupt` が Realtime で届き、
  画面に承認ボタンが出る ④「やめる」で購入せず残高が変わらない（0.1 のまま）ことを確認
- ブラウザは直近の会話 ID を localStorage に持ち、再読込後に `loadConversation` で再開する
  （購入一覧とプレビューに戻れるようにするため）

### PR #3 レビュー（2026-09-03、9観点の並列レビュー）

10 件の指摘のうち、意図的な運用方針である「Issue が無い」（決定14）を除く 9 件を修正した。
セルフレビューを素通りした指摘が複数あり、特に UI の後始末とコメントの正確さに漏れが集中していた。

- **承認しても未解決の支払いが解消されない**（設計。決定31 の意図と食い違い）→ 判定対象を最後の成功より後の
  失敗に限定。事故 → 承認して成功 → 次は承認不要、という流れを実測で確認
- **サインアウトしてもプレビューの iframe と状態表示が消えない** → `discardConversation` で必ず外すようにし、
  ブラウザで「前の利用者のページが次の利用者に見えない」ことを確認
- **購入一覧の取得失敗が画面に出ない**（`void` で握りつぶし）→ 失敗を events と一覧の両方に出す
- **一時的な失敗でも会話を丸ごと忘れる** → 会話を捨てるのは所有検証で弾かれたときだけにし、
  購入一覧の取得失敗では捨てない
- **タイムアウトの根拠「Lambda 570 秒」が誤り** → 実際は Bedrock 570 秒・Lambda 600 秒。2 箇所を是正
- **新設した `resume` / `getPendingInterrupts` が所有検証の e2e から漏れていた**（③と同じ「検証が変更面を
  迂回する」失敗形）→ 他人の会話への承認・確認も拒否されることをテストに追加
- **MCP Apps ホストにテストが無い** → DOM に依存しない解釈の部分（`pickUiHtml` / `parseDownloadRequest`）を
  純関数に切り出してテスト。`npm run test` の対象を `aws-blocks src` に広げ、`src/` が検査範囲から
  構造的に外れていた状態を解消した（③の「CI の検査範囲を疑う」と同じ形）
- コメントの不正確さ 2 件（e2e の前提、View 初期化のタイムアウトが待つ対象）を是正


### 残していること（④の続き・⑤へ）

- **売り手のクラウド再デプロイと結合**（`pnpm cdk deploy` → `BILLING_MCP_URL` 差し替え → ブラウザから
  実決済 → CloudWatch を読む → `cdk destroy`）。ユーザー判断で同日は見送り。`billing-mcp/parameter.ts`
  は plush-breeze から本体へ複製済み。買い手ウォレットは CDP faucet で補充済み（1.1 テスト USDC）
- 売り手側の冪等化（同じ支払い証明の再提示には再決済せず成果物を返す）。決定31 の限界。
  返金に相当する仕組み（`authorization` / `escrow` フロー）と合わせて **U7** に起票（今回の実装では踏み込まない。ユーザー決定）
- ⑤（agent-app のクラウド deploy）: 支払い主体の二重化、selfSignUp とレート制限、`PAYMENT_*` の
  Lambda 配線と AppSetting 化、別オリジンでの HTML 配信の検討。
  **着手前条件**: Agent を実行する AsyncJob の Lambda タイムアウトを `BUYER_TOOL_TIMEOUT_MS`（600 秒）以上にする。
  短いと買い手側のタイムアウトが働かず「決済後に諦める」事故（決定31）が再発する
- **PaymentSession の作成をアプリに組み込む**（ユーザー決定）: 手動が避けられないのは WalletHub の委任と
  初回 provisioning のみ。ツールハンドラが有効なセッションを KVStore で確認し、無ければ
  `CreatePaymentSession` で切る。失効で `ProcessPayment` が拒否されたら一度だけ作り直す（支払い証明を
  送る前なので二重支払いにはならない）。残る設定は `PAYMENT_MANAGER_ARN` と `PAYMENT_INSTRUMENT_ID`
- **残高の推移を画面に出す**（ユーザー決定）: 購入の前後でウォレット残高を表示する。AgentCore Payments の
  API に残高取得があるか要確認。無ければ Base Sepolia の RPC で `balanceOf`（本セッションの検証で使った方法）
- PaymentSession は 60 分で失効（上記の組み込みまでは `payments-setup.ts` の再実行）。WalletHub の委任は
  2026-09-10 まで（決定27）
- Coinbase の Marketplace 課金は 9/3 分の反映後に再確認
- ブラウザの MCP クライアントが単独 SSE（GET）を試みてコンソールに 405 が出る（無害）。気になるなら
  クライアント側で GET を抑止する方法を探す


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
