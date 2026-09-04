# agentic-payments-on-aws-sample

AWS 上で Agentic Payments（AI エージェントによる自律的な支払い）を試すサンプルモノレポ。

x402 プロトコルで課金する MCP Apps（UI 配信付き MCP サーバー）を AWS Lambda（Function URL・無認証）上に立て、
AWS Blocks 製のエージェント + Web アプリがそれを「支払いながら」利用する構成を目指す。

## 構成

| ディレクトリ | 役割 | 主な技術 |
| --- | --- | --- |
| `billing-mcp/` | 売り手。x402 課金付き MCP Apps（HTML 生成ツール + プレビュー UI） | MCP SDK 1.30 系 + ext-apps / @x402/*（v2） / CDK / Lambda + Function URL |
| `agent-app/` | 買い手。MCP を実行するエージェントと制御用 Web アプリ | AWS Blocks（Agent / AuthCognito ほか） |
| `docs/` | 設計決定録（DESIGN.md）・実装記録（implementation-log.md）・AWS 構成図（architecture.drawio.png） | - |

## アーキテクチャ（計画）

構成図（AWS リソースと決済の経路）は [docs/architecture.drawio.png](docs/architecture.drawio.png) にある。draw.io で開けばそのまま編集できる。以下は経路だけを抜き出した略図。

```
[ブラウザ] ──(ui:// の空の表示器を取得・iframe 描画。無課金。生成物は含まない)──┐
    │ 操作・Realtime 受信                                             │
[agent-app: AWS Blocks / ap-northeast-1]                              ▼
    └─ Agent (Lambda) ──(x402 支払い + 有料ツール実行)──> [billing-mcp: Lambda Function URL / ap-northeast-1]
          │                                                    │ 認可は x402 の支払いのみ（無認証）
          └─ ウォレット: AgentCore Payments                    │ 検証・決済: x402.org facilitator
              (ap-southeast-1・クロスリージョン)                │ ネットワーク: Base Sepolia（テスト USDC）
```

なお agent-app はフェーズ⑤まではローカル実行で、上図の Lambda 一式はまだ AWS 上に無い。billing-mcp も検証後にスタックを削除しており、必要なときに `cdk deploy` で作り直す。

## ステータス

- billing-mcp: 実装・CDK・デプロイ・クラウド上での実オンチェーン決済検証まで完了（フェーズ②完了）。検証後にスタックは削除済みで、必要なときに `cdk deploy` で作り直す
- agent-app: これから

経緯と判断はすべて `docs/DESIGN.md` と `docs/implementation-log.md` に残す方針。

## 参考リポジトリ

- 機能の踏襲元: [k-ibaraki/html-creator-mcp-apps](https://github.com/k-ibaraki/html-creator-mcp-apps)
- CDK の作り・開発規約の参考: [k-ibaraki/ops-agent-sample-on-aws](https://github.com/k-ibaraki/ops-agent-sample-on-aws)
- AWS Blocks の参考: [k-ibaraki/handson-aws-blocks](https://github.com/k-ibaraki/handson-aws-blocks)
