# 実装記録

作業のたびに日付見出しで、やったこと・判断・つまずきを記録する。設計決定そのものは DESIGN.md へ分離。

## 2026-09-06: セッション開始前の残枠と、購入したページの見せ方（決定49・50）

### 発端（ユーザーの申告 2 件）

- 「ウォレットのセッション上限の設定後、実際に支払が動くまでの間、エージェントへの依頼の残枠が表示されない」
- 「新規会話を押下するとそれまでに購入したページが全て見れなくなる」

### 調べて分かった原因

- 残枠: 帯は `formatStripRemaining(status.session)` だけを見ていた。PaymentSession は購入のときに切る（決定35）うえ、
  上限の変更は現在のセッションを破棄する（決定43）ので、変更してから最初の購入までは必ず `session: null` になる。
  さらに `session: null` は「取得に失敗した」ときにも返るため、無条件に上限を出すと失敗を実値らしく見せてしまう
- 購入したページ: 購入物そのものは利用者ごとの KVStore（`purchasedHtmlKey(userSub, resultId)`）にあり、
  `getPurchasedHtml` は会話に依存しない。失われていたのは索引だけで、`listPurchases` が会話の履歴から
  組み立てる作り（決定29）のため、会話を変えると空になっていた

### やったこと

- 決定49: `src/ui-rules.ts` の帯を `stripBalance` / `stripRemaining` に置き換えた。セッションが無いだけのときは
  次に切る上限を `1.00 USD（セッション開始前）` の形で出し、`sessionError` があるときだけ「—」に留める。
  光らせる判定は表示文字列ではなく金額（`StripCell.value`）で行うようにし、添え書きが外れただけでは光らないようにした
- 決定50: 画面を画面内タブ 2 枚（依頼 / 購入履歴）に組み直した。買えたページは会話の中のカードに描き、
  カードごとに MCP Apps の View を載せる。自動で載せるのはストリームで届いた購入だけで、再開した会話の
  買い置きと履歴の行は「表示」を押したときに載せる
- buyer API に `listPurchaseHistory` を追加した。`listConversations(userSub)` で所有を解決し、新しい順に最大 20 会話から
  `extractPurchases` で集める（`purchaseHistory`）。呼ぶのは履歴タブを開いたときと「更新」のときだけ
- チャット欄の描画を `replaceChildren` からメッセージ ID を鍵にした差分更新へ変えた。並びの規則（`orderChatNodes`）は
  `src/ui-rules.ts` にテスト付きで置いた

### 判断・つまずき

- 残枠をセッション開始前も出すために「先にセッションを切る」案は採らなかった。決定35 の「購入のときに切る」を崩し、
  購入前に支払いの枠を開いてしまうため。表示だけで解いた
- 添え書き（セッション開始前）はユーザーの選択。区別不要との返答だったが、`session: null` が失敗でも起きる旨を
  伝えたところ「そこまでいうなら付けておく」となった
- 索引を利用者単位にする方法として KVStore の `scan` は採らなかった（全利用者ぶんを読む）。所有の解決に
  そのまま使える `listConversations` を選び、たどる会話は 20 件に抑えた
- 会話の中に iframe を置くと、`replaceChildren` の作り直しで毎回読み込み直しになり `AppBridge` の接続が切れる。
  既にある要素を動かさない差分の当て方（`placeChildren`）にして避けた。iframe は DOM 内で動かすだけでも読み込み直しになる
- 会話を作り直している最中に mount が返ってくる競合があるため、世代（`conversationGeneration`）を持たせて
  遅れて返った View を閉じるようにした
- 錨にしていた吹き出しが消える（承認へ応答すると空の吹き出しが片付く）と、カードが末尾へ動いて
  結局 iframe が読み込み直しになる。消える前に直前の生き残りへ付け替える（`retargetAnchor`）ようにした
- 会話の `updatedAt` は SDK のソースで確認した。`createConversationId` で作られ、応答が終わるたびに
  書き直される（`listConversations` 自身も新しい順に並べる）ので、履歴の見出しの時刻と並びは実値で成り立つ
- セルフレビューの指摘 4 件を同じ枝で直した。①`refreshPurchases` に残っていた旧案のコメント
  ②決定29 の行に決定50 への参照が無かったこと ③吹き出しの並びを Map の挿入順ではなく `messages` の順から作ること
  ④購入が無い応答でも購入履歴を取り直していたこと（カードが増えたときだけ古い扱いにする）
- リベースで origin/main の決定48（二重支払いの防護の是正）と番号がぶつかったため、こちらの決定を
  49（残枠）・50（会話の中の描画と購入履歴）へ振り直した。コード・HTML・CSS の参照も併せて直した
- 履歴タブの一覧に行が並んだ状態は未検証（実オンチェーン決済が要るため、確認を取ってから）。
  未認証で拒むこと・他人の会話を含まないこと・購入が無ければ空になることは e2e で確かめた
- 「過去の会話に戻る切替 UI」は私が選択肢として出したもので、ユーザーの依頼ではなかった（指摘を受けて取り下げ）
- 検証: `npm run test`（158 件）・`npm run typecheck`・`npm run test:e2e`（`listPurchaseHistory` の未認証拒否と
  他人の会話を含まないことを追加）。画面は Playwright で両タブを撮って確認し、選択中のタブの文字色が
  Pico の button 文脈で白に解決される問題と、帯のラベルが 1 文字ずつ割れる問題を直した

## 2026-09-06: 全体レビューで見つけた二重支払い防護の穴を塞ぐ（決定48）

### 発端

ユーザーの依頼「一度全体を見直して、致命的な実装の不具合がないかチェックして」。売り手（billing-mcp）、
買い手の決済コア（`aws-blocks/payments/` ほか）、フロントと Amplify 配線の 3 系統に分けて調べた。
売り手とフロントには致命的な指摘は出なかった（`upfront` の順序・CORS・添付の制限・sandbox 属性・
DOMPurify・ポーリングの停止条件はいずれも決定どおり）。決済コアで 2 件見つかり、コードを読んで裏を取った。

### 見つけた 2 件

1. **会話を変えると承認ゲートが素通りする**。`buyer-agent.ts` の防護（決定31③）は
   `getConversation(context.conversationId)` の履歴だけを見ていた。一方でウォレット・PaymentSession・
   支出上限は利用者（sub）ごとで会話をまたぐ（決定39・43）。`createConversation` は制限なく呼べるので、
   「支払い済み・成果物なし」が残る会話を離れて新しい会話で同じ依頼をすれば、interrupt を経ずに
   もう一度支払えた。画面の「新規会話」を押すだけで防護が外れる
2. **`ProcessPayment` 自体の失敗が記録も承認要求もされない**。`x402-payer.ts` は
   `isSpendLimitRejection` / `isSessionRejection` のどちらでもない例外をそのまま投げ、
   `paid-tool-caller.ts` も `buy-html.ts` も `buyer-agent.ts` も捕まえていなかった。
   コードの注記は「ProcessPayment の失敗は署名前なので二重にならない」としていたが、
   クライアント側のタイムアウトでは AgentCore 側で処理が済んでいた筋を否定できない。
   決定30 の冪等キーは購入ごとに採番し直されるため、LLM の買い直しは別の `clientToken` になり
   Payments 側の冪等性も効かない

### やったこと（TDD、赤 → 緑）

- `repurchase-guard.ts`（+ テスト 15 件）: 利用者ごとの未解決記録を追加。純粋関数
  （`withUnresolved` / `pendingApprovals`）と KVStore 操作（`loadUnresolved` / `recordUnresolved` /
  `clearUnresolved`）に分け、承認の要否を「会話履歴 ∪ 利用者の記録」で決める。書き込みは
  読んだ値を条件にした CAS で、競合したら相手を残す（記録は空にならないので防護は働く）。
  `ifNotExists` は使わない（決定35 改訂・決定40 と同じ罠）
- `x402-payer.ts`（+ テスト 7 件）: `UncertainPaymentError` を追加。`ProcessPayment` の失敗を
  4xx（`$fault: client`）かどうかで振り分ける。作り直し後の呼び出しは `try`/`catch` の外にあり
  同じ穴が開いていたので囲み、セッション作成そのものの失敗は成否不明に混ぜないよう外へ出した。
  応答に支払い証明が無い場合も成否不明に含めた（呼び出しは通っているため）
- `buy-html.ts`（+ テスト 3 件）: 失敗を結果に変える `outcomeFromError` を切り出し、
  `paymentUncertain` を `BuyHtmlOutcome` に追加
- `buyer-agent.ts`: KVStore `unresolved-payment`（TTL 無し）を追加。失敗時は
  `paymentMade || paymentUncertain` でレシートを残して未解決に記録し、成功時に記録を消す。
  systemPrompt にも `paymentUncertain` を書いた
- 同（セルフレビューでの是正）: 書き込みの失敗でツールが投げると、tool-result が会話に残らず
  **KVStore の記録と会話単位の防護が同時に消える**（`toPurchase` は `resultId` の無い要約を捨てる）。
  「利用者単位が書けなければ会話単位が拾う」という二重化が、一段目が成功した経路にしか無かった。
  要約の組み立てを先に済ませ、記録とレシートの書き込みは個別に `try`/`catch` して必ず要約を返す形に直した。
  順序も入れ替え、次の支払いを止める記録を先、証跡のレシートを後にした
- `purchases.ts` / `src/ui-rules.ts`（+ テスト 3 件）/ `src/index.ts`: 購入一覧に
  「支払いの成否不明・」を出せるようにした（`purchaseFailurePrefix`）

### 検証

- `npm run typecheck` / `npm run test`（175 件）緑
- `npx cdk synth` 緑。新しい表 `agent-app-…-app-unresolved-payment` だけが増え、既存の資源は変わらない
- worktree の初回だったため `npm ci` と `npm run blocks:client`（`aws-blocks/client.js` は gitignore）が要った。
  これを踏まないと `npm run build` が `Failed to resolve entry for package "aws-blocks"` で落ちる

### セルフレビューでの是正（同日）

4 件。①`agent-app/README.md` の防護の説明が「同じ会話に未解決の支払いがあれば」のままで、
今回広げた範囲と食い違っていた（成否不明の購入にも触れていなかった）②DESIGN.md の決定31 に
決定48 への追記が無く、決定31 だけを読むと「防護は会話単位」が現行仕様に見えた（覆した側にだけ
書いて、覆された側に書いていなかった）③`buyer-agent.ts` と `aws-blocks/index.ts` の
「防護に使うのは conversationId」というコメントが、`userId` を記録キーに使うようになった後も
残っていた ④失敗の記録を投げないことを固定するテストが無かった。`recordFailedPurchase` として
切り出し（`failed-purchase.test.ts` 6 件）、書き込みの順序と「両方が落ちても投げない」を固定した。
④は将来「例外の握りつぶしは良くない」と `try`/`catch` を外されると、テストは緑のまま本番でだけ
防護が二層とも消える箇所なので、テストで意図を残す価値が高い

### 残っていること

- **実決済での確認は未実施**。とくに②は、タイムアウトを実際に起こして成否不明の記録が残ることと、
  その後の購入で承認を求められることを見たい
- KVStore の書き込みが実際に失敗した経路も通していない。上の是正が効くのはまさにそこなので、
  記録が書けなかったときに会話単位の防護へ落ちることは机上の確認にとどまる
- 承認（`trust`）で「以後は聞かない」に相当する扱いは無いまま。記録は成功でしか消えないので、
  タイムアウトが続くと承認を求め続ける

## 2026-09-06: 依頼の枠に残高と残枠の帯を出し、購入中に取り直す（決定47）

### 発端（grill-me）

- ユーザーの申し出「エージェントへの依頼と同じ枠に残高とセッションの残枠を出したい。使った瞬間にリアルタイムで減るのが
  分かるようにしたい。細かい説明は不要」。実決済で今の画面を見た上での要望で、支払いの時点では残高が減らず、
  成果物が届いた時点で減って見えた（`tool-result` / `done` の取り直しの通り）
- 問いを重ねて決めた点: 帯は見出し行の直下に常時表示、中身は残高と残枠の 2 つだけ、変わった瞬間は一瞬光らせる、
  支払った瞬間に減らせたいので有料ツールの呼び出し中に取り直す、既存の「ウォレットと支払いの枠」は残す

### やったこと

- `src/ui-rules.ts`（+ テスト 6 件、赤 → 緑）: 帯の文字列（`formatStripBalance` / `formatStripRemaining`）、
  取り直しの開始条件（`isPaidToolCall`。`PURCHASE_TOOL_NAME` を `aws-blocks/purchases.ts` から import）、
  継続判定（`shouldContinueBalanceWatch`。間隔 3 秒・上限 600 秒）、変化の判定（`walletSnapshot`）
- `index.html`: 依頼の枠の見出し行の直下に `.wallet-strip`（`#strip-balance` / `#strip-remaining`、`role="status"`）
- `src/style.css`: 帯（淡いブルーの面に大きめの tabular-nums）と `strip-flash` のアニメーション。`prefers-reduced-motion` では止める
- `src/index.ts`: `renderStrip` が帯を書き換えて前回と違えば `flash` を付け直す。`refreshWallet` は変わったかを返す。
  `startBalanceWatch` / `stopBalanceWatch` が `tool-call`（有料ツール）で始め、`tool-result` / `done` / `error`・
  新規会話・サインアウトで止める。取得中は次の回を飛ばす（多重呼び出しの防止）

### 検証

- `npm run typecheck` / `npm run test`（133 件）/ `npm run build` 緑。fresh な node_modules に `@aws-amplify/backend` が無く
  `npm ci` を先に回した
- 見た目は `BUYER_LOCAL_MODEL=canned` の `npm run dev` に Playwright を当てて確認（下記）。減った瞬間の光り方と
  呼び出し中の取り直しは実決済でしか確かめられないため、次の実決済で確認する（API のスロットリングも同時に見る）
### PR #18 のレビューでの是正（8 件）

- **停止条件に残枠を混ぜていたのが最大の誤り。** 残枠は署名の時点で先に減り（`payment-session.ts` の `availableSpendUsd`）、
  セッションが無い状態からの購入では呼び出し中に「—」から数値へ変わる。どちらの経路でも最初の 3 秒で監視が止まり、
  オンチェーンの残高が減る前に終わっていた。判定を残高だけに変えた（`balanceKey` / `didBalanceChange`）
- 残高 API の失敗はサーバーが例外にせず `balance: null` で正常応答する（コミット `1ae702a`）。これを「変化」と扱っており、
  「—」が減少と同じ点滅を出したうえ監視も打ち切っていた。光らせる条件を `shouldFlashValue`（「—」との出入りでは光らせない）に、
  停止の判定を「取れた回どうしの比較」に分けた
- `interrupt` を停止契機に足した。中断時は `done` も `tool-result` も出ない（`agent.js` の `if (interrupted) return;`）ため、
  決定31 の再購入確認で人の応答を待つ間、最大 200 周ポーリングしていた
- 決定番号の振り直し漏れ 2 件（`index.html` と `ui-rules.ts` の冒頭コメントが「決定44・45」のまま）。
  `決定44・45` という並びは `決定45` の検索に掛からず、リベース時の一括置換からも私の確認からも漏れていた
- 390px でラベルが 1 文字ずつ縦に割れ、値も途中で改行されていた（実測）。576px 以下で帯を 2 行に積む指定を足した。
  480px では問題が出ないため、目視の確認幅が足りていなかった
- サインアウト時に飛行中の取得を捨てておらず、前の利用者の残高が遅れて帯に描き戻り得た。破棄で通し番号を進める形にした
- 見えていないタブでは叩かないようにした（`document.visibilityState`）。上限まで回ると 200 周・課金 API 約 400 回で、
  当初 PR 本文に書いた「数回〜十数回」は楽観的すぎた
- 判定ロジックを `ui-rules.ts` の純粋関数に寄せ、テストを 6 件から 12 件に増やした（`index.ts` に直書きの判定を残さない）

- PR #18 を出した後、main が先に進んで（決定45 の 404・決定46 の Markdown 表示）衝突したのでリベースした。
  **私の決定番号 45 は 404 の決定に使われていたため 47 に振り直した**（文書・コード・コミットメッセージすべて）。
  `src/ui-rules.ts` と同テストは決定46 の追加と同じ末尾に足していて衝突し、両方を残す形で解いた。
  リベース後に `npm ci`（marked・DOMPurify が増えている）を回し、typecheck / test（143 件）/ build が緑

### セルフレビューでの是正（5 件）

- 並行した取得の追い越しで帯が古い残高に巻き戻る経路があった。更新ボタン・購入中の取り直し・購入後の再取得は
  互いを知らずに走るため、遅れて返った古い応答が新しい表示を上書きし得た（「支払ったのに減っていない」に見え、
  この機能の目的が崩れる）。通し番号を持ち、追い越された応答は画面にも推移にも反映しない形に直した
- 600 秒の上限が取得の成功時にしか評価されず、`getWalletStatus` が投げ続けると取り直しが永久に止まらなかった。
  判定を `.finally` に移した。併せて、ストリーム自身の失敗は `onChunk` ではなく `onError` に来てチャンクによる
  停止条件に掛からないため、`onError` でも取り直しを止めるようにした
- `prefers-reduced-motion` で光り方を丸ごと消していたのを取り止めた（決定47 の追記参照）
- `role="status"` の帯を値が変わっていなくても 3 秒ごとに書き直しており、支援技術が同じ値を読み上げ続け得た。
  文字列が今の表示と違うときだけ書き込む形にした（変わった数字だけが光るようにもなった）
- `src/ui-rules.ts` から `aws-blocks/purchases.ts` を読むのは `src/` で唯一の越境。今は `purchases.ts` に import が
  無く束は 1 バイトも増えない（import を外して測り出力が同一なことを確認）が、依存が入ると壊れるので
  `purchases.ts` 側にその旨を明記した

## 2026-09-06: チャット欄の Agent 応答を Markdown 表示にする（決定46）

### やったこと

- ユーザーの申し出「チャット欄の Agent の応答をマークダウン表示にして欲しい」を受けて実装
- `agent-app` に marked 18.0.11 と DOMPurify 3.4.14 を依存追加（DOMPurify は型を同梱するので `@types/dompurify` は不要）。
  テスト用に jsdom も devDependency に追加
- `src/markdown.ts` を新設。marked（`gfm` / `breaks`）で HTML にし DOMPurify に通す関数 1 つだけを置く
- `src/index.ts` の `renderMessages()` で `role === 'assistant'` のときだけ `.markdown` を付けて
  サニタイズ済み HTML を `innerHTML` に入れる。生成中は素の文字列のまま出し、`onLoadingChange` で
  生成の終わりを捉えて描き直す
- `src/style.css` に `.msg.markdown` を追加（`white-space` を戻し、ブロック要素の余白と見出しの大きさを整える）
- ブラウザで目視確認（Vite に一時ページを立て、確認後に削除）

### 判断

- 応答は LLM が組み立てる文字列で、売り手の応答も混ざる信頼できない入力。`src/index.ts` の
  「innerHTML は使わない」方針を全部やめるのではなく、Agent の吹き出し 1 か所に例外を切り、
  サニタイズを代わりの防護に据えた（冒頭のコメントもその通りに直した）
- 単体テストは置かず、ブラウザ確認に委ねた。`src/mcp-apps-host.test.ts` が書いているとおり、
  この repo は DOM を伴う組み立てを手動検証に回している。jsdom を足して `DOMPurify.sanitize()` を
  試しても、確かめられるのは DOMPurify 自身で、自分の分岐 1 つではない
  （→ この判断は同日のセルフレビューで覆した。下記）
- 目視では見出し・箇条書き・コードブロック・表・引用・単独改行の `<br>` 化を確認し、あわせて
  `<script>` / `onerror` / `javascript:` リンクが消えること、利用者の吹き出しが素のままであることも見た

### セルフレビューでの是正（同日）

- 生成中の吹き出しを「配列の末尾」で判定していたのが誤り。`useChat` の `respondToInterrupt` は
  承認の吹き出しを末尾に積んだうえで、既存の空 assistant プレースホルダがあればそれを生成先に
  再利用する（`index.hooks.js`）。テキストを返さずに終わったターンがあると空のまま履歴に残るので、
  決定31 の承認経路で判定が外れ、避けたかった点滅がそのまま起きる状態だった。
  最後の assistant を指す `findLastAssistant`（`ui-rules.ts`）に改め、テストで固定した
- 再描画は delta のたびに走るため、過去の応答まで毎回変換し直していた。本文をキーにした
  キャッシュを挟み、会話を捨てるときに消す
- 「単体テストは置かない」判断（jsdom を足しても確かめられるのは DOMPurify 自身、という理由）は
  TDD の規約に対して弱いと判断し直し、jsdom を足して `markdown.test.ts` を書いた。
  このファイルだけ `@vitest-environment jsdom` で動かし、通るもの（見出し・箇条書き・表・`<br>`・
  通常のリンク）と落ちるもの（`<script>`・イベントハンドラ属性・`javascript:` の href）を固定した
- `breaks: true` の理由を「今の pre-wrap 表示に合わせる」と書いていたが、同じ変更で pre-wrap を
  外しているので矛盾して読める。「pre-wrap をやめても改行が改行として見える状態を保つため」に直した

### つまずき

- `npm install` が package-lock.json の同梱依存（`inBundle` の `@opentelemetry/core` 4 件）の記述を消し、
  bundled zod のバージョンを巻き戻した。CLAUDE.md が警告している現象そのもの。追加分（30 行）だけが
  残るよう、npm が書いた lock を土台に消された記述と巻き戻された値を HEAD から戻し、
  クリーンな `node_modules` で `npm ci` が通ることまで確認した
- `bb-agent` の `useChat` は `text-delta` ごとに `onMessagesChange` を呼ぶ（`index.hooks.js`）。
  素直に Markdown 化すると生成中に閉じていない ``` で後続が消えては戻るので、生成中は素の文字列で出す形にした
- `npm run build` が `Failed to resolve entry for package "aws-blocks"` で落ちるのは、生成物
  `aws-blocks/client.js` が未作成だったため（`npm run blocks:client` で解消）。今回の変更とは無関係
## 2026-09-06: 構成図に「Lambda が何者か」の注記を足す（決定32 の追記）

### 発端

- ユーザー指摘「買い手のエージェントが動いているのは Lambda のはずなのに、Agent「buyer」の囲みに Lambda が入っていない。
  Block 単位で分けた結果なのは分かるが、Lambda が何者なのかは書いたほうがよいのでは」

### 確認したこと

- 合成結果では Lambda は 1 本だけで、`Handler`（900 秒 / 2048 MB）が API Gateway（REST）の統合・WebSocket の 3 ルート・
  SQS のイベントソースを兼ねる（2026-09-03 の記録）。会話ループ・LLM 呼び出し・MCP のツール呼び出し・x402 の署名も
  すべてこの関数の中で動く。指摘は実態のとおり
- ただしこの観測は CDK 直 synth のときのもので、決定33 の Amplify 移行後に再合成はしていない（この worktree に
  `node_modules` が無く、裏を取るには install からになる）。図の文言はその範囲を超えないようにした

### やったこと

- 埋め込み XML を取り出して 2 セル足し、draw.io CLI（`-x -f png -e -b 10`）で焼き直した（描き直さない。決定32）
- 凡例に `lg_t5`「囲みは宣言の単位で、中の箱は Block が作る AWS 資源。買い手のコードが動くのは Handler Lambda 1 か所だけ」。
  収めるため凡例ボックスの高さを 205 → 255 にし、下の現況ボックスを y=950 → 1000 へ送った
- Agent「buyer」の囲みの下辺に `k_agent_run`「実行は Handler Lambda。会話ループ・LLM 呼び出し・MCP ツール呼び出し・
  x402 の署名はこの関数の中で動く」。既存の `k_agent_sub`（青「Realtime・AsyncJob・… を内蔵」）と同じ行の左側に、
  Block の説明ではないので通常の文字色で置いた
- 凡例の文言は当初「コードが動くのは Handler Lambda 1 か所だけ」としたが、凡例は図全体に掛かる箱にあり、
  同じ図には売り手の `McpFunction` も描かれている。「1 か所だけ」が売り手まで含むと読めるため「買い手の」を足した
- Handler のアイコンのラベルは触っていない。4 行に整えて縦線が文字を貫かないようにした経緯があり（決定32 の 2026-09-05 追記）、
  字数を増やすと再発する。アイコン自体も動かしていない

### つまずき

- 最初は Agent の囲みのタイトル行の右（y=672）に注記を置いたが、Handler から下段の Bedrock・SQS へ落ちる縦線が文字を貫いた。
  下辺へ移して解消。焼いた PNG を毎回目視しないと気づけない類の失敗で、XML を見ているだけでは分からない
- 座標を書き換える python がリポジトリ直下では動かなかった。ワークツリーの `mise.toml` が信頼されておらず `mise` が止める。
  `/tmp` から絶対パスで叩いて回避した
## 2026-09-06: 未知のパスを 404 にする（決定45）

### 発端

- ユーザーの申し出「トップページ以外の適当なパスでもアプリが動く。購入した HTML に変なものを仕込まれたときに困るので 404 にしたい」
- 調べた結果、コードではなく配信層の挙動だった。クラウドは Amplify コンソールがアプリ作成時に自動で付けた
  `/<*> → /index.html (404-200)` の規則（`aws amplify list-apps` の `customRules` で実物を確認）、
  ローカルは Vite 既定の `appType: 'spa'` のフォールバック（Blocks の開発サーバーは API 以外を Vite にそのまま流す）
- 危険度の見立て: 購入 HTML は不透明オリジンの sandbox iframe に閉じているので、フォールバック自体が権限を増やすわけではない。
  それでも任意 URL が本体を 200 で返すのは不要な露出で、この画面はクライアントルーティングを使わないため締めても失うものが無い

### やったこと

- `agent-app/vite.config.ts`: `appType: 'mpa'`。開発サーバー・preview とも存在しないパスは 404
- `agent-app/public/404.html`: 体裁用の自己完結の一枚（外部 CSS・JS 無し）。Vite が `dist/` 直下へ写す
- Amplify アプリ（ap-northeast-1、`dei96o54khd9a`）の規則を `/<*> → /404.html (404)` に差し替えた（`aws amplify update-app`）。
  アプリ単位の設定でリポジトリでは管理できないため、README のクラウド deploy 節に手順を書いた
- DESIGN.md に決定45

### セルフレビューで見つかった誤り（同日）

- **CDK 直 deploy の経路を「変更不要」と誤って結論していた。** 決定45 の初版は「`Hosting` は `spaFallback` 既定 false」と書いたが、
  根拠にした `?? false` は CloudFront Function を組み立てる低層（`@aws-blocks/hosting` の `defaults.js`）の既定で、
  実際にそこへ渡る値はアダプタが決めていた。`detectFramework` は next / nitro / astro / sveltekit 以外を全て `'spa'` に落とすため
  （`adapters/index.js`）、この Vite プロジェクトは `'spa'` 判定 → `spaFallback: true`。`npm run deploy`（決定33 の退路）では
  今も任意パスがアプリ本体を 200 で返す状態だった。既定値が多層のとき、低層の既定を見て早合点したのが原因
- 直し方: `aws-blocks/index.cdk.ts` の `Hosting` に `framework: 'static'` を明示。あわせて SPA アダプタが `dist/404.html` を見て
  `errorPages[404]` に自動配線するので（`adapters/spa.js`）、追加した `public/404.html` が CDK 経路でもそのまま効く
- Amplify の規則がリポジトリ外の手動設定である件は、`amplify.yml` から `update-app` を流す案の副作用（サービスロールに
  `amplify:UpdateApp` が要る・ビルドがアプリ設定を書き換える）を嫌って手動運用のままとし、残存リスクを決定45 に明記した

### 検証・つまずき

- クラウドの実応答は main ブランチにアクセス制御（Basic 認証）が掛かっており、curl では全パスが 401 だった。
  規則の反映は `update-app` の応答で確認し、404 ページ自体は本ブランチが deploy されてから（`404.html` が `dist/` に入ってから）
  ブラウザで確認する。規則の差し替えは deploy 前でも害はない（無いファイルは元から Amplify 既定の 404 になる）

## 2026-09-06: 買い手の画面の情報設計を組み直す（決定44）

### 発端（grill-me）

- ユーザーの申し出「タブやメニューでセクションの区切りを分かりやすくしたい。送信ボタンの隣に新規会話があるのはおかしい。全体を見直してほしい」
- 問いを重ねて絞った点: 想定利用者は第三者と開発者の両方で画面は同一、デバッグ情報は目立たせずに出す。
  「今何が起きているか」の状態表示は範囲外（別途）。区切りは二段組（タブで依頼と購入結果を分断しない）、
  認証はヘッダーに縮める、新規会話は見出し行の右端で会話があるときだけ確認、内部情報は `details` で既定は開く
- 途中でユーザーから「別ブランチの機能追加（ウォレット残高と支出上限。決定42・43、コミット `7c9b439`）を前提にしてほしい」と
  依頼があり、作業ブランチをそのコミットから切り直して載せ替えた。私の決定番号は 42 が使われていたため 44 に振り直した

### やったこと

- `index.html`: ヘッダー（nav）→ 未サインイン時の説明とサインインカード → 二段組（左: 依頼・ウォレット、右: 購入したページ）→
  `details#internals`（会話 ID・イベントログ）に組み直した。「新規会話」「更新」は各区画の見出し行へ
- `src/index.ts`: Authenticator を 1 要素のままサインインの前後でカード⇔ヘッダーに移し替える。新規会話は吹き出しがあれば
  `window.confirm`。折りたたみの閉じた状態を localStorage に記憶。`renderMessages` で吹き出し数を数える
- `src/ui-rules.ts`（+ テスト 5 件）: 確認の要否と折りたたみ状態の読み書き。DOM 環境（jsdom）は入れていないので
  DOM を伴わない規則だけを切り出した
- `src/style.css`: コンテナ 1280px、`.workspace` の grid（992px 以上で 2 列）、`.panel-header`、ヘッダー内の Authenticator の
  見出しを隠しサインアウトを枠線だけに、`#internals` を控えめに。ウォレット区画の CSS は機能ブランチのものをそのまま取り込んだ

### 検証

- `npm run typecheck` / `npm run test`（127 件）/ `npm run build` 緑。`aws-blocks/client.js` が無い新規ワークツリーでは
  `npm run build` が `aws-blocks` の解決で落ちる（`npm run blocks:client` を先に回せば通る。既存の挙動）
- `BUYER_LOCAL_MODEL=canned npm run dev` に Playwright で、サインアップ → 送信 → 新規会話の確認（取り消しで残る・承認で消える・
  空の会話では出ない）→ 折りたたみの記憶 → サインアウト（カードに戻る）を通し、1280px と 480px のスクリーンショットで確認。実決済なし
- つまずき: mock 認証はメール OTP ではなくメール＋パスワードのサインアップ → 確認コード（`getLastCode`）の流れで、
  Sign In に直接入れると `NotAuthorizedException`。e2e（`test/e2e.test.ts`）の手順に合わせた。
  折りたたみの記憶は、クリック直後に再読込すると `toggle` イベントが落ちて記憶されないように見えるが、
  待ちを入れれば記憶される（計測上の問題）

### PR #13 のレビュー対応

- PR #12 が先にマージされ、GitHub 側で PR #13 は `main` ベースへ付け替え・rebase された（head が変わるので、ローカルは
  `origin` に合わせて `reset --hard`）
- レビュー指摘 2 件を直した。①`#auth-nav form { margin: 0 }` は当たる要素が無く（サインアウトの包みは `form` ではなく
  `renderInternalAction` の `div` で inline の `margin-bottom: 16px` を持つ）、ヘッダーでボタンが上にずれていた。
  `[data-testid='authenticator-action-signOut']` に `margin-bottom: 0 !important` を当てる形に直した。
  ②`#auth-nav button` / `.panel-header button` の `width: auto` は効いていない（Pico が `width:100%` にするのは
  `button[type=submit]` だけ。PR #11 のレビューで一度是正した誤解の再発）ので消した

## 2026-09-06: CDP 資格情報の所在の確認と、コンソールの支払い画面が白画面になる原因の特定

### 発端（grill-me）

- ユーザーの疑問「Amplify で通すには `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET` を
  どの段階で設定する想定か」。Amplify の deploy 設定には無いのに main で決済が通っている理由が不明だった

### 確認した事実

- CDP の 3 点を読むのは `scripts/payments-setup.ts` と `scripts/faucet.ts` だけ。`aws-blocks/` `src/` `amplify/` は
  参照せず、`amplify/runtime-env.ts` の許可リストにも入っていない（決定34: Lambda に写すのは秘密でない値のみ）
- `payments-setup.ts` が `CreatePaymentCredentialProvider` で 3 点を AgentCore Identity（ap-southeast-1）の
  credential provider `coinbaseManual` として一度だけ預け、PaymentConnector `coinbaseQuick` はその ARN を参照する。
  以後 `ProcessPayment` の署名に要る CDP の資格は AWS 側がサービスロール経由で引く。Lambda が持つのは
  `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` と IAM 権限だけで、CDP の 3 点は手元の `.env` にしか残らない
- 3 点が改めて要るのは、provider の作り直し・別アカウントでの一からの provisioning・`faucet.ts` の入金の 3 場面

### コンソールの白画面の原因

- 決定27 の変更理由だった「AgentCore コンソールの支払い画面が白画面のまま」は、コンソールの
  **言語設定** が原因だった。English (US) にすると表示され、日本語はもちろん English (UK) でも描画されない
  （ユーザーが特定）。当時は 3 回失敗して MANUAL へ切り替えたが、コネクタの経路は MANUAL のまま据え置く
  （スクリプトで再現でき、資格情報がコードの外へ出ないため）
- 決定27 の理由欄に追記し、agent-app/README.md の環境変数の節に「CDP の 3 点は Amplify に設定しない」旨を足した
- 検証で AWS CLI を使おうとしたがセッション切れで、credential provider の一覧取得は未実施
  （`aws bedrock-agentcore-control list-payment-credential-providers --region ap-southeast-1` で見える）

### ウォレット残高の表示と、支出上限の画面からの変更（決定42・43）

ユーザーの要望「残高の推移を画面に出したい」「AgentCore Payments の機能で上限を画面から操作したい」を
下調べの上で 4 点に分けて確認し、着工した（残高は Payments の API から／上限は利用者が自分の枠を天井なしで／
変更は即時（現在のセッションを破棄）／残枠と期限も並べて出す）。

- 下調べで分かったこと: SDK に `GetPaymentInstrumentBalance` がある（`paymentConnectorId` が要る。
  これまで環境変数に無かった）。`UpdatePaymentSession` は無く、上限は作成時に固定。`PaymentSession` には
  `availableLimits.availableSpendAmount`（残枠）がある。CLI で引けなかったのはヘッダーの都合で SDK なら通る
- TDD（赤 → 緑）で追加: `payments/wallet-balance.ts`（残高取得と十進表記）、`payments/spend-limit.ts`
  （利用者ごとの上限の保存・検証・正規化）、`payment-session.ts` に `discardPaymentSession`（AgentCore → 記録の順で消す）と
  `describePaymentSession`（上限と残枠）。`maxSpendUsd` は関数でも受けるようにし、作り直し（`renew`）でも
  その時点の上限で切る。KVStore `spend-limit` を新設（TTL 無し）
- buyer API に `getWalletStatus` / `setSpendLimit` を足し、画面に「ウォレットと支払いの枠」の区画を新設
  （残高・今のセッションの残枠と期限・次の上限・上限の入力・残高の推移）。推移はブラウザ内で持ち、
  サインイン時・tool-result / done・更新ボタンで取り直して値が変わったときだけ行を足す
- 配線: `PAYMENT_CONNECTOR_ID` を `runtime-env.ts` の許可リスト（必須ではない）と `payments-setup.ts` の出力に追加。
  IAM に `GetPaymentInstrumentBalance` / `DeletePaymentSession` を追加
- 検証: unit 116 件、`npm run typecheck`、`npm run build`、e2e（偽 LLM。上限の保存・検証・利用者ごとの分離・未認証の拒否）
  が通ることを確認。残高取得と破棄の実物（`amount` の表記、IAM のリソース形式）は未実測で、sandbox か main の
  次回の実決済で確かめる。**deploy 前に Amplify の環境変数へ `PAYMENT_CONNECTOR_ID` を足すこと**
- 見た目は `npm run dev`（偽 LLM）に Playwright を当て、サインアップ → 上限変更 → 書式エラーを広い画面と 390px で撮って確認。
  直した 2 件: ①上限変更の結果表示が直後の再取得で消えていた（再取得は失敗時だけ表示を触る形に）
  ②390px で環境変数名のような長い値が右にはみ出した（`dd` を `min-width: 0` + `overflow-wrap: anywhere`、狭い画面では 1 列に）
- origin/main（決定41 のマージ）へリベースし、DESIGN.md の表の衝突（40 の直後に 41 と 42・43 が並ぶ）を解決した
- セルフレビューで 4 件直した。①上限超過のエラー文とコメントが `PAYMENT_SESSION_MAX_USD` を指したままだった（画面での変更に改めた）
  ②`discardPaymentSession` が記録を無条件に消しており、破棄の間に別の購入が作り直した記録まで消して有効なセッションが
  2 本並び得た（`ifValueEquals` 付きの条件削除にし、不一致なら相手を残す）③`walletStatus` / `changeSpendLimit` の環境変数あり
  の経路に単体テストが無かった（client を引数で差し替えられるようにし `wallet-status.test.ts` を追加）④ルート README の
  ステータスに画面の機能を追記
- PR #12 のレビュー（8 観点）で 1 件直した。`walletStatus` が AWS SDK の例外文をそのまま画面に返しており、
  サインインのたびに走る取得で ARN や ID を含む文が全利用者に見え得た。原文はサーバーのログに残し、画面には例外名だけを
  添えた一般化した文を返す形にした。もう 1 件の「Issue 未連携」は、本リポジトリでは DESIGN.md の決定番号が Issue の役割を
  担っているため対応しない
- つまずき: fresh な worktree では `aws-blocks/client.js`（生成物）が無く `npm run build` が落ちる。`npm run blocks:client`
  で生成してから。mise の shim が `python3` / `npm` を止めるので `mise trust` が要った

## 2026-09-05: 買い手の画面を Pico.css で整える（決定41）

### 着工前の詰め（grill-me）で決めたこと

- 「UI が分かりづらい」→ 直すのは **見た目だけ** 。デバッグ用の表示（直近コード・イベントログ・会話 ID）は
  情報設計ごと現状維持、というユーザー選択。対象は `index.html` の 3 区画すべて
- 手段は軽量な classless CSS フレームワーク（Pico.css）。読み込みは CDN 直読みではなく npm 依存
  （他の依存の管理方針に合わせ、オフラインでも動くため）

### やったこと

- `@picocss/pico` 2.1.1 を追加し、`src/style.css` を新設（`pico.blue.min.css` を `@import` し、
  淡いブルーのテーマ変数と独自要素のスタイルを重ねる）。`index.html` の `<style>` は撤去して `<link>` に
- マークアップを Pico の作法に寄せた: `main.container` / `article` + `header` のカード / チャット入力は
  `role="group"` 。`viewport` の meta を足し、見出しは `h2` のまま残して意味づけを壊さないようにした
- ID とクラス名（`msg` `interrupt` `purchase` `signed-in-only` など `src/index.ts` が触るもの）は据え置き

### つまずき・判断

- `role="group"` の中は子が等分に伸びるため、ボタンだけ `flex: 0 0 auto` にした
- テーマ変数を素の `:root` に置くと Pico の `:root:not([data-theme=dark])` に負けて効かない。同じ強さの
  セレクタで後に書いて上書きした
- 暗色環境で崩れるのを避けるため `data-theme="light"` を固定した。独自要素の吹き出し・ログが明色前提で、
  自動切替に任せると白い箱に白い文字になる
- Authenticator は自前のカード枠を inline style で描くため、`article` と枠が二重になる。inline style が
  相手なので `!important` で打ち消した
- 淡い色を primary に使うと白抜き文字とのコントラストが落ちるので、primary は `#2c6fb0`（白に対して 5.24:1）に
  留め、淡さは背景・枠線・吹き出しで出した
- 390px で 「直近のコードを表示」 のボタンが 3 行に潰れていた。横並びの行（`.code-hint` `.interrupt`
  `.purchase`）に `flex-wrap: wrap` を足し、チャット入力は 576px 以下で枠線の連結をやめて入力欄を 1 行、
  ボタンをその下に並べるようにした
- セルフレビューで 3 件直した。①Pico の `.container` は 1280px 以上で 1200px、1536px 以上で 1450px まで
  広がり、会話の一行が長くなりすぎるので旧実装と同じ 960px で頭打ちにした
  ②`.msg` に `overflow-wrap: anywhere` を足した（tx ハッシュのような空白を含まない長い文字列で
  吹き出しがはみ出す。旧実装から在る穴だが、`#chat-log` を面にして目立つようになった）
  ③購入一覧の「まだありません」は、JS の再描画で class の無い span になり初期表示と見た目が変わるため、
  muted に揃えた
- `npm install` が package-lock.json を書き換えて CI（`npm ci`）を落とした。手元の npm 11.16.0 は
  `@aws-amplify/data-construct` に同梱（`inBundle: true`）された `@opentelemetry/*` の入れ子の記述 74 行を
  「不要」と判断して削るが、CI の npm はそれを必要とし `Missing: @opentelemetry/core@2.0.0 from lock file` で
  止まる。lockfile を origin/main の状態に戻し、`@picocss/pico` の 2 箇所（ルートの dependencies と
  `node_modules/@picocss/pico`）だけを足す形にした。`rm -rf node_modules && npm ci` が通ることを手元で確認済み。
  **教訓**: この lockfile は手元の npm と挙動が食い違うので、依存を足すときは `npm install` の結果を
  そのまま信じず、差分が足したパッケージだけに収まっているかと `npm ci` が通るかを必ず見ること
- 検証: `npm run typecheck` `npm run test`（98 件）`npm run build` が通ることを確認。見た目は `npm run dev` に
  Playwright を当て、未サインイン・OTP 入力中・サインイン後を広い画面とモバイル幅（390px）で撮って確認した。
  会話や購入が入った状態は一時的な確認用 HTML にサンプルの markup を置いて撮り、確認後に削除している
  （実決済は発生させていない）
- CSS だけの変更なので TDD のレッド → グリーンは踏んでいない（振る舞いを変えていないため既存テストが回帰の網）

### PR レビュー（PR #11）で出た指摘と対応

**セルフレビューで「直した」2 件が、実は詳細度で効いていなかった。** 見た目の確認をスクリーンショットだけで
済ませたのが原因で、CSS は「当たっているか」を計算値で測らないと分からない。今回は Playwright で
`getComputedStyle` を取って裏を取った。

- `body > main`（0,0,2）は Pico の `.container`（0,1,0）に負ける。1920px で `max-width` の実測値は 1450px で、
  頭打ちがまったく効いていなかった。`body > main.container` に直した
- `#purchases > span`（1,0,1）は `.error`（0,1,0）に勝つので、購入一覧の取得失敗（`showError`）の警告が
  赤ではなく muted の 0.85em で出ていた（実測 `rgb(100,107,121)`）。金銭に直結する唯一の通知経路なので、
  `:not([class])` を付けて class 付きの span には当てないようにした
- 「Pico の button は既定で `width: 100%`」は誤り。2.1.1 で当たるのは `button[type=submit]` だけで、
  この画面のボタンは `type` を持たない（素の button の実測幅は auto）。`width: auto` の上書きは効果が無く、
  理由も成立していなかったのでブロックごと削除した
- 無効化された「失敗」ボタンは Pico が `opacity: 0.5` を掛けるだけで、白抜き文字とのコントラストが 2.09:1。
  「表示」と濃さでしか区別が付かないので、枠線だけの控えめな見た目に置き換えた
- 決定41 の行が決定40 の行に改行なしで連結され、表の行として成立していなかった（GitHub 上では列数を
  超えたセルが捨てられ、決定41 の本文が一切描画されない）。ついでに決定38 の後ろにあった空行も除いた。
  表の途中の空行で決定39 以降が表として描画されなくなっていたため（前回の PR からの持ち越し）
- 決定41 の「ID / クラス名は変えず」は不正確だった。変えていないのは `src/index.ts` が触るものだけで、
  `.section` は消え、`article` / `hgroup` が入っている。限定を明記した
- チャット入力に足した `role="group"` にアクセシブルな名前が無く、入力欄にもラベルが無かったので
  `aria-label` を足した（実オンチェーン決済を起こす画面の主操作のため）
- 暗色対応を捨てた判断は維持し、理由を決定41 に足した（独自色は変数以外にも直書きがあり、iframe に
  注入される売り手の HTML 自体が明色前提なので、外枠だけ暗色にしても揃わない）

## 2026-09-05: フェーズ⑤の完了 — main で実決済を通し、⑤の残論点 2 件を片づける（決定39・40）

### 着工前の詰め（grill-me）で崩れた前提

- 「PR #7 は open」→ 既にマージ済み。作業中に PR #8（構成図の整形）と PR #9（README 整備・決定38）も入った
- 「ブランチ環境変数が未設定で合成が落ちる」→ 環境変数は既にアプリ単位で設定済みで、deploy も成功していた。
  ただし `PAYMENT_MANAGER_ARN` に `payments-setup.ts` の表形式の出力 3 行が丸ごと貼り付いており、Lambda にも
  そのまま写っていた。許可リストは値の有無しか見ないため合成を通り抜け、発注して初めて露見する状態だった
- 「支払い主体の二重化には利用者ごとの instrument と WalletHub 委任が要る」→ 解きたい問題は「利用者ごとの
  支出上限」と「誰が支払わせたかの監査」の 2 つで、ウォレットを 1 つのまま PaymentSession を利用者ごとに
  切れば両方を満たせる。ユーザー決定でこちらを採った（決定39）
- 「レート制限が要る」→ 何を防ぎたいかを問い、ユーザーは「依頼回数の制限（Bedrock の費用対策）」を選んだ（決定40）

### やったこと

- main の実決済: `aws amplify update-app` で `PAYMENT_MANAGER_ARN` を正しい値に置換して再ビルドし、
  `buy-via-cloud.ts` で 3 回発注（作成 → 使い回し × 2）。tx は `0x6ec5a088…9ec772` / `0xc9594ad5…50b1e8` /
  `0xec97c0b0…8b9b69`。IAM を `payment-manager/*` に絞った状態で通ることも確認した
- 決定39: `payment-session.ts` に `storeKey`（Cognito の sub）を足して記録のキーにし、Payments 側の `userId` は
  ウォレット持ち主のまま据え置いた。`expiryTimeInMinutes` の下限 15 分を実測し、定数を
  `payment-session.ts` に 1 つだけ置いて合成時（`runtime-env.ts`）と実行時（`buyer-agent.ts`）の双方から参照する
- 決定40: `rate-limit.ts`（固定時間窓のカウンタ）と KVStore `request-count` を足し、`sendMessage` で
  所有検証の後・エージェント起動の前に数える。`interrupt-guard.ts` で `resume` に承認待ちの実在を要求する
- ドキュメント: 決定39・40 を新設し、決定28・34・35・36 に追記。README は決定38 の方針
  （決定N を書かず、そのファイルだけで分かる形にする）に沿って書き下ろした
- 構成図: KVStore の箱に `request-count` を足し、現況の注記を main の実決済済みに更新した。
  箱を広げる余地は矢印の経路に阻まれていたため、アイコンの間隔を詰め、各アイコンが繰り返していた
  「Amazon DynamoDB」を箱のタイトルへ寄せてラベルの重なりを避けた

### つまずき

- 作り直しの検証で、削除スクリプトを `/tmp` の `.ts` に置いて `tsx` で実行したところ top-level await が
  CJS 扱いで落ち、それをパイプ（`| sed`）が隠したため `&&` の後段の 3 回目の購入がそのまま走った。
  結果、3 回目は使い回しになり、作り直しは main では未検証のまま。4 回目の実決済はユーザー判断で行わない。
  教訓: 破壊的操作 → 課金操作の連鎖では前段の成否を目で確かめてから後段を起動する
- `aws bedrock-agentcore` の PaymentSession 系コマンドは `X-Amzn-Bedrock-AgentCore-Payments-User-Id` ヘッダーが
  必須で、AWS CLI からは渡せない。参照・削除は SDK の一時スクリプトを `agent-app/scripts/` に置いて行った
  （`/tmp` からは依存を解決できない）
- ワークツリーは `mise trust` するまで npm が動かず、バックグラウンドの `npm ci` が黙って何もしていなかった
- 作業中に main が 7 コミット進み（PR #9）、決定38 の番号が衝突した。ブランチを main に載せ替え、
  こちらの決定を 39・40 に繰り下げた

### セルフレビューで見つけて直したもの

- **`resume` が回数の上限を迂回できた**。決定40 は当初「`resume` は承認待ちがあるときしか呼べず有界」を
  根拠に数えていなかったが、`bb-agent` の `resume()` は承認待ちの実在を検証せず、応答さえ渡せばジョブを
  投入してモデルを起動する。上限に達した後も `resume` を繰り返せば費用が出る。`interrupt-guard.ts` で
  前提の方を成り立たせた（承認待ちに無い ID が 1 件でも混ざれば全体を弾く）
- **`rate-limit.ts` の `ifNotExists` が、決定35 改訂で一度踏んだ罠と同じ形だった**。本番の `get` は期限切れを
  `null` にするが実体は消さず、`ifNotExists` は実体を見る。キーは「利用者/窓の開始」で通常は再利用されないが、
  窓の長さを変えると過去の窓と一致する（60 分の境界は 120 分の境界を含む）。そのままだと該当利用者の依頼が
  窓の終わりまで全て失敗した。記録を読めないのに `ifNotExists` が落ちたら条件を外す形に直し、回帰テストを足した
- 決定35・36 に、決定39・40 で覆された旨の追記が無かった。決定35 の「次の購入が作り直しの経路を踏む」も、
  決定39 で記録のキーが変わるため成立しなくなっていた（残置した持ち主キーの記録は読まれない）。両方直した
- 構成図に KVStore `request-count` が無かった。15 分の下限がリテラルで 2 箇所に散っていた

### 残していること

- 作り直しの経路の main での実測（改めて `DeletePaymentSession` を打つ）
- 決定39・40 のクラウドでの実測（利用者 2 名での別セッション、上限を超えた依頼の拒否）
- ウォレット残高の推移は画面に無く、CLI でも取れない（上記ヘッダーの件）

## 2026-09-05: README の整備と LICENSE の追加（決定38）

ユーザーから「README が分かりにくいので、そろそろドキュメントを整備した方がいいのでは」との相談を受け、
grill-me で前提から問い直した。

### やったこと

- 実測: ルート README（43行、決定番号への参照3件）は簡潔、agent-app/README.md（97行・9.4KB、参照14件）が
  実際に長大で、アーキテクチャ・運用注意・デプロイ手順・環境変数一覧が同じ階層の箇条書きで並んでいた
- ユーザーとの往復で、対象は「agent-app/README の長さ」「ルート README の粒度・順序」
  「第三者向け説明の不足（専門用語の説明なし）」「初見者の導線の分かりにくさ」の4点と確定。
  DESIGN.md の1枚表形式は対象外
- 公開前提であることを確認（ユーザー回答）
- ルート README に「ドキュメントの読み方」（README・AGENTS.md・DESIGN.md・implementation-log.md の
  役割案内）と x402 / MCP Apps / AgentCore Payments の一言説明を追加し、ステータス節の
  「⑤の残論点は決定28」という古い記述を実態（決定34〜36 で大半解消、レート制限・支払い主体の
  二重化は未着手）に更新した
- agent-app/README.md は内容量を変えずに `###` 見出しで再構成した（構成 → アーキテクチャ / 運用上の注意、
  コマンド → ローカル開発 / Amplify sandbox、クラウド deploy → スタック構成 / ネットワークと命名 /
  実行時設定と検証）。冒頭にルート README・DESIGN.md への導線も追加した
- LICENSE（MIT）を追加した。参照3リポジトリ（html-creator-mcp-apps・ops-agent-sample-on-aws・
  handson-aws-blocks）に前例が無く、決済コードを含む公開サンプルであることからユーザー判断で選定

### 判断・つまずき

- 作業前に `git pull` すると main が4コミット遅れており、直近の PR #7（billing-mcp の `pnpm outputs` 追加）で
  billing-mcp/README.md と agent-app/README.md にも変更が入っていた。先に取り込んでから整備した
  （古い内容に対して作業すると PR #7 の変更を潰しかねなかった）
- ドキュメント再構成を1度に大きく書き換えると Edit のマッチングに失敗しやすく、実際に見出し挿入で
  区切り位置を誤り、セクション境界の空行を1箇所削ってしまった（すぐに気付いて復元）。以後は
  `sed` で範囲を切り出してから Python で1回だけ置換する方式に切り替えた

### 訂正（同日）

- 初版は「billing-mcp/README.md と DESIGN.md の1枚表形式は対象外」とファイル単位でスコープを線引きし、
  agent-app/README.md の冒頭にルート README・DESIGN.md への導線（2行）を追加していた。ユーザーから
  「ドキュメント修正はスコープを区切るような作業ではない」という指摘を受け、以後はファイル単位の
  対象外設定を行わない方針に改めた
- 上記の導線についても、billing-mcp/README.md に同種のものが無く非対称になっていたため、
  ユーザーの提案（「無いほうで統一」）どおり削除した。決定の経緯・DESIGN.md への導線はルート README の
  「ドキュメントの読み方」に一本化し、各アプリの README は決定N の引用があっても本文だけで
  内容が分かる独立した記述のままとする
- DESIGN.md 決定38 にも同内容を追記した

### セルフレビューと再修正（同日）

- billing-mcp/README.md を対象から外していたことが実害を生んでいた。売り手スタックを
  「検証後に削除済み」とする記述が billing-mcp/README.md とルート README の計3箇所に残っていたが、
  実際には 2026-09-04 の再 deploy 以降そのまま置いてある（`main` での検証に使うため）。3箇所とも直した
- agent-app/README.md の冒頭が「売り手のクラウド結合は未実施」のままだった。sandbox では
  クラウドの買い手と売り手を結合して実オンチェーン決済まで通っている（2026-09-04 の実測）。
  「フェーズ④〜⑤。main への deploy と実決済は未実施」に改めた
- ルート README が sandbox の到達点を「疎通を確認」と過小に書いていたので、実決済・生成・取得まで
  確認した旨に改めた
- 決定N の記法を統一した。当初「billing-mcp/README.md と対称を取るため各アプリでは導線を張らない」と
  判断したが、これは事実誤認で、billing-mcp/README.md は5箇所すべて「DESIGN.md 決定N」と書いていた。
  agent-app/README.md の裸の「決定N」14箇所をこの記法に揃えた。ルート README だけは
  「ドキュメントの読み方」で意味を説明済みのため裸のままとする
- 反省点: 上の4件はいずれも、今回の改訂で触ったファイルの中か真隣にあった。ルート README の
  ステータス行は書き換えながら、同じ行の「削除済み」を見落としている。「指摘された箇所だけを直す」
  範囲の切り方そのものが、見落としを生んでいた

### 決定N 参照の除去（同日、ユーザー指摘）

- ユーザーの指示は当初から「各アプリの README は外部を参照しないと分からない情報を消し、
  そのファイル内だけで理解できるようにする」だった。決定32 でも同じ理由で構成図の
  決定N参照23箇所を全て外した前例がある
- にもかかわらず二度取り違えた。一度目は「導線の1行だけを消す」と狭く解釈し、二度目は逆に
  「DESIGN.md 決定N」へ揃えて外部参照を強めた。指示ではなく、自分が立てた「記法が不統一」という
  問題設定に沿って解釈したのが原因
- agent-app/README.md の14件と billing-mcp/README.md の6件を全て外した。番号が「なぜ」を
  担っていた2箇所は理由を本文に書いた。①ウォレットが ap-southeast-1 なのは AgentCore Payments が
  東京リージョン非対応のため ②「採らなかった構成」は AgentCore Runtime・API Gateway・
  Cognito ゲスト資格情報それぞれの不採用理由を箇条書きにした
- これで両 README から DESIGN.md への言及は無くなった。決定録への案内はルート README の
  「ドキュメントの読み方」だけが持つ

### 整合性の再確認（同日）

- 古い記述を直す作業の中で、新しい誤りを書き込んでいた。ルート README と agent-app/README.md に
  「main ブランチへの deploy は未実施」と書いたが、決定32 の差し替え記録（「main の Amplify deploy が
  成功したので差し替えた」）と構成図の現況注記（「agent-app は Amplify Hosting の main に deploy 済み」）の
  とおり、main への deploy は 2026-09-04 夜に成功している。未実施なのは main のブランチ環境変数への
  `PAYMENT_*` の設定と main での実決済。3箇所を直した
- 原因は、implementation-log の 2026-09-04 の項に残っていた「未検証: Amplify Hosting 上での配信」だけを
  見て、その後に入った決定32 の差し替え記録と構成図の現況注記に当たらなかったこと。ステータスを
  書くときは決定録と構成図の現況注記の両方を見る
- あわせて次を照合し、記録と一致することを確認した。①ウォレットが ap-southeast-1 な理由（決定12）
  ②使用ブロック5つ（決定26）③「採らなかった構成」の数値 30秒 / 310秒 / 570秒（決定20）
  ④3つの README と構成図の現況注記が、売り手スタックと agent-app の deploy 状態について
  同じことを言っていること
- ルート README の「本文中の「決定N」はここを指す」は、各アプリ README から決定N が消えたため
  「この README で触れている「決定N」はここを指す」に直した

### README の読者を問い直す（同日、ユーザー指摘）

- ユーザーから「README に deploy 済みとか書いてあるのはおかしくないか。作業記録ではない。
  誰向けのメッセージなのか」と指摘を受けた。そのとおりで、上の訂正の一連は
  「README に書くべきでない文」の正確性を直し続けていた
- 「2026-09-04 に deploy 済み」「スタックを置いてある」は著者の AWS アカウントの在庫状況で、
  読者には見えず・使えず・検証できず、スタックを消せばまた古くなる。作業記録の領分
- 「フェーズ④〜⑤」も読者が知らない内部語彙で、決定N を外したのと同じ問題を残していた
- 3つの README を「在庫」ではなく「このサンプルで何がどこまで動くか」に書き換えた。
  日付・スタック名・フェーズ番号・内部タスクの消化状況は README から外し、作業記録に置く

### 読者の疑問の順に組み直す（同日、ユーザー指摘）

- ユーザーから「README が分かりづらいというのが何も伝わっていなかった」と指摘を受けた。
  そのとおりで、ここまでの一連は正確性・一貫性・分類という機械的に検証できることばかりで、
  「読者の疑問に順番に答える」という当初の依頼そのものに手を付けていなかった
- とくにリード文は、用語説明を求められたと解釈して括弧で押し込んだ結果、1文・5行・
  入れ子の括弧3つになり、元の2行より読みにくくなっていた
- ルート README を組み直した。①冒頭を「頼むとエージェントが自分で払って、できたページが出る」の
  3行に ②「何が起きるか」で 1 回の購入の流れを6ステップに ③解読しづらい ASCII 略図をやめ、
  構成図 PNG を本文に埋め込み ④用語説明を独立した表に ⑤「動かす」（前提と、売り手→買い手の手順）を
  新設。これまでどの README にも無かった ⑥「ドキュメントの読み方」は「もっと詳しく」として末尾へ
- agent-app/README.md は冒頭に「まず動かす」（3 ステップのコマンド）を置き、旧「構成」を「しくみ」に
  改名して後ろへ。コマンド節から「まず動かす」と重複する説明を削り、`faucet.ts` の記載漏れも足した。
  「縦串検証に必要な環境変数」は「環境変数」に改名（縦串検証は内部語彙）
- billing-mcp/README.md は「まず動かす」を冒頭に出し、無認証の理由と流量制限の話は
  「認証を掛けない理由」として後ろへ送った

## 2026-09-05: 構成図の見た目の整形（docs/architecture.drawio.png）

ユーザーから「配置の縦横が微妙に揃っていない・線が無駄に曲がっている・囲みから外れているものがある」と
指摘を受け、埋め込み XML を取り出して座標とラベル位置を直した（描き直さない。決定32）。

### やったこと

- アイコンの行を揃えた。買い手の上段は y=275、中段（Amplify ビルド・Cognito・Handler）は y=470 に統一。
  これまで 430 / 460 / 470 とばらばらだった。列も揃えた（AgentCore Identity と Coinbase を Handler の列に、
  Base Sepolia を売り手の Bedrock / CloudWatch の列に）。利用者アイコンの中心をブラウザ枠の中心に合わせ、
  矢印の段差を消した
- 囲みの寸法をラベルが収まる幅に直し、上段 4 つの囲みの右端（1300）を Agent の囲みに揃えた。
  はみ出していたラベル（Amplify Hosting の URL、Cognito の説明、API Gateway の CORS、KVStore の 2 表）は
  囲みを広げるか、文言はそのままで改行を増やして収めた。ap-southeast-1 の枠は Payments のラベルが
  右の枠線をまたいでいたため 1420 まで広げた
- 線の端点を exitDx / exitDy のピクセル指定で整数座標に固定し、0.5px 前後の段差を無くした。
  Handler の右辺から出る 4 本は 13px 間隔（483 / 496 / 509 / 522）、下辺の 5 本も 13px 間隔にした。
  ほぼ重なっていた ⑤ と「セッション」（2px 差）を分けた
- ラベルの位置を直した。横線に貫かれていた ③、囲みの枠線に掛かっていた ⑨・⑤・「セッション」・④、
  Bedrock のラベルに触れていた「ログ」、Base Sepolia のアイコンに食い込んでいた ⑦。「署名権限の委任」は
  AWS Cloud と AWS 外の囲みの間に置いた
- Handler のラベルを 4 行にした。3 行目「PAYMENT_* は Amplify のビルド環境変数から」が 230px あり、
  API Gateway → Handler の縦線がどこを通っても文字を貫いていた。改行で幅を 162px にし、縦線を左へ逃がした

### 判断

- 中段を 470 に揃えると Amplify Hosting / AuthCognito の囲みの底が下がるため、Agent の囲みから下を
  一律 30 下げた（線とラベルの間隔は以前と同じ）
- 幅の予算（買い手の内側 390..1300）が足りず、囲みの間隔は 15 / 22 / 22 になった。22 の 2 箇所は
  縦線（API Gateway → Handler と ⑨）の通り道として要る

### つまずき

- draw.io の edge ラベルの相対位置 x は [-1, 1]（0 が中点）で、0..1 ではない。折れ線上の狙った点から
  逆算するヘルパーを書いて置いた
- この worktree は mise.toml が未 trust で `python3` のシムが落ちる。`/usr/bin/python3` を直接使った

## 2026-09-05: 売り手の出力と、買い手への値の引き継ぎの整備

PR #6 のマージ後に main へ `PAYMENT_*` を設定する段になり、必要な 3 つの値をその場で
集められないことが分かった。売り手の Function URL は deploy 時のログにしか無く、しかも
2026-09-04 の再 deploy で変わっていて、記録の値をコピーすると疎通しない状態だった。

### やったこと

- `billing-mcp` のスタックに出力を 2 つ足した（テスト先行）。`PayToAddress`（買い手の
  `PAYMENT_PAY_TO` と突き合わせる）と `Price`（買い手の `PAYMENT_MAX_AMOUNT` が賄えるか確認する）。
  `price` は省略可なので、省いたときは出力しない——サーバー側に既定額があり、スタックに書くと
  定数が二重になるため（環境変数の渡し方と同じ扱い）。既存の出力の description にも、
  対応する買い手側の環境変数名を書いた
- `pnpm outputs` を追加した。deploy 済みスタックの出力を読み、`export BILLING_MCP_URL=...` の形まで
  出す。スタック名は `parameter.ts` の `envName` から組み立てる（`billing-mcp.ts` と同じ）。
  `parameter.ts` は gitignore なので、名前を決め打ちにすると `envName` を変えた人が別のスタックを見てしまう
- README を整備した。`billing-mcp/README.md` に「デプロイ後に値を取り出す（買い手への引き継ぎ）」を新設し、
  出力と買い手側の環境変数の対応表を置いた。`agent-app/README.md` の「縦串検証に必要な環境変数」も、
  値の出どころ（買い手の `payments-setup.ts` か、売り手の `pnpm outputs` か）が分かる表に変えた

### 判断

- 出力を取るのに `@aws-sdk/client-cloudformation` を足すのはやめ、AWS CLI を呼ぶ形にした。
  この一手のために依存を増やす価値は無く、AWS CLI は既に他の手順（Cognito の利用者作成など）で前提にしている
- `exportName` は付けなかった。値は Amplify コンソールに人が貼るのであって `Fn::ImportValue` で
  渡すわけではないため、付けても使い道が無い
- 実装ログの古い Function URL は書き換えず、追記で「再 deploy で変わっている。現行値は出力を見よ」と補った。
  ログはその時点の記録なので、後から実物に合わせて書き換えると記録の意味が失われる

### つまずき

- 現在 deploy されているスタックは今回の変更より前のものなので、`pnpm outputs` を実行しても
  `PayToAddress` / `Price` はまだ出ない。次の deploy 以降に出る

## 2026-09-05: PR #6 のコードレビュー指摘の修正（決定37・U8）

PR #6 に `pr-code-review` スキルで観点別レビューを行い、ユーザー判断で 11 件を修正した（GitHub には投稿せず、この場で修正）。

### 中核: 支出上限が上限として機能していなかった

レビューで AWS の [AgentCore Payments IAM ガイド](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-iam-roles.html) に次の記述があることが分かった。

> Do not include PaymentSession *write* permissions (for example, `CreatePaymentSession`) and `ProcessPayment` in the same role, or the caller can bypass payment limits by creating new sessions with elevated budgets.

決定35 の実装はこの迂回を IAM で許すだけでなく、**アプリが自動で実行**していた。`isSessionRejection` が
`ConflictException: Session limit exceeded` を「セッション起因」と判定し（`payment-session.test.ts` が
その挙動をテストで固定していた）、`x402-payer.ts` がそれを無条件に `renew()` へ流すため、**上限に当たった
支払いがその場で新しい枠を切って成立していた**。決定35 の理由欄が開示していたのは「枠は時間ごとに戻る」
ことまでで、「上限が一度も支払いを止めない」ことまでは意図していなかった。決定37 として、上限超過は
作り直さず失敗させる側に倒した。

ロール分離は行っていない。共有 Lambda 1 つがセッション作成と支払いの両方を実行するため、ロールを分けても
同じ identity が双方を握ることに変わりがなく、分離にならないため。IAM のリソースは `payment-manager/*` に
絞り、構造での分離は U8 として残した。

### 挙動が変わるもの

- **決済後の再 402 を `PaidToolError` にした**（`paid-tool-caller.ts`）。従来は素の `Error` で、
  `buy-html.ts` の `instanceof PaidToolError` を素通りしてツールハンドラまで伝播し、レシート記録
  （`artifacts.put`）に到達していなかった。9/4 の sandbox 実測（2 回目の購入）でまさにこの経路を踏んでおり、
  ログに「決定31 の防護どおり再試行なし」と書いたが、実際に効いていたのは④（システムプロンプト。補助）だけで
  ③（`interrupt` による承認要求。保証と明記した硬い防護）は発火していなかった。オンチェーンの送金は
  起きていないが署名は売り手に渡っており、売り手は有効期限内なら後から決済を確定できる。「資金が動いていないから
  無害」とは扱わず、レシート（nonce）を残して③を働かせる。**この会話で次に購入するときは人の承認を要求するようになる**
- **`renew` に拒否されたセッション ID を渡すようにした**（インターフェースの変更）。別の購入が既に作り直して
  いればその有効なセッションに乗る。記録の書き込みは条件付き（`ifNotExists` / `ifValueEquals`）にし、
  読んでから書くまでに別の購入が書いていたら相手を残す
- **`PAYMENT_SESSION_MAX_USD` / `PAYMENT_SESSION_MINUTES` の書式を合成時に検証する**ようにした。
  従来は実行時に黙って既定へ戻していたため、`10.000` や `1,000.00` のような書式ミスで「上限を上げたつもり」に
  気づけなかった。ローカル実行で既定に戻す場合も `console.warn` を出す

### その他

- `buy-via-cloud.ts`: cookie jar を `BLOCKS_API_URL` のオリジン限定にした（差し替えた `fetch` が
  プロセスの全通信に及ぶため、他所へセッションを渡さない／他所から同名の Cookie を注入されない）。
  `BUYER_TOOL_TIMEOUT_MS` を実決済の前に検証（`NaN` だと一度もポーリングせず失敗と誤報告していた）。
  サインイン失敗時の `JSON.stringify(state)` をやめた（Cognito のチャレンジ継続用 session や
  TOTP の共有シークレットが hidden フィールドの `defaultValue` に載るため）
- コメントの是正 3 件: `paid-tool-caller.ts`（「資金は動いていない」が実測の半面だけだった。残枠は署名時点で
  1.00 → 0.8 USD と減っている）、`index.ts`（所有検証の根拠を「自己サインアップを許しているため」に
  置いていたが、決定36 でその前提が消えた）、`runtime-env.ts`（`payments/` は `process.env` を読まない。
  読むのは `buyer-agent.ts` で、`payments/` へは引数で渡す）

### 見送ったもの

- リンクされた Issue が無い件: このリポジトリは Issue を使わず DESIGN.md と本ログで経緯を残す運用のため対象外
- `isSessionRejection` の docstring が「sandbox の実測で確定させる」のままだった件: 決定37 の書き換えで
  実測済みの分岐（`ValidationException` + `Payment session not found`）と推定のままの分岐を区別する形に直った
- 構成図の差し替えが同じ PR に混入している件: 独立コミットでコード変更を含まず、記録を残す規約上むしろ自然と判断

### セルフレビューで見つけた退行（同日中に修正）

記録の書き込みを条件付きにした際、記録を読めなかった場合に `ifNotExists` を付けていたが、これは
**本番でだけ**セッションの使い回しを壊す。KVStore は `get` で期限切れを `null` にするが実体は消さず
（DynamoDB の TTL 掃除は最大 48 時間）、`ifNotExists` は `attribute_not_exists(pk)` で実体の有無を見るため、
期限切れの実体が残る間はどう書いても条件不一致になる。結果、購入のたびに新しい PaymentSession を切り続け、
決定35 の使い回しが死ぬうえ、枠が毎回戻るので決定37 で締めた上限も弱まる。

mock 実装は `get` で期限切れを即座に削除するため、`npm run test` も `npm run dev` も e2e もすべて通る。
ライブラリのオプションは docstring ではなく実装（`node_modules/@aws-blocks/bb-kv-store/dist/index.aws.js`）で
意味論を確かめるべきだった。読めた記録があるときだけ `ifValueEquals` を付ける形に直し、
本番の意味論を模した回帰テストを足した。

### 確認したこと

- `npm run test`（12 ファイル 85 件）/ `npm run typecheck` / `npm run test:e2e`（3 件）が通ること
- 未実施: sandbox への再 deploy による IAM の実地確認（資源を作るため、別途確認を取ってから行う）

## 2026-09-04（続き）: フェーズ⑤ — 実行時設定と IAM の配線、PaymentSession のアプリ内作成、selfSignUp の閉鎖（決定34〜36）

### 前提の確認（grill-me）

- 次セッションの作業指示（A: 本番 deploy の実地確認、B: `PAYMENT_*` の配線と IAM、C: その後の 4 項目）を
  grill-me で問い直した。下調べで依頼の前提と食い違う事実が 3 つ出た:
  1. `payments-setup.ts` が切る PaymentSession は `expiryTimeInMinutes: 60`。B の方式でどう渡しても
     deploy から 1 時間で決済が止まるため、C-1（アプリ側でのセッション作成）は「その後」ではなく B の前提
  2. 売り手（`BillingMcpStack-dev`）は ap-northeast-1 に無い（決定32 の「削除済み」のまま）。クラウドの
     Lambda から `localhost` の売り手には届かないので、実決済の検証には売り手の再 deploy が要る
  3. Amplify のアプリ（`dei96o54khd9a`、`main`）は今回のセッション中にユーザーが作成し、job 1 が
     BUILD / DEPLOY / VERIFY とも成功した。サービスロールには `AmplifyBackendDeployFullAccess` が付いている
- 裏取りで分かった好材料: Agent のジョブは `bb-async-job` が共有 Lambda に SQS イベントで流す形
  （`index.cdk.js` の `this.handler.addEventSource`）で、共有 Lambda のタイムアウトは `@aws-blocks/core` で
  900 秒固定。`blocks.handler` の `addEnvironment` / `addToRolePolicy` がそのまま決済処理に届き、
  `BUYER_TOOL_TIMEOUT_MS` 既定 600 秒（決定31 の注記）を包含する
- ユーザー決定: C-1 を B に繰り上げる／売り手は私が再 deploy し検証後も置く／検証は sandbox → main の順／
  設定は①`addEnvironment` で透過（AppSetting 化しない）／ブラウザ検証は Playwright + OTP 転記／PR は
  A（記録と構成図）と B + C-1 の 2 本／main へ `PAYMENT_*` を入れる前に C-2（selfSignUp を閉じる）を入れる／
  セッション既定は 60 分・1.00 USD
- 途中でホスト済みアプリへ私が接続しようとして（Basic 認証で 401）ユーザーから「開発でホスト済みアプリに
  アクセスする必要は無い。deploy が失敗していなければ進めるべき」と指摘を受けた。A の実地確認は行わず、
  deploy 成功の事実のみを記録して開発に進めた

### やったこと

- DESIGN.md に決定34（実行時設定と IAM の配線）・35（PaymentSession のアプリ内作成）・36（selfSignUp を閉じる）を追記
- TDD（赤 → 緑）で 2 モジュールを追加:
  - `amplify/runtime-env.ts`: 合成時の `process.env` から許可リスト（`PAYMENT_MANAGER_ARN` /
    `PAYMENT_INSTRUMENT_ID` / `BILLING_MCP_URL` / `PAYMENTS_USER_ID` / `PAYMENT_MAX_AMOUNT` / `PAYMENT_PAY_TO` /
    `BUYER_TOOL_TIMEOUT_MS` / `PAYMENT_SESSION_MINUTES` / `PAYMENT_SESSION_MAX_USD`）を拾う。ブランチ deploy では
    必須 3 変数の欠落で落とし、`BUYER_TOOL_TIMEOUT_MS` が 900 秒を超えても落とす
  - `aws-blocks/payments/payment-session.ts`: KVStore に保存した記録が期限（60 秒の余裕を引く）内ならそれを
    使い、無ければ `CreatePaymentSession` で切って `expiresAt` 付きで保存する `paymentSessionSource`。
    `isSessionRejection` は `ResourceNotFoundException`、または message に session を含む
    `ValidationException` / `ConflictException` をセッション起因とみなす（SDK の型からの推定。要実測）
- `x402-payer.ts`: コンテキストの `paymentSessionId` を `paymentSession`（供給元）に替え、`ProcessPayment` が
  セッション起因で拒否されたら `renew` して一度だけ再試行する。`clientToken` は再試行でも同じ値
- `buyer-agent.ts`: KVStore `payment-session`（`ttl: true`）を追加し、ツールハンドラで供給元を組み立てる。
  `PAYMENT_SESSION_ID` の読み取りを廃止
- `amplify/blocks.ts`: `runtimeEnvironment` の結果を `addEnvironment` で写し、`bedrock-agentcore:CreatePaymentSession` /
  `GetPaymentSession` / `ProcessPayment` を `addToRolePolicy`（リソースは `*`。合成結果では Blocks の
  `OverflowPolicy`（ManagedPolicy）に載る）
- `aws-blocks/index.ts`: `selfSignUp: process.env.BUYER_SELF_SIGNUP === 'true'`。`package.json` の `dev` /
  `dev:server` / `test:e2e` に `cross-env BUYER_SELF_SIGNUP=true`
- `scripts/payments-setup.ts` からセッション作成を外し、出力を `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` に
- README（agent-app）・CLAUDE.md を更新
- 確認: `npm run test`（74 件）/ `typecheck` / `npm run test:e2e`（ローカル。`BUYER_SELF_SIGNUP=true` で
  サインアップを含む 3 件が通る）/ AWS 資格情報なしの合成（sandbox 姿勢で通る。ブランチ姿勢では
  `PAYMENT_*` 無しで狙いどおり落ち、有りでは Lambda の環境変数と IAM が nested template に出る）

### 判断・つまずき

- IAM のリソースを `*` にしたのは、AgentCore Payments の各アクションが受け付けるリソース形式
  （payment-manager / session / instrument の ARN）を確認していないため。sandbox の実測後に絞る
- セッション起因の拒否をどの例外で受けるかは実測していない。判定に漏れても支払いが失敗するだけで
  二重に払うことはない（`ProcessPayment` は署名前）
- ローカルの mock 認証は `selfSignUp` を強制しない（`BUYER_SELF_SIGNUP` 無しでも e2e のサインアップが通る）。
  強制するのは CDK（`selfSignUpEnabled`）と AWS ランタイムなので、決定36 の効き目はクラウドで確かめる
- `selfSignUp` を「クラウドかどうか」で切り替えられないのは、合成時にはまだ `BLOCKS_STACK_NAME` が無いため。
  明示の環境変数で開ける形にした

### sandbox での実測（同日）

- 売り手 `BillingMcpStack-dev` を再 deploy（メインのチェックアウトの `parameter.ts` / `server/.env` を写して
  `pnpm cdk deploy`。78 秒）。Function URL の `initialize` が応答することを確認。検証後も置いてある
- `PAYMENT_MANAGER_ARN` / `PAYMENT_INSTRUMENT_ID` / `BILLING_MCP_URL` を付けて `npm run amplify:sandbox -- --once`
  （188 秒）。共有 Lambda に 3 変数と `CORS_ALLOWED_ORIGINS`（localhost）・`BLOCKS_CROSS_DOMAIN` が入り、ロールの
  ポリシーに `bedrock-agentcore:CreatePaymentSession` / `GetPaymentSession` / `ProcessPayment`（Resource `*`）が
  付き、ユーザープールは `AllowAdminCreateUserOnly: true`（決定36 が効いている）
- クラウドの buyer API を認証込みで通す `scripts/buy-via-cloud.ts` を追加（`tsx -C browser` で Blocks の
  クライアントを使い、`AuthState` を手で進める。OTP は `BUYER_OTP_FILE`、セッション Cookie は
  `BUYER_COOKIE_FILE` で持ち回る）。利用者は `admin-create-user` で作成
- つまずき: Node の `fetch` は `Set-Cookie` を保持しないため、サインインは通っても次の呼び出しが 401 になった。
  スクリプト内で `globalThis.fetch` を包む最小の cookie jar を入れて解決（OTP の再送が 1 回増えた）
- 1 回目の購入: Lambda のログに `[payment-session] PaymentSession を作成`（期限 60 分・上限 1.00 USD）が出て、
  実オンチェーン決済（tx `0xbcc3071b…d414c85`）→ 生成 → KVStore 保存 → `getPurchasedHtml` で 5,296 バイトの HTML
  まで通った。KVStore `payment-session` の表には `pk=sample-user-1` の記録が `ttl`（epoch 秒）付きで入り、
  TTL は ENABLED

- 2 回目の購入（使い回しの確認）: Lambda は新しいセッションを作らず（ログに作成行なし）`ProcessPayment` まで
  進んだが、売り手が支払い証明を受け取った後に再び 402 を返し、ツールは
  「支払い後の再呼び出しでも支払い要求が返りました」で失敗した。オンチェーン（Base Sepolia の USDC
  `Transfer` ログ）ではウォレットからの送金は 1 回目の 1 件だけで、残高は 0.9 USDC。upfront（決定21）の
  決済確定（settle）が facilitator 側で通らず、資金は動いていない。決定31 の防護どおり LLM は再試行せず報告した。
  ただし AgentCore Payments 側のセッション残枠は 1.00 → 0.8 USD と、決済確定に失敗した分も署名時点で
  差し引かれていた（`GetPaymentSession` の `availableLimits`）。売り手側の 402 の理由（`PaymentRequired.error`）が
  買い手の記録に残らなかったので、`paid-tool-caller.ts` の失敗文面に含めるよう直した（テスト付き）
- 3 回目の購入（作り直しの確認）: `DeletePaymentSession` で保存中のセッションを消してから発注。Lambda のログに
  `[x402-payer] PaymentSession が拒否されたため作り直します: ValidationException: Payment session not found: …`
  → `[payment-session] PaymentSession を作成` と出て、実オンチェーン決済（tx `0x5830a9b7…7111cd9`）→ 生成 →
  896 バイトの HTML まで通った。セッション起因の拒否は **`ValidationException`（message に
  `Payment session not found`）** で来ることが確定（決定35 の推定どおり `isSessionRejection` が拾った）
- 検証後に `npm run amplify:sandbox:delete`。売り手 `BillingMcpStack-dev` は置いたまま（main での検証に使う）

### 構成図の差し替え（同日）

- `docs/architecture.drawio.png` の埋め込み XML を取り出して編集し（描き直さない。決定32）、draw.io CLI で
  `--embed-diagram` 付きで再出力した。変更: Hosting の囲みを Amplify Hosting ＋ Amplify ビルドに、
  ① をブラウザ → API Gateway の直接呼び出し（別オリジン・CORS・SameSite=None）に、Block id を
  `app` / `buyer` / `b` に、KVStore `payment-session` の追加、Cognito の「自己サインアップ無効」、
  現況と処理の流れ（①④）の文面。CloudFront から API Gateway へのプロキシ矢印は削除
- つまずき: ラベルの `&lt;appId&gt;` が HTML として解釈されて消えた（`（appId）` に変更）。矢印ラベルは
  経路の中央に置かれるため、縦の区間に沿わせるには offset で幅の半分ほどずらす必要があった

### 残していること（次の手順）

1. ~~売り手 `BillingMcpStack-dev` の再 deploy~~（済）（メインのチェックアウトの `parameter.ts` / `server/.env` を写す。
   無認証の公開エンドポイントなので実行前に確認）
2. ~~sandbox で決定35 の作成・使い回し・作り直しを実測~~（済。上記）
3. main のブランチ環境変数に同じ値を設定して再ビルドし、main で実決済
4. ~~`docs/architecture.drawio.png` の Amplify 構成への差し替え~~（済）

## 2026-09-04: フェーズ⑤の土台 — Amplify Gen2 への deploy 経路（決定33）

### やったこと

- ユーザー要望「開発は AWS Blocks のまま、deploy は Amplify へ（agent-app のみ）」を grill-me で確認。
  動機は「Amplify コンソールでバックエンドとフロントを一元管理し、git push で deploy」。既存の CDK 直経路
  （`npm run deploy`）は退路として残す、完了条件は sandbox への実デプロイまで、で合意（決定33）
- 追加したもの: `amplify/backend.ts`（`defineBackend({})` + `initBlocks`）、`amplify/blocks.ts`
  （`createStack('blocks')` の上に `BlocksBackend.create()`。CORS とクロスドメイン Cookie の環境変数、
  `custom.blocks_api_url` の出力）、`amplify/cors-origins.ts`（`AWS_APP_ID` から amplifyapp.com の
  正規表現を導く。テスト付き）、`amplify/package.json` / `amplify/tsconfig.json`（`npm create amplify`
  が書く内容の写し）、`aws-blocks/amplify.cdk.ts`（Amplify 用の CDK 入口。`index.cdk.ts` は単独 CDK アプリで
  読み込むだけでスタックと `Hosting` のビルドが走るため分けた）、`scripts/generate-blocks-client.ts`
  （`client.js` 生成。CDK 直経路と dev サーバーが内部でやっている処理を Amplify のビルド用に露出）、
  `scripts/blocks-config.ts` + `scripts/amplify-blocks-config.ts`（`amplify_outputs.json` →
  `dist/.blocks-sandbox/config.json`。テスト付き）、リポジトリ直下の `amplify.yml`（モノレポなので
  `applications[].appRoot: agent-app`）
- `package.json` に `amplify:sandbox` / `amplify:sandbox:delete` / `blocks:client` / `build:amplify` を追加し、
  vitest の対象に `amplify` と `scripts` を加えた。`tsconfig.json` の include に `amplify/**/*`、
  `.gitignore` に `.amplify` と `amplify_outputs*`
- 依存: `@aws-amplify/backend` 1.24.0 / `@aws-amplify/backend-cli` 1.9.0 / `cross-env` 7.0.3（手動で追加。
  `npm create amplify` は `aws-cdk-lib@2.244.0` を固定で入れ、Blocks 側の 2.267 と衝突するため使わなかった）
- `aws-blocks/index.ts` の `AuthCognito` に `BLOCKS_CROSS_DOMAIN` を足し、Block の id を短縮
  （`Scope 'app'` / `Agent 'buyer'` / `BlocksBackend 'b'`。後述）
- TDD: `corsAllowedOrigins` と `blocksConfigFromOutputs` の2モジュールを赤（モジュール未作成で import 失敗）→
  緑。`npm run test` / `typecheck` / `build` を通し、AWS 資格情報なしで `CDK_CONTEXT_JSON` を与えて
  `amplify/backend.ts` を `--conditions=cdk` で直接実行し、Lambda のバンドルまで到達することを確認した
- README（ルート・agent-app）と CLAUDE.md を更新

### 調査で分かった重要事実

- AWS Blocks は AWS 公式（2026-06-16 に public preview 公開、`docs.aws.amazon.com/blocks` に devguide）。
  devguide は Amplify を「補完関係（Amplify = hosting / CI/CD / マネージド体験、Blocks = IfC）」と位置づける
- `BlocksBackend.create()` は devguide「Integrating with existing infrastructure」Pattern 1 の公式 API。
  `@aws-blocks/core` 0.3.1 の `blocks-backend.ts` は `fullId` の説明で「Amplify Gen2 の
  `backend.createStack('blocks')` のネストスタック」を想定ケースとして明記している
- 公式 CLI `@aws-blocks/create-blocks-app` 0.1.21 には `templates/amplify/` があり、`amplify/backend.ts` を
  検出すると `amplify/blocks.ts`・`createBlocksBackend`・`NODE_OPTIONS="--conditions=cdk"` 付きの
  `amplify.yml`・`cross-env` のスクリプトを生成する。ただし `aws-blocks/` を雛形で上書きするため、
  既に Blocks で作ったプロジェクトには当てられない。今回の実装はこの生成物を写した
- CLI は「Blocks 主体で Amplify Hosting は CI/CD と配信だけ」の構成（`amplify.yml` から
  `cdk deploy --app="npx tsx -C cdk aws-blocks/index.cdk.ts"`）も案内している。今回は一元管理の要望で
  Amplify 主体（ネストスタック）を採った
- ブラウザの Blocks クライアント（`@aws-blocks/core` `client/index.js`）は API の URL を
  「`{ url }` 指定 → SSR の環境変数 → Node の `.blocks-sandbox/config.json` → ブラウザは同一オリジンの
  `/.blocks-sandbox/config.json` を fetch」の順で解決する。CDK 直経路では `Hosting` construct が
  相対 URL（`/aws-blocks/api`）を書いた config.json を配り CloudFront で API をプロキシするが、
  Amplify Hosting にはその層が無いので、絶対 URL を書いた config.json をビルドで置き、越境で呼ぶ
- dev サーバーは `BLOCKS_API_URL` があるとその API へプロキシする（sandbox 用）。Amplify の sandbox に
  ローカルのフロントを繋ぐのもこの経路で足りる
- `--conditions=cdk` が無いと Block がモック実装に解決され空のインフラが合成される。
  `BlocksBackend.create()` の冒頭で `assertCdkConditionActive()` が検査して落とす（黙って通りはしない）
- `ampx` は `amplify/backend.ts` を `tsx` の `tsImport` で直接読み込む。`cdk.json` の `app` は使われないので、
  CDK 直経路用の `cdk.json` と共存できる
- Amplify のルートスタック名は `amplify-<namespace>-<name>-<type>-<hash10>`。sandbox は
  namespace = `package.json` の name（英数字のみ、`agentapp`）、name = `--identifier`（既定は OS ユーザー名）。
  ブランチは namespace = appId（14 文字）、name = ブランチ名

### 判断・つまずき

- 参照記事（Zenn）を最初「公式ドキュメント未掲載の非公式ハック」と扱い、その懸念を前提に問いを組んだ。
  ユーザーの指摘で公式 devguide・CLI・ソースまで当たり直し、記事は公式機能のみで組まれていると確認して撤回した。
  下調べは一次資料まで当たってから問いを立てる、が教訓
- フロントと API を別オリジンにした理由: Amplify Hosting の rewrite（200 プロキシ）はアプリ単位の設定で
  ブランチごとの API URL に追随できず、Cookie 転送の挙動も未確認。別オリジン構成は `AuthCognito` の
  `crossDomain` と core の `CORS_ALLOWED_ORIGINS` に公式手順があり、現行 sandbox（localhost + API Gateway）と同じ形
- **S3 バケット名の 63 文字制限**: ローカル合成で `…-blocks-agent-app-buyer-agent-sn`（78 文字）が
  `ValidationFailed` で落ちた。Blocks は S3 名をスコープ id の連結で決め、短縮もハッシュ化も意図的にしない。
  Agent が内蔵する `FileBucket 'sn'` は既存バケットの指定もできない。Amplify のスタック名（36 + 識別子 /
  41 + ブランチ名）の下では id を縮める以外に手が無く、`b` / `app` / `buyer` に短縮（ユーザー決定。
  ブランチ名 7 文字以内・sandbox 識別子 12 文字以内が制約として残る）。予算の計算は決定33 の追記
- `npm run build` が `build-temp/` に `tsc` の出力を吐き、その中の `*.test.js` を vitest が拾って
  テスト件数が倍（10 ファイル 55 件 → 20 ファイル 110 件）になる。今回の変更で生じたものではなく
  以前からの挙動（`build-temp` は gitignore 済みで CI はビルド前にテストするため影響なし）。未修正、要判断
- この worktree は `mise.toml` が未信頼で `node` が起動できず、`mise trust` が要った
- `client.js` 生成時の `[Realtime] BLOCKS_RT_WS_URL not set` 警告は生成には無害（実行時の環境変数）

### sandbox 検証（同日）

- `npm run amplify:sandbox -- --once`（ap-northeast-1、識別子は既定の OS ユーザー名 12 文字）が 193 秒で完了。
  ルートスタック `amplify-agentapp-<識別子>-sandbox-<hash>` の下にネストスタック `blocks` ができ、
  Agent 内蔵の S3 バケット（`…-b-app-buyer-sn`、ちょうど 63 文字）も作成された。`amplify_outputs.json` に
  `custom.blocks_api_url`（API Gateway の `/prod/aws-blocks/api`）が出た
- API Gateway を直接叩いた結果: `api.whoAmI` / `buyer.getSellerInfo` は `401 NotAuthenticatedException`
  （認証が効いている）、`api.getLastCode` は `null`（`BLOCKS_STACK_NAME` によるクラウド判定でローカル専用の
  OTP 漏洩口が閉じている）。localhost オリジンからの preflight は `access-control-allow-origin` と
  `allow-credentials: true` を返した（sandbox モードの CORS）
- `npm run build:amplify` が `client.js` 生成 → `tsc` + `vite build` → `dist/.blocks-sandbox/config.json`
  （絶対 URL）まで通った
- `BLOCKS_API_URL=<blocks_api_url> npm run dev` でローカルの dev サーバーが `/.blocks-sandbox/config.json` を
  `{ apiUrl: "http://localhost:3000/aws-blocks/api", environment: "sandbox" }` で配り、RPC を sandbox の
  Lambda へプロキシした（同じ 401 が返る）。CDK 直の sandbox と同じ手順で Amplify の sandbox にも繋がる
- 検証後に `npm run amplify:sandbox:delete` で削除（187 秒）。ルートとネストの両スタックが
  `DELETE_COMPLETE` になり、`amplify-agentapp-*` は残っていない。ブラウザでのサインアップ（OTP）は
  ユーザー判断で省略し、疎通確認までで締めた
- 未検証: Amplify Hosting 上での配信（`.blocks-sandbox/` の成果物指定・ブランチ deploy の CORS・
  クロスドメイン Cookie）。コンソールでの GitHub 接続を伴うため次回、ユーザー操作で行う

### セルフレビュー（同日）

ブランチ `feat/amplify-deploy` の2コミット後にセルフレビューを実施し、指摘4件を全件修正した:

1. `build-temp/` の `*.test.js` が vitest に拾われ二重に走る（上記「判断・つまずき」の件。今回
   `amplify` / `scripts` を対象に加えて範囲が広がった）→ `vite.config.ts` に `test.exclude: build-temp/**`
2. `AGENTS.md` の deploy 節が CDK 直経路のみで決定33 と食い違う → Amplify のコマンドを正として追記
3. 決定32 の追記に Block id の変更が無く、構成図のラベルが旧 id のまま → 追記を補い、図の差し替え時に直すと明記
4. Amplify Hosting の外から `ampx pipeline-deploy` すると `AWS_APP_ID` が無く CORS 未設定のまま deploy
   される → `requireCorsAllowedOrigins`（テスト付き）で合成時に落とすようにし、README に明記

### PR #5 の CI 失敗と修正（同日）

- agent-app ジョブの `npm ci` が「lock と package.json が不整合」で失敗。`npm install --save-dev` で Amplify の
  依存を足したときに書かれた `package-lock.json` に、`@aws-amplify/backend-cli` 配下が要求する
  `zod@3.25.17` や `@aws-cdk/toolkit-lib` などが記録されていなかった（`node_modules` には入っていたため
  手元のテストは通っていた。`npm ci --dry-run` で再現）
- `npm install` の再実行では直らず、いったん `node_modules` と lock を消して作り直したところ、
  `@aws-blocks/blocks` の指定が `"*"` のため AWS Blocks が 0.3.1 → 0.4.0 に、`aws-cdk-lib` が
  2.267 → 2.268 に上がった。sandbox で検証した版から動かしたくないので採らず、HEAD の lock を戻して
  `npm install --package-lock-only` で不足分だけ補った（+1,556 行。`@aws-blocks/*` と `aws-cdk-lib` は据え置き）。
  `npm ci` で入れ直して test / typecheck を確認
- 教訓: `@aws-blocks/blocks` の指定が `"*"` である限り、lock を全体再生成すると AWS Blocks 本体の版が
  意図せず最新に上がる。lock を直すときは `--package-lock-only` で不足分の追加に留め、
  AWS Blocks の版を上げるのは意図した作業として別に行う

### PR #5 のコードレビュー（同日）

pr-code-review スキルで観点別レビューを行い、ユーザー判断で次の2件を修正した（GitHub への投稿はせず、
この場で修正）:

1. `amplify:sandbox:delete` に `AMPLIFY_SANDBOX=true` が無く、削除が合成の段階で落ちる。
   `ampx sandbox delete` は削除前に `amplify/backend.ts` を読み直す（`@aws-amplify/backend-deployer` の
   `destroy()` → `getCdkCloudAssembly()` → `tsImport`）ため、セルフレビューで足した
   `requireCorsAllowedOrigins` のガードに引っかかっていた。削除の成功確認はガード追加前だったので
   見逃した。スクリプトに `AMPLIFY_SANDBOX=true` を足し、sandbox が無い状態で実行して合成が通ることを確認
2. `buyer-agent.ts` のコメントの S3 バケット名が CDK 直経路の形だけだったので、Amplify 経路の
   `-b-` 付きの形も併記

見送り: 「`AMPLIFY_SANDBOX=true` がブランチビルドの環境変数に紛れ込むと sandbox の姿勢で deploy される」
（人為ミス前提）、「PR に性質の違う変更が同居」（id 短縮も vitest の修正も Amplify 対応の帰結で同質）、
「ブランチ名 7 文字の上限」（決定33 で意図して選んだ取引。レビューで蒸し返すべきではなかった）

## 2026-09-03: AWS 構成図の作成（docs/architecture.drawio.png）

### やったこと

- アプリが②〜④で膨らんだので、全体を 1 枚で見渡せる AWS 構成図を起こした。成果物は
  `docs/architecture.drawio.png`（draw.io の XML を埋め込んだ PNG。決定32）
- 構成の裏取りは想像ではなく合成結果で行った。`agent-app` で `npx cdk synth` を通し、
  出来上がった CloudFormation テンプレートからリソース種別と論理 ID を数え上げた。
  売り手側は `billing-mcp/stacks/billing-mcp-stack.ts` を直接読んだ
- 図には有料経路（赤の実線）と無課金経路（青の破線）、補助の経路（灰色）を色で分けて引き、
  ①〜⑪ の番号を振って図の下に「処理の流れ」を並べた。決定10・11・29 の二経路が図の主題になる

### `cdk synth` で分かったこと（ブロックのドキュメントだけでは分からなかった）

- **AWS Blocks の Lambda は 1 本しか出ない**。`Handler`（900 秒 / 2048 MB）が API Gateway（REST）の
  統合・WebSocket の 3 ルート・SQS のイベントソースをすべて兼ねる。ブロックごとに関数が分かれるのだと
  思い込んでいたが、テンプレート上は `Handler886CB40B` 一つに全部ぶら下がっていた
- Realtime の実体は **API Gateway WebSocket（ApiGatewayV2）**。`bb-agent` のドキュメントには
  「AppSync Events」と書いてあるが、合成結果には AppSync が一切出てこない。ドキュメントの方が古い
- DynamoDB は 5 表（`auth-sessions` / `purchased-html` / `buyer-agent-convos` /
  `buyer-agent-messages` / `buyer-agent-rt-connections`）、S3 は 4 バケット
  （Hosting / アクセスログ / blocks-config / `buyer-agent-sn`）、SQS は本キューと DLQ の 2 本
- CloudFront のオリジンは 2 つ（S3 と API Gateway REST の `/aws-blocks/api`）。
  ブラウザは API Gateway を直接叩かず、必ず CloudFront を経由する
- Bedrock は買い手（`BedrockModels.BALANCED`）と売り手（`jp.` 推論プロファイル）で
  呼び出し元が別。同じサービスだが役割が違うので図でも別のアイコンに分けた

### 判断・つまずき

- 図が示すのは**フェーズ⑤の deploy 時にできる構成**で、④時点の実際の姿ではない。
  買い手はローカル実行、売り手は検証後にスタック削除済み。黙って「動いている構成図」に
  見せるのは嘘になるので、図の中に「現況」の枠を置いて両方を明記した
- 買い手と売り手のまとまりは CloudFormation スタック単位ではなく**役割単位**で囲った。
  Bedrock と AgentCore Payments はスタックの持ち物ではないが、どちらが呼ぶかを図で示したかったため
- draw.io のアイコン名は当てずっぽうだと無言で空箱になる。desktop アプリの `app.asar` を展開して
  `stencils/aws4.xml` の `name` 属性を実際に引き当ててから使った
  （名前は「空白を `_` に置換して小文字化」でスタイル名になる）。`Bedrock AgentCore` のアイコンも存在した
- 配線が図形のラベル文字を貫く問題が 2 回出た。Handler のラベルは 4 行あって左右に広く、
  真下に線を引くと必ず文字を横切る。SQS との往復を 1 本の双方向エッジにまとめ、
  ラベルの外側（`x=970`）を通す経路に変えて解消した
- 中間ファイルの `.drawio` は残していない。PNG から XML を取り出せることを確認済み
  （62 セル・33,031 文字が往復した）

### ユーザーレビューでの手戻り（同日）

- 指摘は 3 点。(a) 線が黒くて見づらい、(b) 交差が多い、(c) AgentCore Payments が買い手側なのに
  売り手の右に置かれていて分かりにくい。左右でなく上下を使えないか
- (c) は配置の組み替えで応えた。ap-southeast-1 の枠を**買い手の真下**に置き、④ を Handler から
  真下に落とす 1 本の縦線にした。外部サービスもそれぞれの呼び出し元の真下（Coinbase は Identity の下、
  facilitator は売り手の下）に並べ、幅を 2,140 → 1,780 に縮めた
- (b) は「通路を先に決めてから線を引く」やり方で交差をゼロにした。Handler のラベルを上側へ移して
  下辺を空け、右辺の出口を ③ ⑤ ④ ⑨ の順に 15 px 刻みで並べ、縦の通路（x=1000 / 1150 / 1180 / 1010）を
  互いに跨がないよう配った。⑤ と ⑪ が McpFunction で交差する問題は、⑤ を左辺・⑪ を上辺に入れて解消
- (a) は取り違えた。枠線の色だと思い込んで `light-dark(明,暗)` 記法（59 箇所）を入れたが、指摘は
  **AWS アイコン内部の絵柄**が黒いことだった。`shapes/mxAWS4.js` を読むと `resourceIcon` は絵柄を
  `strokeColor` で塗り、無指定なら `#000000` に落ちる。初版は `strokeColor=none` としていたのが原因で、
  公式どおり `#ffffff` に直した（15 個）。`light-dark()` は暗い背景で開いたときの見やすさとして残した
- 修正は PNG に埋め込まれた XML を取り出して行った。取り出した中身は既に `<mxfile>` 付きで、
  それをもう一度 `<mxfile>` で包んだところ 52×52 の空 PNG が出た（draw.io は黙って空を返す）。
  埋め込み XML を編集するときは包み直さない
- ⑤ の矢印が「上がって右へ、また下りて右へ」と不自然に曲がっていた。DynamoDB が Handler の右隣に
  あった頃の迂回路が、DynamoDB を下段へ移した後も残っていただけで、今は真っ直ぐ引いても何も貫かない。
  グループの隙間で一度だけ曲がる L 字にした（交差は増えない）
- 図中の「決定N」（23 箇所）は全て外した。図だけ見る人には読み取れない番号だという指摘。
  設計録への導線はタイトル欄の docs/DESIGN.md への言及だけにした
- 無課金経路の青い破線は実線に改めた。「破線」に意味を持たせても伝わらないので、有料＝赤・無課金＝青と
  色だけで区別する（凡例の見本も合わせて実線に）
- 「ui:// が無課金なら中身を無料で掠め取られないか」という問いに、コードを読んで「取られる中身が無い」と答えた
  （静的な空の表示器を返すだけ。生成は upfront の決済後にしか起きない）。ただ「無課金」の一語では中身が
  無料に読めるため、図の凡例・⑪・売り手ノート・手順パネル、README の略図、決定11 の補足を
  「空の表示器の取得（生成物は含まない）」に揃えた。サーバーコードのリソース説明文は据え置き
- DynamoDB のラベル「5 表」は「5 テーブル」に改めた。字数を詰めるための略が日本語として不自然だった
- 買い手側を **Block のインスタンス単位** で囲み直した（ユーザー指摘）。最初は Realtime や Hosting も
  独立した囲みにしようとしたが、「コードで宣言している Block 単位」と正された。宣言は `AuthCognito('auth')` /
  `Agent('buyer-agent')` / `KVStore('purchased-html')` / `ApiNamespace('buyer')` / `ApiNamespace('api')` の 5 つで、
  2 つの ApiNamespace は 1 本の REST API を共有するので囲みは 1 つにした。Realtime（WebSocket と
  rt-connections 表）は Agent の内側、CloudFront と S3 は `Hosting` construct なので「Block ではない」と注記、
  `Handler` は全 Block 共有なので囲みの外の中央に置いた
- 囲みを入れると題字と縦線がぶつかる。ApiNamespace は題を 2 行に割ってアイコンを右に寄せ、Agent は
  題を短くして内蔵要素の列挙を箱の右下に小さく移した。Handler からの扇状の配線は「遠い列ほど高い y で
  曲がる」規則で交差を避けた（交差ゼロのまま）

## 2026-09-03: フェーズ④着工 — 前提検証（grill-me）と方針決定

### 着工前の詰め（grill-me）で崩れた前提

- worktree は 3 つではなく **4 つ**（`glacial-salmon` が detached HEAD で増えていた）。作業は本体 worktree で
  `main` から `feat/integration` を切って行うことにした
- `.env` は本体 worktree に**既に両方あり**、複製は不要だった。一方 `agent-app/node_modules` が無く
  `npm install` が要った。`billing-mcp/parameter.ts` は本体にも teal-linden にも無く、②の
  worktree（plush-breeze）からのみ複製できた
- **CORS は③時点で実装済み**（`billing-mcp/server/src/app.ts` が allow-origin `*` と OPTIONS 応答を
  自前で返す）。依頼文の「設定が要る」は「クラウド上でブラウザから未検証」が正確
- 依頼文が見落としていた重い事実: 売り手の preview-view は `app.ontoolresult` を待つだけの作りで、
  ui:// を iframe に入れただけでは何も映らない。ブラウザが MCP Apps の**ホスト**（`AppBridge`）を
  実装し、`getPurchasedHtml` で取った HTML を `sendToolResult` で注入して初めて描画される（決定29）
- `tool-result` チャンクは `toolName` しか運ばない（bb-agent 0.3.1 の実装を読んで確認）。
  ブラウザが resultId を知るには会話メッセージの `metadata.toolOutput` を読む経路が要る

### 裏が取れた前提

- PaymentManager READY / Connector READY / Instrument ACTIVE。ウォレット残高 0.7 テスト USDC
  （Base Sepolia の RPC で `balanceOf` を実測）。WalletHub 委任の期限は API から読めず未検証
- `BillingMcpStack-dev` は DELETE_COMPLETE で AWS 上に無い
- `useChat`（`@aws-blocks/bb-agent/client`）は React 非依存で、雛形の vanilla DOM のまま使える

### 節目の確認事項

- **U5**: ext-apps の npm 最新は 1.7.5（2026-07-23 公開）、peer は sdk ^1.29 のまま。v2 対応は無く
  決定3 は据え置き（DESIGN.md U5 に追記）
- **Coinbase の課金**: Cost Explorer の AWS Marketplace 明細（8/25〜9/2）に Coinbase の行は**ゼロ**。
  表示されるのは Bedrock の Claude（Marketplace 経由）のみ。9/3 分は反映待ちで後日再確認する

### ユーザー決定（grill-me の問答）

1. ④の完了条件は agent-app ローカル + 売り手クラウド。クラウド deploy は⑤へ（決定28）
2. 描画経路は「ui:// ホスト実装 + getPurchasedHtml 注入」（決定29）
3. ローカルの LLM は `model.local` に Bedrock を指定（決定28）
4. ④で扱う繰り越し課題は「buyer API を通る e2e」と「購入単位の冪等キー」（決定30）。
   支払い主体の二重化・selfSignUp とレート制限は⑤へ
5. 売り手の再デプロイは UI がローカル売り手で通ってから。deploy と destroy の直前に確認を取る
6. 作業場所は本体 worktree の新ブランチ

### 段取り

1. 決定録・実装記録の追記（本エントリ）
2. バックエンド: todos デモと雛形 API の撤去、`model.local`、冪等キー、購入一覧 API、
   売り手情報 API（ブラウザが ui:// を取りに行く先）。TDD
3. フロント: 認証 + チャット（useChat）+ チャンク表示 + MCP Apps ホスト（AppBridge）
4. buyer API を通る e2e（認証込み・所有検証込み）
5. ローカル売り手で縦串 → 売り手をクラウドへ（確認）→ CORS・CloudWatch を実測 → destroy（確認）

## 2026-09-02〜03: フェーズ③ 縦串検証成功 — Agent が AgentCore Payments で実決済

### 結果

**Agent が AgentCore Payments のウォレットで 0.1 テスト USDC を支払い、billing-mcp の
有料ツールを実行して HTML を受領・保存する縦串が通った**（決定27 の検証完了）。

- 決済: tx `0xa0e35a61…29ca5`（Base Sepolia、成功）。買い手 1.0 → 0.9 / 売り手 0.22 → 0.32 USDC
- 成果物: HTML 3,149 バイトが structuredContent のまま欠損なく届き、KVStore に保存
  （U6 回避＝決定25 の実地確認）。会話には resultId のみが返る（決定10 の形）
- 経路: Agent（ローカル、LLM は canned）→ ProcessPayment(CRYPTO_X402) で支払い証明
  → `_meta["x402/payment"]` 付き再呼び出し → 売り手が x402.org facilitator で清算（upfront）
  → Bedrock 生成 → 成果物返却。支払い・清算・生成はすべて本物

### セットアップで実測した事実（ドキュメントに無い・薄いもの）

- Coinbase コネクタは AWS Marketplace サブスクリプション加入後も、QUICK_CREATE（OAuth）が
  AWS コンソールの支払い画面の白画面（描画不能）で3回失敗。**MANUAL（CDP キー持参）へ切替**して解決。
  CDP の API キー発行時、IP allowlist は空にする（キーを使うのは AWS 側サービスのため）
- サービスロールの許可ポリシーの workload-identity パターンも **PaymentManager 名の小文字化**の
  影響を受ける（camelCase のままだと GetWorkloadAccessToken が拒否され
  「Failed to obtain workload access token」で CreatePaymentInstrument が落ちる）
- ウォレットは作成直後から status ACTIVE だが、**WalletHub での Delegated signing 許可
  （エンドユーザー操作・有効期限つき）が済むまで ProcessPayment は
  「Delegated signing grant is not active」で拒否される**。ステータスでは判別できない
- WalletHub のログインには CDP プロジェクトの Domains 許可リストへの
  `https://hub.cdp.coinbase.com` 追加が必要（無いと OAuth が CORS エラー）。
  ④のブラウザ UI 用に `http://localhost:3000` も追加済み
- 旧使い捨て買い手はガス用 ETH ゼロで ERC-20 送金不可（フェーズ②は EIP-3009 の
  gasless 署名のみだったため）。資金供給は **CDP faucet**（`agent-app/scripts/faucet.ts`）へ切替
- ProcessPayment の応答 status は `PROOF_GENERATED` のみ。清算（settle）は売り手側
  facilitator の仕事で、AgentCore は署名だけを担う分担が API 面からも確認できた
- `aws login` の資格情報は12時間で切れる。切れた際の再認証はユーザー操作

### 不手際と対処（詳細はリポジトリ外に記録）

ウォレットの紐づけメールアドレスを、ユーザーの明示的な事前許可なく設定して作成する
不手際があった。当該ウォレットは削除し（リポジトリ・git 履歴への個人情報の混入が
無いことも全域検査で確認）、ユーザー指定のアドレスで再作成した。再発防止策は
リポジトリ外のグローバル設定に記録した（個人情報に類する値は、明示的な事前承認なく
外部サービス・コマンド・リポジトリ内ファイルに一切使わない）。

### セルフレビュー（2026-09-03、PR 作成前）

4件を指摘して修正した。

1. buyer API の所有検証が `getMessages` にしか無く、他人の会話へ発注（実費が発生）・
   ストリーム購読・購入物の取得ができた → `sendMessage` / `getChannel` にも検証を追加し、
   購入物のキーを `${userSub}/${resultId}` で名前空間分離
2. 決定9 が Quick Create のまま → MANUAL への変更経緯を追記
3. QUICK_CREATE 前提のコメント3箇所と README → MANUAL の実態に是正
4. `@smithy/types` が未宣言 → dependencies へ

修正後に縦串を再実行し、決済〜受領が通ることを確認（tx `0x539952ca…ce8b9`、0.1 テスト USDC）。
ただしこの再検証は `buy-via-agent.ts` が Agent を直接叩くため、修正した buyer API 自体は
通っていなかった（下記 PR レビューで指摘）。

### PR #2 レビュー（2026-09-03、9観点の並列レビュー）

26件の指摘のうち上位21件を修正した。自分のセルフレビューを素通りした指摘が複数あり、
「**検証が変更面を迂回している**」という失敗形（フェーズ②の GET/SSE と同型）が再発していた。

修正した主なもの:

- **`sendMessage` の channelId が未検証**（セルフレビューの修正漏れ）→ channelId 引数を廃し
  会話 ID に固定。`getChannel` も会話 ID で受ける
- **支払い条件の未検証** → 支払いポリシー（ネットワーク・資産・1回上限・任意で宛先）を
  `x402-payer` に入れ、合致しない提示には署名を求めない。上限は `PAYMENT_MAX_AMOUNT`
- **決定25 の記述が着工前の見込みのまま**（`PaymentClient` / `@x402/*` 依存）→ 実装に合わせて更新
- **委任 URL が ACTIVE 時に表示されない**（決定27 が記録した失敗モードそのもの）→ 常に表示
- **支払い済みで成果物を得られない経路で tx を捨てていた** → レシートを KVStore に残し signal を出す
- **`tsconfig` の include に `scripts/` が無く CI 未検査** → 追加したところ型エラー3件が即座に露出
- パース失敗と「支払い要求でない」の混同 → `accepts` があるのに解釈できなければ例外。
  上流に合わせ extra は任意、未知フィールドは通す（passthrough）
- 所有ガードを純関数に切り出してテスト、SDK クライアントの作り捨て解消、
  `loadEnvFile` の `fileURLToPath` 化、Secrets Manager の絞り込み、fund-wallet の revert 判定、
  価格のハードコード除去、CLAUDE.md のコマンド節、決定9/26 の補足、など

修正後に縦串を再実行し、支払いポリシーが本物の売り手提示（Base Sepolia / テスト USDC /
100000 = 0.1 USDC）を受け入れて決済〜受領が通ることを確認した
（tx `0x05bdf33e…b986d`、HTML 3,079 バイト）。`tsconfig` に `scripts/` を含めた
ことで露出した型エラー3件（`PaymentInstrumentStatus` に無い `INACTIVE` との比較など）も
同時に修正した。

### 残していること（フェーズ④へ）

- **支払い主体の二重化**: ProcessPayment の userId はウォレットの持ち主（`PAYMENTS_USER_ID`、
  全利用者で共有）で、購入物の所有者は Cognito の userSub。利用者ごとの支出上限や
  Payments 側の監査で「誰が支払わせたか」を追うには、利用者ごとの instrument 発行と
  WalletHub 委任が要る。自己サインアップ + 実費 API の組み合わせにレート制限も無い
- **buyer API を通る自動テストが無い**: 所有ガードの規則は純関数でテストしたが、API 経路
  （認証込み）は e2e で押さえていない。④の UI 実装と合わせて e2e を足す
- 検証用 PaymentSession は60分で失効する。④の結合検証時は `payments-setup.ts` を再実行して作り直す
- WalletHub の Delegated signing 許可は7日で失効する（切れたら redirectUrl から再許可）
- ローカル LLM は canned プロバイダのまま。④はデプロイ（Bedrock）で実施
- スキャフォールド由来の todos デモの撤去と UI 置き換え、Realtime 配線、売り手の再デプロイ

### 実装（同日）

- バックエンド: todos デモ・DistributedTable・雛形 API を撤去し、`buyer` 名前空間に
  `listPurchases` / `getSellerInfo` / `resume` / `getPendingInterrupts` を追加。`model.local` を Bedrock に
  （`BUYER_LOCAL_MODEL=canned` で偽 LLM）。購入単位の冪等キー（決定30）
- フロント: 認証 + チャット（`useChat`）+ チャンク表示 + MCP Apps ホスト（`src/mcp-apps-host.ts`。
  `AppBridge` + `PostMessageTransport`、sandbox iframe + srcdoc）。決定29
- buyer API を通る e2e（`test/e2e.test.ts`）: サインアップ → 会話 → 送信 → 履歴 → 購入一覧 →
  売り手情報、他人の会話の拒否、未認証の拒否。3 件通過。開発サーバーが生成する
  `aws-blocks/client.js` を待ってから import する必要があった（無いと ERR_MODULE_NOT_FOUND）
- Realtime 配線の実測（決定26 の補足）: ブラウザから `useChat` で購読し、Bedrock（ローカル）の
  返答が `text-delta` → `done` で届いた。`tool-call` / `tool-result` も届く（後述）

### 事故: タイムアウトで決済後に諦め、LLM が自動再試行して二重に支払った

ブラウザから「猫カフェの紹介ページを作って」と依頼したところ、ツール呼び出しが 2 回走り、
どちらも成果物なしで終わった。オンチェーンでは 20:01〜20:03 に 0.1 USDC の送金が 4 件
（うち 2 件は並行して行われた別セッションの操作分）。買い手残高 0.7 → 0.3。

- 原因1: MCP SDK の `callTool` 既定タイムアウトが 60 秒で、売り手の Bedrock 生成（今回 60 秒超）
  より短い。売り手は upfront で決済済みのまま生成を続け、買い手だけが諦めた。③では生成が
  短く露見しなかった
- 原因2: 例外は決済後に起きるのに「支払い済み」の情報を持たず、レシートも残らず、
  LLM は「失敗」と見て自動で再購入した
- 原因3（記録の不手際）: 両サーバーの標準出力を `head` / `grep` のパイプで受けていたため、
  決定的な場面のログが残らなかった。ファイルへのリダイレクトに改めた
- 対処: 決定31（タイムアウト 600 秒、`PaidToolError`、会話に未解決の支払いがあれば
  `interrupt` で人の承認、プロンプトでも再試行禁止）。ユーザー決定

### 防護を入れて再検証（同日）

- 通常のタイムアウト（600 秒）で再度ブラウザから依頼: ツール呼び出し 1 回、支払い 1 回
  （tx `0x095937df…66520`、0.1 USDC）、HTML 9,667 バイトを受領。購入一覧に表示され、
  「表示」で **ブラウザが売り手の ui:// を取得（別オリジン、CORS 実証）→ AppBridge で初期化 →
  HTML を注入 → 二重の sandbox iframe に描画**まで通った（決定29 の実地確認）。
  ブラウザのコンソールに 405 が 1 件出るが、MCP クライアントが単独 SSE（GET）を試みて
  売り手が仕様どおり 405 を返すもの（決定22）で無害
- 決定31 の防護を実地で検証: `BUYER_TOOL_TIMEOUT_MS=4000` で決済後の失敗を故意に起こし
  （0.1 USDC、成果物なし）、①レシート（resultId・nonce）が購入一覧に「失敗・支払い済み」で出る
  ②LLM は自動再試行せず報告する ③同じ会話で再依頼すると `interrupt` が Realtime で届き、
  画面に承認ボタンが出る ④「やめる」で購入せず残高が変わらない（0.1 のまま）ことを確認
- ブラウザは直近の会話 ID を localStorage に持ち、再読込後に `loadConversation` で再開する
  （購入一覧とプレビューに戻れるようにするため）

### PR #3 レビュー（2026-09-03、9観点の並列レビュー）

10 件の指摘のうち、意図的な運用方針である「Issue が無い」（決定14）を除く 9 件を修正した。
セルフレビューを素通りした指摘が複数あり、特に UI の後始末とコメントの正確さに漏れが集中していた。

- **承認しても未解決の支払いが解消されない**（設計。決定31 の意図と食い違い）→ 判定対象を最後の成功より後の
  失敗に限定。事故 → 承認して成功 → 次は承認不要、という流れを実測で確認
- **サインアウトしてもプレビューの iframe と状態表示が消えない** → `discardConversation` で必ず外すようにし、
  ブラウザで「前の利用者のページが次の利用者に見えない」ことを確認
- **購入一覧の取得失敗が画面に出ない**（`void` で握りつぶし）→ 失敗を events と一覧の両方に出す
- **一時的な失敗でも会話を丸ごと忘れる** → 会話を捨てるのは所有検証で弾かれたときだけにし、
  購入一覧の取得失敗では捨てない
- **タイムアウトの根拠「Lambda 570 秒」が誤り** → 実際は Bedrock 570 秒・Lambda 600 秒。2 箇所を是正
- **新設した `resume` / `getPendingInterrupts` が所有検証の e2e から漏れていた**（③と同じ「検証が変更面を
  迂回する」失敗形）→ 他人の会話への承認・確認も拒否されることをテストに追加
- **MCP Apps ホストにテストが無い** → DOM に依存しない解釈の部分（`pickUiHtml` / `parseDownloadRequest`）を
  純関数に切り出してテスト。`npm run test` の対象を `aws-blocks src` に広げ、`src/` が検査範囲から
  構造的に外れていた状態を解消した（③の「CI の検査範囲を疑う」と同じ形）
- コメントの不正確さ 2 件（e2e の前提、View 初期化のタイムアウトが待つ対象）を是正


### 残していること（④の続き・⑤へ）

- **売り手のクラウド再デプロイと結合**（`pnpm cdk deploy` → `BILLING_MCP_URL` 差し替え → ブラウザから
  実決済 → CloudWatch を読む → `cdk destroy`）。ユーザー判断で同日は見送り。`billing-mcp/parameter.ts`
  は plush-breeze から本体へ複製済み。買い手ウォレットは CDP faucet で補充済み（1.1 テスト USDC）
- 売り手側の冪等化（同じ支払い証明の再提示には再決済せず成果物を返す）。決定31 の限界。
  返金に相当する仕組み（`authorization` / `escrow` フロー）と合わせて **U7** に起票（今回の実装では踏み込まない。ユーザー決定）
- ⑤（agent-app のクラウド deploy）: 支払い主体の二重化、selfSignUp とレート制限、`PAYMENT_*` の
  Lambda 配線と AppSetting 化、別オリジンでの HTML 配信の検討。
  **着手前条件**: Agent を実行する AsyncJob の Lambda タイムアウトを `BUYER_TOOL_TIMEOUT_MS`（600 秒）以上にする。
  短いと買い手側のタイムアウトが働かず「決済後に諦める」事故（決定31）が再発する
- **PaymentSession の作成をアプリに組み込む**（ユーザー決定）: 手動が避けられないのは WalletHub の委任と
  初回 provisioning のみ。ツールハンドラが有効なセッションを KVStore で確認し、無ければ
  `CreatePaymentSession` で切る。失効で `ProcessPayment` が拒否されたら一度だけ作り直す（支払い証明を
  送る前なので二重支払いにはならない）。残る設定は `PAYMENT_MANAGER_ARN` と `PAYMENT_INSTRUMENT_ID`
- **残高の推移を画面に出す**（ユーザー決定）: 購入の前後でウォレット残高を表示する。AgentCore Payments の
  API に残高取得があるか要確認。無ければ Base Sepolia の RPC で `balanceOf`（本セッションの検証で使った方法）
- PaymentSession は 60 分で失効（上記の組み込みまでは `payments-setup.ts` の再実行）。WalletHub の委任は
  2026-09-10 まで（決定27）
- Coinbase の Marketplace 課金は 9/3 分の反映後に再確認
- ブラウザの MCP クライアントが単独 SSE（GET）を試みてコンソールに 405 が出る（無害）。気になるなら
  クライアント側で GET を抑止する方法を探す


## 2026-08-31: フェーズ③着工 — 前提検証（grill-me）と方針決定

### 着工前の詰め（grill-me）で崩れた前提

- 「PR #1 をマージするか判断」→ **既にマージ済み**（163a161、08:58 UTC）。main から
  新ブランチ `feat/agent-app` を切って着工
- 「作業 worktree は plush-breeze」→ 実際は **teal-linden**（main と同一コミットの
  detached HEAD だった）。`billing-mcp/server/.env` も無かったため plush-breeze から複製
- 「U1 は未検証」→ **事実確認だけで決着**（下記）。SigV4 直呼び・Python 薄層の検討は不要に

### U1 の検証（決定24 に昇格）

`@aws-sdk/client-bedrock-agentcore` 3.1121.0 を一時ディレクトリへ実インストールして
型定義を検分。データプレーンに ProcessPayment / CreatePaymentSession /
CreatePaymentInstrument / GetResourcePaymentToken 等 **Payments 系 11 コマンド**、
`-control` に PaymentManager / PaymentConnector / PaymentCredentialProvider の CRUD を確認。
`PaymentType.CRYPTO_X402` + `CryptoX402PaymentInput/Output` で x402 ペイロードを
そのまま搬送できる。JS SDK だけで完結する。

あわせて実測した周辺事実:

- ap-southeast-1 の PaymentManager は**ゼロ件**。セットアップは完全にゼロから
- Coinbase コネクタの provision は `MANUAL`（CDP の API キー持参）か
  `QUICK_CREATE`（サービスが OAuth 同意を仲介）の二択
- `@x402/mcp` は 2.24.0 のまま。U6（structuredContent 欠落）の上流修正は出ていない

### ユーザー決定（grill-me の問答）

1. ③の完了条件は**売り手ローカルで縦串**（billing-mcp は pnpm dev、agent-app もローカル、
   Payments のみクラウド実物で実オンチェーン決済まで）→ 決定27
2. Coinbase コネクタは **QUICK_CREATE**（OAuth 同意はユーザーが実施）→ 決定27
3. U6 は**低レベル API で回避** → 決定25
4. U6 の上流 issue 報告は**③完了後に改めて判断**（保留）→ 決定25 理由欄
5. 使用ブロックは想定4つに **Realtime を加えた5つ**で確定（配線は④）→ 決定26

### 段取り

ブランチ作成・.env 複製・本記録 → AWS Blocks スキャフォールド → TDD で
支払いクライアント〜有料ツール呼び出し → Payments セットアップ（QUICK_CREATE）→
旧買い手ウォレットから新ウォレットへテスト USDC 送金 → 実オンチェーン決済で縦串検証 →
CI の agent-app ジョブ有効化。push はユーザー指示があるまでしない。

### 同日の実装（縦串の買い手側まで完了、決済検証はブロック中）

- **スキャフォールド生成**: `npx @aws-blocks/create-blocks-app agent-app --template auth-cognito`。
  生成物そのままを基線コミットし、以後の差分を追えるようにした（決定13・15。npm 管理）
- **Payments セットアップスクリプト**（`agent-app/scripts/payments-setup.ts`、冪等）を実装し、
  ap-southeast-1 に IAM サービスロールと PaymentManager（`agenticpaymentssample-btbtr1e6q9`、READY）
  を作成した。実測で公式ドキュメントと食い違った点が2つ:
  - 信頼ポリシーはグローバルの `bedrock-agentcore.amazonaws.com` だけでは
    `Role validation failed` になり、**リージョン付き `bedrock-agentcore.ap-southeast-1.amazonaws.com`
    の併記が必要**だった
  - PaymentManager / Connector の name は**英数字のみ**（`[a-zA-Z][a-zA-Z0-9]{0,47}`）。
    ARN では小文字化される（信頼ポリシーの ArnLike に影響）
- **Coinbase コネクタ作成は `SubscriptionRequiredException` でブロック中**。AWS Marketplace の
  「Coinbase Wallets for AgentCore Payments」への加入（ユーザー操作）が前提と判明。
  加入後に同スクリプトを再実行 → OAuth 同意（QUICK_CREATE、URL 有効期限約10分）→
  ウォレット作成・委任 → 送金 → 縦串検証、の順で再開する
- **x402 支払いモジュールを TDD で実装**（`agent-app/aws-blocks/payments/`。unit 12件グリーン）:
  - `x402-payer`: ProcessPayment(CRYPTO_X402) に「受諾した支払い条件」を渡して
    支払い証明を得る。PaymentStatus は `PROOF_GENERATED` のみで、**清算は売り手側
    facilitator の仕事**（署名だけウォレットが行う）という分担も型から確認
  - `paid-tool-caller`: 素の callTool を「要求受領 → 支払い → `_meta["x402/payment"]` 付き
    再呼び出し」の2段で叩く。structuredContent が欠けないことをテストで固定（U6 回避）
- **買い手エージェント配線**（`aws-blocks/buyer-agent.ts`）: generateHtml ツールで購入し、
  HTML 本体は KVStore へ、会話には resultId だけ返す（決定10 の最終形を見据えた設計）。
  ローカルの LLM は canned プロバイダで、支払い・売り手側生成・決済は本物が動く
- スキャフォールド由来の todos デモ（DistributedTable）はフロントが強く依存しているため
  ③では残置し、④の UI 置き換えと同時に撤去する
- CI に agent-app ジョブを追加（npm ci + typecheck + unit テスト）
- つまずき: `aws login` の資格情報が途中でローテーション失敗の一時エラーを出した
  （数分後に自走回復）。IAM の Description は Latin-1 のみで日本語不可

## 2026-08-31: フェーズ②完了 — クラウドへデプロイし実オンチェーン決済を検証

### やったこと

- 価格を 0.01 → **0.1 テスト USDC / 呼び出し**へ引き上げ（決定18 更新）。記録と実物が
  ずれないよう DEFAULT_PRICE・parameter.sample.ts・.env.example・テスト期待額を揃えた
- `cdk deploy` を実行し、無認証の Function URL を公開
  - エンドポイント: `https://aadgxm2l6a6n77igxsqrdeelja0ivxmo.lambda-url.ap-northeast-1.on.aws/mcp`
    - **追記（2026-09-05）**: この URL は 2026-09-04 の再 deploy で変わっている。Function URL は
      Lambda を作り直すたびに変わるので、当時の記録としてそのまま残す。現行値は
      `BillingMcpStack-dev` の `McpEndpointUrl` 出力（`aws cloudformation describe-stacks`）で確かめること
  - ロググループ: `BillingMcpStack-dev-McpFunctionLogsDE22E4A3-qqKrCgVjY6cX`
- **実オンチェーン決済を 2 回成功**（Base Sepolia、各 0.1 テスト USDC）
  - 1回目: [0x1f05b837…39221](https://sepolia.basescan.org/tx/0x1f05b837dd19da8a8c10928766afeaf05146a0efc9f313b2de958a8479939221)
  - 2回目: [0xbe8f1bdf…90f4](https://sepolia.basescan.org/tx/0xbe8f1bdfa1040c9998a81d8b91e0ed010f8ae08e86f2557800c4a2ac795590f4)
  - 売り手 0.02 → 0.12 → 0.22 USDC（1回あたり +0.1）／買い手 19.98 → 19.88 USDC
- これでフェーズ②（billing-mcp 単独での動作確認）は完了

### 実測値

- **コールドスタート**: INIT 363.81ms + 初回実行 1,530ms（facilitator への `/supported`
  照会を含む）。遅延構築にした判断（決定22）が効いており、INIT の 10 秒制限には遠い
- **ウォームの MCP 往復**: 4〜95ms（initialize / tools/list / 支払い要求）
- **有料ツール呼び出し**: 7,013ms（Bedrock の HTML 生成込み）。タイムアウト 600 秒に対し十分
- **メモリ**: 1,024MB 中 132〜143MB しか使っていない。削れる余地あり
- クラウド初回の疎通は 2.2 秒（コールドスタート込みの initialize）

### 見つけて直した不具合: GET（SSE ストリーム要求）で Lambda が落ちる

初回の実決済は成功したが、CloudWatch に `Runtime.NodeJsExit`
（"a Promise that was never settled"）が 1 件記録されていた。

- **原因**: MCP クライアントが initialize 後に開く単独の SSE ストリーム要求（GET）。
  ステートレス + enableJsonResponse では SSE を提供しないが、GET をそのまま SDK に
  渡すと終わらないストリームが返り、それを `response.text()` でバッファしようとして
  Promise が永久に未解決になっていた
- **再現**: ローカルで GET を投げると 5 秒待っても応答が返らないことを確認
- **対処**: GET は SDK へ渡さず 405（Allow: POST, DELETE, OPTIONS）を返す。加えて
  万一ストリーミング応答が来ても待ち続けないよう `isStreamingResponse` で防護し、
  body を cancel して 500 を返す。両方をテストで固定（決定22 に追記）
- **確認**: 再デプロイ後に 2 回目の実決済を通し、6 回の実行でエラーゼロ

決済フロー自体は最初から成功しており、この不具合は副次的な GET 経路にのみ現れていた。
ローカルのテストでは MCP クライアントの `fetch` を差し替えていたため GET 経路を
踏んでおらず、クラウドのログを読んで初めて露見した。

### 後片付け

検証が済んだので `cdk destroy` でスタックを削除し、公開エンドポイントを閉じた
（スタック不存在とエンドポイントの 403 応答を確認）。フェーズ④で結合検証をする際は
`cdk deploy` で作り直す（URL は変わる）。

### 残していること

- フェーズ③（agent-app）着工。着工前に U1（JS SDK から AgentCore Payments を
  呼べるか）の検証と、U6（x402MCPClient が structuredContent を落とす）の
  対処方針決めが必要
- Lambda のメモリは 1,024MB 中 143MB しか使っていない。コスト最適化の余地があるが、
  コールドスタートとのトレードオフなので結合検証まで様子を見る

## 2026-08-30: フェーズ②後半 — 売り手を Lambda へ転換し、CDK でデプロイ直前まで

### 着工前の詰め（grill-me）で崩れた前提

着工前に依頼の前提を調べ直したところ、技術的前提が3つ崩れた。

1. **「server/ は実装済み・テスト17件グリーン」が成り立たない。** AgentCore Runtime は
   `Mcp-Session-Id` を持たないリクエストにプラットフォーム側が勝手に付与する仕様
   （MCP protocol contract）だが、当時の `server.ts` は知らないセッション ID を 404 で
   弾いていた。デプロイ後の最初の `initialize` で落ちる状態だった
2. **「API Gateway は 29秒上限」は REST API には当てはまらない。** 2024年6月に統合
   タイムアウトの引き上げが可能になっており、当アカウントの L-E5AE38E3 も
   Adjustable: True だった（HTTP API の 30秒上限は引き上げ不可のまま）
3. **「AgentCore は匿名アクセス不可」は authorizer の設定項目に限った話だった。**
   Cognito Identity Pool の未認証（ゲスト）ID で AWS 一時クレデンシャルを取れば、
   実質匿名の公開も可能だった

### 設計の転換

ユーザーの指摘「IAM で絞るなら x402 で課金する必要がそもそもなくない？」が決定打になり、
売り手を **AgentCore Runtime から無認証の Lambda Function URL へ移した**（決定19）。
AgentCore の authorizer は IAM か JWT の二択で、IAM で絞ると認可の主体が「支払い」ではなく
「権限付与」になり、x402 で課金する筋書きが崩れる。買い手側の AgentCore Payments は
Runtime 非依存と調査済みだったため、売り手を AgentCore に置く必然性は残っていなかった。

検討して不採用にした構成（REST API + クォータ引き上げ / AgentCore + Identity Pool ゲスト /
AgentCore + 公開プロキシ）は理由ごと決定20 に記録した。

### やったこと

- ドキュメント更新: 決定4・5・6・10・17 を追随更新、決定19〜22 を追加、U3 を決着
- x402 の支払いフローを `upfront` に切り替え（決定21）。テストの支払いペイロードは、
  サーバーが広告した accepts の写しから組み立てる方式に変更した
- express を廃し、`WebStandardStreamableHTTPServerTransport` を素の Lambda ハンドラから
  使う形に作り替え（決定22）。MCP セッションはステートレス
- CDK（billing-mcp/ 直下、ops-agent 方式）で NodejsFunction（arm64 / Node.js 22 / zip）+
  Function URL（AuthType NONE）+ reserved concurrency + CloudWatch Logs + Bedrock IAM
- CI に billing-mcp-cdk ジョブを追加（型・テスト・合成・バンドル検証）
- テスト 17件 → 32件（サーバー）+ 7件（CDK）

### 実測で分かったこと・つまずき

- **AgentCore のデータプレーンは CORS 全開だった**（allow-origin `*`、リクエストヘッダは
  エコーで全許可、`Mcp-Session-Id` は expose 済み）。決定10 のブラウザ直接取得は IAM でも
  JWT でも成立すると分かり、U3 の判断材料が一つ減った
- **旧 express サーバーが実際に 404 を返すことを実物で確認した。** 本体チェックアウト側で
  起動しっぱなしだった旧サーバーに未知の `Mcp-Session-Id` 付きで `initialize` を投げると
  `404 {"error":"Session not found"}`。同じリクエストが新実装では 200 で通る
- **合成した Lambda バンドルをそのまま実行して、デプロイ後にしか出ない不具合を2件潰した**:
  ①`@aws-sdk/*` は NodejsFunction の既定で external になりランタイム同梱版に依存する
  → `externalModules: []` で同梱。②AWS SDK v3 は CJS 配布で動的 require を持つため、
  ESM 出力に同梱すると `Dynamic require of "node:stream" is not supported` で落ちる
  → `createRequire` バナーを追加。再発検知のため `scripts/verify-bundle.mjs` を CI に載せた
- **`jp.` 推論プロファイルは ap-northeast-1 と ap-northeast-3 に跨る**（`aws bedrock
  list-inference-profiles` で実測）。IAM はプロファイル ARN だけでは足りず、跨ぐ全リージョンの
  基盤モデル ARN も要る。片方だけだとデプロイ成功後に AccessDenied になる
- **買い手クライアントの upfront 対応を、テスト USDC を使わずに検証した。** `@x402/mcp` の
  実クライアント + 使い捨て viem 鍵（署名は本物）+ 偽 facilitator で往復を通した
- `pnpm exec tsx --env-file-if-exists=.env` は pnpm がフラグを食うため動かない。
  `./node_modules/.bin/tsx` を直接呼ぶ必要がある
- mise の設定が未信頼だと `pnpm install` が黙って失敗する（`| tail` で終了コードが隠れた）
- 支払いラッパーの構築（facilitator への `/supported` 照会）は全リクエスト経路で走るため、
  x402.org に到達できないと無課金のはずの `ui://` 取得まで 503 になる。決定11 の
  「ui:// は無課金」は価格については成り立つが、可用性については facilitator に連座する
- 認証情報なしでも `pnpm synth` が通ることを確認済み（CI ジョブは資格情報を持たない）
- 決定16（進行順 ①②③④）は今回の転換でも変わらないため、書き換えていない

### セルフレビュー（同日・フェーズ②後半）

指摘5件を全件修正した。あわせて添付ファイルの上限をユーザー判断で最大1件に変更（決定23）。

1. 添付上限の退行: 旧 express の 25mb 上限が消え、ツールは「3件まで」と広告したまま
   Function URL の 6MB に当たる状態だった → 上限を1件に絞り、サイズの目安を説明文に明記
2. Bedrock クライアントの作り捨て: ステートレス化の副作用で毎リクエスト
   `new BedrockRuntimeClient` が走っていた → fetch ハンドラ生成時に1度だけ解決して共有
3. 「損失の上限」の誇張: reserved concurrency が押さえるのは瞬間的な流量であって
   累積コストではない → 4箇所の文言を修正し、累積の上限には AWS Budgets 等を併用と明記
4. ゼロアドレスの罠: 雛形のまま deploy すると売上が焼却される（settle は成功しレシートも
   返るため無音）→ 合成の段階でゼロアドレスを弾くガードを追加（テスト付き）。
   CI は合成のみなので、雛形コピー後に検証用ダミーへ sed 置換して通す
5. commandHooks の cp が未引用: 空白を含むパスで bundling が壊れる → 引用を追加

### 残していること（次回セッションの作業）

フェーズ②の完了に向けて、上から順に:

1. **デプロイ実施**: `billing-mcp/` で `pnpm cdk diff` を再確認して `pnpm cdk deploy`。
   無認証の公開エンドポイントが出るため、parameter.ts の `payToAddress`（設定済み:
   0x833E…B94D）と `reservedConcurrency` を確認してから。出力の `McpEndpointUrl` を控える
2. **クラウド実オンチェーン決済**（決定18 の仕上げ・upfront の実地初検証）:
   ワークツリーに `.env` が無いので本体チェックアウト側から複製し、
   `MCP_SERVER_URL=<McpEndpointUrl> pnpm buy:once`。買い手 0xd98A…3Ebf に
   約19.98 テスト USDC 残あり。売り手残高の増分とトランザクション確定を確認
3. **検証結果の記録**: CloudWatch Logs（出力 `LogGroupName`）でコールドスタートと
   facilitator 疎通を確認し、結果を DESIGN.md（決定18・21 の理由欄）と本記録に反映。
   検証が済んだらフェーズ②完了
4. **フェーズ③着工（agent-app）**: AWS Blocks のスキャフォールド生成から。着工前に
   U1（JS SDK から AgentCore Payments を呼べるか）の検証と、U6（x402MCPClient が
   structuredContent を落とす）の対処方針決めが必要
5. 小物: PR マージ後に CI（billing-mcp-cdk ジョブ初回実行）がグリーンか確認

注意事項:

- **ポート 8000 で本体チェックアウト側の旧 express サーバーが動いたまま**（PID 15052、
  2026-08-30 22:02 起動）。`buy-once.ts` の既定接続先と衝突するので、ローカル検証の前に
  止めること
- デプロイ後の売り手は誰でも叩ける。検証が長引く場合も出しっぱなしにせず、
  終わったら `pnpm cdk destroy` で片付けるか、残す判断を記録すること

## 2026-08-30: フェーズ②前半 — billing-mcp サーバー実装とローカル実決済検証

### やったこと

- 着工前調査で U2・U4 を決着（決定17・18 を追加。`@x402/mcp` インプロトコル方式の採用と検証手段）
- `billing-mcp/server/` を新規実装（TDD、テスト16件）:
  - `generate-html` ツール（Bedrock Converse。呼び出しを関数注入にしてテスト可能化。踏襲元のロジックを移植）
  - `createPaymentWrapper` で generate-html だけを有料化（0.01 テスト USDC）。ui:// リソース（プレビュー UI）は無償
  - Streamable HTTP + Express（AgentCore 契約に合わせポート 8000 の /mcp）
  - テストは偽 facilitator（/supported /verify /settle を持つ express）を立てて統合的に検証
- 買い手テストスクリプト `scripts/buy-once.ts`（`createx402MCPClient` + viem 使い捨て鍵）
- 実オンチェーン検証: Circle Faucet のテスト USDC → x402.org facilitator 経由で決済 2 回成功（Base Sepolia、売り手残高が 0.01 USDC ずつ増加、トランザクション確定を確認）

### 実測で分かったこと・つまずき

- x402 v2 の照合は `accepted`（クライアントが選んだ支払い条件の完全な写し）必須。scheme/network だけでは「No matching payment requirements found」になる
- 価格 "$0.01" は SDK が Base Sepolia のテスト USDC（0x036C…）と amount 10000 に自動解決してくれる
- `@x402/mcp` クライアントは有料ツール結果の structuredContent を落とす（U6 として記録。サーバー側は正しく返している）
- 決済（settle）が `invalid_exact_evm_transaction_failed` で失敗することが 3 回中 1 回あった。一過性（facilitator 側）と判断。失敗時に買い手へ課金されないことは確認できたが、settle-after-handler フローのため Bedrock の生成コストは売り手が被る（悪意ある買い手が無効な支払いで生成だけ走らせる余地。本サンプルでは許容し、対策するなら verify 強化か前払いフロー）
- 決済直後の残高照会はブロック確定前で 0 に見えることがある（数秒待てば反映）
- Biome の `vcs.useIgnoreFile` は同ディレクトリに .gitignore が無いとエラーになるため、明示的な `files.includes` 除外に切り替えた
- 検証用ウォレットは使い捨て（`.env` に保存、gitignore 済み）。買い手 0xd98A…3Ebf / 売り手 0x833E…B94D

### セルフレビュー（同日・フェーズ②前半）

- 指摘5件を全件修正: ①settle 失敗経路のテスト追加（支払い未完了時に成果物を渡さない契約を固定）②CI に billing-mcp-server ジョブを有効化 ③ルート README のステータス更新 ④ツール説明文から価格ハードコードを除去（PRICE 可変のため）⑤buy:once を決済未完了時に exit 1 へ

## 2026-08-30: リポジトリ立ち上げ（技術調査・設計決定・土台作成）

### やったこと

- 参照リポジトリ3つ（html-creator-mcp-apps / ops-agent-sample-on-aws / handson-aws-blocks）の構成調査
- x402・MCP Apps・MCP 最新リビジョン・AgentCore Runtime / Payments の最新動向を Web 調査（モデルのカットオフ以降の情報を確認）
- 設計決定 1〜16 と未決論点 U1〜U5 を DESIGN.md に記録
- モノレポの土台（ディレクトリ骨格・CLAUDE.md・記録ファイル・CI 骨格・mise 設定）を作成し初回コミット

### 調査で分かった重要事実

- MCP の最新リビジョンは 2026-07-28（セッション廃止・ステートレス化の大改造）。実装 SDK は「SDK v2」という別パッケージ群（`@modelcontextprotocol/server` / `client` / `core` 等、2026-07-27 GA）。ただし MCP Apps の `ext-apps` SDK は v1 系専用のため、現時点では「MCP Apps」と「2026-07-28」は両立不可
- AgentCore Payments は 2026-08-18 に GA（プレビュー卒業）。テストネット（Base Sepolia + テスト USDC）完全対応で実マネー不要。Runtime 非依存の公開 API（boto3 / CLI から直接呼べる）で Lambda 上のエージェントからも利用可。ただし東京リージョン非対応（近場は ap-southeast-1 / ap-southeast-2）
- x402 は v2 仕様が現行。npm パッケージは `@x402/*` スコープへ世代交代済みで、旧 `x402-express` 等は deprecated。テストネット用の無料 facilitator（x402.org、API キー不要）あり
- AgentCore Runtime の CDK L2 construct は alpha（`@aws-cdk/aws-bedrock-agentcore-alpha`）から `aws-cdk-lib/aws-bedrockagentcore` 安定版へ移行済み
- 踏襲元 html-creator-mcp-apps は ext-apps（Apps 仕様 2026-01-26）は既にほぼ最新だが、ベースプロトコル側（SDK 1.29、自前 Mcp-Session-Id 管理等）が旧い

### 判断・つまずき

- 当初指示の踏襲元 URL は貼り間違いで、正しくは html-creator-mcp-apps だった（ユーザー訂正。amplify-gen2-agentcore-sample の調査結果は無駄にはならず、デプロイ構成の把握に流用）
- 「MCP の最新仕様で作る」がユーザー要望だったが、上記のとおり ext-apps と SDK v2 が両立不可と判明。ユーザーと相談し「MCP Apps 優先・2026-07-28 は ext-apps 対応後に追随」で合意（決定3）
- 決済基盤は「Base Sepolia 自前ウォレット」案と比較のうえ、GA 直後の AgentCore Payments を採用（決定9）。東京非対応のためリージョン戦略を相談し「東京主体 + Payments のみ越境」で合意（決定12）
- 今回のセッションは土台のみで着地（決定16）。実装コードは次セッション以降

### セルフレビュー（同日）

- 初回コミット後にセルフレビューを実施。指摘1件: 決定15の「全体 pnpm」が決定13「agent-app はスキャフォールド生成・手書きしない」（npm 前提）と衝突 → 決定15の pnpm 適用範囲を billing-mcp に限定し、CI 骨格の agent-app ジョブ（コメント内）と agent-app/README.md を npm 想定に修正

### 表現の見直し（同日、ユーザー指摘）

内容はそのままに、日本語の表現だけ見直した。フラグメント文（「〜だけ。」）の解消、
常体・敬体の混在の解消（3ファイルとも、追加した文を既存の常体へ揃えた）、句読点の位置の調整、
「空の表示器」など初見では通じない語の言い換え、不自然な位置での改行の是正。
