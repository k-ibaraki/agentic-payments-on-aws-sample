# AgentCore Payments の使い道についての考察

2026-09-07。フェーズ④⑤（結合・クラウド deploy）を終えた時点で、AgentCore Payments の「制限」が
何をしてくれて何をしてくれないか、どこまで制限を掛けるべきかを整理したもの。ユーザーと Claude の
問答を文書に起こした。設計決定ではないので DESIGN.md には番号を振っていない。決定に昇格させる場合は
そちらへ番号付きで書き、本書からは参照する。

## 1. 結論

- セッション枠は「いくらまで・いつまで署名させるか」を署名の手前で止める仕組みで、
  「何を・誰から・一件いくらで」は見ない
- 本サンプルの売り物（MCP Apps の生成物）も、ペイウォール付きのページも、推論のトークン課金も、
  支払いの側から見れば同じ「コンテンツ」であり、枠の尺度を分ける必要はない
- 制限は「いくらまで失ってよいかを決めるもの」と「何を買うかをエージェントの代わりに決めてしまうもの」に
  分けて考える。前者はエージェントに任せるための条件、後者は任せることの取り消しに近い。
  後者を置くときは、実際に起きた事故か、起きたら取り返しのつかない損失を理由として残す

## 2. セッション枠で「できる制限」と「できない制限」

PaymentSession の枠は作成時に固定され、後から変えられない。

| 項目 | 値 |
| --- | --- |
| 上限 | `limits.maxSpendAmount`（金額と通貨）。省略も可能で、その場合は期限だけの枠になる |
| 期限 | `expiryTimeInMinutes`。15 分から 480 分 |
| 変更 | Update API は無い。消して作り直すのみ（決定43） |
| 判定 | `ProcessPayment` の署名前に枠を予約し、署名に失敗した分は戻す |
| 冪等 | `clientToken` で同じ支払いの再送を二重にしない（決定30） |

### できる制限

- **1 セッション内の累計金額と期限** 。予約方式で判定するため、並行して支払っても越えない。
  ただし枠は「署名した額」で減り、売り手側の settle が失敗して資金が動かなかった分は戻らない
  （決定35 の実測。1.00 → 0.8 USD）
- **枠そのものの改竄防止** 。プロンプトインジェクションで上限や期限は動かせない。変えるには消して
  作り直すほかない（決定43）
- **利用者ごとの枠** 。サービスは `X-Amzn-Bedrock-AgentCore-Payments-User-Id` ヘッダの単位で
  セッションを切れる。本サンプルはこの userId をウォレット持ち主の `PAYMENTS_USER_ID` 一つにしたまま、
  KVStore で Cognito の sub とセッション ID を対応付けて利用者ごとの枠にした（決定39）。
  ゆえに Payments 側の監査ログに利用者は現れず、誰が支払わせたかはアプリの記録で追う
- **枠を作る者と払う者の分離** 。公式の IAM ガイドは ManagementRole（`CreatePaymentSession` 可、
  `ProcessPayment` は明示 Deny）と ProcessPaymentRole を分けることを求める。分ければエージェントが
  自分で新しい枠を切る抜け道を塞げる。本サンプルは共有 Lambda が両方を担うため未分離（決定37、U8）

### できない制限（と本サンプルでの扱い）

| 制限 | サービス側 | 本サンプル |
| --- | --- | --- |
| 宛先（payTo）の制限 | 検証しない | `payments/x402-payer.ts` の支払いポリシーで `PAYMENT_PAY_TO` と照合 |
| 1 回あたりの上限 | 無い。枠が 1.00 USD なら 1 回で使い切れる | 置いていない |
| セッションをまたぐ累積（日次・月次） | 無い。作り直せば枠は戻る | ウォレット残高が事実上の上限（決定35・39・43） |
| 回数の制限 | 無い | 依頼回数を KVStore で数える（決定40。対象は Payments でなく Bedrock の費用） |
| 品目・対価の妥当性、成果物が届くか | 見ない | 決済後の失敗は決定31・48 で人の承認へ。返金に相当する仕組みは U7 |
| 枠の外に出る費用 | MPP で買い手がガス代を負う場合（`buyerPaysGasFees`）と upto の Permit2 承認の手数料は、公式が「payment amount」と呼ぶ枠に含まれないと読める（明言は無い） | 該当機能を使っていない |
| userId の真正性 | `AWS_IAM` 認可ではヘッダの自己申告。`CUSTOM_JWT` 認可なら JWT から取る | `AWS_IAM` のまま。userId は固定の `PAYMENTS_USER_ID` で、ヘッダは Lambda が付けるので利用者は触れない |

告知文にある「agent-level」の制限は、API 上は `X-Amzn-Bedrock-AgentCore-Payments-Agent-Name` ヘッダが
観測用に付くだけで、エージェント単位の枠は無い。エージェントごとに予算を分けたければセッションを分けて作る。

## 3. 別の仕組みで補えるもの

上の「できない」側は、Payments とは別の仕組みで補う。二つは互いの結果を参照しない。
Policy は「このツールを、この引数で呼んでよいか」を判定し、Payments は「この金額を署名してよいか」を判定する。

- **AgentCore Policy** （Gateway に付ける。Cedar / Dogwood）。ツール名・引数・利用者で許可と拒否を
  書ける。Dogwood の temporal policy なら「セッション内の合計を閾値以下に」「承認の後でのみ実行」
  「N 回まで」といった履歴依存の規則が書ける。ただしセッション ID は呼び出し側が渡すため、
  セッションをまたぐ累積は Payments と同じく不得手。東京リージョンで使える（Payments 自体は東京非対応。決定12）
- **SDK 側の制御** （Strands plugin / LangGraph middleware）。`tool_allowlist`、`auto_payment=False`
  で人の承認、失敗時の interrupt。クライアント側の制御であってサービスの保証ではない

## 4. コンテンツの種類と尺度

問いは「MCP Apps のようなコンテンツの購入と、一般的なホームページの購入を同じ尺度で制限してよいか」。

- 最初の回答は「一般的なホームページの購入」を物販と読み違え、返品・取消の要る取引との二層論を
  展開した。ユーザーの指摘で訂正した（経緯として残す）
- 本サンプルの売り物は Bedrock が生成した HTML で、実態は推論のトークン課金である。公式の想定
  ユースケースにある「有料 MCP サーバー」「ペイウォールの記事」「pay-per-intelligence」は、支払いの
  性質（少額・先払い・返品なし）で見れば一つの類で、線は引けないし引く必要もない
- 種類の違いが現れる場所は二つだけ。スキームの選択（固定価格なら `exact`、従量なら `upto`）と、
  失敗時に買い直すかどうかのアプリ側の判断。枠の尺度には現れない。セッション枠がコンテンツの
  種類を一切見ないのは設計として妥当
- 返品・取消が要る取引（物販・予約）は AgentCore Payments の守備範囲外。x402 の escrow は未対応、
  MPP は `charge` intent のみ。公式も「road ahead」と位置づけている

## 5. 制限をかけるべきか

「制限をかけられる」ことと「かけるべき」ことは別で、後者が本質的な問いである。制限は二種類に分けて考える。

- **いくらまで失ってよいかを決めるもの** 。セッション枠、期限、利用者ごとの枠。エージェントに任せる
  ことと衝突しない。むしろ任せるための条件で、法人カードの限度額と同じ。判断を疑っているのではなく、
  判断を誤ったときの損失を限っている。AWS 自身の立て付け（限度があるから任せられる）も、
  AP2 の Intent Mandate（私の代わりに X まで使ってよい）も同じ発想
- **何を買うかをエージェントの代わりに決めてしまうもの** 。宛先の許可リスト、ツールの許可リスト、
  購入ごとの人の承認。積めば積むほど「エージェントが払う」は「人がエージェント経由で払う」に近づき、
  エージェントに選ばせる意味が薄れる

### 本サンプルの実例

- 2026-09-03 の二重支払い（決定31）。枠 1.00 USD の中で、成果物なしの支払いが 4 件（0.4 USDC）残った。
  枠は事故を止めなかったが、損失を枠の内側に限った。前者の種類の役目はそこまでで、それ以上は期待しない
- 決定31 は「毎回の承認」を退け、「成果物なしの支払いが残ったときだけ承認」にした。後者の種類を
  異常時に限定して、平時の自律性を保った例
- payTo の照合は、売り手が一つに決まっている本サンプルでは「知らない相手に払わない」という前者の
  種類。Bazaar で相手を探す構成に持ち込めば、後者の種類に転じて衝突する。同じ仕組みでも置く場所で
  性格が変わる
- 決定40 の回数制限は、Payments ではなく Bedrock の費用に対する前者の種類

### 指針（提案。決定に昇格させるなら DESIGN.md へ）

- 前者の種類は常に置く。枠の大きさを決めるのは開発者ではなく金の持ち主（決定43 で利用者が自分の枠を
  変えられるようにした形）
- 後者の種類は、置くたびに「エージェントの判断を奪っていないか」を問う。奪うなら、理由（実際に起きた
  事故、または起きたら取り返しのつかない損失）を DESIGN.md に残す。「なんとなく心配」は理由にしない
- 「かけない」にも根拠が要る。テストネットの USDC では「残高が上限」で困らないが、本物の資金では
  残高は上限ではない。本番に持ち込む前に前者の種類を組み直す

## 6. 今回使わなかった機能と公式の想定ユースケース

### 未使用の機能

- **x402 の `upto` スキーム** 。上限までの従量課金。Permit2 の承認（`permit2AllowanceLimit`。
  ガス代が掛かる）を伴う。推論のトークン課金向け。本サンプルの売り手は `exact` 固定
- **MPP（Machine Payments Protocol）** 。Stripe と Tempo の規格。`WWW-Authenticate: Payment` の
  challenge を丸ごと `ProcessPayment` に渡し、`Authorization` ヘッダに載せる credential を得る。
  `evm` / `tempo` / `solana` に対応、`charge` intent のみ
- **Stripe（Privy）コネクタと Solana** 。コネクタは Coinbase CDP のみ使用
- **Quick create** 。Coinbase の OAuth 同意だけで資格情報を自動作成する。本サンプルは CDP の鍵を手で入れた
- **AgentCore Gateway と Coinbase x402 Bazaar** 。1 万を超える有料エンドポイントの発見
- **AgentCore Policy** 。3 節のとおり
- **AgentCore Browser とペイウォール** 。x402 対応サイトの閲覧。Anchor Browser が GA の事例
- **Strands plugin / LangGraph middleware** 。`auto_session`、`tool_allowlist`、interrupt、
  残高やセッションを引く組み込みツール。本サンプルは AWS Blocks の上に自前の x402-payer を書いた
- **AgentCore CLI / CDK の Payments 構築** （`agentcore add payment-manager` など）。本サンプルは
  SDK 直の `scripts/payments-setup.ts`
- **`ListPaymentSessions`、`CUSTOM_JWT` 認可、`agentName` ヘッダ** 。セッションは KVStore で追い、
  認可は `AWS_IAM` のまま
- **PaymentManager の KMS CMK** 、**観測** （vended logs、X-Ray span、既製ダッシュボード）は使い込んでいない

### 公式の想定ユースケース

一貫して「機械が消費する pay-per-use の資源」に寄せてある。

- リサーチエージェントが予算内で有料データを買う
- 金融分析でペイウォール越しの市場データを取る
- ブラウザエージェントが bot を制限するサイトを閲覧する
- 推論のトークン課金に支払う pay-per-intelligence
- オンデマンドのストレージ

GA の事例は Anchor Browser（ペイウォールの閲覧）、BlockRun / SpreadX と Ampersend（推論の
ルーティング）、Elsa AI と Heurist（金融リサーチ）、Travala（ホテル予約の MCP）。いずれも 402 で払う
API 呼び出しの形に収まる。本サンプルの「有料 MCP サーバーから生成物を買う」はこの守備範囲の中心にある。

## 7. 参考

- [Amazon Bedrock AgentCore payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html)
- [Core concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-concepts.html)
- [How it works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-how-it-works.html)
- [Process a payment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-process-payment.html)
- [CreatePaymentSession API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreatePaymentSession.html)
- [IAM roles](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-iam-roles.html)
- [Framework integrations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-framework-integrations.html)
- [Temporal policies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-temporal.html)
- [GA announcement blog](https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-payments-is-now-generally-available-enabling-agents-to-transact-safely-and-autonomously-at-scale/)
- [Guardrails blog](https://aws.amazon.com/blogs/machine-learning/enable-safe-agentic-payments-with-built-in-guardrails-using-amazon-bedrock-agentcore-payments/)
- [Technical deep dive blog](https://aws.amazon.com/blogs/machine-learning/technical-deep-dive-agentcore-payments-and-innovation-in-agentic-commerce/)
- [Agentic Payments on AWS: where the spending limit is enforced](https://hidekazu-konishi.com/entry/agentic_payments_on_aws.html)
- [Google AP2 announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
