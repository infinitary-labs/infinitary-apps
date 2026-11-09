# Tasks and their relationships

A task is the durable record of one piece of work: who owns it, what it waits on, what it is part of, and how it was handed on and closed.

## Intended use

Record every piece of work the fleet does, the captain's ask that led to it, and its outcome, on one row with a timeline that explains every change.
Express ownership with the parent edge (containment), ordering with `blocks` links, provenance with `discovered-from` and `replaced-by`, and hand-off with a basis, a typed result and `branch_from`.
Build a guided way of working, a multi-step plan, a fan-out or a continuation by arranging parent and child tasks on this graph.
A task is a record, never a handle (`docs/task-record.md`): code reads and writes its facts through the owner and never holds a task as a live object that does work.

## When to use it, and when not

Use a task whenever work is to be owned, waited on, handed on, or shown to the captain as something under way or done.
Do not build a workflow engine, a step runner, a stage column or a feature-named stamp to move work through steps.
A guided way of working is a parent task with child tasks on the task graph the app already has, not its own runner, stamp, or card effect, and the host never learns the feature's name ([principles](../docs/principles.md), "Reuse the primitives you already have").
Sequences are guidance, never a runner; never add a host rule that knows the word "sequence" (`docs/sequences.md`).
Do not add a second queue, timer or scheduler to start work later: the ready query, `start_policy` and gates already decide when a task starts.
Do not make a follow-up a child of the task it was found on: discovery is not containment, so use `discovered-from` (`file_followup`).
Do not invent a new link type for a dependency: a wait is `blocks`, and a must-merge-first wait is the `holds_merge` mark on that edge.
When a script should decide the steps (a loop, a fan-out, retries), use a program ([programs.md](programs.md)), which files its parts as ordinary child tasks.

## Owner and entry points

One writer each: `TaskService` over the task tables (`docs/task-record.md`).
`TaskService` ([`../src/core/tasks/taskService.ts`](../src/core/tasks/taskService.ts)) is the one writer over `tasks`, `task_events`, `task_links`, `task_references`, `task_sessions`, `task_session_observations`, `task_execution`, `task_policies`, `task_delivery_evidence`, `task_permissions`, `changes`, `change_versions` and `captain_asks`, the immutable specifications and typed shape records described in the task-record manual, and every change commits with the timeline event that explains it.
Every write goes through one `TaskWriter` ([`../src/core/tasks/taskWriter.ts`](../src/core/tasks/taskWriter.ts)), whose outermost transaction moves the board's seq and tells listeners after the commit; the timeline's fold of old events is [`../src/core/tasks/timelineCompaction.ts`](../src/core/tasks/timelineCompaction.ts).
Beside its own record writes, the service reaches seven parts over that writer, each in its own file: `tasks.graph` (links, waits and derived reads, `taskGraph.ts`), `tasks.capture` (asks, cards and origins, `taskCapture.ts`), `tasks.starts` (dispatch, start attempts and the backlog, `taskStarts.ts`), `tasks.placement` (where work runs, its gate and moves, `taskPlacement.ts`), `tasks.delivery` (change evidence, required actions and write asks, `taskDeliveries.ts`), `tasks.turns` (reports, steers and idle, `taskTurns.ts`) and `tasks.archive` (conversations, recorded references, import and purge, `taskArchive.ts`).
`TaskStore` ([`../src/core/storage/taskStore.ts`](../src/core/storage/taskStore.ts)) sits beneath it; `TaskStore.listReady` is the ready query.
Conversation associations: `turns.setSessionFile` writes the resume pointer and conversation row together; by-key `tasks` reads list recorded conversations and retained older files, and name an earlier stronger-model attempt without copying its sessions ([task record](../docs/task-record.md), "Conversations on a task").
Graph writes: `create`, `setParent`, `moveToProject`, `fileFollowup`, `updateFields`, `close` and `dropWithChildren` on the service, with `graph.link`, `graph.unlink`, `starts.startAgain` and `placement.setGate`.
Derived reads, all on `graph`: `flagsOf` (`blocked`, `held`, `ready`, `deadBlocker`), `basisHolds` / `basisOf`, `builtOn`, `verdictReviewOf`, `closeRefusal`, `blockersHoldingClose`, `blockerRefusal`.
Typed results: `resultSchemaRefusal` and `resultRefusal` in [`../src/core/tasks/taskResult.ts`](../src/core/tasks/taskResult.ts).
Reports and results as entries: `reportEntryOf` and `latestResultOf` in [`../src/core/tasks/reportEntry.ts`](../src/core/tasks/reportEntry.ts); one task's entries from every owner, read only: `TaskTimeline` in [`../src/core/tasks/taskTimeline.ts`](../src/core/tasks/taskTimeline.ts), its shape in [`../src/shared/timeline.ts`](../src/shared/timeline.ts).
Settling and its refusals: the settle owners `createSettleOwners` composes ([`../src/core/orchestrator/settleOwners.ts`](../src/core/orchestrator/settleOwners.ts)) - land, merge-pr and discard in `SettleService` ([`../src/core/orchestrator/settleService.ts`](../src/core/orchestrator/settleService.ts)), a task's close in `TaskClosing` ([`../src/core/orchestrator/taskClose.ts`](../src/core/orchestrator/taskClose.ts)), the kept merge approval in `KeptApproval` and `KeptMerge`, the first mate's declared closes in `DeclaredCloses` - each returning a structured `SettleRefusal` built in [`../src/core/orchestrator/settleRefusals.ts`](../src/core/orchestrator/settleRefusals.ts).
Agent tools: the first mate's `create_task`, `update_task`, `link_tasks` and `tasks` in [`../src/core/pi/taskTools.ts`](../src/core/pi/taskTools.ts); the crewmate's `file_followup`, `note_progress`, `revise_required_action` and read-only `tasks` in [`../src/core/pi/crewmateTaskTools.ts`](../src/core/pi/crewmateTaskTools.ts) and [`../src/core/claude/claudeTaskTools.ts`](../src/core/claude/claudeTaskTools.ts).

## Operations and lifecycle

Status is `open | active | done | dropped`, with `activity` and `closed_reason` beside it; settling closes a row, it never deletes it.
An open row waits on a gate (`quota-reset | at-time | captain`), on `blocks` links, or on request (`start_policy`).
The ready query is the dispatch list: open work, no gate, `when-ready`, every blocker `done`; on-request rows never dispatch on their own.
An active work row may wait in the backlog too (INF-2062): `backlog_since` on its running work (`TaskService.starts.setQueued`, `leaveBacklog`) keeps its work while nothing the host sends wakes it, and the idle ladder and the sort read it as the witness `inBacklog` ([task board](../docs/task-board.md), "A started task in the backlog").
It runs on the shared tick, after any close, after any graph change, on quota refresh and at boot (`CrewWatch.sweepGates`).
The gate is a witness: every card with actions, and a wait on the captain a crewmate declares in its report, places the `captain` gate on its task (a task-less host card files an `operation` row) (`docs/task-graph.md`).
The whose-turn sort and the idle ladder read that gate as one witness among their shared set (`IdleLadder.witnesses`, [report-sort](../docs/report-sort.md)), which stays documented there.
On an active work row the `captain` gate has one writer, `IdleLadder.syncCaptainGate`.

Relations:

Every relation below is one kind of the checked relationship contract, with its own rule in `TASK_RELATIONSHIP_RULES` ([`../src/core/tasks/taskRelationships.ts`](../src/core/tasks/taskRelationships.ts)); only `blocks` holds a start ([task record](../docs/task-record.md), "Relationships").

- Parent (`parent_id`, one per task) means containment; a child inherits its parent's project and repository, and the ancestor walk refuses a cycle.
- `blocks`: the target is not ready until the source is `done`; a dropped blocker never clears readiness and becomes a dead wait the first mate resolves.
- `related` is informational; `discovered-from` is provenance; `replaced-by` records that a task's work moved to another, and a task closed through it reads done, carried on by that task, rather than dropped; none of the three affects readiness or closing.
- Basis: a task names one task whose answer it builds on, a `basis` row of `task_references`; whether it holds is derived at every read, never stored, and a name that names no task yet is kept.
- Branch inheritance: a parent moves no code; `branch_from` names a task in the same project whose last commit the working copy starts at, a `branch-source` row, and it is the one relation that moves code.
- Retry provenance: a stronger-model retry names the attempt it retries, a `retry-of` row; the escalation stamp beside it stays on the shape as a fact of how it ran.
- Typed result: `result_schema` on the shape makes the report's `result` a checked JSON object, delivered to the first mate and to any task whose basis names it.

Close rules: a parent closes only when every child is closed, except host delivery children (`isDeliveryChild`); a task does not close while a marked blocker is still live work (a soft hold the captain may override); a container no crewmate holds completes with its children.
An answer task closes `done/answered` on the captain's choice on its crewmate's card, unless the crewmate declared that card `continues`, or through `settle_task` done, why `answered`, when it was declared an internal step and a live task builds on it or waits on it.
A reported, idle task whose result was handed on through verified file delivery or a captain result choice can also close `done/answered` without `internal_step`; the handoff receipt never bypasses unmerged-work, outstanding-work or relationship checks (`docs/task-graph.md`).
An operation delivers a named effect, not code or an answer card, and is declared with the operation constraint; `in_folder` work is an operation too.
Read-only beside either declaration is refused; operations skip kind classification and request medium through R12 after captain overrides and a program’s choice.
Reported operations and legacy work declared `in_folder` can close `done/finished` through `settle_task` done, why `finished`, with the first mate's explicit evidence, through the same settle and task owners, without touching the project folder (`docs/task-record.md`).
Host closes (a failed turn, a cancel) are unguarded so a record can always record what happened.
Retiring the working copy and branch on close belongs to [projects-and-working-copies.md](projects-and-working-copies.md).

## Authority

The first mate creates, links, starts and drops tasks within the captain's authorization; on-request filing needs no `blocked_by` declaration, so related work can be filed and linked before anything starts.
`create_task` or `update_task` setting `when-ready` must declare `blocked_by` in the same call (`[]` declares none).
A crewmate only files follow-ups, writes progress and reads; it never edits another task.
`internal_step`, `basis`, `result_schema` and `branch_from` are the first mate's declarations; the host stores and checks typed facts and infers no judgment from titles, kinds or words.
Overriding a soft hold needs the captain's words in that turn.

## Compositions

- Guided ways of working (plan then build, reproduce then fix): a parent left on request with child steps, each grounded on the previous by `basis` ([sequences](../docs/sequences.md)).
- A program is a task whose script files its parts as child tasks ([programs.md](programs.md)).
- A change's after-merge steps become `when-ready` `Continue: …` tasks, or start the unstarted tasks they name, inside the merged close's transaction, discovered from the origin and held by `blocks` links from the work each waits for ("After-merge steps", [task graph](../docs/task-graph.md)); a `Continue: …` filed during the work waits on its origin through a `blocks` edge set from origin to continuation before it is made `when-ready`.
- Cards with actions hold their task through the `captain` gate ([cards-and-consent.md](cards-and-consent.md)).
- Captain-owned required actions are durable operation records whose prerequisites are ordinary `blocks` links ([required actions](../docs/required-actions.md)).
  Their words change only through `TaskService.delivery.reviseRequiredAction`, which moves the requirement's generation and refuses a completed action ([required actions](../docs/required-actions.md), "Correcting the words").

## Failure and recovery

A graph refusal is tool text, never a thrown error or a silent no-op (`docs/task-graph.md`).
`TaskGraphRefusal` (a `blocks` cycle, a live-wait loop naming the full key loop) writes nothing and spends no repair attempt.
A close refused by the rules returns a `SettleRefusal` with typed ways out that ride the settle wake.
A declared work wait no owner moves wakes the self-resolving loop: the first mate tries consent-free alternatives, then commissions a bounded read-only internal step before asking the captain ([report sort](../docs/report-sort.md), "Self-resolving work waits").
A host-record takeover uses `branch_from` and `files_from` immediately, with a related link rather than a must-merge-first edge from the stalled task.
A dropped blocker produces one deduped `[fm-op]` wake (`wakeDeadGate`); `link_tasks remove` or `update_task drop` are the ways out, and `start_now` refuses while the dead edge stands.
Dropped work starts again as a fresh task joined by `replaced-by` (`TaskService.starts.startAgain`), never by reviving the old row.

## Uses

- Every captain ask lands on a task through capture ([task capture](../docs/task-capture.md)).
- The sequences guide's feature and bugfix shapes: a parent with plan, implement, reproduce and fix steps.
- Crewmate follow-ups (`file_followup`), joined by `discovered-from` and triaged by the first mate.
- A change's independent review child, started on request at any care, joined to its builder by the parent edge ([delivery rigor](../docs/delivery-rigor.md)).
- Program parts filed by `ProgramRunner` as child tasks.

## Checks

- [`../src/core/tasks/taskService.test.ts`](../src/core/tasks/taskService.test.ts) and [`../src/core/tasks/taskService.graph.test.ts`](../src/core/tasks/taskService.graph.test.ts): the record, graph, refusals and close rules.
- [`../src/core/tasks/taskService.releases.test.ts`](../src/core/tasks/taskService.releases.test.ts): a start whose contact was lost or came back unconfirmed, and a message the first mate's turn never read.
- [`../src/core/tasks/taskService.edits.test.ts`](../src/core/tasks/taskService.edits.test.ts): `update_task`'s edits to a task's shape, each keeping the rest, and the edits started work refuses.
- `taskProtocol.presentation`, `.cache`, `.push`, `.view` and `.detail` tests beside [`../src/core/tasks/taskProtocol.ts`](../src/core/tasks/taskProtocol.ts), over one fixture in [`../tests/helpers/taskProtocol.ts`](../tests/helpers/taskProtocol.ts): the board's rows and words, what a board read reads and keeps, its pushes, and a record's detail and search.
- [`../src/core/orchestrator/settleService.test.ts`](../src/core/orchestrator/settleService.test.ts): settle modes and `SettleRefusal`.
- [`../src/core/orchestrator/settleService.boundary.test.ts`](../src/core/orchestrator/settleService.boundary.test.ts): the last look before a merge goes out, and a merge's, land's and discard's refusals.
- [`../src/core/orchestrator/settleService.keptMerge.test.ts`](../src/core/orchestrator/settleService.keptMerge.test.ts): the captain's kept merge approval - its guard, its waits, a host-run merge's first checks and an attempt read back.
- [`../src/core/orchestrator/settleService.closes.test.ts`](../src/core/orchestrator/settleService.closes.test.ts): the order a close takes and the rechecks of the first mate's declared closes.
- [`../src/core/pi/taskTools.test.ts`](../src/core/pi/taskTools.test.ts): the first mate's task tools.
- [`../tests/e2e/sequences.spec.ts`](../tests/e2e/sequences.spec.ts): the binding test that guided work stays parent and child tasks.
- [`../tests/e2e/task-followup.spec.ts`](../tests/e2e/task-followup.spec.ts) and [`../tests/e2e/answer-task.spec.ts`](../tests/e2e/answer-task.spec.ts).

## Where the detail lives

- [Declared heavy runs](../docs/heavy-runs.md): caller-owned demand, per-computer admission, group lifetime and the task's separate Run row.
- [The task record and its protocol](../docs/task-record.md): "Relationships", "Derived, never stored: the basis and the review join", "A typed result and where a working copy starts", "The unified timeline", "Starting dropped work again".
- [Task graph](../docs/task-graph.md): "The graph", "The ready query", "Gates on active rows", "Follow-ups are not children", "The close rules", "Tools".
- [Sequences](../docs/sequences.md): "The decision", "The host pieces it runs on (all generic)".
- [Architecture](../docs/architecture.md) §19 "The task system"; [task retention](../docs/task-retention.md); [the whose-turn rule](../docs/report-sort.md).
- [Completed-operation repetition](../docs/tool-repetition.md): incremental exact completion observations, indexed task state and once-named lifecycle notices.
