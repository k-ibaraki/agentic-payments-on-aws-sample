# billing-mcp（売り手）

依頼を受けて HTML ページを作る有料ツールを、x402 で課金しながら提供する MCP サーバー。
支払いを済ませた相手にだけツールが開く。生成物を表示するための画面（MCP Apps の UI）も
同じサーバーが配る。

## まず動かす

ローカルなら 3 コマンドで立つ。

```bash
cd server
cp .env.example .env   # PAY_TO_ADDRESS（売上の受取先）を自分のアドレスに変える
pnpm install && pnpm dev   # http://localhost:8000/mcp

pnpm buy:once          # 使い捨てウォレットで実際に買ってみる
```

`pnpm buy:once` は接続先を省くと `http://localhost:8000/mcp` に向く。ポート 8000 に古いサーバーが
残っていると、そちらに当たって紛らわしい 404 になるので、`lsof -nP -iTCP:8000 -sTCP:LISTEN` で
確かめてから起動すること。

クラウドへ出す手順は下の「デプロイ」にある。

## 認証を掛けない理由

**「支払った者にツールが開く」を x402 が単独で担う**のがこのサンプルの主張。
その手前に IAM や JWT のゲートを置くと、認可の主体が支払いではなく権限付与になってしまう。

無認証で公開する代わりに、支払いフローは `upfront`（決済の確定後に生成）とし、
reserved concurrency と関数タイムアウトで瞬間的な流量に上限を掛けている。
これは累積コストの上限にはならないので、必要なら AWS Budgets 等を併用すること。

添付ファイルは最大 1 件。Function URL のリクエスト上限 6MB（base64 後）に収めるため。

## 構成

```
billing-mcp/
├── billing-mcp.ts        # CDK エントリ（tsx 実行）
├── stacks/               # 関数ベースのスタック定義
├── test/                 # CDK Template テスト（jest + @swc/jest）
├── scripts/
│   └── verify-bundle.mjs # 合成したバンドルが読み込めるかの検証
├── parameter.sample.ts   # パラメータ雛形（parameter.ts は gitignore）
└── server/               # MCP Apps サーバー
    └── src/
        ├── app.ts        # MCP の fetch ハンドラ（ローカルと Lambda で共通）
        ├── handler.ts    # Lambda Function URL のエントリ
        ├── dev-server.ts # ローカル開発用の薄い node:http エントリ
        ├── tools/        # generate-html（有料ツール、x402 で課金）
        └── ui/           # ui:// で配信する単一 HTML（vite singlefile）
```

主要ライブラリ:
`@modelcontextprotocol/sdk` 1.30 系 / `@modelcontextprotocol/ext-apps` 1.7 系 / `@x402/*`（v2） / `aws-cdk-lib`（aws-lambda-nodejs）

## デプロイ

CDK のバンドルはサーバーの依存を解決し、vite singlefile の出力を zip に同梱するため、
先に `server` を用意しておく必要がある。

```bash
cd server && pnpm install && pnpm build:ui && cd ..

pnpm install
cp parameter.sample.ts parameter.ts   # payToAddress を自分のアドレスに変える
pnpm typecheck && pnpm test
pnpm synth && pnpm verify:bundle      # 合成したバンドルが実際に読み込めるかまで見る
pnpm cdk diff                         # 差分を確認してから
pnpm cdk deploy
```

クラウド上の決済検証は接続先を差し替えるだけでよい。

```bash
cd server
MCP_SERVER_URL=https://xxxx.lambda-url.ap-northeast-1.on.aws/mcp pnpm buy:once
```

## デプロイ後に値を取り出す（買い手への引き継ぎ）

出力は「買い手（agent-app）に引き継ぐ値」を揃えてある。deploy 時のログを遡らなくても、
いつでも次のコマンドで取り出せる（読み取りのみ。AWS CLI と有効な資格情報が要る）。

```bash
pnpm outputs         # parameter.ts の envName からスタック名を決める
pnpm outputs <名前>  # スタック名を直接指定する
```

| 出力 | 中身 | 買い手側の対応 |
| --- | --- | --- |
| `McpEndpointUrl` | 無認証の公開 MCP エンドポイント | agent-app の `BILLING_MCP_URL` |
| `PayToAddress` | 売上の受取先 | agent-app の `PAYMENT_PAY_TO`（任意。売り手アドレスを固定する）|
| `Price` | 段を判定できない呼び出しの退避額（`parameter.ts` で設定した場合のみ） | agent-app の `PAYMENT_MAX_AMOUNT` が松の価格を賄えるか確認する |
| `LogGroupName` | Lambda のロググループ名 | —（調査用）|

`Price` は `parameter.ts` で `price` を省くと出力されない。その場合はサーバー側の既定額が効く
（値を二重に持たないため、スタックからは出さない）。

## 価格（段階制）

価格は呼び出しごとに決まる（DESIGN.md 決定56）。売り手が依頼の内容から段を判じ、その段の価格を
根拠つきで提示し、同じ段の目安トークン数を生成の指示に織り込む。

| 段 | 目安 | 既定の価格 |
| --- | --- | --- |
| 梅 | 5,000 トークン | $0.1 |
| 竹 | 8,000 トークン | $0.15 |
| 松 | 12,000 トークン | $0.2 |

価格と目安は AppConfig から変えられる。`parameter.ts` に `appConfigExtensionLayerArn`
（AppConfig Agent Lambda extension のレイヤー ARN）を渡すと、Lambda がそこから価格表を読む。
渡さなければ上の既定値で動く。設定が読めないときは直前に読めた表を使い続けるので、
書き損じで売り手が止まることはない。

提示した額は見積書（決定55）として `accepts[].extra.quote` に載り、買い手がそのまま返す。
支払いのときは判定をやり直さずその値を使うので、同じ額で決済できる。価格表を差し替えた
直後の古い見積書は、表と食い違うため使われず、新しい額で提示し直す。

段の判定には Bedrock の Haiku を使う。`allowedModelIds` に
`jp.anthropic.claude-haiku-4-5-20251001-v1:0` を含めること。判定は無認証の経路で走るため、
呼び出し予算で単位時間あたりの費用に天井を付けている（決定57）。

**`McpEndpointUrl` は作り直すたびに変わる。** 過去のログや記録に載っている URL をそのまま使わず、
その時点の出力を取り直すこと。

`PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` は売り手ではなく買い手側の資源で、
agent-app の `npx tsx scripts/payments-setup.ts` が出力する（agent-app/README.md 参照）。

> **注意**: `pnpm cdk deploy` は無認証の公開エンドポイントをインターネットに出す。
> 誰でも Bedrock を動かせる状態になるため、`reservedConcurrency` と価格の設定を確認してから実行すること。

## 後片付け

検証が済んだら公開を閉じる。理由は 2 つある。

1. 支払いなしで叩ける経路（`initialize` / `tools/list` / `ui://` 取得）の
   Lambda 実行時間とログの課金が、出しっぱなしのあいだ積み上がり続ける
2. **テストネットでは x402 が経済的な抑止力にならない**。売上は Base Sepolia の
   テスト USDC（faucet で無料に手に入る）で、原価だけが実費の Bedrock ドルなので、
   正規に支払われても攻撃者の費用はゼロ。閉じないかぎり、実費の Bedrock を
   無料で配っているのと変わらない（DESIGN.md 決定8。2026-09-07 の点検で判明）

```bash
pnpm cdk destroy
```

再び必要になったら `pnpm cdk deploy` で作り直せる（Function URL は変わる）。

## 採らなかった構成

AgentCore Runtime・API Gateway・AgentCore + Cognito Identity Pool のゲスト資格情報を検討したうえで不採用にした。

- AgentCore Runtime: 匿名のインバウンドを許さず、認可は IAM（SigV4）か JWT の二択しかない。
  IAM で絞ると認可の主体が支払いではなく権限付与になり、x402 で課金する意味が消える
- API Gateway: HTTP API は統合タイムアウト 30 秒が上限。REST API も引き上げ不可の
  アイドル接続タイムアウト 310 秒があり、生成の上限 570 秒が通らない
- AgentCore + Cognito のゲスト資格情報: 実質の匿名公開はできるが、買い手に
  「ゲスト資格情報の取得と SigV4 署名」という AWS 固有の作法を強いる。
  事前の関係なしに HTTP と決済だけで買える、という x402 の売りが消える

Lambda の制限（リクエスト 6MB / 実行 15分）を超えたくなった場合は ECS へ移す。
