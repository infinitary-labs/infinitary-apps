# The task record and its protocol

The task as a record (task-system P0) and the wire protocol over it (P3).
`docs/architecture.md` §19 summarizes the whole task system; capture is `docs/task-capture.md`, the graph `docs/task-graph.md`, retention `docs/task-retention.md`.

## The idle clock

Four columns on the record (migration 45; new databases receive them with the record) hold the idle ladder's durable state, written only through `TaskService` like every other column: `idle_since` (`markIdle` at every idle boundary, `endIdle` when a turn the ladder did not start begins), `recovery_rung`, `recovery_count` and `recovery_at` (`recordRecovery`).
They are machinery, not a state change: no timeline event and no `updated_at`.
What reads them is `CrewSupervisor.reconcileIdle` and the crew line's `stalled` fact (`docs/report-sort.md`, "The idle ladder").

## Where a task runs

`device_id` (migration 63, written only by `TaskService.setDevice`) names the paired computer that runs work holding the task's conversation, and null is this Mac (`docs/helper.md`, "The home's side").
Such a row has no working copy here, so the boot keeps it active once its conversation was recorded (`sessionFile`) rather than by its `worktreeDir`, never marks its turn interrupted, and reads it as resumable whatever its activity: a turn it was running went on there.

## Derived, never stored: the basis and the review join

The record keeps no stamp of a fact the graph already holds (migration 46 removed the two it had).
A task's `basis` is stored on its shape as the first mate named it (a key or an id); whether it holds - the named task is done or has reported - is derived at every read (`TaskService.basisHolds`, `basisOf`), so a step planned behind a still-running task reads grounded the moment that task answers, with no write.
The store strips `basis_verified` from any shape it is handed; the router still receives it, derived, beside the shape.
The basis reads the same everywhere it is shown: `tasks.detail` carries `basis: { ref, verified }`, `v_tasks_v1` a `basis` column, and the export the shape verbatim.
A review's builder is its parent (the one stored join), and which review a builder's verdict came from is read off that edge (`TaskService.verdictReviewOf`: the newest review child opened at or before `reviewedAt`), never cached in the builder's delivery facts; the verdict's timeline event still names the review in its data, which is what the replay scorer reads.

## Live task policies

The captain changes a named open task's Delivery, Merging and Care by talking to the first mate, not through new record controls.
`update_task` takes `delivery: direct-pr|local-only|project`, `autonomy: on|off|project`, and `rigor: quick|standard|reviewed|project`.
Omission preserves a policy; `project` resets it to the current project setting, including a project's permission to merge on its own.
An explicit request is consent; ambiguity about the task, policy or consent gets one specific question rather than a routine confirmation.
`TaskService.updateFields` commits the live policy revision, cancellation of old pending approval, and its actor-attributed Activity/feed event together; a rejected mixed edit rolls back its other fields too.
`WorkShape.policies` holds edits separately from original asks, dispatch stamps, published delivery facts, pull request identity and evidence.
The shared `effectiveTaskPolicies` reader supplies the record, task query, crew context, briefs, review gates and final merge guards; the task detail's legacy `rigor` remains dispatch history, and its optional `policies` holds the current values and sources.
Details shows three read-only rows and `This task` or `Project setting` beside each, followed by the helper inviting a request to the first mate.
For Automatic work or once a computer that runs work is on the list, a fourth read-only row, Runs on, says where the task runs and whether that came from `This task`, its `Parent task` or the `Project setting` (`TaskDetail.runsOn`; `docs/helper.md`, "A task's own Runs on"); `update_task` `runs_on` changes it before the task starts.
A local merge bounds Careful to Default without losing the requested care, with an explanation in Details.
Queued, interrupted and waiting work stays in place; the existing durable inbox carries policy notices to active and later resumed crews without starting a crew solely for that notice.
A restart recovers a notice from the committed event if the app quit before enqueueing it.
Newly closed work snapshots its effective policies beside the closed outcome (`delivery.closedPolicies`), without creating or rewriting a routing shape; policy edits refuse closed tasks, reviews, answers and the personal workspace.
The merge and care semantics, including the final asynchronous boundary, are in `docs/delivery-rigor.md`, “Changing policy on open work”.

## Specification delivery and history

`update_task` applies combined edits before `start_now`; a typed graph refusal prevents that start.
Goal edits atomically update `tasks.goal`, the structured intent and the host-rendered goal in the stored template.
The captain's verbatim words, constraints, delivery and escalation context are not rewritten.
Queued intent tasks render from saved intent at dispatch (escalations retain their host-authored context).

A by-key `tasks` read carries the latest `outcome` and `card`, complete chronological `reports` with event ids, saved timeline `decisions`, the explicit `basis`, and the most recent pinned `brief`.
Lists carry no bodies.
A short closure report still replaces the latest outcome but cannot hide earlier full specifications.
Reports, closing choices and exact first-turn briefs are exempt from timeline compaction alongside existing provenance; no historical approval is inferred and no historical builder is restarted.

At dispatch the named verified basis carries its latest report once, as the answer, and every report before it as history, the full card and its full thread, plus the existing saved choice/answer reader.
No card or thread tail is cut from the implementation handoff.
An existing `discovered-from` edge also delivers its origin's recorded findings, explicitly labelled provenance, not accepted scope or a basis routing discount.
A follow-up so handed its origin, as an origin section or as its basis, loses the line its filing wrote telling it to read the origin through `tasks` (`withoutOriginReadLine`), so the origin reaches it once; an answer follow-up gets no section and keeps the line.
No natural language scan attaches a basis, no self-basis is invented, and same-session prototypes and narrow direct builds remain valid without external sources.

The brief a first turn serves is appended as a non-feed `briefed` event just before serving it; Activity leaves this host receipt out as evidence ("What Activity holds").
The project's standing directions are not part of it: every served turn, the first included, adds the current ones (`docs/knowledge.md`, "Knowledge first").
Each report the brief copies off a task's timeline is stored in the receipt as a reference to its event wherever the reference is smaller than the copy (`src/core/tasks/briefReceipt.ts`): a short stand-in naming the event in the text, and its offset, task, event id and the text's hash in `data.reports`.
Report events are never compacted, so `TaskService.servedBrief` reads the receipt back as served, for the `tasks` query's `brief` and the record's timeline; the hash finds the report again when an export reloads it under a new event id.
The card is already a file the brief names, so the receipt holds its path; a card that could not be saved rides in the brief, and the receipt, whole.
`TaskDetail.cards` lists every card the task showed, open and past, newest first, for the record's Cards row (`docs/card-evidence.md` "The past card").
Successor lookups can recover that pinned content even after source or builder reports change.
This proves host delivery, not model compliance or how an agent reads an approval; that judgment is `HANDOFF`'s (`docs/card-authoring.md`, "The handoff").

## Starting dropped work again

The dropped work record offers Start again in its action bar's next slot, with no confirmation and the shared keyboard focus ring.
Done records have no bar; dropped work with parts, a `replaced-by` successor or a stronger-model retry has no Start again.
An accepted click removes that record from the stack, not from history; a refusal is inline and writes nothing.
The old task stays dropped.

`TaskService.startAgain` creates a fresh record and the old-to-new `replaced-by` link in one transaction, moving outgoing `blocks` links whose waiting task is still open or active to the new task.
It copies title, goal, intent (including the captain's words and constraints), project, repository, priority and a parent that is still open or active.
The supervisor carries the basis, captain-named model and task-level delivery, autonomy and care declarations, but no session, chosen model/account, delivery outcome or escalation stamp.
It dispatches through the ordinary Start path with fresh routing, not a tier increase, after pending retirement has finished.
The replacement's brief reads its predecessors beside discovered-from origins, carrying their keys, full reports and saved work even when they never reported.
The crewmate starts a fresh conversation and applies saved work itself; the working copy is not preloaded.
The basis remains a specification, never a substitute for saved-work provenance.

A captain click writes a `note` on the old task with `startAgain` naming the new key and `via: task-card`, which the next first mate context lists once beside other task-card clicks.
`update_task start_again` is the conversational equivalent, only on the captain's own request, and returns the replacement key.
It takes no other edits or operation in that call; start and steer refusals on dropped tasks point to it.
Drop task, Discard, stronger-model retries, provider retries and closed-work retirement retain their meanings.

## Ready waiting is a presentation projection

Approved specification: FI3-275, direction A, reachable cards, split waiting children.
Cancellation and terminal session failure retire task cards at closure through `SettleService.closeRecord` (FI3-270); the waiting projection also independently excludes closed tasks.
`waitingCardId` is the sole waiting fact: the first unresolved shown ready decision associated with a live task, with no `awaiting` and nonempty actions, in `CardService.snapshot()` order.
Direct associations and captain-gate references use that same test.
A ready card behind the foreground card still counts; navigation can focus it.
A hidden or Working sibling cannot mask another ready decision.
Closed tasks always have null.
Count each task once, not cards or ancestors.

`flags.needsYou` and project `counts.needsYou` retain broader durable attention (cards, captain holds and dead dependencies); they no longer label a task as waiting.
Ready waiting also implies attention.
A crewmate-declared `captainWait` remains an operational hold, but never creates a waiting label, lane or count without a ready card (FI3-702).
A cardless paused record keeps the latest report summary in its attention box, even when a later closed note occupies Now; the host displays that authored reason without classifying its prose.
Continuing checks, jobs or replies take precedence over that paused box.
Project `counts.waitingOnYou` is the derived live-task waiting count (protocol 1.39.0).
No task status, readiness column or dispatch permission is added.
Losing a waiting signal never releases a gate.
The record keeps generic attention/hold guidance and the bar's other slots when there is no ready choice; a ready choice outranks a blocker or an interruption in the action bar, whose next slot is then Show the card, while the body's attention box still names the blocker or interruption.

CardService declares stack changes through `presentationChanged` at its broadcast seam, including pending shown-version revisions, reply holds, close-out, Working/ready, retirement and restoration.
`TaskService` alone advances `task_board.seq` for that invalidation, without changing task rows, updated/idle/recovery clocks, timeline or feed.
TaskProtocol delivers the focusable card snapshot before its board snapshot or delta, explicitly, not by relative timer delays.
`tasks.detail` re-reads on either board carrier as well as its own events; project readers refresh too.

The renderer immediately overlays local card availability on board/detail and project waiting counts when it hides a reply, or restores a refused one.
The read executor retains raw data as its delta base; local presentation does not change seq.
A presentation change repaints what each reader holds and reads nothing again: a change the core derives from the stack arrives on the board carriers, so a card change never sends each board reader back for the whole board.
Older snapshots/deltas do not restore a hidden shortcut; gaps re-read.
In-flight reply pushes stay hidden, and a reply receipt refreshes the stack if a fast author returned before the receipt.
Task navigation and Show the card refresh the association before focusing it, falling back to the record rather than forcing a hidden card forward.

Tasks separates a waiting child from a working parent tree.
Nonwaiting parents/siblings keep their existing grouping, nesting, sorting and activity dots; no parent context is duplicated or counted as a decision.
The binding interface regression is `src/core/tasks/readyWaiting.test.ts`, joined through real CardService, TaskProtocol and the read executor; the isolated app journey is the ready-waiting case in `tests/e2e/card-threads.spec.ts`.

A crewmate's `report` takes an optional top-level `summary`: one plain sentence of what happened.
The record's headline and the feed's report line prefer it.
Without one, the first sentence past a leading Intent section stands in.

## A held task says why

Queued work a gate holds has never reported, so its record's attention box says what the gate waits for and what ends the wait instead of asking for a reason (`TaskDetail.hold`).
The host reads it from the gate and the work's own ask alone, never from words (`holdOf` in `src/core/tasks/taskProtocol.ts`), and `taskHoldWords` in `src/shared/taskHold.ts` is its one wording.
A level's gate that is the level the work asked for is that ask's own wait: a premium ask, or a stronger-model retry's rung, held on that level's allowance rather than started lower (`requiresReasoningWait`, `docs/routing.md`).
Its words say it starts by itself once a model at that level has allowance, and that the first mate can start it sooner on another model.
Any other gate on queued work is one first mate set with `start_after`: a level's allowance, a plan's allowance by its provider's name, or a time in this computer's zone.
The captain's own gate, and any gate on underway work, keeps the paused box above.

## The plan a crewmate reports

A crewmate's `note_progress` takes a `plan` beside its line, optional only until the first valid list (FI3-734, the captain's Build it on the steps-view preview): the whole list of what the task takes, each item a label of at most 60 characters, a short label of at most 12 for its dot, and a state the crewmate declares - done, current, next or skipped - at most 12 items (`src/shared/taskPlan.ts`).
The tool and the persona prompt ask for a short, high-level list of under eight items, sent with the brief, sent whole with every later note, unchanged if nothing moved, with finished items folded into one to make room, and every item done or skipped at the final report; the host refuses, in words and writing nothing, an omitted list after the first valid one or a list that does not fit.
The list rides the `progress` event's data (`TaskService.noteProgress`), never a column of its own, and `tasks.detail` reads the newest note that carried one as `plan` (`planOf`, `src/core/tasks/taskProtocol.ts`): the items as declared plus `since`, when each first read its state in an unbroken run of notes, matched by label, so a finished item shows when it finished and a folded item reads from the note that folded it.
Null when no note ever carried one; the board row carries none, so the crew summary shows the plan once the record answers, as it shows Now.
The shared task facts carry it as `plan` after `now` (`taskFactsOf`), labelled Progress, with the newest list note’s short age at the right edge as on Now, drawn as dots on the summary and as the list on the record (the design skill's NowPanel, Shared task facts); `foldPlan` and `planCounts` are the one home of the fold past eight items and of the count.

## What Activity holds

A task's Activity (`TaskDetail.activityLog`, `condenseActivity` in `src/core/tasks/recordActivity.ts`) holds every event of its timeline in time order, read in plain words from typed fields only, never from the words.
It also holds the events of other tasks that concern it, each a row in its time ("Whom an event concerns" below).
Nothing is left out but evidence: a minor event folds under the next row of the task's own, the one it led to, and what no row followed yet folds under the newest of them.
A row carries what folded under it as `folded`, oldest first, and on the record its line opens to them (the design skill's TaskRecord, "Activity lines that open").
What the crewmate did folds the same way, read from its kept session rather than the timeline ("A crewmate's actions").
The timeline itself stays whole on `TaskDetail.events`.
An answer given on a card is stored as the card's body (`FileQuestionInput`, `recordAnswer`), so `TaskDetail.outcome` reads it as the card's words (`cardWords` in `src/shared/cardWords.ts`), and the line that closed the task opens to those words, never to the markup.
The `tasks` query keeps the body, and the record's Cards row opens the card itself.

Every event kind has one place: a `row` of its own, `folded` under the row it led to, or `evidence` the timeline keeps for whoever digs.
`ACTIVITY_PLACES` is the code copy of this table, so a new kind fails the build until it has a place; `recordActivity.test.ts` holds the two to the same places and checks that condensing leaves out nothing but evidence.

| Kind | Place | When it reads otherwise |
| --- | --- | --- |
| `created` | row | |
| `ask` | row | |
| `answered` | row | |
| `briefed` | evidence | The brief as sent, read on the timeline and by the `tasks` query. |
| `dispatched` | row | |
| `steered` | row | A reply the captain typed under a card reads as the captain's words and the card's title; a line he typed in the Crewmate tab reads as his words. |
| `progress` | row | The update just before a crewmate's report folds under the report, which restates it. |
| `report` | row | |
| `failed` | row | |
| `card_raised` | row | |
| `card_resolved` | row | |
| `status` | folded | A status that closes the task is a row. |
| `linked` | row | |
| `unlinked` | row | |
| `moved` | row | |
| `pr_opened` | row | |
| `ci` | row | A reading with the same result as the last one shown, or with no change to read, folds. |
| `landed` | row | |
| `merged` | row | The host's receipt reads as the pull request the task opened (`Merged pull request #965.`), not its address. |
| `triaged` | row | |
| `note` | row | One its writer declared bookkeeping folds. |
| `compacted` | row | |
| `interrupted` | row | |
| `decided` | evidence | The first mate's sorting decisions, for the export and the offline readers. |
| `escalated` | row | |
| `review` | row | |
| `cap_reset` | row | |
| `replied` | row | A reply its crewmate or the first mate wrote under one of the task's cards reads as its first sentence under the card's title. |

Each writer of a `note` declares what it is, through `TaskService.note`'s required `news`, stored as `data.news`.
News is a row: a merge approval or refusal, a kept merge that ended, a working copy kept, a quiet crewmate, a failed install, what happened to the task's browser.
Bookkeeping folds: where the working copy came from, dependencies installed, a working copy removed with its work saved, a closed task's leftover files removed, lint findings at a commit, a refused completion card.
A note written before writers declared is news unless the host wrote it.

A reply the captain typed under a card is recorded as the whole message its crewmate was sent.
The steer's `data.words` says where the captain's own words sit in that text, a span rather than a copy (`replyWordsSpan`, `src/core/orchestrator/wakes.ts`), and Activity reads the card's title by `cardId`.
A reply recorded before the span, or one whose text redaction changed, reads as the whole message.
A line the captain typed in the task card's Crewmate tab is the same kind of steer (`via: "crewmate-tab"`, `docs/task-card-tabs.md`, "Typing"), its words a span too, and reads `You told the crewmate: ...`.
A reply its crewmate or the first mate writes in a card's thread is a `replied` event on the card's task (`TaskService.recordReply`, from `CardService.addMessage`), with the author's words.
A reply the captain types under a first mate card reaches the first mate as a turn, and its ask is the record of it (`docs/task-capture.md`).

A feed line about a task whose fact the task's own timeline does not already hold is a row on that task: the writer names the task (`firstmate_note`'s `taskId`), and the `broadcastEvent` seam writes it as a news `note` that the feed reads back, with its words as written (`data.feedLine`).
The feed line stays where it was, now with the task's key.
Activity sentences start with capitals at their producers, including `taskFeedLine`, which authors the same task update for live events and restored history.
The renderer never changes the case of supplied text, so a deliberate lowercase name, key, path or command stays intact; previously stored free-text notes keep their original words.
A line whose fact the record already holds - the captain's reply or a line he typed in the Crewmate tab, a start, a drop, a filing, a close, the receipt of a merge - names no task and stays task-less.

## Whom an event concerns

An event is written once, on its own task, and names the other tasks it concerns (FI3-1189's rule 1).
`TaskService` derives them in the transaction that writes the event, only from the typed links as they stand then, and keeps them in `task_event_concerns` (migration 71): the event, the other task, how the event's task stands to it, and the task a replacement carried it through (`via`).
`TaskService.concerning` reads them, and that task's Activity shows each as a row naming the task that wrote it (`TaskActivityLine.from`), whose key at the line's end is a link to that task.
Such a row takes no fold, and the task's Now line stays its own newest row (`taskFactsOf`).

| Event | Concerns | How it reads there |
| --- | --- | --- |
| A milestone: `created`, `dispatched`, `pr_opened`, `merged`, `landed`, and a `status` or `failed` that closes the task | its parent; each task it blocks; the origin it was filed from; the task it replaced, and through it every task that one concerns | `SCR-5, a part of this task, merged pull request #977.` and `SCR-6, which replaced SCR-3, merged pull request #977.` |
| `linked` and `unlinked` | the link's other end | `SCR-4 waits for this task.`; the far end of a filing folds under the filing's own note |
| A refused merge (`note` with `data.refused`) | each task the refusal names that a link or a parent edge joins to it | `SCR-1, which waits for this task, could not merge.` |

A drop reads with its reason, and a drop for a replacement names it (`SCR-3, filed by this task, was dropped: SCR-6 replaces it.`).
The first mate declares the replacement with `update_task`'s `replaced_by` beside `drop`, which writes a `replaced-by` link from the dropped task to its replacement before the close, or with `link_tasks` type `replaced-by` (`docs/task-graph.md`).
An event another task reads is exempt from timeline compaction, so the row it makes there never folds away.
The task export carries each event's concerns on its line (`concerns`), and an import writes them back with the event.

## Other tasks' keys in the record

Every other task's key the record shows is a link to that task (FI3-1271; the design skill's core rule "Task keys"): resting on it opens that task's summary beside the record, and a click or Enter opens it as its Tasks row does.
That holds for the Waiting on box, Details' Part of, Waits on and Holds up, the Now line, Activity's lines and the texts they open to, the goal, the captain's words and a refused drop; the record's own key stays text, as do Cards row titles, an Activity line's toggle and Drop task's question.
The window finds which keys name tasks from the record's own read (`recordWords` in `RecordCard.tsx`, then `useTaskLinks`), and the record's frame links them where its text writes them, as a card's body does (`docs/card-authoring.md`, "Task keys").
Part of names the parent's key, never its id: the frame reads the parent's own record when the board does not list it.

## Pull requests in the record

Every pull request the record names by its number links to its page where the host has one on the web (FI3-1159; the design skill's TaskRecord, "Pull request links").
`condenseActivity` says which words of a line name one, as `TaskActivityLine.change`: the span of the text and the page, never a copy of the words.
On the task's own lines that is the task's pull request, from the `pr_opened` event's `prUrl`, wherever its label stands as a whole token (`#965`, not `#9650`), with "pull request " or "PR " just before it taken in; on a linked task's line it is that task's pull request (`ConcernedEventView.from.changeUrl`, its delivery's `prUrl`).
A pull request with no `https` page, or a branch on a plain Git host, gives no span.
Now carries its row's span (`taskFactsOf`), so the record links it there too; the record's frame links the Activity lines, and a click goes where every link in the record goes.
`recordActivity.test.ts` holds the spans, `record.frame.test.ts` the frame's links, and `tests/e2e/task-card-links.spec.ts` opens the pull request from the fact strip, from Now by keys and from an Activity line.
The `tasks` query's rows carry the same change as `change`, its label and its page (`taskChangeOf`), so an agent that names a task's pull request on a card links the page it was given (FI3-1307; `docs/card-authoring.md`, "Pull request numbers").

## A crewmate's actions

Activity also holds what the task's crewmate did: each call it made to a tool other than the app's own, read from the sessions the app keeps for the task (FI3-1189's rule 3, the captain's "Folded under the row they led to").
The calls are never copied into the timeline, whose ordinary history folds into counts past 500 events (`TIMELINE_CAP`); the session already keeps every call, and nothing prunes it (`docs/task-retention.md`).
`CrewActions` (`src/core/tasks/crewActions.ts`) reads every session in `crewmates/<task>/sessions/` through the one session reader (`sessionToolCalls`, `src/core/storage/sessionReader.ts`), with the Claude client's own file standing in for the app's copy of the same session while it holds a turn's tail the copy has not caught up with (`createCrewmateTranscriptResolver`).
It follows each file as it grows: a read parses only the whole lines appended since the last, and only a line that can be an assistant's.
A call to the app's own tools (`CREWMATE_TOOLS`) is left out, because what it did is already an event: a report, an update, a card, a pull request.
So is a shell call that runs one of the app's own task commands, such as `infinitary-browser-axi` (`runsTaskCommand`, `docs/axi-commands.md`): the task's browser line and timeline already say what its browser did, and never what was typed into a page.
A call reads as the one-line description the crewmate wrote with it; a call with none reads plainly from its typed arguments (`Read src/a.ts`, `Ran pnpm test`, a path inside the working copy relative to it, and `Used <tool>` for a tool with no reading).
Each line is redacted as an update is and ends in an ellipsis past 160 characters.
The Claude client's command tool asks for a description; the app's own command tool for a Pi crewmate takes an optional `description` for the same line (`src/core/pi/bashTool.ts`).

The task card's Crewmate tab reads the same sessions whole, as a transcript, through the same reader (`docs/task-card-tabs.md`, "The Crewmate tab").

`condenseActivity` folds each action under the first row recorded at or after it, the row it led to, as the row's `actions`, and what no row followed yet under the newest row; an update a report restates takes what led to it along under the report.
On the record, a line's count and what it opens to hold its actions and its folded events together, in time order.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The task record (task-system design P0, captain decisions D2/D5/D6; spec `fm-homes/mini-default/data/fm3000-task-system-design-s1/report.md`): a task is a RECORD, not a runtime handle.
  `src/core/tasks/taskService.ts` is the ONE writer over `tasks` / `task_events` / `task_links` (migrations 17-19) - every state change commits in one transaction with the timeline event that explains it; nothing else writes those tables, and tests seed rows through `seedTask` (`src/core/tasks/seedTask.ts`), never raw SQL.
  Status is `open | active | done | dropped` with `activity` (starting/running/idle/interrupted) while active and `closed_reason` once closed; the offline corpus scripts pass the column through verbatim.
  The `delivered` status and the `finish` settle mode were retired together (cards/tasks/agents P2, WI-11, migration 30 maps every historical `delivered` row to `done`): an idle crewmate with unlanded work stays `active` and resumable, shown in the Tasks panel's `working` group like any other active row (captain: "if it's finished and doesn't need me, why is it even there?"; the captain later dropped the group's own separate "to land" bucket - it's just working), until merged, landed, or discarded.
  Settling CLOSES: land -> done/landed, merge-pr -> done/merged (also when the task's own pull request, read by its number, was already merged outside the app: nothing is sent, and the autonomy hold has nothing to hold), an explicitly verified external release with no task-owned proposed change or unlanded work -> done/released (`settle_task released` with `release_evidence` recorded on the timeline), discard -> dropped/discarded, and - on a task whose deliverable is an ANSWER (Task B of the crew-posture rationalization) - the captain's choice on its own crewmate's card closes it done/answered, while his close control reaches the crewmate like every crewmate card's close (FI3-435) (the one other path, captain's call C of 2026-09-24: `settle_task answered` closes an IDLE answer task the first mate itself declared an internal step at creation - `WorkShape.internal_step`, its judgment under its instructions, stored and honoured with no host inference - done/answered once a live task names it as its basis or waits on it through a blocks link, or any answer task once its crewmate reports it finished after the captain's close; anything else stays the captain's to close - `docs/task-graph.md`), while merge-pr and land are refused on it outright; only the worktree and branch go, the row, its timeline and the session JSONL under `crewmates/<id>` stay (captain: "we shouldn't remove the entire session JSONL altogether"; P5 scopes pruning).
  Fleet hygiene is enforced in code (interaction P0, WI-7): every close refusal is a structured `SettleRefusal` (`{ refused, task, tasks, ways, text }`, WI-12) whose runnable ways ride the settle wake as a fenced JSON block the first mate carries as effect buttons (`proceed_with_open` lets a settle bypass the children-open gate, keeping children planned); every closed status stamps `closed_at` in `patch`, a done/dropped close ALWAYS retires the worktree and branch (captain, 2026-09-22: "cleaned up period. no exceptions") - whatever never landed (uncommitted edits, tracked and untracked but not ignored, plus branch commits) is first saved as ONE commit on the hidden ref `refs/infinitary/kept/<task-id>` (`WorkspaceService.retireTaskWorktree`; outside refs/heads, never named on a surface, nothing expires it yet), git ancestry only decides whether a save is needed (it reads squash-merged work as unlanded forever), and the one exception is a save that FAILS, which keeps the tree with a feed line; a task on a computer that runs work keeps its working copy there, `present` with no `worktree_dir`, and its close saves the same commit there, brings it home as a bundle and only then deletes the copy (`docs/helper.md`, "Its working copies"), and a working copy there whose task this Mac no longer records goes by the same rule, its work saved here first (`docs/helper.md`, "Leftovers"); boot hygiene applies the same rule to closed rows still holding a tree and to directories under `userData/worktrees` no record explains; discard of unlanded work still asks, a discard of unlanded work is refused without `confirm` (its ways: discard anyway, or land/merge instead), a crewmate's completion card is two effects - a `settle merge` the host resolves by the repository's posture and a danger `settle discard` - and never a keep button (closing the card is the keep; cards/tasks/agents P1), commissioning installs pnpm dependencies before the first turn (`WorkspaceService.installDependencies`, a timeline note), and `reconcileFleetHygiene` at boot reports leftover `fm/task-*` branches as one feed line and never deletes one.
  The D-13 purge is the one control that deletes the record; a closed task's leftover files go a week after the close (`docs/task-retention.md`).
  `crew_status` and the strip list resumable records (idle/interrupted) with the report from the `outcome` column, so a restart forgets nothing.
  Projects (`projects` table, `ProjectStore`): Scratch plus one per managed repo, born in `RepoRegistry.insert`'s transaction and archived on unregister; keys `<KEY>-<seq>` (`deriveProjectKey`, or the key chosen when the project was added, `docs/fleet.md` "Choosing a task key") are the conversational handle from P3 on.
- The task protocol (task-system P3, `docs/ui-plugins.md` "The read catalog"; design section 9): `src/shared/tasks.ts` is the wire surface (board, detail, project views), `inf:tasks:board` / `inf:tasks:detail` / `inf:projects:list` the reads, `inf:tasks` the push, `task_changed` / `task_event` the two FmEvents, `tasks.board` / `tasks.detail` / `projects.list` the catalog entries.
  ONE seam feeds all of it: every `TaskService` write goes through its private `write()`, whose outermost transaction bumps `task_board.seq` (migration 20, one row) in the same commit and notifies `onChange` listeners only AFTER the commit; `src/core/tasks/taskProtocol.ts` turns each change into the FmEvents through `broadcastEvent` and one coalesced (40 ms) `inf:tasks` snapshot rebuilt from task records and the shown card projection, so a pushed board always equals a fresh read (`taskProtocol.test.ts` pins it).
  A nested write is one change with one seq; a no-op write bumps nothing; a refused write notifies nothing.
  The board is the LIVE set (open/active, closed within `BOARD_RECENT_MS`, plus shown rows' parents; links only across shown rows); history is `tasks.detail`, one task at a time.
  The one exception is the Tasks filter: typed text also asks `inf:tasks:search` / `tasks.search` (`TaskProtocol.search`) for closed work older than the window, for dropped work, and for questions, decisions and operations closed within the window (the panel never lists those), matched on key, title and goal only, newest closed first, at most 50, empty text finding nothing; the panel paints them as an `earlier` group and a row opens the record through `tasks.detail` like any row.
  Every task search - the filter's board rows, this search, the task board's Find (`docs/task-board.md`) and the `tasks` query's `text` - compares through `foldForSearch` (`src/shared/searchText.ts`): lowercase, with a curly apostrophe or quote read as the plain one a keyboard types, so `what's new` finds `What’s new in …`.
  Flags (`blocked`, `held`, `needsYou`, `ready`) and `waitingCardId` are derived on read from links, gates and the open card stack.
  The feed is a VIEW since P3: `inf:feed:recent` merges `task_events` (feed=1, line authored by `src/core/tasks/taskFeed.ts` from event + record, keyed by `taskKey`) with the task-less `activity_events`; `feedLineFrom` no longer authors the task-bound runtime events (`task_started`, `task_report`, `task_landed`, `task_finished`, a crewmate's `turn_failed` - those FmEvents still flow for the character, Observe and the strip), and `broadcastEvent` never persists a `task_event` line (it already lives in the timeline).
  The `task_event` FmEvent's `text` is the feed line when `feed` is true, else the timeline text.
  The two pinned surfaces moved: `window.infinitary` gained `tasks` and `projects` (`phase0-guardrails.spec.ts`); the self-map's channel and event lists are read from the contract itself.

### By-key closing resolution

A single `tasks` lookup includes `resolution` alongside the report/newest card: closing action, submitted answers, resolved time and stored card, plus an exact `offer` when interaction capture recorded it.
Both the first mate and crewmates read the same fields.
The tool-text renderer returns the original heading and indented JSON byte for byte when the complete response fits 50,000 characters, on every provider.
Only above that threshold, it shares identical values within each row when a local JSON Pointer such as `{ "$ref": "#/0/card" }` is shorter; this includes repeated bodies, reports, actions and answer arrays.
The response explains these references: they point inside that same response and require no extra tool call.
Above 50,000 characters it drops JSON indentation and, where that saves more space, serves strings as verbatim length-framed `Text #/…` blocks below the JSON metadata.
A `{ "$text": N }` field names that block’s exact UTF-16 length; references still resolve inside the same result, without decoding compressed data or fetching files.
This reduces serialization overhead, not the meaning or completeness of the plan; truly larger unique content can still exceed a client’s limit.
The latest outcome and newest card are the first canonical texts; distinct historical reports and differing closing card/offer bodies remain whole, alongside every event id, answer, action and other metadata.
This is a lossless presentation of the query, not a storage change, truncation, or change to authorization.
Lists omit this material.
This is evidence, not authorization interpreted by the host.
The shared `HANDOFF` contract owns that agent judgment.
Basis briefs hand over the matching offer as a file they name and quote the answers alongside full report and thread history.

A missing basis on an existing successor can be repaired with `update_task basis` before a separate `start_now` call.
Only open work that has never started can change its basis; unknown/self references are refused.
This edits grounding, not permission or dependencies, and preserves the rest of its work shape.
By-key/list task rows expose the basis reference.

A model the captain names for a filed task is `update_task override_model_id` (contract v4.46, FI3-436): `TaskService.updateFields` stores it as the shape's `override_model_id` on open work no crewmate holds - a row a failed start returned to the queue included - recomputes `difficulty` from the shape, and an empty value clears it.
Combined with `start_now` it is an edit that applies before the start, so the same row - its key, parent and links - routes on the named model (R0), and the start answer names the model that took it, saying so when the named one was not available, as a new spawn's answer does (`docs/routing.md`).
Before it, a model could be chosen only on a new spawn, so a filed task was dropped and replaced.
A model or basis named or cleared while a queued task starts decides that start (INF-83).
The classifier's verdict is stamped on the row as it stands when the classifier answers, so the edit stays and the tier is computed from it.
A start whose model or basis moved while it waited on a computer, to place the task or to route it, starts over from the record as it now stands.
Once the start claims the row it is no longer open work, so both edits are refused in words.

## Requested crew speed

A task’s optional `override_speed` is its own explicit choice, never inherited from a parent, basis or failed attempt.
The task query names it as `crew_speed`; absent means the selected model’s current default.
Speed notes use ordinary task notes, not progress notes, so they never replace or refuse a crewmate’s saved plan.
Each note carries the typed requested, sent and provider-confirmed service with the actual model, and explains any Standard fallback.

## Requested reasoning

A reasoning effort the captain names for a task - low, medium, high or extra high - is its shape's `override_reasoning`: `spawn_crewmate.shape.override_reasoning` at the start, or `update_task reasoning` on open work no crewmate holds, which null clears.
It is the captain's own word for that task, never the first mate's judgment, and never inherited from a parent, basis or failed attempt; start again copies it with the task's other asks.
Its crewmate opens at it in place of the model's Settings → Models choice and the level's default, capped to what the model offers and not stepped down for Quick care (`docs/routing.md`, "Reasoning effort"); the Settings choice is unchanged.
A started conversation keeps the level it opened at, so the edit is refused once a crewmate holds the task.
The task query names it as `reasoning`; the crewmate summary shows the level the session opened at.

## Placement commitments

`tasks.placement_json` is one bounded historical commitment and its reservation state, written only through `TaskService`.
It preserves the selected computer, stable preparation order, explicit acceptance of an existing model fallback, resolved demand and at most 64 candidate explanations.
`TaskDetail.placement` exposes that snapshot, and the Runs on explanation renders its past-tense reasons and saved headroom.
A live resource refresh never writes it; task retention owns its lifetime.
`v_placements_v1` publishes task id, commitment time, selected computer id/name, reservation state and snapshot JSON, without the private preparation origin, to a declared and granted read-only SQL query.
The snapshot is never reused as fresh scheduling evidence.
