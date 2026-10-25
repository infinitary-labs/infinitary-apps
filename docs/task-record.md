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

## A folder a merge left behind

After a merge the host brings the project's folder up to date only by fast-forwarding a clean folder on its default branch (`WorkspaceService.refreshManagedCheckout`); any other state is refused with a typed cause (`FolderRefreshCause`, `src/shared/folderRefresh.ts`, which owns its words), such as edits of its own, another branch, no branch, a failed fetch or a diverged default branch (INF-549).
A refusal is kept on the merged task's record as a note naming the cause, the branch, the merged version and origin's version as last read (`data.folderRefresh`); on the first mate's own settle that note is the Activity line, and on the captain's click the settle's own line already carries the same sentence.
The host then files one task under the project, "Bring the folder up to date", and starts it the way a when-ready task starts, with no reminder or card of its own (`CrewSupervisor.fileFolderRepair`).
Its shape carries the facts as `in_place`, a host stamp: the crewmate's working directory is the folder itself, with no working copy and no branch, and the task ships nothing, so it has no delivery, rigor or autonomy, no delivery tools and no completion decision, and it runs on this Mac whatever the project's Runs on says.
Its brief is filled from those facts at each start (`renderFolderRepairBrief`): the crewmate judges whether the folder is safe to bring up to date, may set edits aside on a backup branch or a stash, and asks the captain on a card before it discards or overwrites anything, moves the folder off its default branch, pushes or opens a pull request.
A later refusal on the same project while that task is open or active updates its facts, notes it, and tells its crewmate; it files nothing new.
Once a minute the host reads each such folder without changing it (`WorkspaceService.folderCurrent`), and a task whose folder is clean, on its default branch and at or past the merged version closes as finished with a line saying so, unless its crewmate is mid-turn or one of its cards is up (`CrewSupervisor.closeCurrentFolders`).
A refusal for `no-origin` or `no-default-branch` read no default branch, so the minute's read takes it from the folder's own `origin/HEAD`, as the next merge's update does (INF-583).
Its brief has the crewmate add origin at the project's address when the folder has none, and name origin's default branch with `git remote set-head origin --auto`, since a pull of one branch leaves `origin/HEAD` unset.
Removing a working copy never touches a directory that is the repository itself or holds it, so a failed start of a task that works in place leaves its folder, or the folder above a missing one with everything in it, as it was (INF-585).
It deletes a directory git refused to remove only when it is in the worktrees area, so a failed start never deletes a folder outside it, whatever the record says the task started in.

A folder that is gone is `missing`, and one git cannot read is `unreadable`; neither reads as having no address (INF-572).
Work that needs the folder notices it then, never earlier: a merge's update says it is missing, and a task starting on this computer, a branch coming home from a computer that runs work (`PlacedCopies.bringBranchHome`), and a merge into the folder itself (`SettleService`) are refused with words naming the folder and its repair (`CrewSupervisor.folderMissing`, `folderMissingText`).
Each files or names the same "Bring the folder up to date" task, with `in_place.noticed` saying what found it; a folder found missing again while its repair knows it tells nobody anything new.
Of the tasks that work in the folder, only that repair starts while the folder is missing: folder work and "Close the pull request" are refused at their start with the same words (INF-584).
A refused start waits on the captain like any start that failed.
A task bound for a computer that runs work still starts: the start's read of the folder's address skips a missing folder (`ProjectChanges.inspect`), and that computer clones from the project's saved address.
A missing folder's repair works in the folder that held it, or the nearest folder above that exists, recorded as `in_place.started_in` so a resume opens there again (`nearestFolderAbove`).
Each start opens a new conversation, so it reads the project's folder at the path the project names now and starts in it when it is there, dropping `started_in` (`CrewSupervisor.inPlaceDir`, INF-757).
Its brief has the crewmate find out why the folder is missing, clone it again into the same path only when it was deleted, and otherwise ask the captain on a card.
A repair that never read a default branch reads it from the folder's own `origin/HEAD` when the minute's read comes round, so it closes once the folder is back, clean, on that branch and level with origin's.

At each app start, the computer that keeps the record reads every project with an address once, in the background (`CrewSupervisor.checkFoldersAtStart`, `WorkspaceService.refreshAtStart`).
A missing folder is left for the work that next needs it; a folder on another branch or on none is left alone without a fetch; one that cannot be read, or is level with or ahead of origin's default branch, is left as it is.
A clean folder behind on its default branch is fast-forwarded, as after a merge, with one Activity line.
One behind with edits or commits of its own gets the repair, with `noticed: "app-start"`, unless the captain dropped the project's latest repair while origin's default branch stood where it stands now; once that moves on, the next start files it again.

A pull request an abandoned task could not close gets the same kind of task (INF-549's sibling).
When a discarded, cancelled, failed or superseded task's pull request is refused its close (`SettleService.closeOpenPullRequest`), the host files one task under the project, "Close the pull request", with `in_place.pull` naming the pull request, its link and branch, the abandoned task, and what the host answered (`CrewSupervisor.filePullRepair`); one stands per pull request.
The note on the abandoned task names it, and is an Activity line unless the captain's own click already put the outcome there.
Its brief says close the pull request or report why not (`renderPullRepairBrief`): the crewmate works in the folder without changing it, holds only the read and write tools where the project lives, and never merges, pushes or deletes a branch.
The same minute's read closes it as finished once the host reads that pull request closed or merged.

Work on a project's folder itself is the first mate's to declare, by its own judgment (INF-567, direction A).
`spawn_crewmate`'s `shape.in_folder` stamps `in_place: { folder: true }` (`CrewSupervisor.workShape`), and a stronger-model retry keeps it.
Such a task runs on this Mac, which keeps the folder, whatever the project's Runs on says, and works in the folder with no working copy, branch, delivery, rigor or completion decision, as the folder repair does.
Its brief is the first mate's intent with no Delivery line, closed by a paragraph naming the folder and that the captain's edits there are the captain's (`renderIntentBrief`'s folder facts).
It needs a project other than the personal workspace, and refuses `runs_on_ask`, `delivery_ask` and `review_of` beside it; nothing spawns.
While the folder is missing it is refused at its start, as any task starting on this computer is, and the folder's repair is filed or named (INF-584).
It closes as any task does: the host's folder-reading close never reads it.

## Derived, never stored: the basis and the review join

The record keeps no stamp of a fact the graph already holds (migration 46 removed the two it had).
A task's `basis` is stored on its shape as the first mate named it (a key or an id); whether it holds - the named task is done or has reported - is derived at every read (`TaskService.basisHolds`, `basisOf`), so a step planned behind a still-running task reads grounded the moment that task answers, with no write.
The store strips `basis_verified` from any shape it is handed; the router still receives it, derived, beside the shape.
The basis reads the same everywhere it is shown: `tasks.detail` carries `basis: { ref, verified }`, `v_tasks_v1` a `basis` column, and the export the shape verbatim.
A review's builder is its parent (the one stored join), and which review a builder's verdict came from is read off that edge (`TaskService.verdictReviewOf`: the newest review child opened at or before `reviewedAt`), never cached in the builder's delivery facts; the verdict's timeline event still names the review in its data, which is what the replay scorer reads.

## Live task policies

The captain changes a named open task's Delivery, Merging and Care by talking to the first mate, not through new record controls; the one exception is a merge card's Review carefully, which raises Care to Careful (`docs/delivery-rigor.md`, "Raising care from a merge card").
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
It names `computer`, the computer the task's crewmate ran on, and `evidence_folder`, its evidence folder there, so a crewmate reports a file on another computer as a gap instead of searching for it (INF-1217, `docs/macos-privacy.md`).
A crewmate's `tasks` also takes `projects`: true answers every project's key, name and folder instead of tasks; the first mate's has no such parameter, which keeps it out of the first mate's fixed context.
It also carries `built_on_by`: every task whose basis names this one, by key or id, open, done or dropped alike, each with its status, closing reason, short outcome and change (`TaskService.builtOn`, INF-976); the host's delivery machinery, such as a review, is not among them.
Lists carry no bodies.
A short closure report still replaces the latest outcome but cannot hide earlier full specifications.
Reports, closing choices and exact first-turn briefs are exempt from timeline compaction alongside existing provenance; no historical approval is inferred and no historical builder is restarted.
So is any event whose data marks it `journal: true`, a record a replay reads back, such as a program's ask answers and its start (`docs/programs.md`).

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

## A typed result and where a working copy starts

A task's shape can carry `result_schema`, a JSON Schema with an object at its root, which the first mate declares on `spawn_crewmate`, `create_task` or `update_task` (INF-799 piece 1).
The host refuses a schema without an object at its root, or one the validator cannot read, as tool text, and files nothing (`resultSchemaRefusal`, `src/core/tasks/taskResult.ts`).
The brief prints it in a "Result shape" section with one sentence saying the report's `result` must fit it (`renderResultShapeSection`).
The crewmate's `report` takes `result`, a JSON object, checked with the JSON Schema validator the app ships (typebox's `Schema`).
A result that does not fit, or a missing one where a schema stands, is refused as tool text naming the first failing field, such as `result.files[0] must be string`, so the crewmate reports again; a report that declares `waiting_on_captain` or `needs_firstmate` is taken without one.
A task with no schema keeps whatever object its report carried.
A checked result is stored on the report's event (`data.result`) and, as the task's latest result, on its delivery facts (`delivery.result`), where it stands until a later report carries another.
The report wake carries it as a typed fact after "Its result, as declared:", a by-key `tasks` read carries `result` and `result_schema`, and a brief whose basis carries one prints it after that task's report under the same words.
A crewmate's report text that ends a turn without the tool carries no result.
A task running on another computer carries its result home on the report order (`report-result.md`); the home starts a task with a schema there only when that computer lists the change.

`branch_from` names, by key, the task whose last commit a task's working copy starts at: that task's branch head while its working copy is present on this Mac, else the kept ref its work was saved on.
The host checks it when it is named and again when the task starts, and refuses as tool text an unknown task, the task itself, a task in another project, a working copy on another computer, or a task with neither a branch nor saved work (`CrewSupervisor.handOffShape`).
A step filed behind open work that has not started yet may name it; a start that then finds nothing to branch from fails in those words.
At dispatch the working copy is created at that commit (`WorkspaceService.baseAt`) instead of the dispatch base, and the brief says so in one line (`renderBranchFromLine`).
A task that branches from another starts only on this Mac.
Both fields change only on open work that has not started, like `basis`, and both are the first mate's own, so no host stamp writes them (`CAPTAIN_OWNED_SHAPE_FIELDS`).
`update_task` clears either one with an empty value, `{}` or an empty string.
The tools serve both parameters bare, with no description, and the served sequences guide's preamble says their rule once, to keep the first mate's fixed context inside its boundary (`tests/firstmate-fixed-context.test.ts`).

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
`waitingCardId` is the operational ready-decision fact: the first unresolved shown ready decision associated with a live task, with no `awaiting` and nonempty actions, in `CardService.snapshot()` order.
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

A crewmate's `note_progress` takes an optional `plan` beside its line (FI3-734, the captain's Build it on the steps-view preview): the whole list of what the task takes, each item a label, a short label for its dot, and a state the crewmate declares - done, current, next or skipped (`src/shared/taskPlan.ts`).
The tool and the persona prompt ask for a short, high-level list of under eight items, sent with the brief, sent whole with every later note, unchanged if nothing moved, with finished items folded into one to make room, and every item done or skipped at the final report.
How long and how many is the crewmate's call (INF-484 move 5: clip and show, never refuse a shape): the host keeps every word and every item, the record lists them whole, and the summary's line cuts what it cannot hold - a short label by its width, with the full name on hover, and past twelve dots the items after the current one, folded into one (`clipPlanLine`).
A note that omits the list is written and leaves the last list standing, and its answer says so; only a list no surface could draw - an item with no words, a state outside the four, an empty list - is refused, in words and writing nothing.
The list rides the `progress` event's data (`TaskService.noteProgress`), never a column of its own, and `tasks.detail` reads the newest note that carried one as `plan` (`planOf`, `src/core/tasks/taskProtocol.ts`): the items as declared plus `since`, when each first read its state in an unbroken run of notes, matched by label, so a finished item shows when it finished and a folded item reads from the note that folded it.
Null when no note ever carried one; the board row carries none, so the crew summary shows the plan once the record answers, as it shows Now.
The shared task facts carry it as `plan` after `now` (`taskFactsOf`), labelled Progress, with the newest list note’s short age at the right edge as on Now, drawn as dots on the summary and as the list on the record (the design skill's NowPanel, Shared task facts); `foldPlan`, `clipPlanLine` and `planCounts` are the one home of the fold past eight items, the line's cut past twelve dots and the count.

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
| `steered` | row | A reply the captain typed under a card reads as the captain's words and the card's title; a line the captain typed in the Crewmate tab reads as the captain's words. |
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
News is a row: a merge approval or refusal, a kept merge that ended, the captain's override and its take-back (quoting the captain's words, `docs/delivery-rigor.md` "The holds"), a working copy kept, a quiet crewmate, a failed install, what happened to the task's browser.
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
A writer that would repeat one line on a task marks it with `data.feedOnce`, a name for the line, and the feed shows only the newest of that name per task while the timeline keeps each (`recentFeed`, `src/core/tasks/taskFeed.ts`): queued guidance going out as a crewmate's next turn is one (INF-1137).
Activity sentences start with capitals at their producers, including `taskFeedLine`, which authors the same task update for live events and restored history.
The renderer never changes the case of supplied text, so a deliberate lowercase name, key, path or command stays intact; previously stored free-text notes keep their original words.
A line whose fact the record already holds - the captain's reply or a line the captain typed in the Crewmate tab, a start, a drop, a filing, a close, the receipt of a merge - names no task and stays task-less.

## Whom an event concerns

An event is written once, on its own task, and names the other tasks it concerns (FI3-1189's rule 1).
`TaskService` derives them in the transaction that writes the event, only from the typed links and the declared basis as they stand then, and keeps them in `task_event_concerns` (migration 71): the event, the other task, how the event's task stands to it, and the task a replacement carried it through (`via`).
`TaskService.concerning` reads them, and that task's Activity shows each as a row naming the task that wrote it (`TaskActivityLine.from`), whose key at the line's end is a link to that task.
Such a row takes no fold, and it never stands as the task's Now line ("The Now line" below).

| Event | Concerns | How it reads there |
| --- | --- | --- |
| A milestone: `created`, `dispatched`, `pr_opened`, `merged`, `landed`, and a `status` or `failed` that closes the task | its parent; each task it blocks; the origin it was filed from; the task its basis names (INF-976); the task it replaced, and through it every task that one concerns | `SCR-5, a part of this task, merged pull request #977.`, `SCR-7, built on this task, merged pull request #977.` and `SCR-6, which replaced SCR-3, merged pull request #977.` |
| `linked` and `unlinked` | the link's other end | `SCR-4 waits for this task.`; the far end of a filing folds under the filing's own note |
| A refused merge (`note` with `data.refused`) | each task the refusal names that a link or a parent edge joins to it | `SCR-1, which waits for this task, could not merge.` |

A drop reads with its reason, and a drop for a replacement names it (`SCR-3, filed by this task, was dropped: SCR-6 replaces it.`).
The first mate declares the replacement with `update_task`'s `replaced_by` beside `drop`, which writes a `replaced-by` link from the dropped task to its replacement before the close, or with `link_tasks` type `replaced-by` (`docs/task-graph.md`).
An event another task reads is exempt from timeline compaction, so the row it makes there never folds away.
A `compacted` row keeps the newest plan it folded (`plan`, written at `planAt`) and the highest program line number per op it folded (`programLines`), so the task's plan and a program's replay still read them.
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
Now carries its row's span when it reads a row (`taskFactsOf`), so the record links it there too; the record's frame links the Activity lines, and a click goes where every link in the record goes.
`recordActivity.test.ts` holds the spans, `record.frame.test.ts` the frame's links, and `tests/e2e/task-card-links.spec.ts` opens the pull request from the fact strip, from Now by keys and from an Activity line.
The `tasks` query's rows carry the same change as `change`, its label and its page (`taskChangeOf`), so an agent that names a task's pull request on a card links the page it was given (FI3-1307; `docs/card-authoring.md`, "Pull request numbers").

## Activity updates during a press

The record frame reconciles Activity rows by event id, leaving unchanged nodes mounted rather than detaching them with `replaceChildren`.
A native pointer press therefore reaches the same summary on release even when a detail or board update arrives between them.
When folded events, actions or whole text change beneath an unchanged summary, the frame keeps that disclosure, its summary and its count node, and refreshes the body and count in place.
The retained rows keep their age registrations, so relative times and their accessible names still refresh on pushes and minute ticks.
Rows that change their summary or disclosure shape are rebuilt with the existing open-state and late-toggle handoff; removed rows leave the rendering cache.
This is Activity's renderer behavior only; Cards and Knowledge used still render through their own owners.

## A crewmate's actions

Activity also holds what the task's crewmate did: each call it made to a tool other than the app's own, read from the sessions the app keeps for the task (FI3-1189's rule 3, the captain's "Folded under the row they led to").
The calls are never copied into the timeline, whose ordinary history folds into counts past 500 events (`TIMELINE_CAP`); the session already keeps every call, and nothing prunes it (`docs/task-retention.md`).
`CrewActions` (`src/core/tasks/crewActions.ts`) reads every session in `crewmates/<task>/sessions/` through the one session reader (`sessionAssistantLines`, `src/core/storage/sessionReader.ts`), with the Claude client's own file standing in for the app's copy of the same session while it holds a turn's tail the copy has not caught up with (`createCrewmateTranscriptResolver`).
It follows each file as it grows: a read parses only the whole lines appended since the last, and only a line that can be an assistant's.
A call to the app's own tools (`CREWMATE_TOOLS`) is left out, because what it did is already an event: a report, an update, a card, a pull request.
So is a shell call that runs one of the app's own task commands, such as `infinitary-browser-axi` (`runsTaskCommand`, `docs/axi-commands.md`): the task's browser line and timeline already say what its browser did, and never what was typed into a page.
A call reads as the one-line description the crewmate wrote with it; a call with none reads plainly from its typed arguments (`Read src/a.ts`, `Ran pnpm test`, a path inside the working copy relative to it, and `Used <tool>` for a tool with no reading).
Each line is redacted as an update is and ends in an ellipsis past 160 characters.
The Claude client's command tool asks for a description; the app's own command tool for a Pi crewmate takes an optional `description` for the same line (`src/core/pi/bashTool.ts`).

The task card's Crewmate tab reads the same sessions whole, as a transcript, through the same reader (`docs/task-card-tabs.md`, "The Crewmate tab").

`condenseActivity` folds each action under the first row recorded at or after it, the row it led to, as the row's `actions`, and what no row followed yet under the newest row; an update a report restates takes what led to it along under the report.
On the record, a line's count and what it opens to hold its actions and its folded events together, in time order.

## The Now line

Now says what the crewmate is doing: its own newest doing, with that doing's age (`nowOf` in `src/shared/taskFacts.ts`; INF-554's audit, built as INF-557).
It is the newest of three things the record already holds.
The first is the crewmate's own newest row: a progress note, a report, a card, a pull request or its checks.
The second is its newest action, in the description it gave the call or the plain reading Activity writes for it.
The third is the last sentence it wrote in its session (`TaskDetail.said`), which `CrewActions.said` reads on the same pass as its actions, from the last line with words of its newest assistant line, never its thinking or a helper's sidechain.
A message the app sent the crewmate and a compaction stay in Activity and never stand as Now, so a crewmate that did nothing since reads its last doing at its true age, and a stalled crewmate looks stalled.
Before its first doing, Now is the task's own newest row but those, such as the start line; a row another task wrote is Activity's alone.
Who wrote a row is its kind, a typed fact; Now never reads a row's words to choose.
The same Now follows `working` in the thread of a crewmate's card the captain replied under, once it is newer than the captain's line, and the record's read re-reads on each of the crewmate's calls so it moves with the work (`docs/card-threads.md`, "The waiting line").

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The task record (task-system design P0, captain decisions D2/D5/D6; spec `fm-homes/mini-default/data/fm3000-task-system-design-s1/report.md`): a task is a RECORD, not a runtime handle.
  `src/core/tasks/taskService.ts` is the ONE writer over `tasks` / `task_events` / `task_links` (migrations 17-19) - every state change commits in one transaction with the timeline event that explains it; nothing else writes those tables, and tests seed rows through `seedTask` (`src/core/tasks/seedTask.ts`), never raw SQL.
  A read of many rows (`list`, `listByStatus`, `listLiveOrClosedSince`, `getMany` and `listChildren` in `src/core/storage/taskStore.ts`) comes back oldest first, by `created_at` and then `seq`, sorted after reading and never by an `ORDER BY` over whole rows.
  SQLite's sorter copies every column of every row it sorts, and once that copy outgrows its cache it writes it to a temporary file, on the main thread, on every read of a long record (INF-940; `taskService.test.ts` asks SQLite for each read's plan).
  Status is `open | active | done | dropped` with `activity` (starting/running/idle/interrupted) while active and `closed_reason` once closed; the offline corpus scripts pass the column through verbatim.
  The `delivered` status and the `finish` settle mode were retired together (cards/tasks/agents P2, WI-11, migration 30 maps every historical `delivered` row to `done`): an idle crewmate with unlanded work stays `active` and resumable, shown in the Tasks panel's `working` group like any other active row (captain: "if it's finished and doesn't need me, why is it even there?"; the captain later dropped the group's own separate "to land" bucket - it's just working), until merged, landed, or discarded.
  Settling CLOSES: land -> done/landed, merge-pr -> done/merged (also when the task's own pull request, read by its number, was already merged outside the app: nothing is sent, and the autonomy hold has nothing to hold), an explicitly verified external release with no task-owned proposed change or unlanded work -> done/released (`settle_task released` with `release_evidence` recorded on the timeline), discard -> dropped/discarded, and - on a task whose deliverable is an ANSWER (Task B of the crew-posture rationalization) - the captain's choice on its own crewmate's card closes it done/answered unless the crewmate declared that card `continues` (INF-1226), while the captain's close control reaches the crewmate like every crewmate card's close (FI3-435) (the one other path, captain's call C of 2026-09-24: `settle_task answered` closes an IDLE answer task the first mate itself declared an internal step at creation - `WorkShape.internal_step`, its judgment under its instructions, stored and honoured with no host inference - done/answered once a live task names it as its basis or waits on it through a blocks link or once its crewmate reported its answer (INF-1137), or any answer task once its crewmate reports it finished after the captain's close; anything else stays the captain's to close - `docs/task-graph.md`), while merge-pr and land are refused on it outright; only the worktree and branch go, the row, its timeline and the session JSONL under `crewmates/<id>` stay (captain: "we shouldn't remove the entire session JSONL altogether"; P5 scopes pruning).
  Fleet hygiene is enforced in code (interaction P0, WI-7): every close refusal is a structured `SettleRefusal` (`{ refused, task, tasks, ways, text }`, WI-12) whose runnable ways ride the settle wake as a fenced JSON block the first mate carries as effect buttons (`proceed_with_open` lets a settle bypass the children-open gate, keeping children planned); every closed status stamps `closed_at` in `patch`, a done/dropped close ALWAYS retires the worktree and branch (captain, 2026-09-22: "cleaned up period. no exceptions") - whatever never landed (uncommitted edits, tracked and untracked but not ignored, plus branch commits) is first saved as ONE commit on the hidden ref `refs/infinitary/kept/<task-id>` (`WorkspaceService.retireTaskWorktree`; outside refs/heads, never named on a surface, nothing expires it yet), git ancestry only decides whether a save is needed (it reads squash-merged work as unlanded forever), and the one exception is a save that FAILS, which keeps the tree with a feed line; a task on a computer that runs work keeps its working copy there, `present` with no `worktree_dir`, and its close saves the same commit there, brings it home as a bundle and only then deletes the copy (`docs/helper.md`, "Its working copies"), and a working copy there whose task this Mac no longer records goes by the same rule, its work saved here first (`docs/helper.md`, "Leftovers"); boot hygiene applies the same rule to closed rows still holding a tree and to directories under `userData/worktrees` no record explains; discard of unlanded work still asks, a discard of unlanded work is refused without `confirm` (its ways: discard anyway, or land/merge instead), a crewmate's completion card is two effects - a `settle merge` the host resolves by the repository's posture and a danger `settle discard` - and never a keep button (closing the card is the keep; cards/tasks/agents P1), commissioning installs pnpm dependencies before the first turn (`WorkspaceService.installDependencies`, a timeline note), and `reconcileFleetHygiene` at boot reports leftover `fm/task-*` branches as one feed line and never deletes one.
  The D-13 purge is the one control that deletes the record; a closed task's leftover files go a week after the close (`docs/task-retention.md`).
  `crew_status` and the strip list resumable records (idle/interrupted) with the report from the `outcome` column, so a restart forgets nothing.
  Projects (`projects` table, `ProjectStore`): Scratch plus one per managed repo, born in `RepoRegistry.insert`'s transaction and archived on unregister; keys `<KEY>-<seq>` (`deriveProjectKey`, or the key chosen when the project was added, `docs/fleet.md` "Choosing a task key") are the conversational handle from P3 on.
- The task protocol (task-system P3, `docs/ui-plugins.md` "The read catalog"; design section 9): `src/shared/tasks.ts` is the wire surface (board, detail, project views), `inf:tasks:board` / `inf:tasks:detail` / `inf:projects:list` the reads, `inf:tasks` the push, `task_changed` / `task_event` the two FmEvents, `tasks.board` / `tasks.detail` / `projects.list` the catalog entries.
  ONE seam feeds all of it: every `TaskService` write goes through its private `write()`, whose outermost transaction bumps `task_board.seq` (migration 20, one row) in the same commit and notifies `onChange` listeners only AFTER the commit; `src/core/tasks/taskProtocol.ts` turns each change into the FmEvents through `broadcastEvent` and one coalesced (40 ms) `inf:tasks` snapshot rebuilt from task records and the shown card projection, so a pushed board always equals a fresh read (`taskProtocol.test.ts` pins it).
  A nested write is one change with one seq; a no-op write bumps nothing; a refused write notifies nothing.
  The board is the LIVE set (open/active, closed within `BOARD_RECENT_MS`, plus shown rows' parents; links only across shown rows); history is `tasks.detail`, one task at a time.
  Building it reads only those rows, the rows at the other ends of their links and their children's counts, never the older closed history, since every crew event pushes it and a long record is mostly that history (INF-703; `taskProtocol.test.ts` counts the rows read).
  A record's `tasks.detail` reads the same way: the record, the rows its concerning events, standing waits and gate's card name, the rows at the other ends of their links, and one row on its own for any other task its Activity names, never the whole history, since each open of the Info tab reads it several times (INF-939).
  The one exception is the Tasks filter: typed text also asks `inf:tasks:search` / `tasks.search` (`TaskProtocol.search`) for closed work older than the window, for dropped work, and for questions, decisions and operations closed within the window (the panel never lists those), matched on key, title and goal only, newest closed first, at most 50, empty text finding nothing, with the graph read around the found rows alone; the panel paints them as an `earlier` group and a row opens the record through `tasks.detail` like any row.
  Every task search - the filter's board rows, this search, the task board's Find (`docs/task-board.md`) and the `tasks` query's `text` - compares through `foldForSearch` (`src/shared/searchText.ts`): lowercase, with a curly apostrophe or quote read as the plain one a keyboard types, so `what's new` finds `What’s new in …`.
  Flags (`blocked`, `held`, `needsYou`, `ready`) and `waitingCardId` are derived on read from links, gates and the open card stack.
  The feed is a VIEW since P3: `inf:feed:recent` merges `task_events` (feed=1, line authored by `src/core/tasks/taskFeed.ts` from event + record, keyed by `taskKey`) with the task-less `activity_events`; `feedLineFrom` no longer authors the task-bound runtime events (`task_started`, `task_report`, `task_landed`, `task_finished`, a crewmate's `turn_failed` - those FmEvents still flow for the character, Observe and the strip), and `broadcastEvent` never persists a `task_event` line (it already lives in the timeline).
  The `task_event` FmEvent's `text` is the feed line when `feed` is true, else the timeline text.
  A drop the first mate made carries its closing sentence in the close's data, and its line reads `Dropped:` and that sentence (INF-547; `docs/card-authoring.md`, "Work that closed without the captain's click").
  The two pinned surfaces moved: `window.infinitary` gained `tasks` and `projects` (`phase0-guardrails.spec.ts`); the self-map's channel and event lists are read from the contract itself.

### By-key closing resolution

A single `tasks` lookup includes `resolution` alongside the report/newest card: closing action, submitted answers, resolved time and stored card, plus an exact `offer` when interaction capture recorded it.
Both the first mate and crewmates read the same fields.
The query view omits a closing card or offer body only when it is identical to the newest `card` body.
Its action, submitted answers and other closing metadata remain in `resolution`; a differing historical body stays there too.
The stored resolution is unchanged, and `taskResolutionBody` reads a closing body from its own field or the identical newest body.
The tool-text renderer returns the original heading and indented JSON byte for byte when the complete response fits 50,000 characters, on every provider.
A longer by-key read does not compress and does not cut unique content.
It keeps every field that still fits and names each remaining field, whether that field is its own text or JSON, and that field's length.
Read one named field from a 1-based character offset.
The answer's nextOffset continues that field, and none ends it.
The page index asks the reader to finish the remaining fields before acting.
Each page fits the same 50,000-character band, in characters and in UTF-8 bytes, so the client does not replace it with a saved file.
The first mate's 100,000-token cap stays the outer limit and is not this band.
Distinct historical reports and differing closing card and offer bodies remain whole, alongside every event id, answer, action and other metadata.
This is a paged presentation of the query, not a storage change or a change to authorization.
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
Once the start claims the row it is no longer open work, so a basis is refused in words, and a named model moves the task instead.

## Moving a started task to another provider

A started task moves to another provider in place (INF-849): it keeps its key, branch, working copy, record, pull request and waiting messages, and only its model, account and sometimes its conversation change.
Two things ask for it, and both run `CrewSupervisor.requestMove`.
The crewmate sign-in card's default, "Move to" the app's pick, is the captain's: the router evaluates the task's own shape with the failed provider left out (`withoutProvider`, `docs/routing.md`), and the card offers it only when a model serves; otherwise the card keeps only Open settings.
The button names that model by its Settings name (`ModelSlots.nameOf`), the model the task would run on.
Its `move-task` effect names the task, the provider it moves off and the model offered, so a card left up after another move, or after the app's pick changed, refuses in a feed line rather than move somewhere the card did not name.
`update_task override_model_id` on started work is the first mate's, on the captain's words: the router pins the named model as R0 does, and a model that cannot serve is refused as text.
A crewmate mid-turn moves once that turn ends; a turn is never cut short.
The move commits the routing decision with who asked, selects the account (`selectForSpawn`), lets go of the old session, and writes the record's model and account with one timeline row and feed line naming who moved it (`TaskService.recordMove`).
The sign-in card comes down, the lane's waiting rows are due at once with their spent attempts given back (`InboxStore.movedProvider`), and the task reopens in the same working copy.
Between two Pi providers the same conversation resumes on the new model.
To or from Claude, the new backend cannot reopen the conversation, so a new one starts and is told it moved (`CrewmateRestart` `moved`), with the brief and the earlier transcript's path, as an unopenable one is.
A task on another computer does not move: it stays on that computer's own subscriptions.

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

## Minimized cards in Tasks

A minimized message remains open, with its task and operational ready-decision association unchanged.
The desktop’s `presentTask` overlays the optional `minimizedCardId` for presentation only, never a gate or a task move.
`nowGroupOf` puts that task’s own row under waiting on you without an added word, even for a note on a finished task.
The raw board includes finished tasks while they have minimized cards, however old; the phone keeps its existing card list.
`presentBoard` gives a taskless minimized card one presentation-only row, titled by the card, never a saved task.
The task board and compact Tasks count use that same projection, and restoring or withdrawing the last minimized card removes that presentation override.
Click or Enter restores the task’s minimized cards; a task’s existing ready card already opens on a row click through `openTask`.
The record’s Cards row labels an open minimized card Put aside, and its link brings the live card back.
The record’s Show the card also brings back a minimized decision.

## Live validation

A Careful change's `delivery.liveValidation` retains scenario revisions, version-bound observations and digested selected proof, independent reviewer judgments, and separate captain permissions.
`TaskService.recordLiveValidation` and `decideLiveValidation` are the only writers; no prose parser grants proof or consent.
The merge completion card presents the live-validation result, evidence and limitations beside the merge decision; the captain need not open the task record to understand what was demonstrated.
The task-detail read keeps the Live validation summary and keyboard-openable evidence rows as supporting history under Details in the existing record frame.
Details starts closed, so validation does not displace the record's overview and ordinary rows.
Delivery and timeline rows contain evidence metadata and compact references, never transcript bytes or a repeated copy of the complete validation state.
The detail reader loads only bounded retained text for presentation, never media bytes or repeated proof hashes.
Digest verification remains uncached at review and delivery gates.
Retained pictures and recording posters open the existing picture and demo viewer, with focus returning to their record control.
Only media named by that record's retained proof may open, and playback requires the captain's press.
The record frame never plays a recording itself: its opaque origin cannot load the media URL.
The contract, expiry and delivery gates are owned by `docs/delivery-rigor.md`, "Careful live validation".
A keyed `tasks` read includes `live_validation` and, for a reviewer, `validation_assignment`; compact lists include neither.
That agent-facing record carries proof identities and digests, not duplicate transcript bytes; the reviewer reads the verified files named in its assignment.

Proof for a different committed version remains readable, with its scenario result marked Another version rather than a current live pass.
