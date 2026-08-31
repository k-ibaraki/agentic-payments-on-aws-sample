# agent-app（買い手: MCP を実行する Agent + 制御 Web アプリ）

AWS Blocks 製。billing-mcp の有料ツールを AgentCore Payments のウォレットで x402 支払いしながら実行するエージェントと、
その制御・MCP Apps UI（iframe）表示を行う Web アプリ。フェーズ③（縦串）を実装中。

## 構成

- 雛形は `npx @aws-blocks/create-blocks-app --template auth-cognito` の生成物（決定13・15。npm 管理）
- 使用ブロック: Agent / AuthCognito / KVStore / ApiNamespace / Realtime（決定26）
- ウォレット（AgentCore Payments）は ap-southeast-1（クロスリージョン。決定12・24）
- 買い手エージェントの配線は `aws-blocks/buyer-agent.ts`、x402 支払いは `aws-blocks/payments/`
  （@x402/mcp のラッパは structuredContent を落とすため使わず、素の callTool を2段で叩く。決定25）
- スキャフォールド由来の todos デモ（DistributedTable）はフェーズ④の UI 置き換えで撤去予定

## コマンド

- `npm run dev` — ローカル起動（ポート 3000）
- `npm run test` / `npm run typecheck` — コミット前に必ず通すこと
- `npm run test:e2e` — ローカルサーバーに対する e2e（node:test）
- `npx tsx scripts/payments-setup.ts` — AgentCore Payments のセットアップ（冪等。
  `PAYMENTS_LINK_EMAIL` 必須。Coinbase の Marketplace サブスクと OAuth 同意が途中で要る）
- `npx tsx scripts/buy-via-agent.ts "指示"` — 縦串検証。**実オンチェーン決済（0.1 テスト USDC）が発生する**

## 縦串検証に必要な環境変数

`scripts/payments-setup.ts` の出力から設定する（.env 等は使わず実行時に渡す）:

- `PAYMENT_MANAGER_ARN` / `PAYMENT_SESSION_ID` / `PAYMENT_INSTRUMENT_ID`
- `BILLING_MCP_URL`（既定 `http://localhost:8000/mcp`）・`PAYMENTS_USER_ID`（既定 `sample-user-1`）
