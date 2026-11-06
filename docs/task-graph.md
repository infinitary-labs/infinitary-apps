# Task graph: parents, links, and the ready query

Task-system phase P2 (design record `fm3000-task-system-design-s1/report.md`, sections 7 to 9).
P0 made a task a durable record, P1 made every captain ask land on one; P2 gives the records structure - one parent per task, typed links between them - and turns the R1 sweep into a query over that structure.

## The graph

- **Hierarchy**: `tasks.parent_id`, one parent per task, and it means *containment* - the child is part of the parent's work.
  A child inherits its parent's project (and its repo unless bound to one of its own); the ancestor walk refuses a cycle at write time (`TaskService.setParent`).
  Only open work that has not started moves to another project, by `update_task`'s `project` or a parent there, and its parts move with it (`TaskService.moveWithin`).
  The moved task takes the repository it lands in - the new parent's on a re-parent, as a new child does, else the project's - so its working copy, pull request, checks and GitHub writes are there; where there is none to take (Scratch, or a parent with none) it keeps its own.
  Each part takes what its parent takes, as a new child does, unless it is bound to a repository of its own, which it keeps.
  The move is refused into a removed project, and into a project whose repository has no remote when a task it would take asks to ship as a pull request.
  A parent may carry a crewmate or be a pure container - a planned row that never dispatches on its own.
  **Discovery is not containment**: a follow-up a crewmate files is never a child of the task it was found on (see "Follow-ups are not children" below).
- **Links** (`task_links`, primary key `(from, to, type)`): `blocks` - `to` is not ready until `from` closes successfully (`done`; dropped never clears).
  A `holds_merge` mark on that edge, set only by a must-merge-first filing or a required action's prerequisite, is what holds `to`'s close while `from` is still live work.
  `related` is informational; `discovered-from` - `from` was found while doing `to`, provenance with no effect on readiness or closing; `replaced-by` - `to` does `from`'s work now (a drop, a takeover or a fresh task), with no effect on readiness or closing either.
  Each link reads on both ends, and the links decide which tasks read another's milestones (`docs/task-record.md`, "Whom an event concerns").
  A `blocks` edge that would close a cycle is refused at insert (`TaskGraphRefusal`, surfaced as tool text): the walk follows `blocks` edges outward from `to` and must not reach `from`.
  Both ordinary insertion and baseline-diagnosis acceptance also call one live-wait reachability guard, normalizing blockers to waiter → prerequisite and reading `standingDependencyWaits` at the current non-green head.
  Only open or active endpoints participate in the mixed traversal; historical diagnoses, green deliveries, closed dependencies and informational links do not.
  A refusal names the complete task-key loop, writes no link or diagnosis, and spends no repair attempt.
  Structural ordinary-link refusal remains in force even for historical links, and dropped blockers retain their existing startup rules.
- **Derived, never stored** (design principle 4): `blocked`, `held`, `ready`, `deadBlocker` come from `TaskService.graph.flagsOf` at read time.

Start again uses the existing `replaced-by` link: the dropped predecessor stays closed, and a fresh task takes its outgoing waits from still-open or active work atomically (`docs/task-record.md`, "Starting dropped work again").
**A wait follows moved work** (INF-1826).
Writing a `replaced-by` link from A to B moves the live waits in the same write (`TaskService.moveWaits`, called from the one link writer): each open or active task A blocks now waits on B, and each `blocks` edge into A from open or active work now runs into B, keeping its merge mark and its `createdAt`.
A link between A and B, a closed waiter, done or dropped work A waited on, the host's delivery machinery (a review), and a wait whose move would close a cycle stay where they are, and so does a baseline wait on a delivery record, which is not a link.
The `unlinked` event the move writes on the waiter carries `movedTo`, which the idle ladder reads to name the work a carrier took over.
The first mate links `replaced-by` on every move of work to another task (`link_tasks`'s description), and `update_task`'s `replaced_by` and Start again write the same link.
Nothing moves back when the link is removed.
Closed dependents keep their historical edges.
A second restart of the same record refuses once a replacement or stronger-model retry exists; a task with any parts refuses too.
The successor inherits the predecessor's parent only while that parent is still live, and its basis still means a specification.

## The ready query

`TaskStore.listReady()` is the sweep's dispatch list: open work, no gate, `start_policy = when-ready`, no `blocks` edge from a task that is not `done`; priority first, then age.
`CrewWatch.sweepGates` runs it on the shared 60 s tick, after any close (`closeTask` sweeps), after any graph change (`graphChanged`), on quota refresh, and once at boot.
The quit (`CrewSupervisor.disposeAll`) runs no new sweep and starts nothing, a start still waiting before its claim included, and it waits, at most `QUIT_SETTLE_MS`, for a sweep already running to end, so a host closes its database only after the sweep's last write; the next launch's sweep starts what the quit left.
On-request rows never appear in it; a captain-held row waits on its card.

## Gates on active rows

The gate is one hold, read by every reader of "is this task moving, and whose turn is it" (the primitives review's P2, captain-approved 2026-09-26).
It holds an **active** row as it holds an open one: `flagsOf` and the board's view both report `held` whenever `gate` is set, and the board's `needsYou` counts a `captain` gate whose ref is a durable open card.
`waitingCardId` is separate: only an eligible shown ready decision, not the gate itself (`docs/task-record.md`, "Ready waiting is a presentation projection").
On an active work row the `captain` gate is written in one place, `IdleLadder.syncCaptainGate` (`src/core/orchestrator/idleLadder.ts`), from a card with actions up on it (the one the gate already names while it stays up, else the newest), or a wait on the captain its crewmate declared.
Every card placement and departure, cap and answer runs it; a change on an idle record restarts its idle clock (`docs/report-sort.md`).
These writes are machinery: no timeline event of their own - the card and cap events already say what happened.

An `at-time` gate on an active row is a timed wait.
The sweep's active branch walks `listActive()`: it heals each work row's captain gate, and a due `at-time` gate is cleared into **one steer on the task's own lane** - the idle ladder's steer path, actor `supervisor` (`timedWaitOver`, worded by `renderWake`) - never a dispatch.
A wait on another task ends the same way when that task closes: one `dependency-closed` steer per closed task, once (`docs/report-sort.md`, "A wait on work underway moves on its own").
A baseline wait also resumes sooner, when the default branch's own run of the check it names passes (`docs/forge.md`, "A main failure's wake").
A wait the first mate recorded can end sooner: a report from the task it waits on wakes the first mate, which passes on a finding the waiter was held for and removes the link (`docs/report-sort.md`, "A hold on a task's finding ends when that task reports it").
The wait's end opens a new idle episode, so the turn it starts is the task's own.
Its one writer on an active row is a crewmate's report that names `check_back` (`TaskService.turns.recordReport`, `docs/report-sort.md` "A check-back on a running job"); the next turn's start clears it with the rest of that report's declaration.
A crewmate declares a wait with `waiting_on_captain` (`docs/report-sort.md`); the host does not parse a free-text wait.

A host card with actions and no task files an open `operation` row, `captain` gate ref = the card id (`TaskService.capture.fileHostCardTask`), so the host's own asks count as waiting on the captain while their shown decisions are ready, like every other card.
An explicit choice closes the row `done/answered`; host withdrawal records `dropped/superseded`, and a recorded terminal dismissal records `dropped/cancelled`, with no feed line (host bookkeeping).
The minus is not a terminal dismissal: it keeps the host card, its operation row and its captain gate open without choosing or declining.
The sweep closes a row whose card is gone and files one for a host card that has none, as it does for first mate decision rows (`openCardTaskFor` finds either).

A row whose blocker was **dropped** is a wait that cannot end: `listDeadBlocked` feeds one `[fm-op]` wake to the first mate (`wakeDeadGate`, cards/tasks/agents P0), deduped by content on the task's ref so the tick never nags, and the row stays as it is - no card, no hold.
The first mate's own tools are the ways out: `link_tasks remove` the dead edge (the sweep then starts it), `update_task drop` it too, or leave it waiting.
`update_task start_now` refuses while the dead edge stands, because the wait is the edge.

## Follow-ups are not children

A follow-up is not a child.
`fileFollowup` sets **no `parentId`** (it passes `projectId` instead, keeping the origin's project and repo) and the `discovered-from` edge carries the whole relationship.
The one way a follow-up holds its origin up is `blocks_me`, which adds a `blocks` edge and says so in the refusal.
While nobody has started it, every report from the origin wakes the first mate and names it (`docs/report-sort.md`, row 2a).
Migration 26 detaches the redundant parent edge from every live row whose parent is also its discovered-from origin, recording each in `followup_parent_backfill`; `blocks` edges are untouched, and closed rows keep their history.

A detached follow-up must stay findable, so its origin is shown wherever the parent used to place it: `found on SCR-1` in the context-block index (`indexGraphNote`), `discovered_from` and `follow_ups` on a `tasks` row, and rows under the settle card's strip, labelled "Filed while working on this", one per open follow-up with its key, title and one word (must merge first, starts once this merges, working, queued, backlog) chosen from the links, status and start policy, never the title (`followupNotice`) - the one moment those follow-ups bear on the decision to land.

## The close rules

A parent closes only when every child is closed (`TaskService.graph.closeRefusal` names the open children by key) - except delivery machinery: a child the HOST commissioned as part of delivering its parent (a `host:*` kind_source: the independent review, and the independent assessment of a kept merge's undecided repair; `TaskService.isDeliveryChild`) carries no intent of its own, so it never holds the parent's close, keeps the parent the host gave it (`setParent` refuses), and is retired by the supervisor whenever the parent closes, in any direction (`docs/delivery-rigor.md`, the reviewed sequence).
The parent edge is the only stored review-to-builder join: which review a builder's verdict came from is read off it (`TaskService.graph.verdictReviewOf`), never cached on the builder.
The host records no `blocks` edge from a review onto its builder (INF-1876): whether a merge waits for the verdict is the care runbook's guidance, and the edge an earlier release recorded is removed at the upgrade (`docs/saved-data-compatibility.md`, "The review's edge").
A task also does not close while something it waits on is still live work - open or active (`TaskService.graph.blockerRefusal`, over `blockersHoldingClose`): that is what `blocks_me` promises, and blocks edges otherwise gate dispatch alone, which says nothing about work already under way.
That wait is a soft hold (`waits`): the captain's recorded override passes it, and a close refused on it says so (`docs/delivery-rigor.md`, "The holds").
A **dropped** blocker clears a close, and only a close - for readiness it is a wait that can never end and the first mate answers the dead-gate wake, but that wake names open rows only, so an active task held by a dropped blocker would strand with no way out.
A `discard` abandons the work rather than completing it, so a wait never forbids it; only containment does (`closeGateRefusal`, `settleRefusals.ts`).
A crewmate's merge card is refused at emit time while that same rule would refuse the click (`CrewmateCards.addCrewmateCard`; open children stay a click-time choice because the captain can override them).
The `link_tasks` description says a blocks link holds the start, and says nothing about a merge.
It says `related` is for work neither task is waiting on.
The first mate records a practical wait as `blocks` that turn, even when it is not a strict prerequisite, so Tasks draws the arrow.
A click refused by a promised hold reads in plain words on the feed (captain, 2026-10-01: a second Merge click was needed after a tracking-only wait).
Because a marked edge gates closing, `flagsOf` reports `blocked` for **active** rows too: the task a `blocks_me` follow-up is filed against is exactly the one a crewmate is holding, and it must say it is held rather than look free until the merge refuses.

A task whose deliverable is an answer closes on a third path (captain F2 A): the captain's choice on its own crewmate's card closes the row `done/answered`, and `merge-pr` and `land` are refused on it outright, because it ships nothing.
A card its crewmate declared `continues`, something it goes on from such as a consent, a card asking to send a kept write and a card handing the captain the task's browser (`browser_handoff`, INF-1322) are not that card: their choice reaches the crewmate and the row stays active (INF-1226, `docs/card-authoring.md` "An answer task's card is its deliverable").
A choice made while the crewmate is still working outranks the cancel of that turn (INF-721): the close stops the turn, and that turn's end, before or after the close, neither relabels the row nor drops the `answer-closed` wake the first mate is owed (`CrewSessions.stopRuntime` marks the runtime settling, and `finish` leaves the record to the close).
The captain's close control is not a choice and never ends work: it puts a decision or pending card aside, or reads an ordinary note.
An ordinary note read acknowledges its message and reaches its crewmate through `card-closed`; a duplicate closure also reaches the author, but is not an ordinary-read acknowledgement.
Putting a card aside or reading a marked saved answer sends no author wake and does not acknowledge that saved answer.
Only explicit Done receipts the marked saved answer (`CardService.finishAnswer`, `answer-done`); for an answer deliverable, it closes the row `done/answered` without a `card-closed` wake.
After an ordinary read, the crewmate reports `finished` if nothing remains, and the first mate can close the answer row with `settle_task answered`; the read itself never closes it.
The row lists under the now panel's `landed` group like any other closed work and reads `answered`.

Whether an answer task is an internal step (captain's call C, 2026-09-24: "intelligent judgments ... handled mostly through instructions") of a sequence the first mate runs, or something the captain asked for personally, is the first mate's judgment: it declares a step when it creates it (`internal_step` on `spawn_crewmate` or `create_task`, stored on the shape), and the host infers nothing - no rule reads the parent, the kind or the words.
Absent is the captain's own ask, which is also every row from before the field.
`settle_task` mode `answered` lets the first mate close an IDLE answer task it declared a step `done/answered` once a planned or started task names it as its `basis` - its answer carries on in that task's brief (`DeclaredCloses.closeAnswerUsedAsBasis`).
It closes a step the same way when a live task waits on it through a `blocks` link (FI3-422): the step was run for that task, and its close as done is what clears the wait, so a finished check never holds that task's merge or has to be discarded; a task naming it as its basis comes first.
The feed says where it went ("KEY answered: its answer carries on in KEY \"title\""), never "discarded".
A step whose crewmate reported its answer closes the same way when nothing builds on it or waits on it (INF-1137): the first mate passed the answer on itself, as by a steer to a task already under way, and the feed reads "Answered: its crewmate reported the answer", so a finished investigation is never announced as dropped.
The same mode closes an answer the captain asked for once its crewmate's report declared it finished (`delivery.finishedAt`, FI3-435), with nothing built on it required.
A verified file delivery through `steer_crewmate files_from`, or a plain result choice on the crewmate's card, records a durable result-handoff receipt (INF-1426).
`settle_task answered` also closes a reported, idle task with that receipt, without requiring `internal_step` or an answer deliverable.
The first mate judges whether the result completes the task; the receipt proves only that it was handed on.
Consent, browser handoffs, continuing cards, invalid actions and dismissals record no result receipt.
A task with a proposed change, uncommitted edits, unmerged commits, an unreadable working copy, outstanding work or guidance, or open children or dependencies cannot use this path to bypass delivery.
It is refused, as text, on anything neither declared a step nor declared finished nor holding a result receipt, on a change without that receipt, one still working or never run, a step that reported nothing and no live task builds on or waits on, one whose own answer card is still up, and one whose first mate card still asks the captain something, because the close would take that question down.
A first mate note on the task stays on the stack through the close, the same as a crewmate's note, until the captain closes it.
Discard, cancel and `update_task drop` keep their own closes.

A **container completes with its children**.
A parent that never started - on request, no crewmate, no working copy, no card of its own open - has nothing of its own to settle, so the ready sweep closes it.
Once every child is closed, the ready sweep (`TaskIntake.completeContainers`, which runs after any close) closes it through `TaskService` as the host: `done/finished` when at least one child is done, else `dropped/cancelled`, with one feed line ("KEY done: everything under it is finished", or "stopped: nothing under it went ahead").
A parent that carries a crewmate, ever started, or still has an open child is never touched, and `closeRefusal` is unchanged.

`settle_task` in every mode and every settle through `SettleService.settleTask` check these first.
An externally delivered work task may close `done/released` only through an explicit `settle_task released` with a specific verified release named in `release_evidence`; it needs an idle reported change task, none of its own pull requests reading open or unreadable, and a successfully inspected working copy with no uncommitted edits.
A pull request of its own closed without merging, or commits only history calls unmerged, such as a squash merge's originals, do not refuse it: the close keeps those commits on the task's kept ref (INF-2628).
The release evidence is recorded in its close event.
Ordinary work declared `in_folder` closes `done/finished` through `settle_task finished` after the first mate verifies its reported result and supplies `completion_evidence` (INF-1279).
`DeclaredCloses.closeFinishedFolderWork` records the declaration through the existing close owner without inspecting or changing the project folder, preserving edits, staged work, stashes and unpushed commits.
Only an idle, reported change task with no task-owned working copy, branch or proposed change qualifies; outstanding jobs, guidance, check-backs, captain waits, questions, pending settles and the child or dependency holds refuse the close.
The host checks these typed facts, never the meaning of the evidence; verification remains the first mate's judgment, not a publication-specific state or a substitute for merging.
A missing proposed change, a note dismissal or an unverified assertion never closes work; the host does not infer delivery from either.
Each close refusal is a structured `SettleRefusal` (`{ refused, task, tasks, ways, text }`, cards/tasks/agents P2 WI-12): the tool returns its `.text`, and the ways out ride the settle wake as a fenced JSON block the first mate carries as effect buttons - a merge that keeps a task's open children planned is `settle_task` with `proceed_with_open`.
`update_task drop` on a parent with open children needs `confirm`, which drops the open descendants as `superseded` (deepest first) and then the parent as `cancelled`; work a crewmate holds (an `active` row, idle included) is never dropped from a field edit - that stays with settle_task and its unlanded-work guard.
Host closes (a failed turn, a cancel) are unguarded by design: a record must always be able to record what happened to it.

## Tools

The first mate (`src/core/pi/taskTools.ts`): `create_task` (plan without starting by default: the intent - goal, the user's words, and the same `constraints` and `delivery_note` `spawn_crewmate` takes, one shared schema, so a planned step's brief prints a free constraint verbatim under the user's words - `parent`, `blocked_by`, `start_policy` defaulting to on-request, `priority`, and `basis` - the same fact `spawn_crewmate` carries, recorded as named, a `basis` relationship (`docs/task-record.md`, "Relationships"), its verdict derived at every read and never stored, since the task it names is usually still running when the step is planned; `docs/task-record.md`), `update_task` (`start_again` on the captain's request to replace dropped work and start it, returning the new key; otherwise title, goal, priority, start_policy, parent, project for open workspace-less work, `override_model_id` - the model the captain named for a filed task, which keeps its key and links and starts on it with `start_now` in the same call (contract v4.46, FI3-436), and on started work moves the task there between turns (INF-849, `docs/task-record.md` "Moving a started task to another provider") - `runs_on`, where the captain said a task that has not started runs (`docs/helper.md`, "A task's own Runs on"), `withdraw_merge`, the captain taking back a merge the captain clicked, which keeps the work and holds its merge for the captain's next click (contract v4.67, `docs/delivery-rigor.md` "A kept merge approval"), `override`, the soft holds the captain's words in this turn pass and for how long, which the host refuses in a turn without the captain's words (`docs/delivery-rigor.md`, "The holds"), or `drop` with `reason`, `confirm` and `replaced_by`, the task that does the dropped one's work, which writes a `replaced-by` link before the close), `link_tasks` (`from`, `to`, `type`, `remove`), and `tasks` (the query: project, status, key, text, parent).
The first mate's `create_task` and `update_task` calls setting `start_policy: "when-ready"` must declare `blocked_by` in that same call; `[]` explicitly declares none.
An omitted list is undeclared, not independent: either tool returns the same typed refusal before any write or combined `start_now`.
Creation records its declared prerequisites atomically with the new row.
An update adds each declared prerequisite that is not linked yet, in the same step as its field edits, and never compares the list with the current links or removes one.
Ids and keys name the same task, and duplicate references count once.
A cycle refuses the whole update, so its field edits and the new link do not remain.
An already linked prerequisite is left as it is, including one whose task has closed.
`link_tasks` remains the way to remove a wait.
Removing `blocks` also clears standing baseline diagnosis references from the waiting task to that owner, even when no graph edge exists; the check failure and diagnosis evidence remain recorded.
On-request creation and updates still need no declaration, so the first mate can file related work safely, add its links, read back the graph, then start ready work within the captain's authorization.
This is a generic input requirement, not a rule over plans, titles, parents or sequence labels; automatic scheduling and explicit independent work otherwise behave as before.
`spawn_crewmate` gained `parent`, `blocked_by`, and `priority`; `after_task` stays as an alias of `blocked_by`.
`spawn_crewmate`, `create_task` and `update_task` take `result_schema`, the JSON Schema a task's report `result` must fit, and `branch_from`, the task whose last commit its working copy starts at; the schema lives on the shape and `branch_from` is a `branch-source` relationship, both change only before the task starts, and are refused as tool text when they do not hold (`docs/task-record.md`, "A typed result and where a working copy starts").
A parent still says only what a task is part of and moves no code; `branch_from` is the one relation that moves code, and the task it names is a sibling, never the parent.
Every write attaches the turn's ask to the task it acts on (P1's attach-first).
The prompt's class 4 is "spawn or plan"; the C5 dispatch extractor sorts `create_task` with spawn, the graph edits with operate, and `tasks` with the reads.

Crewmates (`src/core/pi/crewmateTaskTools.ts`, the same pair over Claude's tool server in `src/core/claude/claudeTaskTools.ts`): `file_followup` (title, goal, why, `blocks_me`, and for a test failure `test_failure` plus `test_path`) files an on-request task of its own - never a child - joined to the crewmate's task by a `discovered-from` edge and placed in its project and repo, and the first mate hears one `[fm-op]` that names the key, whether it holds the origin up, and the choices.
The host stores `test_path` and answers with the existing key instead of filing a second open or active row for the same path; a test failure with no path is refused.
A test that fails outside the crewmate's change is a follow-up only when it also fails on the untouched main line, otherwise one line in the report.
A report's `waits_on` records an existing open task its work cannot go on without as a `blocks` link that holds no merge, on the task carrying its work when a `replaced-by` link moved it (`TaskService.graph.carrierOf`), refusing an unknown, closed, own or circular key (`TaskService.graph.linkWaits`; `docs/report-sort.md`, "A wait on work nobody has started is the first mate's turn").
`note_progress` writes one `progress` event on the crewmate's own timeline with `feed = 0`.
Both register through `CrewmateSpec.onFollowup` / `onProgress`.

The quiet ledger (FI3-152, direction A) is how the captain hears about those filings without a card.
Charted's header counts crew-filed rows not yet opened (`captain_opened_at`; opening the record clears it).
The row's word is `found on <origin key>`.
The record card shows the filing's why and the first mate's `verdict` (one line, `update_task verdict` when leaving it planned).
Hide removes the shown record entry from the stack, without dropping the task.
Drop task on never-started work drops that one record as cancelled ("No longer wanted", captain-attributed) and refuses while any part is still open (on started work the same button is the captain's cancel, `stop-task`, which keeps a copy of the unfinished work); `update_task drop` is unchanged and still cascades open children when confirmed.
`verify.yml`'s lanes run their gate from a path with a space, the path every crewmate works under.

The retired supervision session held the read-only `tasks` query beside `crew_status`, so a wake about a task could see its parent, blockers and follow-ups; it wrote nothing on the graph, and S7c retired both it and those tools (`docs/report-sort.md`).
Every crewmate still holds the same read-only query.

## What gets filed, and what closes it

Filing is selective (FI3-868, the captain's choice on FI3-845's backlog assessment).
What counts is a judgment, so it lives in the crewmate's and the first mate's instructions alone; the host files whatever a crewmate files.

- A crewmate files a concrete defect it can show on the current main line, or a credible risk to the person's data, accounts, signing material or merges.
  Its `why` gives the evidence, what the finding breaks and for whom, and what the crewmate is unsure of.
- An optional improvement - a refactor, a test that would only add assurance, a nicer wording - stays in the crewmate's report, unfiled.
- Work the crewmate's own change needs, and the documents it makes stale, stay with that change.
  The rest of its own work that must wait for a merge is not filed: it is listed as after-merge steps on the change's story, below.
- A finding that matches an existing task is not filed: the report names that key and what the finding adds to it.
- A change that meets another open task's whole goal names that key and the evidence in its report.

On the report the first mate triages each filing.
A repeat is dropped as covered (`update_task drop`, its reason naming the covering key) once anything it adds is in the kept task's goal.
The rest start when ready, are dropped, or stay planned at the priority they deserve, with a verdict saying what waiting costs and who pays it, and what would start them.
Optional ideas reach the captain only when they merit the captain's choice: together, in one decision card after the report that names them, and only the ones the captain picks become tasks.

When a report says its change covers open tasks nobody started, the first mate links each to wait on the reporting task (`link_tasks blocks`) and leaves it on request.
A captain's merge that goes through wakes the first mate only when it frees open work that only a start begins (`settled`, `docs/inbox.md`), so such a covered task brings the first mate back once the merge is in, as the first mate's own `settle_task` result does.
It then drops a covered task only when the merge met its whole goal, removing that task's `blocks` links first so nothing is left waiting on a dropped row.
Partial or unsure ones stay, with a verdict; nothing cascades into children, and started work is never dropped this way.

Nothing is dropped by age, and no queue, timer, expiry or count decides what stays.
At a release cut the first mate re-verifies crew-filed rows older than the last release against the main line before a drop (`docs/alpha.md`, "Activating the channels").
The review names each key it checked, that key's fate, and the keys left unchecked; a row not re-verified stays.

## Current blockers in the task panel and record

The board/detail `blockedBy` list names only the waits that hold the task now, by one rule the board and the crew's tasks reader share (`holdingWaits`, INF-999).
On open work that is every live (open or active) blocker.
On active work it is a live blocker whose edge holds its merge, unless the captain's words passed that hold (the recorded override, `overridePasses`); a recorded wait only while its crewmate stands idle on its waits (posture idle, reason `dependency`), so the arrow still draws while it waits; and the live work a standing baseline wait names.
A crewmate working past a recorded wait is not blocked by it, and a merge hold the captain released reads as released.
Close refusals, the active blocked flag and the context's “cannot land until” line read only the marked edges (`blockersHoldingClose`).
Done, dropped and discarded work stays in graph/timeline history, not in the record's “Waiting on” banner or “Waits on” facts.
With no live blockers, that banner disappears.
The baseline wait (FI3-250) holds no edge to its close, but the task waits on that work all the same.
The tasks reader's open rows also name a dropped blocker, so the agent can resolve it.

This is not a change to the start policy: a dropped edge still prevents an open task from dispatching until the first mate resolves it.
Such a record says it needs attention rather than claiming closed work is still underway, and Start stays disabled without naming the closed task as a live blocker.
The ready query, dead-gate wake, agent wait explanations and historical feed lines retain the dropped-edge information.
Closed blockers do not hold an active task's close.

## Context block

Index rows carry the graph in a few words: `[under SCR-1; blocked by SCR-3]`, `[found on SCR-1; on request]`, `[cannot land until SCR-4]` for active work, `blocked by X (dropped)`.
`crew_status` says `starts on request` for a planned row.

Task refs in tool text are keys; ids stay the join column.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The task graph (R1 on the record; task-system P2, `docs/task-graph.md`): `open` rows wait on a gate (`quota-reset | at-time | captain`), on `blocks` links, or on request (`start_policy`).
  The R1 sweep IS the ready query now (`TaskStore.listReady`: open work, unheld, when-ready, every blocker `done`; on-request rows never dispatch on their own) and runs on the tick, after ANY close, after any graph change, on quota refresh, and at boot.
  One parent per task (`parent_id`; a child inherits the project, the ancestor walk refuses cycles) and three link types; a `blocks` edge that would close a cycle is refused at insert as `TaskGraphRefusal`, which every tool returns as text - never let it become a thrown tool error or a silent no-op.
  A dropped blocker is a dead wait: one deduped `[fm-op]` wake to the first mate (`wakeDeadGate`), no card and no hold; `link_tasks remove` on the dead edge lets the sweep start it, `update_task drop` drops it too, and `update_task start_now` refuses while the edge stands.
  That refusal marks a dropped blocker and names its dead edge to remove with `link_tasks remove`; it never suggests dropping a blocker, because a dropped blocker's edge still blocks (`startWaitRefusal`).
  The parent close rule (`closeRefusal`) guards settle/land/merge and `update_task drop` (confirm cascades open children as superseded); host closes stay unguarded.
  Crewmate follow-ups (`file_followup`) are on-request rows with a `discovered-from` edge and a feed line, and the filing itself sends no wake: the report names what the turn filed (`filedThisTurn`).
  While nobody has started a follow-up that holds the origin, a later report from the origin wakes the first mate and names it (`docs/report-sort.md`, row 2a).
  Every crewmate (Pi and Claude) holds the read-only `tasks` query to search first (cards/tasks/agents P0, WI-4); `note_progress` is a `feed=0` timeline event.
  A first mate decision row (`kind=decision`, gate ref = card id) lives exactly as long as its card is on the stack, and the sweep closes one whose card is gone.
  There is no automatic Later and no park (cards/tasks/agents P0, captain rulings D1-D8 of 2026-09-15): a card carries exactly the actions its author declared, every click returns to the author, `recall_decision` is gone, and migration 28 closed every open park row into `park_row_backfill`.
  Open rows have no worktree ("" columns) until dispatch; `closeTask` must keep skipping workspace removal for them.

### After-merge steps

The rest of the origin's work after its own change merges is declared, never filed during the work: the change's saved story may list `afterMerge` steps (`src/shared/afterMerge.ts`), each a new task's title, goal and why, or the key of an existing open task that has not started (`task`).
A new step may name the project it is filed in by key (`project`), the origin's when absent, and any step may name the tasks whose merge it also waits for (`blockedBy`).
Preparing the story refuses a step whose shape is incomplete, a named task that is running, closed, unknown or the origin itself, a named task already set to start on its own unless it waits on the origin, an unknown or archived project, and a wait on an unknown task, on the origin, or one that would close a cycle (`TaskDeliveries.afterMergeRefusal`).
The list is optional, and a story without one merges exactly as before (INF-2796, the captain's "a merge can totally end without anything to continue").
The merge card draws the steps under "After merging, the crew starts", beside the captain's own required actions, from the story the card shows: an existing task by its key, title and goal, read when the card is shown, and a waiting step with a line naming what it waits for (`TaskDeliveries.afterMergeShown`).
A merged or landed close files each new step in its own transaction (`TaskDeliveries.activateAfterMergeSteps`, beside `activateRequiredActions`) as a `when-ready` task titled `Continue: …`, discovered from the origin, and sets each named existing task `when-ready` with a note saying why.
Each `blockedBy` key becomes a `blocks` link from that task into the step, so the step starts only once that work merges too; a wait that would close a cycle by the time of the merge is skipped with a note on the step, so the merge is still recorded.
The card leaves out a wait on work already closed.
A named task that started or closed between the card and the merge is left as it is, and the settled wake says it started nothing for a closed one, so the first mate decides whether its work still needs a task.
Its id is derived from the story's change, revision and the step's place, so a restart or a second activation files nothing twice.
The ready sweep after the close starts each step nothing else holds; the discovered-from link gives its brief the origin's report, card and thread.
A discard, refusal or unknown merge closes nothing as merged, so it files nothing.
The settled wake names the filed steps once, and so does the first mate's own `settle_task` result, so the first mate can drop a step another task already covers.

A `Continue: …` filing made during the work, as older instructions asked, is still the rest of the origin's work, not a dependency holding the origin.
The first mate sets the `blocks` edge **from origin to continuation** before setting the filing `when-ready` in the same turn: the sweep runs after each graph change, so reversing this order can start it too early.
A missed triage leaves an ordinary visible on-request filing.

## Combining repairs after a circular-wait refusal

The crewmate reports the full task-key loop to the first mate rather than declaring another wait or retrying the refusal.
The first mate chooses one existing repair owner and combines necessary patches with attribution, keeping existing permissions and repair records.
It removes only waits made obsolete by that consolidation, has the owner verify the combined version including every failed check, and reconciles other tasks only after merge.
The host refuses loops but never chooses an owner or stores another wait type.

## Captain-owned required actions

Required actions use durable operation records distinct from card-only operations (`docs/required-actions.md`).
They remain captain-owned after their cards close, and prerequisites use ordinary blocks links.
Their sources are related links, never blocking children of a code task.
