---
source: 37599270c99ffda1
title: 任務與船員
description: 任務是什麼、它如何從待辦清單走到完成、在哪裡追蹤它，以及如何引導處理它的船員。
---

任務是大副正在追蹤的一份工作，帶有像 `WEB-12` 這樣的編號。
船員是處理任務工作的 AI 幫手，在它自己的專案工作副本裡工作。
每項任務都會留下紀錄，記下你要求了什麼、變更了什麼、證據，以及你的決定。

## 任務目前的狀態 {#where-a-task-stands}

視窗右側的「任務」會依目前的狀態列出你的任務：

- **等你處理**：任務上有一張卡片需要你做決定。
- **工作中**：現在有一位船員正在處理它。
- **排入佇列**：它在等的東西完成後（例如另一項任務），它就會自己開始。
- **待辦清單**：它在等你開始它。
  想讓它開始時，按它那一列的 **開始**。
- **已完成 · 7 天**：這一週完成的。

一列可能會在標題後面多加一個詞，例如「受阻」、「暫緩」、「檢查」或「無法開始」。
無法開始的任務會提供 **再試一次**。

點按一列就能打開那項任務。
如果它上面有卡片在等你，那張卡片會先出現。

### 每項任務旁的標記 {#the-mark-beside-each-task}

「任務」裡的每一列都以一個小標記開頭。
它的形狀說明任務目前的狀態，顏色則加以佐證。

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **待辦清單**：它在等你按 **開始**。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **排入佇列**：它能開始時就會自己開始。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **啟動中**：Infinitary 正在幫它準備船員。
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **工作中**：現在有一位船員正在處理它。
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **工作中，背景工作進行中**：它的船員開始的某件事，例如一次長時間的建置或測試，仍在執行。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **工作中，正在等待檢查**：它的船員正在等它的變更上的檢查完成。
  那一列會多加「檢查」。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **工作中，正在等待批次**：它已核准的變更正在等它加入的批次的檢查。
  那一列會多加「批次」。
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **閒置**：它已經開始，但它的船員現在沒有在工作，它的工作會保留。
  當它在等另一項任務時，那一列會多加「等待中」。
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **已中斷**：它的船員這一輪在完成之前就停止了。
  告訴它接下來要做什麼。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **等你處理**：任務上有一張卡片需要你做決定。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **已完成**：它已經完成。
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **已放棄**：它被放棄了。
  放棄的工作會顯示在任務看板上，而不是「任務」裡。

當任務執行所在的電腦連絡不上時，它的標記會保持形狀並變成橘色，那一列的結尾也會加上「連絡不上」（[你的其他電腦](/zh-hant/your-other-computers/#a-computer-that-runs-work)）。
例如，那台電腦上的一項待辦清單任務會顯示 <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>。

拆成幾個部分的任務，會在它下面列出它的各個部分。
它的某個部分開始之後，這項任務就會列在「工作中」底下，下面是它尚未完成的部分。
任務在那裡保留它自己的標記，所以由各部分負責工作的任務，可能會在「工作中」底下顯示待辦清單或排入佇列的標記。

想用文字讀到任務的狀態和原因，把指標停在它那一列上，或用鍵盤移到那一列。

## 任務看板 {#the-task-board}

想看得更完整，按「任務」頁首的 **開啟任務看板**。
看板頂端顯示「等你處理」，下面是三欄：待辦清單、排入佇列和工作中。

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="任務看板：一排專案的標籤，頂端有一項在等你的任務，下面是待辦清單、排入佇列和工作中三欄。" width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="任務看板：一排專案的標籤，頂端有一項在等你的任務，下面是待辦清單、排入佇列和工作中三欄。" width="876" height="493" />

它的檢視也會列出整個待辦清單、已完成 · 7 天，以及這一週放棄的工作。
在 **搜尋任務** 裡輸入編號或標題，就能縮小每一欄的範圍，包括較早完成的工作。
你的專案有標籤時，看板會顯示一排標籤，按下其中一個，看板就只顯示帶有它的任務；請看 [標籤](#tags)。

想移動任務，就把它的方塊拖到另一欄，或使用它的 ⋯ 選單：

- 移到 **排入佇列**，它能開始時就會自己開始。
- 移到 **工作中**，它會立刻開始。
- 移回 **待辦清單**，它會再次等你的指示。
  已經開始的任務會保留它的工作。
- 移到 **放棄任務** 區，它就會被放棄。

會讓工作開始或被放棄的移動，會先問一次。
看板絕不會合併任何東西：合併只會在任務的合併卡片上發生。

## 任務的卡片 {#a-tasks-card}

打開任務就能看到它的卡片。
在它的標題下方有一排分頁：

- **資訊**：你要求了什麼、它目前的狀態、它的標籤，以及它如何交付。
- **卡片**：這項任務顯示給你的卡片，以及數量。
- **動態**：這項任務寫下的每一行，依序排列。
- **船員**：船員自己的對話，在它工作時一行一行顯示。
- **瀏覽器**：船員在它自己的瀏覽器裡打開的網頁（如果有的話）。
  請看 [船員的瀏覽器](/zh-hant/the-crews-browser/)。

只有在任務有東西可以顯示時，該分頁才會出現。

## 標籤 {#tags}

任務可以帶有所屬專案的任何標籤，例如錯誤或功能。
專案的標籤要在設定 → 專案裡建立；請看 [專案](/zh-hant/projects/#tags)。

想替任務加上標籤，就打開它的 **資訊** 分頁，按 **標籤** 那一列的 **編輯標籤**。
選單會列出專案的標籤，每次勾選都會立刻儲存。
專案有了標籤之後，**標籤** 這一列才會出現。
你也可以請大副替任務加上標籤。

有三個地方可以依標籤尋找任務：

- 「任務」頁首的 **搜尋任務** 會顯示一排專案的標籤。
  按一個標籤，就只列出帶有它的任務；按 **無標籤** 會列出沒有任何標籤的任務，按 **所有標籤** 則會再次列出所有任務。
- 它旁邊的 **任務分組** 可以讓你的任務 **依標籤** 列出，而不是 **依狀態**。
  每個標籤自成一組，在你展開之前都是收合的。
  **等你處理** 的任務會排在它所帶每個標籤那一組的最前面，即使那一組收合也照樣列出。
- 任務看板有它自己的一排標籤，它的 **依標籤** 檢視會依任務目前的狀態，計算每個標籤各有幾項任務。

標籤一次只顯示一個專案的：目前聚焦的專案，或你唯一有標籤的專案。
想聚焦在一個專案，請看 [專案](/zh-hant/projects/#focus-on-one-project)。

## 引導船員 {#steering-a-crewmate}

你可以用三種方式告訴船員一些事：

1. 在它的某張卡片下輸入，然後按 **聊天**。
2. 在它 **船員** 分頁底部的方塊裡輸入。
   工作中的船員會邊工作邊接收你的話；閒置的船員則會從你的話重新開始。
3. 在訊息框裡告訴大副。

想停止船員的這一輪，按它「船員」分頁上的 **停止**。
任務會保持開啟，你可以告訴它接下來要做什麼。

## 謹慎度 {#rigor}

謹慎度是工作在送到你面前之前，被檢查得多徹底。
它有三個等級：

- **快速**：檢查通過，其他做得不多。
- **預設**：船員會展示變更確實可行，附上圖片，並執行重要的測試。
- **謹慎**：先做到「預設」，再加上一次獨立審查，以及變更確實可行的證明，然後才送出合併卡片。

每個專案在設定 → 專案裡都有自己的謹慎度。
針對單一任務，就在提出請求時說明要多謹慎，例如「這項要謹慎一點」。
在合併卡片上，**仔細審查** 會把那項任務提高到「謹慎」。

## 合併前先問過你 {#asking-before-merging}

每個專案要嘛合併前先問過你，要嘛自行合併。
設定 → 專案裡的 **合併前先問過你** 開關決定這一點。
開啟時，完成的工作會等你的合併卡片。
關閉時，通過檢查的工作可能不經詢問就合併，之後你會收到一張附上變更說明的卡片。
想針對單一任務更改，就告訴大副。

## 結束任務 {#closing-a-task}

大多數任務會自己結束：

- 合併它的變更，就會結束這項任務。
- 它合併卡片上的 **捨棄** 會放棄這份工作。
- 回答你問題的筆記上的 **完成**，會以「已回答」結束它。

你也可以從任務的卡片結束它：

- **放棄任務** 會結束它。
  正在工作的船員會停止，它尚未完成的工作會保留。
- 已經開始的任務上的 **以完成結束**，表示工作已經完成。

結束的任務會保留它的紀錄。
放棄的工作會以唯讀的方式在看板上保留一週。
