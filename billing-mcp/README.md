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

## 途中の経過を知らせる

買い手が `tools/call` の `_meta.progressToken` を付けてきたときだけ、応答を SSE にし、
MCP 標準の `notifications/progress` で売り手の中の経過を途中に流す（DESIGN.md 決定65）。
流すのは、価格帯の判定の結果（どの判定モデルが何と判定したか）、支払いの署名の受け取り、
決済の確定と生成の開始、生成の終わり。取引 ID は従来どおり最終結果の `_meta["x402/payment-response"]` に載る。
`progressToken` を付けない依頼への応答は、従来どおり JSON のまま。
SSE を途中で届けるため、Function URL はレスポンスストリーミング（`RESPONSE_STREAM`）で返す。

## 構成

```
billing-mcp/
├── billing-mcp.ts        # CDK エントリ（tsx 実行）
├── stacks/               # 関数ベースのスタック定義
├── test/                 # CDK Template テスト（jest + @swc/jest）
├── scripts/
│   ├── verify-bundle.mjs # 合成したバンドルが読み込めるかの検証
│   ├── outputs.ts        # deploy 済みスタックの出力を取り出す（pnpm outputs）
│   ├── set-jev-key.ts    # Jev の API キーを Secrets Manager に入れる（pnpm set:jev-key）
│   ├── set-tier-table.ts # 価格表を AppConfig に配る（pnpm set:tier-table）
│   └── tier-table-input.ts # 配る前に価格表をサーバーと同じ規則で確かめる
├── parameter.sample.ts   # パラメータ雛形（parameter.ts は gitignore）
└── server/               # MCP Apps サーバー
    └── src/
        ├── app.ts        # MCP の fetch ハンドラ（ローカルと Lambda で共通）
        ├── handler.ts    # Lambda Function URL のエントリ（レスポンスストリーミング）
        ├── progress.ts   # 途中の経過の通知（notifications/progress）
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

> **注意**: `pnpm cdk deploy` は無認証の公開エンドポイントをインターネットに出す。
> 誰でも Bedrock を動かせる状態になるため、`reservedConcurrency` と価格の設定を確認してから実行すること。

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
| `LogGroupName` | Lambda のロググループ名 | —（調査用）|
| `Pricing*Id`（4 つ） | 価格表（AppConfig）の配り先 | —（`pnpm set:tier-table` が使う）|

**`McpEndpointUrl` は作り直すたびに変わる。** 過去のログや記録に載っている URL をそのまま使わず、
その時点の出力を取り直すこと。`PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` は売り手ではなく
買い手側の資源で、agent-app の `npx tsx scripts/payments-setup.ts` が出力する（agent-app/README.md 参照）。

価格は出力に出さない。価格は呼び出しごとに価格表が決めるため（次節）、agent-app の `PAYMENT_MAX_AMOUNT` は
通したい価格帯の価格を賄えるように決める。

## 価格（段階制）

価格は呼び出しごとに決まる（DESIGN.md 決定56）。売り手が依頼の内容から価格帯を判定し、その価格帯の価格を
根拠つきで提示し、同じ価格帯の目安トークン数を生成の指示に織り込む。

| 価格帯 | 目安 | 既定の価格 |
| --- | --- | --- |
| 梅 | 5,000 トークン | $0.1 |
| 竹 | 8,000 トークン | $0.15 |
| 松 | 12,000 トークン | $0.2 |

価格と目安は AppConfig から変えられる。`parameter.ts` に `appConfigExtensionLayerArn`
（AppConfig Agent Lambda extension のレイヤー ARN）を渡すと、Lambda がそこから価格表を読む。
渡さなければ上の既定値で動く。設定が読めないときは直前に読めた表を使い続けるので、
書き損じで売り手が止まることはない。

CDK が作るのは AppConfig の器（Application / Environment / ConfigurationProfile / DeploymentStrategy）
だけで、価格表の中身（版と配信）は配らない（決定64）。deploy した直後は上の既定値で動く。変えるときは表を丸ごと書いた JSON を配る（AWS コンソールで配信してもよい）。一度配った表は、
以後の `cdk deploy` で巻き戻らない。

```sh
pnpm set:tier-table < tier-table.json
```

```json
{
  "tiers": {
    "ume": { "price": "$0.1", "targetTokens": 5000 },
    "take": { "price": "$0.15", "targetTokens": 8000 },
    "matsu": { "price": "$0.2", "targetTokens": 12000 }
  },
  "judge": "haiku"
}
```

`judge` だけを変えるときも `tiers` を含めること（`tiers` の無い表はサーバーに退けられ、直前の表のまま
変わらない）。`pnpm set:tier-table` は送る前にサーバーと同じ規則で表を確かめ、サーバーが受け付けない表
（価格帯の欠け・価格の書式違い・価格帯の逆転・読めない `judge` など）は AWS に触れずに止める。
`appConfigExtensionLayerArn` を渡していない環境では、Lambda が AppConfig を読まないので、
配っても何も変わらない。何も配っていない環境では、CloudWatch に警告が出ることがある（U13）。

提示した額は見積書（決定55）として `accepts[].extra.quote` に載り、買い手がそのまま返す。
支払いのときは判定をやり直さずその値を使うので、同じ額で決済できる。価格表を差し替えた
直後の古い見積書は、表と食い違うため使われず、新しい額で提示し直す。

### 価格帯を判定するモデルを切り替える（決定58）

既定は Bedrock の Haiku。`allowedModelIds` に
`jp.anthropic.claude-haiku-4-5-20251001-v1:0` を含めること。判定は無認証の経路で走るため、
呼び出し予算で単位時間あたりの費用に天井を付けている（決定57）。

TypeSafe の Jev に切り替えることもできる。手順は二つ。

1. **鍵を入れる。** CDK は仮の値 `REPLACE_ME` を入れたシークレットだけを作る。
   [console.typesafe.ai/keys](https://console.typesafe.ai/keys) で取った鍵を入れる:

   ```sh
   pnpm set:jev-key            # 端末から。入力は画面に出ない
   pbpaste | pnpm set:jev-key  # クリップボードから渡す場合
   ```

   鍵はコマンド引数に置かない（シェルの履歴と `ps` に残るため）。スクリプトは標準入力で受け、
   本人しか読めない一時ファイルに書いて AWS CLI に渡し、成否によらず消す。

2. **価格表で切り替える。** 価格表の `judge` を `jev` にして配る（上の `pnpm set:tier-table`）:

   ```json
   { "tiers": { "ume": { ... }, "take": { ... }, "matsu": { ... } }, "judge": "jev" }
   ```

   再デプロイは要らない。`judge` を省くか読めない値を書けば `haiku` に戻る
   （価格表そのものは巻き添えにしない）。鍵が未投入のまま切り替えた場合も Haiku に留まり、
   CloudWatch に警告が出る。

   `jev` を配っても確信度が付かない（Haiku のまま）なら、Lambda が `jev` を知らない古いコードのまま
   でないかを疑う。CloudWatch に「判定モデルの指定を読み取れませんでした（"jev"）」（古いコードでは
   「判定器の指定を…」）が出ていれば、それが原因。コードを deploy し直せばよい（2026-09-23 に実際に起きた）。

   **反映は即時ではない。** AppConfig の Lambda 拡張は更新を取得した回の呼び出しには旧値を返し、
   次の回から新値になる。Lambda は呼ばれていないあいだ凍結され拡張もポーリングできないので、
   伝播は時間ではなく呼び出し回数で進む。実測では展開から反映まで 2〜4 分、間隔をあけた呼び出しが
   2 回ほど要った。切り替えの最中は同じ依頼が回によって別の判定モデルに当たり得る。

切り替えると、買い手の依頼文が AWS の外（`api.typesafe.ai`）へ出る。

2026-09-21 に 20 件で実測した範囲では、両者の精度に差は認められない（既定を Haiku に
据えているのは、この用途では速度・費用の差も効かないためで、Jev の出来が悪いからではない）。
詳細（実測値・費用の内訳）は DESIGN.md 決定58。

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
