# agentic-payments-on-aws-sample

ブラウザで「こんなページを作って」と頼むと、AI エージェントが有料のツールを見つけ、
自分でテスト USDC を支払って呼び出し、できあがったページが画面に返ってくる。
支払いのたびに人が承認することはない。最初にウォレットへ署名権限を委ねるだけ。

その一部始終を AWS の上に組んだサンプルです。動くお金はテストネットの USDC だけで、実マネーは使いません。

## 何が起きるか

1 回の購入で、こうなります。

1. ブラウザから依頼を送る
2. 買い手のエージェント（Amazon Bedrock）が、売り手の `generate-html` という有料ツールを使うと決める
3. 売り手が「0.1 テスト USDC を払え」と返す
4. エージェントがウォレットで支払いに署名し、支払い証明を添えてツールを呼び直す
5. 売り手は決済の確定を見届けてから HTML を生成して返す
6. ブラウザは売り手から空の表示器を無課金で取り、そこに生成物を流し込んで描画する

売り手のエンドポイントには認証が掛かっていません。「支払った者にツールが開く」を決済だけで
成り立たせる、というのがこのサンプルの主張です。

![AWS 構成図](docs/architecture.drawio.png)

図は買い手・売り手の両方をクラウドに置いたときの姿です。draw.io で開けばそのまま編集できます。

## 使っている技術

| | |
| --- | --- |
| x402 | HTTP の 402 Payment Required を土台にした決済プロトコル（Coinbase 発）。リクエスト 1 回ごとに支払いを検証・決済する。事前の契約も API キーも要らないのが特徴 |
| MCP / MCP Apps | Model Context Protocol は、エージェントに道具を渡すための規格。MCP Apps はその拡張で、ツールに画面（HTML UI）を添えて配れる |
| AgentCore Payments | Amazon Bedrock AgentCore のマネージドウォレット。エージェントに代わって支払いへ署名する。人は最初に署名権限を委ねるだけでよい |
| AWS Blocks | インフラをコードから起こすフレームワーク。買い手のアプリはこれで書いている |

## 動かす

### 前提

- AWS アカウント。Amazon Bedrock のモデルを ap-northeast-1 で有効化しておく
- AWS Marketplace で Coinbase のサブスクリプションに加入する（AgentCore Payments のコネクタに要る）
- Coinbase Developer Platform の API キーとウォレットシークレット
- Node 24 / pnpm 10（`mise install` で入る）

### 手順

売り手 → 買い手の順に立てます。詳しい手順と選択肢は各アプリの README にあります。

1. 売り手を動かす（[billing-mcp/README.md](billing-mcp/README.md)）

   ローカルなら `pnpm dev` でポート 8000 に立ちます。クラウドに出すなら `pnpm cdk deploy` ですが、
   これは無認証の公開エンドポイントをインターネットに晒します。価格と同時実行数を確かめてから実行し、
   済んだら `pnpm cdk destroy` で閉じてください。

2. 買い手のウォレットを用意する（[agent-app/README.md](agent-app/README.md)）

   `npx tsx scripts/payments-setup.ts` でウォレットを作り、表示される WalletHub の URL を開いて
   署名権限を委ねます。ここだけは人の操作で、委任には有効期限があります。
   続いて `npx tsx scripts/faucet.ts <アドレス>` でテスト USDC を入れます。

3. 買い手を動かす

   `payments-setup.ts` が出力する `PAYMENT_*` と、売り手の URL（`BILLING_MCP_URL`）を環境変数で渡して
   `npm run dev`。ポート 3000 に立ちます。

> ブラウザから依頼を送ると、実際にオンチェーンの決済（テスト USDC）が起きます。

## ディレクトリ構成

| ディレクトリ | 中身 |
| --- | --- |
| `billing-mcp/` | 売り手。x402 で課金する MCP Apps サーバーと、それを Lambda へ載せる CDK |
| `agent-app/` | 買い手。支払って MCP を実行するエージェントと、操作・表示を行う Web アプリ |
| `docs/` | 設計決定録・実装記録・AWS 構成図 |

## ステータス

作りかけのサンプルで、動くところと手つかずのところがあります。

- 売り手: 実装・デプロイまで完了。クラウド上の Lambda に対して実オンチェーン決済が通ることを確認済み
- 買い手: 上の「何が起きるか」を、ローカルとクラウドの双方で確認済み
- 手つかず: 利用者ごとに支払い主体を分ける仕組み（現状はウォレット 1 つを全員で共有）と、
  無認証で公開したときのレート制限

## もっと詳しく

このサンプルは、結論だけでなく判断の経緯を残すことを目的の半分に置いています。

- [docs/DESIGN.md](docs/DESIGN.md) — 設計判断とその理由を番号付きで記録した決定録。
  この README で触れている「決定N」はここを指します
- [docs/implementation-log.md](docs/implementation-log.md) — 日付ごとの作業記録。
  何につまずき、どう判断したかの詳細
- [CLAUDE.md](CLAUDE.md) / [agent-app/AGENTS.md](agent-app/AGENTS.md) — AI エージェントに作業させるための規約

## 参考リポジトリ

- 機能の踏襲元: [k-ibaraki/html-creator-mcp-apps](https://github.com/k-ibaraki/html-creator-mcp-apps)
- CDK の作り・開発規約の参考: [k-ibaraki/ops-agent-sample-on-aws](https://github.com/k-ibaraki/ops-agent-sample-on-aws)
- AWS Blocks の参考: [k-ibaraki/handson-aws-blocks](https://github.com/k-ibaraki/handson-aws-blocks)

## ライセンス

[MIT](LICENSE)
