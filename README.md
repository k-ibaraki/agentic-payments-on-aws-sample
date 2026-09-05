# agentic-payments-on-aws-sample

AWS 上で Agentic Payments（AI エージェントが人の介在なしに自律的に支払いを行うこと）を試すサンプルモノレポ。

x402（Coinbase 発の決済プロトコル。HTTP 402 Payment Required を土台に、リクエスト単位で支払いを検証・決済する）で課金する
MCP Apps（Model Context Protocol の拡張仕様。ツールに画面〈HTML UI〉を添えて配信できるようにする）を
AWS Lambda（Function URL・無認証）上に立て、AWS Blocks 製のエージェント + Web アプリが
AgentCore Payments（Amazon Bedrock AgentCore のマネージドウォレット。エージェントに代わって決済を実行する）で
「支払いながら」利用する構成を目指す。

## ドキュメントの読み方

はじめての方は次の順に読むとよい。

1. この README — 全体像とステータス
2. [billing-mcp/README.md](billing-mcp/README.md) / [agent-app/README.md](agent-app/README.md) — 各アプリの構成・セットアップ・コマンド
3. [docs/DESIGN.md](docs/DESIGN.md) — 設計判断とその理由を番号付きで記録した決定録。この README で触れている「決定N」はここを指す
4. [docs/implementation-log.md](docs/implementation-log.md) — 日付ごとの作業記録。判断に至った経緯の詳細

AI エージェントへの作業指示は別系統で、[CLAUDE.md](CLAUDE.md)（プロジェクト全体の規約）と
[agent-app/AGENTS.md](agent-app/AGENTS.md)（AWS Blocks 固有の規約。スキャフォールドの生成物）に分かれている。

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

上図は買い手・売り手の両方をクラウドに置いたときの姿。買い手は Amplify Gen2 + Amplify Hosting（`amplify.yml` と `agent-app/amplify/`。決定33）、売り手は CDK で Lambda + Function URL に置く。自分で動かす手順は各アプリの README にある。

## ステータス

作りかけのサンプルで、動くところと手つかずのところがある。

- 売り手（billing-mcp）: 実装・CDK・デプロイまで完了。クラウド上の Lambda に対して、
  実オンチェーン決済（Base Sepolia のテスト USDC）が通ることを確認済み
- 買い手（agent-app）: 「ブラウザから依頼 → エージェントが x402 で支払う → 生成された
  ページが画面に出る」までを、ローカルとクラウドの双方で確認済み
- 手つかず: 利用者ごとに支払い主体を分ける仕組み（現状はウォレット 1 つを全員で共有）と、
  無認証で公開したときのレート制限（決定28）

経緯と判断はすべて `docs/DESIGN.md` と `docs/implementation-log.md` に残す方針。

## 参考リポジトリ

- 機能の踏襲元: [k-ibaraki/html-creator-mcp-apps](https://github.com/k-ibaraki/html-creator-mcp-apps)
- CDK の作り・開発規約の参考: [k-ibaraki/ops-agent-sample-on-aws](https://github.com/k-ibaraki/ops-agent-sample-on-aws)
- AWS Blocks の参考: [k-ibaraki/handson-aws-blocks](https://github.com/k-ibaraki/handson-aws-blocks)

## ライセンス

[MIT](LICENSE)
