# billing-mcp（売り手: x402 課金付き MCP Apps）

x402 で課金する MCP Apps（HTML 生成ツール + プレビュー UI）を CDK で **Lambda（Function URL・無認証）** にデプロイする。
`server/` は実装済み（ローカルで実オンチェーン決済まで検証済み）。CDK はこれから。

認証は掛けない。**「支払った者にツールが開く」を x402 が単独で担う**のがこのサンプルの主張であり、
その手前に IAM や JWT のゲートを置くと認可の主体が支払いではなく権限付与になってしまうため（DESIGN.md 決定19）。
無認証で公開する代わりに、支払いフローは `upfront`（決済確定後に生成）とし、
reserved concurrency と関数タイムアウトで損失の上限を設ける（同 決定21）。

## ローカル実行

```bash
cd server
cp .env.example .env   # PAY_TO_ADDRESS 等を設定
pnpm install
pnpm dev               # http://localhost:8000/mcp
pnpm buy:once          # 使い捨てウォレットで実決済テスト
```

## 予定構成（ops-agent-sample-on-aws 方式）

```
billing-mcp/
├── billing-mcp.ts        # CDK エントリ（tsx 実行）
├── stacks/               # 関数ベースのスタック定義
├── test/                 # CDK Template テスト（jest + @swc/jest）
├── parameter.sample.ts   # パラメータ雛形（parameter.ts は gitignore）
└── server/               # MCP Apps サーバー
    └── src/
        ├── handler.ts    # Lambda ハンドラ（Function URL / Streamable HTTP）
        ├── dev-server.ts # ローカル開発用の薄い node:http エントリ
        ├── tools/        # generate-html（有料ツール、x402 で課金）
        └── ui/           # ui:// で配信する単一 HTML（vite singlefile）
```

主要ライブラリ（DESIGN.md 決定3・5・7・19・22参照）:
`@modelcontextprotocol/sdk` 1.30 系 / `@modelcontextprotocol/ext-apps` 1.7 系 / `@x402/*`（v2） / `aws-cdk-lib`（aws-lambda-nodejs）

## 採らなかった構成

AgentCore Runtime・API Gateway・AgentCore + Cognito Identity Pool のゲスト資格情報を検討したうえで不採用にした。
理由は DESIGN.md 決定19・20 に記録している。Lambda の制限（リクエスト 6MB / 実行 15分）を超えたくなった場合は ECS へ移す。
