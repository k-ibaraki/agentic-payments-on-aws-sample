# billing-mcp（売り手: x402 課金付き MCP Apps）

x402 で課金する MCP Apps（HTML 生成ツール + プレビュー UI）を CDK で AgentCore Runtime にデプロイする。実装はこれから。

## 予定構成（ops-agent-sample-on-aws 方式）

```
billing-mcp/
├── billing-mcp.ts        # CDK エントリ（tsx 実行）
├── stacks/               # 関数ベースのスタック定義
├── test/                 # CDK Template テスト（jest + @swc/jest）
├── parameter.sample.ts   # パラメータ雛形（parameter.ts は gitignore）
└── server/               # MCP Apps サーバー（Dockerfile / linux-arm64 / :8000 の /mcp）
    └── src/
        ├── server.ts     # Streamable HTTP
        ├── tools/        # generate-html（有料ツール、x402 で課金）
        └── ui/           # ui:// で配信する単一 HTML（vite singlefile）
```

主要ライブラリ（DESIGN.md 決定3・5〜7参照）:
`@modelcontextprotocol/sdk` 1.30 系 / `@modelcontextprotocol/ext-apps` 1.7 系 / `@x402/*`（v2） / `aws-cdk-lib`（bedrockagentcore 安定版 L2）
