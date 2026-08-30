# billing-mcp（売り手: x402 課金付き MCP Apps）

x402 で課金する MCP Apps（HTML 生成ツール + プレビュー UI）を、CDK で **Lambda（Function URL・無認証）** にデプロイする。
サーバー・CDK ともに実装済み。クラウド上での実オンチェーン決済検証は未実施。

認証は掛けない。**「支払った者にツールが開く」を x402 が単独で担う**のがこのサンプルの主張であり、
その手前に IAM や JWT のゲートを置くと認可の主体が支払いではなく権限付与になってしまうため（DESIGN.md 決定19）。
無認証で公開する代わりに、支払いフローは `upfront`（決済確定後に生成）とし、
reserved concurrency と関数タイムアウトで損失の上限を設ける（同 決定21）。

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

主要ライブラリ（DESIGN.md 決定3・5・7・19・22参照）:
`@modelcontextprotocol/sdk` 1.30 系 / `@modelcontextprotocol/ext-apps` 1.7 系 / `@x402/*`（v2） / `aws-cdk-lib`（aws-lambda-nodejs）

## ローカル実行

```bash
cd server
cp .env.example .env   # PAY_TO_ADDRESS 等を設定
pnpm install
pnpm dev               # http://localhost:8000/mcp
pnpm buy:once          # 使い捨てウォレットで実決済テスト
```

`pnpm buy:once` は `MCP_SERVER_URL` を省略すると `http://localhost:8000/mcp` に向く。
**ポート 8000 に古いサーバーが残っていると、そちらに当たって紛らわしい 404 になる**ので、
`lsof -nP -iTCP:8000 -sTCP:LISTEN` で確認してから起動すること。

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

デプロイすると `McpEndpointUrl`（無認証の公開 MCP エンドポイント）と `LogGroupName` が出力される。
クラウド上の決済検証は接続先を差し替えるだけでよい。

```bash
cd server
MCP_SERVER_URL=https://xxxx.lambda-url.ap-northeast-1.on.aws/mcp pnpm buy:once
```

> **注意**: `pnpm cdk deploy` は無認証の公開エンドポイントをインターネットに出す。
> 誰でも Bedrock を動かせる状態になるため、`reservedConcurrency` と価格の設定を確認してから実行すること。

## 採らなかった構成

AgentCore Runtime・API Gateway・AgentCore + Cognito Identity Pool のゲスト資格情報を検討したうえで不採用にした。
理由は DESIGN.md 決定19・20 に記録している。Lambda の制限（リクエスト 6MB / 実行 15分）を超えたくなった場合は ECS へ移す。
