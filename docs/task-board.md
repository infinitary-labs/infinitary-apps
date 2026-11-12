# The task board

The task board shows every task the Tasks panel reads, on the stage beside the cards, as a focused board: Waiting on you above the work not yet done in three columns, Backlog, Queued and Working, with the whole backlog, this week's done work, dropped work and older finds in short paged lists.
However many tasks there are, it draws a page of each lane at a time and counts every lane whole, so a busy week never becomes one long scroll.
Its look is the design skill's `components/now/TaskBoard.prompt.md`.

The board is the Tasks panel's card, and the Tasks panel is an ordinary panel folder, `src/panels/now/` (`docs/ui-plugins.md`, "The app's own panels are ordinary folders"): the board is built on the API every panel gets, and no code of the app's names it.
The same folder added from elsewhere does everything below under its own id (`tests/e2e/tasks-from-elsewhere.spec.ts`).

| Piece | Where |
| --- | --- |
| The board's view | `src/panels/now/cards/board.tsx`, its stylesheet `src/panels/now/board.css` |
| What it lists, where, its words, chips, count, pages, earlier matches and arrows | `src/panels/now/boardTiles.ts` (`boardTilesOf`, `boardLaneOf`, `tileWordOf`, `boardChipsOf`, `boardPageOf`, `boardEarlierOf`, `boardNavMove`) |
| What a move does, and a tile's ⋯ menu | `src/panels/now/boardMoves.ts` (`boardMoveOf`, `boardMenuOf`, `dropAskOf`, `moveContextOf`) |
| Picking a tile up with the pointer | `src/panels/now/boardDrag.ts` (`useTileDrag`) |
| The card, its header button and its commands | the folder's `manifest.json`: `cards.board` (`wide`, `fill`), the header's `board` button, and the commands `board`, `board-find`, `board-backlog`, `board-done`, `board-dropped`, `board-move` |
| Queue and unqueue, and their one guard | `inf:task:run`'s `queue-task` and `unqueue-task`, `TaskService.starts.setQueued`, their words in `src/shared/taskQueue.ts` |
| The stage entry and what it keeps | a panel's card (`OpenRecord`'s `{ panelCard }` in `src/renderer/src/app/stack.ts`), its place kept with `card.keep` |
| The summary beside a tile | `src/renderer/src/plugins/point/PeekSummary.tsx`, from the board's `point.peekTask` |

## Opening and hiding

Open task board is an icon button in the Tasks header, between Search tasks and the chevron while the panel is expanded, and beside the collapsed panel's counts while it is collapsed.
A press puts the board up at the front of the stack, or brings the open board forward; focus stays where it was.
Its command, `panel:now/board` (⌘B), and command search do the same and also give the board the keyboard's focus, on its tiles' stop.
There is only ever one board: the card's name, `board`, is its id, so a second press revises the open one.

The board is one of the Tasks panel's cards on the stack (entry id `panel-card:now/board`): it pages with the cards, is never persisted, and is never a card the first mate wrote or a feed line.
The app draws its title row - Tasks and Hide - and the board draws the rest in a page of its own, as any panel's card from the app's own lib: the title row is the app's for every panel's card, where it names who made the panel, and the board's count, chips and Find live in its page, so they sit on the board's own row beneath.
It is a wide card: up to 800 px, giving way to the docks, the docks folding only when the stage is under 560 px; and a card of `fill` height, so it takes the stage's height and its own rows and foot stay while its body scrolls.
Under about 700 px the columns scroll sideways with the rest of the body; text never shrinks.

While it is open the card keeps its project chip, Find, its view, each lane's page, the selected tile and its scroll (`card.keep`), so paging away and back finds it as it was.
The Board's Backlog column keeps its page apart from the Backlog list's, since their pages are five and twenty long.
Hide or Esc closes it and lets go of Find, the view, the pages and the selection: the next board starts fresh on the Board view.
The project chip is the window's project focus, the same as the top bar's pill and the Tasks panel's chip (`docs/project-focus.md`), so Hide keeps it and the next board opens on the focused project.
There is no setting for any of it.

## What it shows

The board reads the same sequenced `tasks.board` the Tasks panel paints.
It reads the whole board, the week's closed rows included, so while it shows the window's lighter first read gives way to the whole one (`docs/task-retention.md`, "A view's first board read").
Each ordinary task appears once, under its own shared group (`nowGroupOf`, `src/shared/nowPanel.ts`), named with the panel's words, in one of its lanes:

- Waiting on you, with "Decisions, not another stage" beside its label.
- Backlog, Queued, Working and Done · 7d; Backlog also counts crew filings the captain has not opened (`· N new`).
- Dropped · 7d: work dropped in the board's seven days, read-only.

Pinned work closed before the seven days is on the board only for the Tasks panel's Pinned (`pinnedPastWeek`, `src/shared/taskPin.ts`): it is in no lane, list or count here, and it brings no old closed parent with it.
Find still reaches it: done work of this kind lists under Earlier matches like any older done work (`boardEarlierOf`).

Answered questions, decisions and operations stay off the board, as they stay off the panel.
Unlike the panel, which keeps a working parent's live tree together in Working (its finished parts stay under Done · 7d), the board shows each task under its own state: a child nests under its parent only when both are in the same lane, and otherwise stands alone with "part of KEY" as its word.
A program occupies one tile in its own lane, with its total parts and finished count; its direct children do not occupy separate tiles unless Find has words.
Find reaches a part by its key or title, and each part keeps its full record.
Ordinary parent/child tasks keep the lane and nesting rules above.
Lanes sort by priority, then oldest first; Done and Dropped newest first.
An empty lane says so in its place ("Nothing queued").
Unstarted list rows name their wait and its recorded time from the shared `queueWait`; kanban tiles use the optional grouped wait projection described below.

Under the app's title row the board has one row of its own: the count of every task in Waiting on you and the four lanes of work, the project chips (All projects, then each project's key, only when two or more projects have tiles), and Find (a task's key or title, for this board alone).
The chip and Find narrow every lane before it is paged, and every count is the whole narrowed lane's, never only the tiles drawn.

### The views

Under that row are the views, a row of buttons: Board, Backlog with its count (and `· N new`), Done · 7d with its count, and Earlier matches with its count only while Find has words.
The pressed one is the view shown; Board opens first.
Every view draws Waiting on you above it, at most three of its tasks as one-line rows, and Show all N when there are more, which opens Waiting on you as a list of its own.

- **Board**: the work not yet done in three columns, Backlog, Queued and Working, five tiles a page.
  Each column shows its range ("6–10 of 12") and Previous and Next in its foot once it has a second page; the Backlog view opens the whole backlog as a list.
  Done · 7d is not a column: its view button, with its count, opens it.
  Five is a page, never a limit on how much work runs.
- **Backlog**, **Done · 7d**, Waiting on you's own list, **Dropped · 7d** (the foot's Dropped · N) and **Earlier matches**: one lane as a list, twenty one-line rows a page - the key, the title and the status - with Previous and Next above the rows and the range with Previous and Next below them, the rows scrolling between while the list has the room.
  A child whose parent is on another page stands alone there as part of it, so paging never hides or repeats a task.
  At either end of a lane, Previous or Next stays, dim, so focus stays on it.

Nothing draws more than a page of a lane: with 60 in the backlog and 300 done this week, the Board draws at most eighteen tiles and a list at most twenty-three.
After a live change a lane's page is clamped to the pages it still has.

### Find and the earlier matches

Find narrows every lane by a task's key or title.
While it has words, it also asks the app for done work from before the board's seven days (`tasks.search`, the panel read), and Earlier matches lists what came back: work only, done only, in the chosen project, matching the key or title, each task once and never one the board already lists, newest first.
These never count toward Done · 7d.
The search answers at most 50; an answer that long may have been cut before the board narrowed it, so the count carries a plus ("12+") and the list asks for narrower words: these are partial results, never a total.
With no answer in five seconds the list says earlier results are unavailable, never that nothing matches.
Blank Find asks for nothing earlier, and Earlier matches goes away.

A tile keeps the shared status mark, task key, dim word, project and two-line title.
Its existing two-line status area holds the lifecycle word, grouped wait names and the earliest recorded event; full recorded-since dates stay on the task card.
Without the optional structured waits it keeps the previous reason and recorded-since presentation.
Pressing Start, or dragging a tile to Working, shows it in Queued at once, labeled Starting, and moves it to Working when its crewmate begins.
A Starting tile in Queued refuses Back to backlog and Start now with "It is starting.".
Dragging a tile to Queued that nothing holds is a Start.
A Start tells the first mate first (`captain-start`, `docs/inbox.md`): it applies the standing directions that bear on the task, then starts it.
Dragging a task that waits to Queued tells the first mate the same way and starts nothing; the ready sweep starts it when its wait ends.
A confirmed failure returns it to Backlog with Could not start, and the Backlog header counts those tasks.
Every start that began no crewmate ends in one place (`TaskStarts.returnStart`), whoever started it: the captain's Start, the ready sweep, or the first mate.
It leaves the task open and never started, so its record always offers Drop task: Could not start in Backlog, which Start tries again, or, when a sign-in refused it, queued behind that sign-in until it is back.
The record says Could not start and its reason in its bar, between Drop task and Try again, never in its title row.
A start the first mate asked for - a spawn, a review or its `start_now` - keeps any working copy the start made for the retry, and the first mate hears that the task is still open (`queued-start-failed` with `open`).
A start behind the first mate's answer queues a backlog task while it starts (`TaskStarts.queueForStart`), so a quit that stops it tells nobody it failed and the next launch's ready sweep starts it, and a wait it ends in starts it when that wait ends; a failure puts it back in Backlog, and once it starts it is back on request (`TaskStarts.keepOnRequest`), as a started backlog task always was.

## A tile is a pointing gesture

A click or Enter opens the tile's or row's task exactly as a Tasks row does (`point.openTask`): its put-aside cards return first, then its waiting decision, deferred required action or newest showable card comes forward, with its record as the fallback.
Resting on a tile, with the pointer or the keyboard's focus, opens the crew summary beside the tile, the same summary and beat as a Tasks row's (`point.peekTask`).
Where neither side of the tile has room, as beside a list's full-width row in a narrow window, the summary sits under the tile or over it (`placeKeySummary`).
The board lets the summary go when the pointer leaves the tile, on a press, on Esc, and when the tile moves or leaves; a scroll of the body or a list that left the tile where the summary was placed keeps it, since Chromium can deliver that scroll a frame after the summary read the tile's place.
The tile focus is on is the selected one, tinted as an open row is; while the board is the shown entry, the selected tile is the turn's hint, as a shown record is (`point.aim`).
A rest also lights the tile's task everywhere else it shows (the lit task, `docs/crew-orbits.md`), and a rest elsewhere lights its tile: the tile takes its hover surface as `data-board-lit`, and nothing about it changes size or moves.
A click, Enter or a rest writes nothing; the moves below are the board's only writes.

## Moves

A tile on the Board moves by dragging it onto a column or the Drop task tray, and any tile or list row by its ⋯ menu; a list's rows are never dragged, so a row of the Backlog list moves by its menu, and nothing is dragged between views.
Each move is one of the panel API's moves (`tasks.run`, the Tasks folder asks for `moves`), which run the record's own path on `inf:task:run` (Start, Drop task, queue and unqueue), or a pointer at the task's card (`point.showCard`); none changes priority, order, project, parent or dependencies (`boardMoveOf`).
A move counts only from the captain's own click or key in the board's page, and lands on the task's record as the captain's, from the task card, as the record's own buttons' moves do: the app's own panels name no panel.

- Backlog, or Back to backlog on the menu, takes never-started work at once: `unqueue-task`, its blockers and holds kept.
  It takes started work at once too, from Working or Back to backlog on a Working tile's menu (INF-2062): its turn stops, its work stays, and nothing wakes it until Start ("A started task in the backlog").
- Queued, or Queue it on a Backlog row's menu, takes never-started work with no parts: `queue-task`, at once while a blocker or hold stands, and after asking once when it could start at once.
- Working, or Start now on a Backlog row's menu, is the record's Start (`start-task`): it asks once, and refuses blocked, held, parent, queued, started and closed work.
  Started work in the backlog is the exception: Start asks once and picks it up again.
- Waiting on you is never a target: only a reachable ready decision puts a task there.
- Done · 7d is not a column on the Board, so it takes no drop.
  Show the card, on a waiting tile's menu, brings the task's waiting card forward, its merge card included; the card's own button merges, the board never does.
- The Drop task tray, in the foot only while a tile is in the air, is the record's Drop task: `drop-task` on never-started work with the effects its record lists (`dropAskOf`, from `tasks.detail`), `stop-task` once started, whichever the row's `moves` allow; it asks once in the record's words and refuses open parts.
- A waiting tile goes nowhere but Drop task; Done and Dropped tiles never move; a drop on a tile's own lane changes nothing.

Queue is an operation for never-started work only; unqueue takes started work as well.
`TaskService.starts.setQueued` is their one guard, at write time: a parent whose parts do the work, closed work, and Queue it on started work are refused as text, and nothing is written.
The start policy is the one field it writes, with one timeline entry in the captain's words and `via: "task-card"`, so the first mate's next context block lists it as it lists the captain's Start and Drop task (`docs/inbox.md`).
A queued task that nothing holds starts on the ready sweep the move runs.

### A started task in the backlog

Back to backlog on started work (INF-2062), from the board, the stall card (INF-3143, `docs/report-sort.md` "Parking an unchanged blocker") or the first mate's `update_task` `start_policy` on-request with a reason, runs `HostOps.moveToBacklog`, which also takes the task's stall card down.
The task stays active: `TaskService.starts.setQueued` records when it went (`backlogSince`, on its running work's row) and who moved it with one sentence why, and its idle ladder starts over.
Its running turn stops and a kept merge approval ends, as an interrupt does; its working copy, branch, conversation, pull request and background jobs stay.
While it waits there, the host's own rows - a job's end, a check's result, a timed wait's end, a closed dependency - wait on its lane, and the first of them in each stay wakes the first mate once (`backlog-news`, `CrewSteer.tellBacklogNews`) to start it or leave it; no rung of the idle ladder nudges, wakes or raises a card for it, a report wakes the first mate only to act on it, to close it or to triage what it filed, and a reopen does not carry its turn on.
Words the captain or the first mate send still reach it, with a line that it waits in the backlog and stays there; that turn carries whatever waited on its lane with it.
Unless the captain moved it there, or the first mate recorded that the captain asked for the wait, it is begun work with no next move: the next-move check tells the first mate once and, if it still stands after that turn, shows the captain one card (`docs/report-sort.md`, "The next-move check").
Start, from the board, the record or `start_now`, takes it out (`TaskService.starts.leaveBacklog`) and delivers what waited, with one line that it left the backlog, in the same conversation.
The board lists it under Backlog, its status "Started", with how long it has waited; `crew_status` lists it with status `backlog`.

A drag works as the Models board's does (`useTileDrag`): a press becomes a drag after 5 px, a ghost of the tile follows the pointer while the tile stays at 40%, Esc lets go and writes nothing, and the body scrolls while the pointer rests near one of its edges.
While a tile is in the air, each lane that takes it is tinted, the one under the pointer has an accent hairline, and one that refuses has a warn hairline, with its reason on the live line.

A move that asks once asks on the tile where it landed: the tile is drawn dashed in its destination column when the view draws that column, else on its own row or tile, its status unchanged, with the sentence, Cancel (focused), then Queue it, Start or Drop task; its lane turns to the page that holds it.
Nothing is written before the confirm; Cancel or Esc puts the tile back.
A live change to the task while it asks cancels the move, and the live line says so; the host checks the row again at write time all the same.
Focus then goes at once to the task where the view draws it now, or else to the row now nearest where it stood, never later to its tile in a view drawn next.

The ⋯ menu, on a tile's hover or focus, offers what a drag does: Open record (`point.openRecord`); Show the card while a decision waits; Continue on interrupted work; Back to backlog on started work; Queue it or Back to backlog and Start now on open work and on started work in the backlog, each with a sub-line saying what it does; Pin or Unpin, at once, which keeps the task at the top of the Tasks panel whatever its state (`tasks.pin`, INF-3127), after the moves so a move keeps its place in the menu; then Drop task, last, in danger (`boardMenuOf`).
An entry that cannot run stays listed, dim, with its reason under it, and each one does exactly what the matching drop does, its confirmation included.

The live line under the foot (`role="status"`) says what each move did or why it was refused.
A Start the host refuses comes back to it as well as to the feed.
Focus follows an accepted move to the tile's new lane when the view draws it, else to the row now nearest where it was, and comes back to the tile after a refusal or a cancel.
An accepted move follows focus at once when its result is already drawn; changing the view or a lane's page forgets a follow still waiting for that result, so it never takes focus later in the place you chose next.
When a live change takes the focused tile away - another surface moved its task, or a page shrank under it - focus goes to the task where the view draws it now, turning its lane's page, or else to the row now nearest its old place, and the live line says where the task went.

## Keys

- ⌘B opens or focuses the board; Find on task board opens it with focus in Find, and Show the backlog, Show done tasks and Show dropped tasks open it on that list with focus on its rows.
  Each puts the same card up with the place in its data (`{ "focus": "find" }`), and the board answers each time it is put up once (`card.revision`), keeping the one it answered with its place, so a board paged back to moves no focus.
- F6 lands on it like any shown card, giving its page focus, and Tab goes through its own row, the views, then the tiles as one stop among the lanes' Show all, Previous and Next, then the foot.
- ↑ ↓ move within a lane and onto its other pages, Home and End to the lane's real first and last task, turning its page and bringing the tile into view; ← → go to the nearest drawn tile in the next column that has one; ↓ from Waiting on you's last row goes to the first column's top, and ↑ from any lane's top back to it (`boardNavMove`).
- Enter opens the tile's task; Space opens its ⋯ menu, where ↑ ↓ move, Enter picks and Esc closes; ↓ in Find goes to the tiles.
- Move the selected task, chosen by name in command search, opens the board with the selected tile's menu open.
- Esc closes the menu or the summary, then lets go of a move that asks, then clears Find, then hides the board: the board's page hears it first, and an Escape it did not use hides the card.
- The board shows each of these commands' current key on its own control that does the same, read from its page's `keys` (`docs/keyboard.md`, "Key hints"): Find on task board's at the empty Find's far end, gone once Find has focus or words; Show the backlog's and Show done tasks' inside Backlog and Done · 7d after their counts; Show dropped tasks' inside Dropped after its count; and Move the selected task's in every tile's ⋯ label, since the command opens the selected tile's menu.
  The Board view has no command of its own, so it names no key; a command with no key shows nothing.

## Tests

- Unit: `src/panels/now/boardTiles.test.ts` (lanes, words, chips, counts, pages, earlier matches and the arrows), `boardMoves.test.ts` (every drop and the menu, on the moves the app's own rule gives each row), `src/core/personal/appPanels.test.ts` (the folder compiles for the frame realm on the panel library alone, its card view as the app lists it, and the lint passes), `src/renderer/src/app/stackActions.test.ts` (a panel card's aim as the turn's hint), `src/renderer/src/plugins/panelCards.test.ts` (a card put up again is one more revision), `src/shared/keymap.test.ts` (keys saved under `tasks.board*` carried over); `src/core/tasks/taskService.graph.test.ts` and `src/core/orchestrator/hostOps.start.test.ts` (queue and unqueue, and a refused Start's text); `src/core/tasks/taskProtocol.detail.test.ts` (the search's limit of 50).
- E2E: `tests/e2e/task-board.spec.ts`, the journey by keys with a decision waiting behind the board, the window coming forward included, `tests/e2e/task-board-moves.spec.ts`, the moves by drag and by menu, `tests/e2e/task-board-pages.spec.ts`, 60 in the backlog and 300 done this week paged and reached by keys, `tests/e2e/key-hints.spec.ts`, the board's controls naming the keys its commands are given, changed and removed in Keyboard settings, and `tests/e2e/tasks-from-elsewhere.spec.ts`, the same folder added from elsewhere under another id running the board's journey by keys, drag and menu.
  Their helpers are `tests/e2e/taskBoard.ts`: they read inside the board's page - a tile, a lane, a view and its count, a lane's pages - take the panel whose card it is, press and drag with events dispatched in that page, and read where focus is from the page's own active element and the window's.
  The keyboard, moves and pages journeys prepare the waiting card behind the board (`stagePrepared`) and complete the window's focus handoff (`windowComesForward`) before driving its keys, asserting that its tile keeps focus.
  Otherwise the first injected key can reach the board's body during that handoff, before the shell gives its tile focus back (`docs/e2e-contracts.md`, "Frame and rail helpers").

Minimized messages use the same presentation-only waiting rows as Tasks (`docs/task-record.md`, "Minimized cards in Tasks").
Its waiting section reads Cards waiting for you; a taskless card has only Show the card in its menu, never task moves or a crew summary.

## Recorded waits

Desktop kanban tiles replace their generic status reason with grouped standing wait names and the earliest recorded event, never a finish estimate.
The Tasks list and board list rows retain their existing presentation.
Kanban columns keep their existing minimum and expand to the recorded event’s intrinsic width, using horizontal scrolling rather than clipping the time or shrinking text.
The task card reconciles every structured wait into its existing header, Checks and blocker or hold explanation, without another Wait section; the hover preview keeps its short status, blocker keys and one-row fact strip (INF-2528).
Checks keeps each named watch and its own next read separate from other runs’ results.
Dependencies retain their keys and recorded-since dates; missing end times stay unknown.
Only recorded events carry clock times: next read, check-back, reset or start time.
Past events say was due, not resumed; Backlog still requires Start.
Older homes without the optional projection retain the previous presentation.
