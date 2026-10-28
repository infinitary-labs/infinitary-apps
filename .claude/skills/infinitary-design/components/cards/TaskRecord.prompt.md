The body of a task's record card.
Its top row is the status pill, the reason beside it, and the task key, then close; the title sits alone beneath at `--text-lg`, the decision card's title size.
The pill uses the shared eight-state task mark and word (`components/now/NowPanel`, Shared task status).
The whole pill tints for Waiting on you (`accent`) or Interrupted/failed Dropped (`danger`); its mark never changes because of tint.
The key gives way (ellipsis).
The model is not in the top row: it is a cell of the fact strip below, read the way the crew summary reads it (FI3-565 piece 2).

**Tabs.**
Once a crewmate has started the task, or while it has a browser, a tab strip sits under the title: `Info` first, selected, then `Crewmate` (`components/cards/TaskCrewmate`), then `Browser · <page title>` for each page (`components/cards/TaskBrowser`, "The tab strip").
It is one tablist and one Tab stop; the arrows, Home and End move between tabs and Enter or Space shows the focused one.
A task with neither has no strip.
Info is the body below; the Crewmate tab and a Browser tab each replace this card in the same place on the stack, so a task has one entry.

**One left edge** (FI3-1159, the captain's "the goals, activity, details section headers don't seem to left-align with the 'now' and 'progress'").
Everything the record draws starts 20px in from the card's edge, where a decision card starts its own: the status pill, the title, the NOW and PROGRESS labels, the plan's marks, the labels of Goal and your words, Cards, Knowledge used, Activity and Details, the Activity lines' ages, the fact strip's labels and Drop task.
A row's hover tint and its focus ring reach 6px past that edge on both sides, so the tint never pushes its label in; the body frame reaches out by the same 6px and pads it back.
It uses the normal ResponseCard surface, height cap, scrolling body, regular width and edge drag, with the stack’s entrance and pager.
One shell-held entry per task opens at the front and is shown immediately; opening an existing task focuses it there without duplicating it.
New agent cards wait behind the shown entry unread.
Hide or Esc removes only the shown record, and Start again the host accepts removes that record; outside clicks do nothing.
A Start pressed in that record removes it as soon as the host accepts it, while the task reads Starting, without taking focus back if you have moved on (the captain's "hide the card immediately when it enters the 'starting' state", FI3-1538).
A start that fails after that still says why: its own line in the feed, its row back in the backlog, and, on the record opened again, the reason with `Start` or `Try again` in its bar.
A record opened while its task is starting elsewhere stays open when the crewmate begins.
Records have no thread or reply row.

**Its footer is the action bar: one shape in every open state; judgment calls stay on cards** (the captain's 4A, 2026-09-28, reversing the 2026-09-09 read-only record; Drop task, FI3-243; one bar, FI3-565 direction A piece 4, with the captain's `end_verb` "Drop task in every state" and `end_while_waiting` "yes"; Drop task at the left edge, FI3-948, the captain's layout B).
Every open record ends in one row of buttons read only from the task's typed state (`recordBarOf`), under the fact strip, `--space-3` above it: the end slot holds the row's left edge and the next slot its right edge, in every state, so neither button moves when the state changes.
The row's edges line up with the strip's labels.
The row has no sentence of its own: the reason beside the status pill and the body's attention box already say what happens next (FI3-948, the captain's "A crewmate is working ... feels unnecessary").
A row with no button draws nothing, and Done records have no bar.
A Dropped work record has only Start again in its next slot unless a replacement or stronger-model retry superseded it, or it has parts.

| Status | End | Next | Said in the body's attention box |
|---|---|---|---|
| Backlog | Drop task | `Start` | - |
| Starting | empty | `Starting`, unavailable | Still starting. You can keep working. after 15 seconds, or Checking whether it started if contact is lost. |
| Backlog, could not start | Drop task | `Try again` | The concrete reason. |
| Backlog or Queued, blocked | Drop task | `Start`, disabled | Waiting on FI3-6 (a dropped dependency: A task it waits on was dropped, Ask your first mate about its dependencies before starting.) |
| Backlog or Queued, with parts | Drop task | empty | Its 5 parts do the work, 3 closed, 2 still open. |
| Queued, held or not | Drop task | empty - no Start now | - (held: what it waits for and what ends the wait, Waiting for a premium model, You asked for premium, and no premium model has allowance now. It starts by itself once one does. Ask your first mate to start it sooner on another model.) |
| Dropped, with no replacement or parts | empty | `Start again` | - |
| Working | Drop task | empty | - |
| Idle | Drop task | empty | - |
| Interrupted | Drop task | `Continue` | Work was interrupted |
| Waiting on you | Drop task | `Show the card` | - (no card to show: This task needs you, Ask your first mate what is needed to continue.) |

`Drop task` (secondary) is the one verb that ends a task from its record, whatever its state.
Before the work starts it drops the record and the task never starts; once started it ends the task the way the stall card's Drop task does, keeping a copy of its unfinished work.
The record whose Drop task was confirmed closes once the host accepts the drop, as it does on Start; the task stays dropped on its record, which the Tasks panel opens again with `Start again`.
A row no host operation can end - the first mate's own decision and operation rows, or work returned to the queue after it started - leaves the end slot empty.
The next slot holds the one primary: `Start` on work that waits for your word - on request, held or not, with no parts - and, disabled, on blocked work.
Once Start is accepted the next slot reads `Starting` and is unavailable, and Drop task, queue and unqueue cannot race it.
The record whose Start was pressed closes on that acceptance, not when the crewmate begins; a refusal keeps it open with the inline line under the row.
`Continue` on Interrupted work; `Show the card` while a decision card waits, which brings that card forward and writes nothing.
A confirmed failure offers `Try again` on the same start path when another attempt is safe, and `Show the card` still wins when a decision is ready.
`Start again` needs no confirmation: it creates fresh work from the dropped task and removes the old record from the stack once accepted.
The old task stays closed; the new crewmate gets its reports and saved work, and tasks waiting on it wait on the replacement.
The button is a Tab stop and draws the shared focus ring.
An empty next slot means nothing needs you.
A waiting decision outranks an interruption or a blocker, as the status does.
Merge, discard and keep are never here.

Drop task asks once, inline, and the confirm sentence says whether unfinished work is kept: "Drop FI3-x?
It won't start, and there is no unfinished work to keep.
Its record stays." before the work starts, or "Drop FI3-x?
It ends the task and keeps a copy of its unfinished work." after.
Cancel (secondary, takes focus) moves into the end slot at the left edge, the sentence (`--text-sm`, `--fg-2`) sits between the two buttons and wraps there on a narrow card, and the danger-outline Drop task takes the next slot at the right edge, so a second click on the same spot cancels; Enter does not approve.
The confirmation names tasks still waiting on never-started work and says dropping will not start them.
A parent with open parts is refused in plain words; nothing is written.
Cancel, or hiding the record card, writes nothing.
A click is pending until the record moves under it, and competing buttons disable immediately.
A refusal is an inline line under the row and writes nothing.
Tab reaches the buttons in the order shown.
The top-right cross is `Hide`: it dismisses the record card and never drops the task; the size control stands right before it (`ResponseCard.prompt.md`, "Maximize"), and a maximized record restores on Esc before a later Esc hides it.
Every other write to a task happens by talking to the first mate while the card is shown (only the shown entry hints the turn).

Waiting uses only `waitingCardId`, the reachable shown ready decision on a live task, not `flags.needsYou` (broader attention).
Reply hides and refusal restorations update the open record with the rail.
No ready choice means existing attention/hold guidance and the bar's other slots, not a decision claim.
Show the card refreshes the choice before focusing it, never forcing a hidden card onto the stage.

The body leads with the shared task facts (`components/now/NowPanel`, Shared task facts): NOW, the crewmate's own newest doing with its short age (`NowPanel`, Shared task facts), its label in the summary's 66px side column (the line may take up to three lines here); then PROGRESS, the count and the current item of the plan the crewmate reported, its newest list note’s short age at the right edge as on Now, with the whole list under it, always open, finished items past eight behind `Show earlier · N` (FI3-734); then BROWSER, while this computer keeps the task's own browser open or knows why it stopped (`TaskBrowser.prompt.md`): the site in mono, then who is driving (`the crewmate is driving`, `nobody is driving`) or what stopped it (`you stopped it`, `the crewmate closed it`, `stopped after 30 minutes unused`, `its page stopped working`, `stopped when the task closed`), then `Open` as a link that brings the task's browser view to the front, parted by `·`.
The Browser line shows only on the record: the crew summary, a smaller surface, leaves it out.
Then a crew filing's reason, which leads only while it is open (queued or in the backlog); an attention box when something is wrong or the task waits on something (danger-tinted, in plain words, for an interrupted or failed task; warn-tinted for a blocker, a dropped dependency, a parent whose parts do the work, a hold or another need); and, on a closed task, one sentence of how it closed (`Merged 46 min ago as pull request #417. The checks passed.`, `Dropped 1 hr ago: <the words it was dropped with>`).
A cardless paused task says “Work is paused” with its latest report summary, or “No reason has been reported yet.” when none exists.
Queued work a gate holds has never reported, so its box says what the gate waits for and what ends the wait instead, in the words `taskHoldWords` gives (`src/shared/taskHold.ts`): a premium ask or a stronger-model retry waiting for a model at its level with allowance, or a level's allowance, a plan's allowance or a time the first mate set.
A later dismissed note in Now never hides that report, and continuing checks, jobs or replies show no paused box.
A declared captain wait alone never prints “Waiting on you”; only a reachable ready decision does.
What happens next is the status reason's and the attention box's to say, never a sentence of the bar's, and the body has no buttons.
There is no second newest line: Now is the record's one.
Then the record, as peer rows that each open on their own, painted like the panel `Disclosure` (micro label, mono count, caret), each absent when empty: Goal and your words (the goal in `--fg-1`, a filing's "Why it was filed" once it is no longer open, the captain's words verbatim in a hairline blockquote, later asks) · Cards (FI3-579 piece 1: every card the task showed, open and past, newest first; see below) · Knowledge used (what the task's work declared it relied on, by the revision it used; see below) · Activity (every event of the timeline in plain words, newest last, short relative ages in mono, the minor ones and what the crewmate did folded under the row they led to, a plain `Show earlier · N` link above when it is longer; see below) · Details (a labeled list: Crewmate `crewmate 21 on GPT-6 Sol`, Project, Branch, Delivery, Merging, Care, and the related work).
For work with a merge policy, Details shows Delivery (`Pull request` or `Local merge`), Merging (`Asks first` or `Merges on its own`), and Care (`Quick`, `Default`, or `Careful`) in separate rows.
Each value is followed by its muted source, `This task` or `Project setting`, and the rows end with `Ask your first mate to change these for this task.` while the task is open.
Once a device that runs work is on the list, Details adds Runs on after Care, for any task that could run elsewhere, answers included (`../devices/RunsOn.prompt.md`): where it started, or where it would start now (`Mac mini`, `Running as Builder`, `This computer`), followed by its muted source, `This task`, `Parent task` or `Project setting`.
It is read-only like the others, and the helper line shows under it while the task is open.
Local merge bounds Careful to Default; the muted explanation retains that Careful was requested for pull requests.
The values update in place, leaving disclosures and keyboard focus alone; accepted changes appear in Activity and the feed.
These are read-only facts, not switches: the existing message input is the only editing surface, and the action bar does not change.
Closed tasks keep their policies as history and omit the helper; answers, reviews and the personal workspace keep their existing no-merge presentation.
A Careful change presents its live-validation result, evidence and limitations primarily in the merge completion card, beside the decision.
The task record keeps its retained validation evidence under Details, closed by default, rather than as a prominent section above the record's rows.
Its scenario observations can expand there to show the supporting transcript, picture or recording; these are history, not another merge decision.

The fact strip sits just above the action bar, under a `--line-1` hairline, after those rows (FI3-1159, the captain's layout B): MODEL, INTELLIGENCE, REASONING, PULL REQUEST, CHECKS and REVIEW as cells, the merge card's own shape, then the footnote saying why that model (`components/now/NowPanel`, Shared task facts).
The pull request and its checks are there, beside the model, and nowhere in the body: the body holds the work and its record, the strip where the work lands.

**Pull request links** (FI3-1159, the captain's "i feel that should be a consistent experience whenever we render a PR number").
Every pull request the app names - by its number - is a link to its page wherever the host has one and the surface takes clicks: in the `--accent` color, underlined only while the pointer rests on it, a Tab stop with the focus ring, and a click opens it in the browser.
On the record that is the strip's PULL REQUEST cell, the words of Now that name the task's pull request (`The checks failed on pull request #965.`), every Activity line that names it - the task's own, a folded one, and a linked task's line naming that task's pull request (`SCR-6, filed by this task, merged pull request #977.`) - and the closing line of a merged task.
The host says which words of a line name a pull request (`TaskActivityLine.change`); the window reads nothing out of the text, and a number in a crewmate's words that is not one of the task's pull requests stays text.
The merge card's PULL REQUEST cell is the same link, and so is a pull request number a card's author writes in its body (`ResponseCard.prompt.md`, "Pull request numbers in a body").
The crew summary never takes the pointer, so its pull request stays plain text; a click on what opened it opens this record.
Every time reads relative, the absolute time on rest; the ages of Now, Progress and each finished item, and the checks' words and finish age, are Tab stops of their own, and the keyboard's focus shows the absolute time - for the checks, when they started and when they were last read - as the pointer's rest does (readme, "Facts shown on rest").
So are the body's ages - an Activity or ask line's, a closed task's, a card's - each named by its short age and absolute time, in the same label the body draws in its own page; an Activity line that opens is the stop for its age, and its name reads the age's.
Inside a row, only Activity's `Show earlier · N` link, the Activity lines that open (below), and the retained validation observations under Details open further.

**The Cards row** (FI3-579 direction A, the captain's 3 "a Cards row on the task's record").
Its label is `Cards`, with the count in mono, and it sits between Goal and your words and Activity; it is absent when the task never showed a card.
Open, it lists every card the task showed - the open ones and every closed one, those closed with the cross, those withdrawn and those taken down when the task ended - newest first, one line each, in the Activity line's grid: the kind in mono (`Decision` or `Note`), the title as a link in `--accent` (ellipsis, full title on hover), and how it ended in `--text-xs` `--fg-3` with its short age (`You chose Approve and build · 4h`, `Closed without choosing · 2h`, `Withdrawn by its author`, `Taken down when the task ended`).
A card still open - a folded seen note included - reads `On the stage` and no age, and its link focuses that live card, never a past copy.
Every closed card's link brings it forward through the shared show-card door, the one the first mate uses, as the read-only past card (`ResponseCard`, Past card); the row writes nothing and shows no button of its own.
The Cards row is the same body row on closed and open records.
Enter or Space on the summary opens the row and each link is a tab stop in list order.

**The Knowledge used row** (FI3-1150, the rest of the captain's approved FI3-1110 design; `../knowledge/KnowledgeBrowser`).
It exists only where the window has the Knowledge browser - a build with knowledge to show - and only once the task's work declared a use.
Its label is `Knowledge used`, with the count in mono, and it sits between Cards and Activity.
Open, it says once, in `--text-sm` `--fg-3`, that these are what the work declared it relied on by the revision it used and that opening one records no use; then one entry per line, newest first, each entry and revision once.
A line is the entry's words as the revision it used said them - a finding's statement, a concept's name - as a link in `--accent` (full words on hover), then in `--text-xs` `--fg-3` what it is and the revisions (`Finding · used revision 1 · current revision 2`, `Concept · used revision 3, the current one`, `· retired since` when it was), then the work's own reason in `--fg-3`.
A link opens that exact revision in the Knowledge browser's inspector, with how it compares to the current revision first (`KnowledgeBrowser`, The inspector); the record, the use and the entry stay as they were.
More than twenty end with `And N more.`

**Activity lines that open** (FI3-901, the captain's "Fold Full report into Activity"; FI3-1201, "Folded under the row they led to").
There is no Full report row.
A report reads in Activity as its one-line summary, and that line opens to the report's whole text, so every report the task gave can be read in full, each beside its own age.
An answer or an operation's result that no report carries opens the same way from the Activity line that closed the task.
An answer given on a card opens to the card's words, never its markup: each paragraph, heading and list item on a line of its own, with its drawings and pictures left to the card, which the Cards row opens (FI3-904).
Nothing about the task is left out of Activity: a minor event - the update a report restates, a check reading that repeats, a status that does not close the task, the app's bookkeeping - folds under the row it led to, and what no row followed yet folds under the newest row (`docs/task-record.md`, "What Activity holds").
Activity and agent history read the same normalized timeline: retained card offers, messages and choices, brief receipts and conversation actions sit in the same chronology as the task's events.
The earlier folded action summaries remain a compatible read; the window shows each action once, as a disclosure from the common timeline.
Each disclosure opens its exact retained source, including an earlier offer after its card changes, and shows the recorded author without treating a card script as the captain.
An unknown time reads Undated, and an unavailable source says so rather than substituting newer words.
Historical content is text, with no buttons that can repeat the action; the Cards row remains the full card detail view.
A line with events or actions folded under it ends with their count in mono `--fg-3` (`+3`, read as "3 more") before its caret, and opens to them: each in the Activity grid, its short age in mono and its words in `--fg-3`, events and actions together oldest first, then the whole text, then any that came after the line.
A retained source still opens when its summary already contains its words, so its recorded author remains reachable.
A revised brief or recorded conversation leads with a plain sentence, such as "The brief was revised" or "The conversation resumed", rather than serialized fields or an internal opening reason.
Where the source also holds raw structured text, a second native disclosure labeled `Recorded details` sits beneath the plain reading in Activity's text column, closed initially.
It uses the row disclosure's quiet label, caret, hover and focus ring; Tab reaches its summary and Enter or Space opens it independently.
Its exact raw contents retain line breaks in `--text-xs` `--font-mono`, `--fg-2`, wrapping within the text column rather than widening the record.
A card script's raw value uses that same deeper disclosure while its choice and recorded author stay in plain sight.
Opening either level remains a read, never a repeated choice, action or permission.
An older detail response without the common timeline keeps plain lines where there is nothing more to read.
The line keeps the Activity grid, with the row caret at its end, `--bg-2` on hover and a focus ring like a row's summary; the whole text sits beneath it in the text column, `--fg-2`, with its line breaks kept.
Each line opens on its own and stays open across live updates; Enter or Space on the line opens it.

**Lines from linked tasks** (FI3-1209, FI3-1189's rule 1, "record each fact once, for every task it concerns").
Activity also holds what happened to the tasks linked to this one - its parts, the tasks it waits for or that wait for it, the follow-ups it filed, a task that replaced one of them - each a plain line of its own in its time, worded from this task's side (`SCR-6, which replaced SCR-3, merged pull request #977.`, `SCR-3, filed by this task, was dropped: SCR-6 replaces it.`, `SCR-4 waits for this task.`).
The line keeps the Activity grid and ends with `from SCR-6` in mono `--text-xs` `--fg-3`, a link to that task's record: `--accent` and underlined on hover, a focus ring like a Cards row link, a tab stop in list order, and Enter or Space opens the record the way its Tasks row does.
Nothing folds under such a line, and it never stands as Now.

```jsx
<ResponseCard kind="record" title="Refactor the auth middleware" meta="FM3K-9 · working" onClose={onClose}>
  <TaskRecord record={{goal:"The middleware has one code path and the suite is green.",userWords:"commission a crewmate: refactor the auth middleware",
    blockedBy:[],blocks:["FM3K-11"],children:{total:1,closed:0},
    events:[{id:1,at:Date.now()-900000,text:"created"},{id:2,at:Date.now()-800000,text:"dispatched to crewmate 1"},{id:3,at:Date.now(),text:"Steady as she goes.",report:"Steady as she goes. 14 files changed, tests green."}],
    delivery:{mode:"direct-pr",ci:"green"}}}/>
</ResponseCard>
```

Never persisted as a card, never emitted by an agent, never a feed line: it is a view of the record, opened from a now-panel row and gone when closed.
In the app the body is a Tier-2 frame template (`src/renderer/src/plugins/builtin/record/`) fed by the `tasks.detail` read, not this JSX; the look is the same.

The task record adds a live Use row after Now and Progress, on the same left edge, in the shared fact-row type.
It shows the computer name, measured processor equivalents, resident memory and attributed process count in mono, without a meter or a color judgment.
A missing or stale reading says Use unavailable; no matched processes says No attributed processes in available readings.
Resident memory counts shared pages once per process and is not the computer’s used-memory figure.
