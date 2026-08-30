# agentic-payments-on-aws-sample

AWS 上で Agentic Payments（AI エージェントによる自律的な支払い）を試すサンプルモノレポ。

x402 プロトコルで課金する MCP Apps（UI 配信付き MCP サーバー）を Amazon Bedrock AgentCore Runtime 上に立て、
AWS Blocks 製のエージェント + Web アプリがそれを「支払いながら」利用する構成を目指す。

## 構成

| ディレクトリ | 役割 | 主な技術 |
| --- | --- | --- |
| `billing-mcp/` | 売り手。x402 課金付き MCP Apps（HTML 生成ツール + プレビュー UI） | MCP SDK 1.30 系 + ext-apps / @x402/*（v2） / CDK / AgentCore Runtime |
| `agent-app/` | 買い手。MCP を実行するエージェントと制御用 Web アプリ | AWS Blocks（Agent / AuthCognito ほか） |
| `docs/` | 設計決定録（DESIGN.md）・実装記録（implementation-log.md） | - |

## アーキテクチャ（計画）

```
[ブラウザ] ──(ui:// リソース取得・iframe 描画。無課金)──────────────┐
    │ 操作・Realtime 受信                                           │
[agent-app: AWS Blocks / ap-northeast-1]                            ▼
    └─ Agent (Lambda) ──(x402 支払い + 有料ツール実行)──> [billing-mcp: AgentCore Runtime / ap-northeast-1]
          │                                                  │ 検証・決済: x402.org facilitator
          └─ ウォレット: AgentCore Payments                  │ ネットワーク: Base Sepolia（テスト USDC）
              (ap-southeast-1・クロスリージョン)
```

## ステータス

土台（構成・規約・記録の仕組み）のみ。実装はこれから。
経緯と判断はすべて `docs/DESIGN.md` と `docs/implementation-log.md` に残す方針。

## 参考リポジトリ

- 機能の踏襲元: [k-ibaraki/html-creator-mcp-apps](https://github.com/k-ibaraki/html-creator-mcp-apps)
- CDK の作り・開発規約の参考: [k-ibaraki/ops-agent-sample-on-aws](https://github.com/k-ibaraki/ops-agent-sample-on-aws)
- AWS Blocks の参考: [k-ibaraki/handson-aws-blocks](https://github.com/k-ibaraki/handson-aws-blocks)
