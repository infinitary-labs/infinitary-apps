---
source: e113b8fc8884a051
title: タスクと乗組員
description: タスクとは何か、バックログから完了までどう進むか、どこで経過を追えるか、作業中の乗組員にどう伝えるかを説明します。
---

タスクは、一等航海士が追跡している 1 つの作業で、`WEB-12` のようなキーが付きます。
乗組員は、タスクの作業をこなす AI のアシスタントで、プロジェクトの専用の作業コピーで作業します。
どのタスクにも、依頼した内容、変わったこと、根拠、決めたことの記録が残ります。

## タスクの状況 {#where-a-task-stands}

ウインドウの右側にある「タスク」には、タスクが状況ごとに一覧表示されます。

- **あなた待ち**：タスクのカードがあなたの判断を待っています。
- **作業中**：乗組員が今取り組んでいます。
- **待機中**：別のタスクなど、待っているものが終わると自動的に始まります。
- **バックログ**：あなたが開始するのを待っています。
  始めたいときに、その行の **開始** を押します。
- **完了 · 7日**：今週終わったものです。

行のタイトルの後ろには、「ブロック中」「保留中」「チェック」「開始できません」などの言葉が付くことがあります。
開始できなかったタスクには **もう一度試す** が表示されます。

行をクリックするとタスクが開きます。
そのタスクにあなたを待つカードがあれば、まずそのカードが前に出てきます。

### 各タスクの横の印 {#the-mark-beside-each-task}

「タスク」の各行は、小さな印で始まります。
形がタスクの状況を示し、色がそれを補います。

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **バックログ**：あなたが **開始** を押すのを待っています。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **待機中**：始められるようになると自動的に始まります。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **開始中**：Infinitary が担当の乗組員を準備しています。
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **作業中**：乗組員が今作業しています。
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **作業中（バックグラウンドの作業）**：時間のかかるビルドやテストの実行など、担当の乗組員が始めたものがまだ動いています。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **作業中（チェック待ち）**：担当の乗組員が、変更のチェックが終わるのを待っています。
  行には「チェック」が付きます。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **作業中（一括プルリクエスト待ち）**：承認済みの変更が、加わった一括プルリクエストのチェックを待っています。
  行には「一括」が付きます。
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **アイドル**：開始済みですが、担当の乗組員は今は作業しておらず、作業内容は保たれています。
  別のタスクを待っているときは、行に「待機中」が付きます。
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **中断**：担当の乗組員の作業が、終わる前に止まりました。
  次に何をするかを伝えてください。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **あなた待ち**：タスクのカードがあなたの判断を待っています。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **完了**：終わっています。
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **取りやめ**：取りやめになりました。
  取りやめた作業は「タスク」ではなく、タスクボードに表示されます。

タスクを実行するコンピューターと連絡がつかないときは、印の形はそのままでオレンジ色になり、行の最後に「連絡がつきません」と表示されます（[ほかのコンピューター](/ja/your-other-computers/#a-computer-that-runs-work)）。
たとえば、そのコンピューター上のバックログのタスクは <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> と表示されます。

パートに分かれたタスクは、その下にパートが一覧表示されます。
パートの 1 つが始まると、タスクは「作業中」の下に移り、まだ開いているパートがその下に並びます。
タスクはそこでも自分の印を保つので、パートが作業をしているタスクは、「作業中」の下でもバックログや待機中の印を表示することがあります。

タスクの状況とその理由を言葉で読むには、行にポインターを置くか、キーボードでその行に移動します。

## タスクボード {#the-task-board}

もっと詳しく見るには、「タスク」の見出しにある **タスクボードを開く** を押します。
ボードには、いちばん上に「あなた待ち」、その下にバックログ、待機中、作業中の 3 つの列が表示されます。

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="タスクボード：いちばん上にあなた待ちのタスクが 1 件、その下にバックログ、待機中、作業中の列。" width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="タスクボード：いちばん上にあなた待ちのタスクが 1 件、その下にバックログ、待機中、作業中の列。" width="876" height="493" />

表示を切り替えると、バックログ全体、「完了 · 7日」、今週取りやめた作業も一覧できます。
**タスクを検索** にキーやタイトルを入力すると、以前に完了した作業も含め、すべての列が絞り込まれます。

タスクを移すには、そのタイルを別の列へドラッグするか、⋯ メニューを使います。

- **待機中** へ移すと、始められるようになったときに自動的に始まります。
- **作業中** へ移すと、すぐに始まります。
- **バックログ** へ戻すと、再びあなたの指示を待ちます。
  すでに始まっていたタスクは、作業内容を保ちます。
- **タスクを取りやめ** のトレイへ移すと、取りやめになります。

作業を始めたり取りやめたりする移動では、先に 1 回だけ確認されます。
ボードが何かをマージすることはありません。マージは、タスクのマージカードでしか行われません。

## タスクのカード {#a-tasks-card}

タスクを開くと、そのカードが表示されます。
タイトルの下にはタブが並んでいます。

- **情報**：依頼した内容、現在の状況、届け方。
- **カード**：タスクがこれまでに表示したカードとその数。
- **アクティビティ**：タスクが書いたすべての行を順番に表示します。
- **乗組員**：乗組員自身の会話を、作業に合わせて 1 行ずつ表示します。
- **ブラウザ**：乗組員が自分のブラウザで開いたページがあれば、それを表示します。
  [乗組員のブラウザ](/ja/the-crews-browser/)を参照してください。

タブは、そのタスクにそこで見せるものができたときにだけ表示されます。

## 乗組員に伝える {#steering-a-crewmate}

乗組員に何かを伝える方法は 3 つあります。

1. カードの下に入力し、**チャット** を押します。
2. **乗組員** タブのいちばん下の欄に入力します。
   作業中の乗組員は作業を続けながらあなたの言葉を受け取り、アイドル状態の乗組員はその言葉から作業を再開します。
3. メッセージ欄で一等航海士に伝えます。

乗組員の作業を止めるには、「乗組員」タブの **停止** を押します。
タスクは開いたままなので、次に何をするかを伝えられます。

## 慎重さ {#rigor}

慎重さは、作業があなたに届く前にどれだけ念入りに確かめられるかを表します。
レベルは 3 つあります。

- **クイック**：チェックに合格すること、ほぼそれだけです。
- **標準**：乗組員が変更が動く様子を画像付きで示し、重要なテストを実行します。
- **慎重**：標準の内容に加えて、マージカードの前に独立したレビューと、変更が動くことの証明を行います。

慎重さはプロジェクトごとに、設定 → プロジェクトで決めます。
1 つのタスクだけなら、依頼するときに「これは慎重にお願いします」のように伝えます。
マージカードでは、**慎重にレビュー** を押すとそのタスクが「慎重」に上がります。

## マージ前の確認 {#asking-before-merging}

各プロジェクトは、マージの前に確認するか、自動でマージするかのどちらかです。
設定 → プロジェクトの **マージ前に確認** スイッチで切り替えます。
オンのときは、終わった作業はあなたのマージカードを待ちます。
オフのときは、チェックに合格した作業が確認なしにマージされることがあり、あとでそのストーリーを載せたカードが届きます。
1 つのタスクだけ変えたいときは、一等航海士に伝えてください。

## タスクを閉じる {#closing-a-task}

ほとんどのタスクは自動的に閉じます。

- 変更をマージすると、タスクが閉じます。
- マージカードの **破棄** を押すと、作業が取りやめになります。
- 質問に答えるお知らせで **完了** を押すと、回答済みとして閉じます。

タスクのカードから閉じることもできます。

- **タスクを取りやめ** を押すと、タスクが終わります。
  作業中の乗組員は止まり、終わっていない作業は保たれます。
- 開始済みのタスクで **完了として閉じる** を押すと、作業が終わったことになります。

閉じたタスクにも記録は残ります。
取りやめた作業は、1 週間ボードに読み取り専用で残ります。
