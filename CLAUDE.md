# CLAUDE.md

## プロジェクト概要

AWS 上で Agentic Payments を試すサンプル。モノレポに2アプリ:

- `billing-mcp/` — 売り手。x402 課金付き MCP Apps を CDK で Lambda（Function URL・無認証）にデプロイ
- `agent-app/` — 買い手。AWS Blocks 製のエージェント + 制御 Web アプリ

## 必ず守ること（作業記録）

サンプルの目的の半分は「経緯を残すこと」にある。以下を怠ったまま作業を終えない。

- 設計判断をしたら `docs/DESIGN.md` の設計決定録に番号付きで追記・更新する（行は消さず、変更経緯は理由欄に残す）
- 作業のたびに `docs/implementation-log.md` へ日付見出しで記録する（やったこと・判断・つまずき）
- 未決論点（U 番号）に触れる実装は、先に検証して結果を DESIGN.md に反映してから進める

## 言語

- ドキュメント・コードコメント・コミットメッセージは日本語

## 開発の進め方

- TDD（レッド→グリーン）で進める
- 実装前に DESIGN.md の決定・未決論点と、参照リポジトリの該当箇所を確認する
- 進行順は DESIGN.md 決定16（①土台 → ②billing-mcp → ③agent-app → ④結合）

## 各アプリの規約

### billing-mcp/

- CDK は ops-agent-sample-on-aws 方式: 関数ベースのスタック定義、`parameter.ts`（gitignore、`parameter.sample.ts` をコミット）、jest + @swc/jest で Template テスト、cdk.json は tsx 実行
- サーバー実装は Biome（lint / format）+ Vitest
- MCP は `@modelcontextprotocol/sdk` 1.30 系 + `@modelcontextprotocol/ext-apps` 1.7 系に固定。SDK v2（`@modelcontextprotocol/server` 等）へは ext-apps の v2 対応後に移行（DESIGN.md 決定3）
- サーバーは express を使わず、`WebStandardStreamableHTTPServerTransport` を素の Lambda ハンドラから使う。MCP セッションはステートレス（DESIGN.md 決定22）
- 売り手は無認証の公開エンドポイント。認可は x402 の支払いのみが担う（DESIGN.md 決定19・21）
- x402 は `@x402/*`（v2 系）のみ使用。旧 `x402-express` 等の v1 パッケージは deprecated のため使わない

### agent-app/

- AWS Blocks を使用（aws-blocks スキルと、スキャフォールドが生成する AGENTS.md に従う）
- 雛形はスキャフォールドで生成し、手書きで模倣しない

## リージョン

- 基本: ap-northeast-1（東京）
- AgentCore Payments 関連リソースのみ: ap-southeast-1（クロスリージョン呼び出し。DESIGN.md 決定12参照）

## コマンド

### billing-mcp/server/

- `pnpm dev` — UI ビルド + ローカル起動（ポート 8000。`.env` の `PAY_TO_ADDRESS` が必要）
- `pnpm test` / `pnpm typecheck` / `pnpm lint` — コミット前に必ず全て通すこと
- `pnpm buy:once` — 使い捨てウォレットで実オンチェーン決済テスト（`.env` の `BUYER_PRIVATE_KEY`。未設定なら鍵を生成して表示）。`MCP_SERVER_URL` で接続先を差し替えられる

### billing-mcp/

- `pnpm test` / `pnpm typecheck` — CDK の Template テストと型検査
- `pnpm synth` — 合成。`server` 側で先に `pnpm build:ui` が必要
- `pnpm verify:bundle` — 合成したバンドルが実際に読み込めるかの検証（synth の後に実行）
- `pnpm cdk diff` / `pnpm cdk deploy` — **deploy は無認証の公開エンドポイントを出す。実行前に必ず確認を取ること**

agent-app は実装が入り次第追記する。
