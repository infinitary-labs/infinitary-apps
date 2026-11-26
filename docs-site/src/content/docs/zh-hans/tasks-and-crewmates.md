---
source: 7a56385e256eae30
title: 任务和船员
description: 什么是任务，它如何从待办列表走到完成，在哪里跟进它，以及如何引导正在做它的船员。
---

任务是你的大副正在跟踪的一项工作，带有一个编号，例如 `WEB-12`。
船员是做任务工作的 AI 助手，在你项目的独立工作副本中工作。
每个任务都会保留一份记录：你要求了什么、改了什么、证据，以及你做过的决定。

## 任务处于什么状态 {#where-a-task-stands}

窗口右侧的“任务”按状态列出你的任务：

- **等你处理**：任务上有一张卡片需要你决定。
- **工作中**：现在有一名船员在做它。
- **排队中**：等它所等待的事情（例如另一个任务）完成后，它会自动开始。
- **待办列表**：它在等你让它开始。
  想让它开始时，点击它那一行上的“**开始**”。
- **已完成 · 7 天**：本周已完成。

一行可能会在标题后加一个词，例如“受阻”“暂缓”“检查”或“无法开始”。
无法开始的任务会提供“**重试**”。

点击一行即可打开任务。
如果任务上有一张卡片在等你，这张卡片会先显示出来。

### 每个任务旁边的标记 {#the-mark-beside-each-task}

“任务”中的每一行都以一个小标记开头。
它的形状说明任务处于什么状态，颜色则作为补充。

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **待办列表**：它在等你点击“**开始**”。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **排队中**：条件允许时，它会自动开始。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **正在开始**：Infinitary 正在为它准备船员。
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **工作中**：现在有一名船员在做它。
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **工作中，在做后台工作**：它的船员启动的某件事（例如耗时较长的构建或测试运行）仍在运行。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **工作中，正在等待检查**：它的船员在等它那项改动的检查完成。
  这一行会加上“检查”。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **工作中，正在等待这批改动**：它已获批准的改动，在等它所加入的那批改动的检查完成。
  这一行会加上“批量”。
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **空闲**：它已经开始，但它的船员现在没有在工作，它的工作成果都保留着。
  当它在等另一个任务时，这一行会加上“等待中”。
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **已中断**：它的船员这一轮在做完之前就停了。
  告诉它接下来该做什么。
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **等你处理**：任务上有一张卡片需要你决定。
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **完成**：它已经完成。
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **已放弃**：它已被放弃。
  被放弃的工作显示在任务看板上，不显示在“任务”中。

当任务所在的电脑无法联系时，它的标记保持原来的形状并变成橙色，这一行以“无法联系”结尾（[你的其他电脑](/zh-hans/your-other-computers/#a-computer-that-runs-work)）。
例如，那台电脑上的待办列表任务显示为 <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>。

拆分成多个部分的任务，会在它下面列出它的各个部分。
一旦其中一个部分开始，这个任务就会列在“工作中”下，它未完成的部分列在它下面。
任务在那里保留自己的标记，因此由各部分做工作的任务，可能在“工作中”下显示待办列表或排队中的标记。

要用文字读取任务的状态及其原因，请把指针停在它那一行上，或用键盘移到该行。

## 任务看板 {#the-task-board}

要查看更完整的视图，请点击“任务”标题处的“**打开任务看板**”。
看板顶部是“等你处理”，下面是三列：待办列表、排队中和工作中。

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="任务看板：一排项目的标签，顶部有一个等你处理的任务，下面是待办列表、排队中和工作中三列。" width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="任务看板：一排项目的标签，顶部有一个等你处理的任务，下面是待办列表、排队中和工作中三列。" width="876" height="493" />

它的视图还会列出整个待办列表、已完成 · 7 天，以及本周放弃的工作。
在“**查找任务**”中输入编号或标题，可以缩小每个分栏的范围，包括更早完成的工作。
你的项目有标签时，看板会显示一排标签，点击其中一个，看板就只显示带有这个标签的任务；请参阅[标签](#tags)。

要移动任务，请把它的图块拖到另一列，或使用它的 ⋯ 菜单：

- 移到“**排队中**”，条件允许时它会自动开始。
- 移到“**工作中**”，它会立即开始。
- 移回“**待办列表**”，它会再次等你发话。
  已经开始的任务会保留它的工作成果。
- 移到“**放弃任务**”托盘，它会被放弃。

会开始工作或放弃工作的移动，会先询问一次。
看板从不合并任何东西：只有在任务的合并卡片上才会发生合并。

## 任务的卡片 {#a-tasks-card}

打开任务即可看到它的卡片。
标题下面是一排标签页：

- **信息**：你要求了什么、它处于什么状态、它的标签，以及如何交付。
- **卡片**：任务向你展示过的卡片，并显示数量。
- **动态**：任务写下的每一行，按顺序排列。
- **船员**：船员自己的对话，在它工作时逐行显示。
- **浏览器**：船员在它自己的浏览器中打开的页面（如果有的话）。
  请参阅[船员的浏览器](/zh-hans/the-crews-browser/)。

只有任务在某个标签页上有内容可显示时，该标签页才会出现。

## 分成多个部分的任务 {#a-task-split-into-parts}

在分成多个部分的任务的 **信息** 标签页上，**组成部分** 一行统计已关闭的部分，并按登记顺序列出每个部分及其状态。
点击计数可以收起列表，再点击一次即可展开。
部分超过八个时，已关闭的部分会收在一行后面，你可以展开它。
要打开某个部分的卡片，点击该部分，或用键盘移到它上面并按 Enter；在那里启动它或回答它。

待办列表中由各部分完成工作的任务，从不要求你为它本身点击 **开始**。
它的 **信息** 标签页顶部会说明它的部分在等什么，例如“它的最后一个部分在等你点击“开始””，并且它的部分全部关闭后，任务会自动关闭。

## 标签 {#tags}

任务可以带有它所属项目的任何标签，例如缺陷或功能。
项目的标签由你在设置 → 项目中创建；请参阅[项目](/zh-hans/projects/#tags)。

要给任务加标签，请打开它的“**信息**”标签页，点击“**标签**”一行上的“**编辑标签**”。
菜单会列出项目的标签，每次勾选都会立即保存。
只有项目有了标签，“**标签**”一行才会出现。
你也可以让你的大副给任务加标签。

你可以在三个地方按标签查找任务：

- “任务”标题处的“**搜索任务**”会显示一排项目的标签。
  点击一个标签，只列出带有它的任务；点击“**无标签**”，列出不带任何标签的任务；点击“**所有标签**”，则重新列出全部任务。
- 它旁边的“**任务分组**”可以把你的任务改为“**按标签**”列出，而不是“**按状态**”。
  每个标签是一组，在你展开之前保持收起。
  “**等你处理**”的任务会排在它所带每个标签那一组的最前面，即使那一组收起也照样列出。
- 任务看板有自己的一排标签，它的“**按标签**”视图会按任务所处的状态，统计每个标签下各有多少个任务。

标签一次只显示一个项目的：处于聚焦状态的项目，或者你唯一有标签的那个项目。
要聚焦于一个项目，请参阅[项目](/zh-hans/projects/#focus-on-one-project)。

## 引导船员 {#steering-a-crewmate}

你可以用三种方式告诉船员一些事：

1. 在它的某张卡片下输入，然后点击“**聊天**”。
2. 在它的“**船员**”标签页底部的输入框中输入。
   正在工作的船员会在工作时接收你的话；空闲的船员会从你的话重新开始。
3. 在消息框中告诉你的大副。

要停止船员的这一轮，请在它的“船员”标签页上点击“**停止**”。
任务保持打开，你可以告诉它接下来该做什么。

## 把关 {#rigor}

把关是指工作送到你面前之前，检查得有多彻底。
它有三个级别：

- **快速**：检查通过，仅此而已。
- **默认**：船员用图片展示改动能正常工作，并运行重要的测试。
- **谨慎**：在默认的基础上，先经过独立审查并证明改动有效，再出现合并卡片。

每个项目都有自己的把关设置，在设置 → 项目中。
对于单个任务，请在你提出要求时说明要多小心，例如“这一项要谨慎”。
在合并卡片上，**仔细审查**会把该任务提升到谨慎。

## 合并前先询问 {#asking-before-merging}

每个项目要么在合并前先询问，要么自动合并。
设置 → 项目中的“**合并前先询问**”开关决定了这一点。
打开时，完成的工作会等你的合并卡片。
关闭时，通过检查的工作可能不经询问就合并，之后你会收到一张带有它改动说明的卡片。
要为单个任务更改这一点，请告诉你的大副。

## 等待工作的步骤 {#a-step-that-waits-on-work}

当你要求在工作完成后做一件项目之外的事，比如关闭一个议题或发布一条更新，你的大副会把这个步骤登记为一个单独的任务。
它会等待每一个做这项工作的任务，包括之后加入的部分。

- 只有这些任务都已合并各自的改动，或在没有可合并内容的情况下完成，它才会开始。
- 如果其中一个被放弃，这个步骤什么也不做，你的大副会告诉你。
- 如果你要求在工作进入某个版本后再做这个步骤，它会等到你的船员记录下包含这项工作的版本；参见[自动化](/zh-hans/automation/#when-it-runs)。

Infinitary 不会在合并的改动里加入关闭议题的字样，所以议题由这个步骤自己的任务来关闭。

## 结束任务 {#closing-a-task}

大多数任务会自行结束：

- 合并它的改动就会结束任务。
- 合并卡片上的“**丢弃**”会放弃这项工作。
- 回答你问题的便笺上的“**完成**”，会把它作为已回答来结束。

你也可以在任务的卡片上结束它：

- “**放弃任务**”会结束它。
  正在工作的船员会停止，它未完成的工作会保留。
- 在已经开始的任务上，“**标记为已完成**”表示工作已经完成。

已结束的任务会保留它的记录。
被放弃的工作会在看板上保留一周，只读。
