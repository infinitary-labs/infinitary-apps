# The whose-turn rule (S7c)

What happens when a crewmate reports.
Captain call **C7 A, heuristics only** ("Send and End", 2026-09-20), on the scout report `fm3000-s7c-supervision-decision-model-s1`, revisions R4 and R5.
Code: `src/core/orchestrator/reportSort.ts` (the rule, `sortReport` and `idleTurn`), `src/core/orchestrator/idleLadder.ts` (`IdleLadder`: the one `witnesses(taskId, now)` both readers call, the reconciler, the ladder, the gate, the caps and the ready sweep), and `CrewTurns.sortReport` (`src/core/orchestrator/crewTurns.ts`), which composes them.
Tests: `reportSort.test.ts` (the table), `crewTurns.whoseTurn.test.ts` ("the whose-turn rule at the report's call site"), `idleLadder.test.ts`, `idleLadder.waits.test.ts` and `idleLadder.served.test.ts` ("the idle ladder"), `core.boot.test.ts` ("the idle ladder across a restart"), `tests/e2e/report-sort.spec.ts`, `tests/e2e/idle-ladder.spec.ts`, `tests/e2e/relayed-decision.spec.ts`, `tests/e2e/sequences.spec.ts`, `tests/e2e/sequences-claude.spec.ts`.

A report is sorted from typed state the host already holds, never by a second model reading its prose.
The question is whose turn it is now.

A standing named run watch (`runWatches`) shares the `checksWatched` witness with a pull request watch.
The minute reader supplies the next named wake, so the idle ladder treats the task as moving, its report wakes nobody, and the task posture reads Waiting for checks (`docs/forge.md`, "The run watch").
A pull request watch's early failure wake leaves that witness standing until the checks finish (`docs/forge.md`, "The check watch").

## The rule

At the report's call site, in code, with no word of the report read.
In order; the order IS the rule.

| # | The facts | Whose turn | What happens | `model` on the record |
|---|---|---|---|---|
| 0 | An open card currently waits for its author's answer (`cards.awaiting = answer`) | the crewmate's | no wake | `rule:thread-unanswered` |
| 0a | The report declared `needs_firstmate`: a captain decision only the first mate can carry out (FI3-710) | the first mate's | wake, with what it must do | `rule:needs-firstmate` |
| 0s | The task has started and went back to the backlog (INF-2062, `docs/task-board.md` "A started task in the backlog"), and the report declares neither finished work nor follow-ups it filed | nobody's: it waits for a Start | no wake | `rule:in-backlog` |
| 0b | Started work waits on this task through a `blocks` link from it, whoever recorded it (INF-735, INF-3167) | the first mate's, which passes on what that work waits for | wake, naming that work | `rule:waited-on` |
| 0c | The task's open review last returned findings or blocked, and this report made no host handoff | the first mate reads it for a blocker or decision, not to repeat a handoff | wake, naming the review and what it read | `rule:review-reread` |
| 1 | An open **decision** card for the task, a wait on the captain its crewmate declared in its report while a card of the task is on the captain's screen (FI3-435), or work its crewmate declared finished while a card of its own is still on the captain's screen (INF-731) | the captain's | no wake | `rule:captain-card` |
| 1a | The report declared its work finished: the captain has read its outcome and nothing is left (FI3-435) | the first mate's, which closes the task | wake | `rule:finished` |
| 2 | The report filed follow-ups this turn | the first mate's | wake | `rule:filed-followups` |
| 2a | The task waits on work nobody has started: a task its standing baseline wait names, or a blocker holding its close, that only a start begins (FI3-671) | the first mate's, which starts it, folds the fix in or asks | wake, naming that work | `rule:waits-unstarted` |
| 2b | The task is a running program's part and the report carries the answer its program waits for: its checked result, or, with no result shape, a report that hands the turn to nobody; a report that names a check-back carries no answer (INF-799, INF-2037, `docs/programs.md`) | the program's, which reads the answer and closes the part | no wake | `rule:program-part` |
| 3 | A job running inside its bound, guidance its lane will still deliver, a captured settle, a timed wait on its gate, the host watching its change's checks or a named run (`docs/forge.md`), or a wait on work underway (FI3-250) | the crewmate's | no wake | `rule:still-moving` |
| 4 | The gate holds it for the captain and no card is up (a wait its crewmate declared with nothing on the captain's screen, INF-11) | the first mate's, which owes the card | wake | `rule:captain-gate` |
| 4a | A typed cut-off holds its account, or the computer that runs work it runs on is out of reach or not yet caught up (`docs/helper.md`, "The home's side") | the crewmate's, when the account serves again or that computer is back | no wake | `rule:still-moving` |
| 4r | None of the above, and the turn left a typed work stall or read-only recovery findings (INF-1550; "Self-resolving work waits" below) | the first mate's, which takes the next consent-free way | wake, with the stall and findings | `rule:recovery` |
| 4b | None of the above, and the first mate declared the task an internal step (`shape.internal_step`) | the first mate's, which decides the next step | wake on any backend | `rule:step-answered` |
| 5 | None of the above, and the host can see all of this backend's work | nobody's | **wake now**, with the report's own words | `rule:stopped` |
| 6 | None of the above, and it cannot | nobody's, as far as the host can see | **wake now**, with the report's own words (INF-11) | `rule:cannot-tell` |

What the table turns on.

**An internal step's report is its answer to the first mate** (FI3-793).
The first mate declares `shape.internal_step`; the host never infers it from report prose, a title, deliverable, or a successor's basis.
After cards, declarations, moving witnesses, the gate and the account cut-off, row 4b wakes on any backend.
A Claude step's cardless final report therefore reaches the first mate without waiting for the idle ladder, even when no successor has been filed yet.
The first mate decides what follows; the row starts or closes nothing itself.
Ordinary client-side work without this declaration sorts row 6, which wakes as well (INF-11); row 4b keeps its own rule on the record, and its receipt and nudge speak of the step's answer.
The report receipt describes this hand-off without asking an internal step to misuse `needs_firstmate`.

**A current unanswered captain reply outranks the open card.**
Row 0 is cards-as-threads phase 1 (`docs/card-threads.md`): a card is the head of a conversation with its author, so the captain replying under it means the captain has spoken SINCE that card went up.
The card no longer holds the turn - the author owes the captain an answer - which is why row 0 sits above row 1 rather than beside it.
The persisted `answer` hold, not the newest historical message, is authoritative: withdrawal, resolution and same-id reopening retain the thread without retaining the old obligation.

**A crewmate asks the first mate to act; the host never guesses it** (FI3-710, grounded on FI3-703, captain-approved 2026-10-03).
Some captain decisions reach a crewmate that only the first mate can carry out: a build the captain approved by reply under an answer task's card, a merge, a discard, a stronger model, unrelated work.
The crewmate relays the captain's words verbatim and declares it: `report`'s top-level `needs_firstmate`, a few words on what the first mate must do.
Row 0a wakes the first mate on any backend, above an open decision card, a declared wait and every moving witness, because each of those would otherwise hold the report quiet; a relay whose card was withdrawn also wakes at row 6, but without the request on the wake.
It sits below row 0: the captain's reply is answered first (`HANDOFF`: one thread line naming who is next), and the report tool's receipt says so when that reply is still open.
The wake carries the request beside the report's own words (`needsFirstmate` on the facts) and says it authorizes nothing by itself: the first mate checks the captain's words and starts the existing successor once (`HANDOFF`).
The `report` event keeps the request, and so do the record's delivery facts (`delivery.needsFirstmate`) until the crewmate's next turn starts, as they keep a declared wait (FI3-714); the durable inbox's content dedupe keeps a repeated relay to one wake.
While it stands and the first mate has not acted on the task since, the idle ladder raises it again ("The idle ladder" below).
It may ride beside `finished` or `waiting_on_captain`; an empty one is refused.
A report without it sorts exactly as before, and the receipt no longer promises a wake: it says whether the first mate is woken depends on the task's state.

**A hold on a task's finding ends when that task reports it** (INF-735, INF-720's Fix 2: "file a fix so a hold on another task's finding ends when that task reports it").
A wait the first mate records on started work is a `blocks` link (`docs/task-graph.md`), and the waiter reads as waiting on work underway, which nothing nudges until that work closes (row 3).
When the wait is for the work's finding, its close can be days after the finding: PR #184's task waited 2,393 minutes after INF-621 reported what it was held on, because INF-621's report came while its own work still ran and woke no one.
So a report from a task that such a link holds active work on wakes the first mate on any backend, above a card on the captain's screen and every moving witness (`IdleLadder.heldOn`, `waitedOn` on the facts).
The sorter shares its synchronous task projection, and the held-work read selects active waiters before composing their records, leaving closed waiters' retained payloads unread.
Every report wake from that task names the work (`waiting` on the report's facts), and its words tell the first mate what to do: when the report carries what that work waits for, such as a finding or an answer, pass it on with `steer_crewmate`; then, when this task is a step whose report was all that work needed, `settle_task` done, why `answered`, closes it and ends the wait, and when only the finding was needed of a task that goes on, `link_tasks remove` ends it; every other wait ends when the task closes, since each holds the waiter's start and merge (INF-3167).
Whether it does is the first mate's judgment; the host reads the link, never the words.
A baseline wait and a planned waiter that has not started read as before; a must-merge-first mark sets no wait apart any more, since every wait holds the close (INF-3167).
The row sits below row 0, as the crewmate answers the captain's reply first, and below row 0a, which wakes anyway.

**A note never holds the turn.**
There is one card shape on the wire; the word comes from the actions alone (`cardPresentation` / `cardWord`, `src/shared/cards.ts`).
A note is one fact with no next step - nothing waits on it - so a crewmate may post an FYI and keep working.
Only a card with actions is an ask, and only an ask makes the next move the captain's.
The record: of 133 card-up reports, 24 had only a note, and in 12 of those the crewmate was mid-work.
Under an all-cards reading, a crewmate that later stalled behind its own note would have been watched by nothing.

**A crewmate declares its wait; the host never guesses it** (FI3-435, captain-approved 2026-10-01).
A finished crewmate whose outcome is a note says so in its report: `report`'s top-level `waiting_on_captain` (a reason, and the open card of its own the captain is to read, if one is up) stores `delivery.captainWait` and places the task's `captain` gate (`IdleLadder.syncCaptainGate`, ref the card, reason the crewmate's).
While a card of the task is on the captain's screen - the one the wait names, or any other, a note included - that gate is row 1, so nothing nudges the crewmate and nothing wakes the first mate.
With no card up the captain has nothing to answer, so the gate is a card the first mate owes (INF-11, the captain's "make this missed escalation structurally impossible", 2026-10-18): the report sorts row 4 and wakes the first mate, its wake says what the crewmate waits on the captain to do and that no card of its is on the captain's screen (`captainWait` on the report's facts), and the idle ladder reads the task as `owed` - no nudge, since the crewmate already did its part, and the owed wakes and the host's card if the first mate takes no act.
The report's receipt tells the crewmate so when no card is up as it reports.
A wait that names a card of the crewmate's own that is already closed, while no card of its is open, drops the card and names none, and the receipt says so (INF-3060, `ReportIntake.ownOpenCard`); with a card of its open, or a name that is no card of its own, it is refused with the full id of each card it has open.
Only a ready card lists the task under "waiting on you"; without one, its record shows the latest report as the reason it is paused (FI3-702, `docs/task-record.md`).
An undeclared note still holds nothing.
The ladder still climbs past it, but what it sends names the newest note up on the task rather than claim no card is up (FI3-438): the nudge (`idleNoteNudgeText`) asks a crewmate whose outcome it is to declare its wait instead of posting it again, and the stall wake (`idle-stall` with `note`) tells the first mate the note is up and to steer it that way.
The wait lasts until the crewmate's next turn starts (`TaskService.turns.clearDeclaration` in `beginTurn`): a choice, reply or steer starts one, and that turn's report declares it again if it still holds.
Putting a decision or pending note aside, or reading a marked saved answer, starts no turn and preserves its wait.
Reading an ordinary note acknowledges it and starts its author's next turn through the existing durable path, clearing that declaration; the author reports finished if nothing remains.
A crewmate whose latest report already declared its work finished gets no such turn: the read wakes the first mate for its close once no card of its own is up (`IdleLadder.finishedRead`, the rung-2 asked wake counted as its first; INF-2718).
The minimize corner itself never declares work finished.
A saved marked answer remains a captain-turn witness (`answerReady`) even after its note is read, until explicit Done on the note or its record; neither the idle clock nor a finished report takes that choice.
The first mate’s crew context row carries the saved answer’s creation time and explicit Done receipt, so reading the note removes no answer witness and elapsed time does not rewrite that row.
What remains after the acknowledgement is the crewmate's call, never the first mate's.

**Finished wakes the first mate once, after an explicit acknowledgement** (INF-731, with the INF-1879 corner rule).
`finished` is the crewmate’s declaration that nothing remains after the captain’s acknowledgement, and on an answer task the first mate's `settle_task` done close is held while a card of the crewmate's is up (`DoneClose`), so each such wake asked for a close it could not make.
So a report that declares it while a card of its own is still on the captain's screen, a note included, is row 1: the captain's turn, no wake (`finishedCardUp`, kept apart from `decisionCardOpen` so a note alone never holds a report's turn).
The captain's replies under that card each bring the crewmate a turn and a report, and none of them wakes the first mate; the receipt tells the crewmate so.
An explicit message can reach the crewmate as its next turn, whose report declares `finished` with the card no longer holding a decision; a corner press never starts that turn.
A request beside it (`needs_firstmate`) still wakes at row 0a, so a reply that needs the first mate reaches it.

**A wait on work nobody has started is the first mate's turn** (FI3-671, captain-approved 2026-10-03).
Two typed waits stand on a task.
A `baseline-blocked` diagnosis at its change's current head, while the checks are not green, names its `dependencyTask` (`standingDependencyWaits` in `src/core/tasks/dependencyWaits.ts`: derived, never stored, so a new head or a passing reading ends the wait by itself).
A `blocks` edge from a task that has not closed holds the waiter's start and its close alike (`blockersHoldingClose`), whether a `blocks_me` filing, a required action's prerequisite or a link the first mate records wrote it (INF-3167).
When the named task is open and the ready sweep will not start it - on request, held, or waiting on blockers of its own (`TaskService.graph.awaitsStart`) - only the first mate or the captain can begin that work, so a report from the waiting task wakes the first mate on any backend, naming that work - which a moving witness would otherwise hold quiet.
An open named task that cannot start until its own blockers close stands for those blockers (the wait chain, INF-1428, the captain's Approve and build on INF-1670's piece 2): its blockers are read the same way, so a chain that ends in work underway is a wait on work underway, and a chain that ends in work nobody has started names that work.
An open task a dropped blocker holds is named itself, since nothing will free it.
So INF-785, waiting on an on-request task blocked by a task whose pull request was up for merge, is quiet until that merge; then the on-request task needs a start, and the waiting task's next report wakes the first mate naming it.
Closed dependencies, including dropped baseline owners, are not unstarted work and do not mask a wait on other work still underway.
The wake names each such task (`waits` on the report's facts, `IdleLadder.unstartedWaits`); the first mate's prompt says what to do with it: start it, steer the waiting crewmate to fold the fix into its own branch when that is smaller, or one decision card.
Host delivery machinery (a review) never counts.
The row sits after the filings, which wake anyway, and before row 3: a crewmate still moving does not start the work it waits on.
The idle ladder's turn ignores this witness.

**A wait on work underway moves on its own** (FI3-250).
When every task those typed waits name is live and not something only a start begins - underway, queued to start by itself, or a wait chain that ends in such work - the task waits on that work, not on anyone (`waitsOnUnderway`, `IdleLadder.underwayWaits`).
It is a moving witness like a timed wait: a report sorts row 3 with no wake on any backend, and the ladder neither nudges, wakes nor raises its card however long the work takes - the work's own crewmate is supervised on its own clock.
A wait on unstarted work beside it keeps the task out of this witness, so row 2a and the ladder still act.
The task reads as waiting: its posture is `dependency` ("Blocked by another task"), the record names the work (`blockedBy` includes a live task a standing baseline wait names), and its context-block row says `waits on KEY`.
When that work closes, done or dropped, the ready sweep's active branch ends the wait as it ends a timed one: one typed steer on the task's own lane (`dependency-closed`, actor supervisor), named by that work so the inbox queues it once even across a restart, and a new idle episode.
It goes only for work that closed after the wait began (the link's `createdAt`, the diagnosis's host-stamped `at`) and after the task started - so a continuation its origin's close started hears nothing - and while the task has not gone idle since the close.
A wait moves with its work when a `replaced-by` link is written, so a waiter hears the carrier's close, not the drop of the task it first named (INF-1826).
When the link comes after the waiter already heard that drop, the sweep sends one `wait-moved` steer naming the task that took the work over, once per pair of tasks.
Only the close wakes: a pull request that merges while its task stays open wakes no waiter until the task closes (the captain's choice on INF-1826).
The words say what the close means, naming the work's pull request when it has one: a link's done or dropped work no longer holds the task, so it carries on, and a wait that moved to it names the task whose work it took over (the waiter's `unlinked` event with `movedTo`, `docs/task-graph.md` "A wait follows moved work"); a baseline wait's done work means bring the change up to date, and its dropped work means lead the report with it, which the ordinary report sort routes without treating the dropped task as unstarted work.
A baseline wait also hears the default branch before that close (`docs/forge.md`, "A main failure's wake"): one `main-check-observed` steer for each commit whose checks finished, for its crewmate to judge whether they clear the wait, and the close still resumes it.
A record cancelled from its record or stall card runs the sweep at once, as every close does.
A crewmate names a wait itself in its report: `report`'s top-level `waits_on` lists the keys of open tasks its work cannot go on without, and each is recorded as a `blocks` link from that task, actor crewmate, which holds its start and merge until that task closes (`TaskService.graph.linkWaits`, INF-1428, INF-3167).
A key whose work moved through `replaced-by` links is recorded on the task carrying it now, and refused, naming that task, when it is already done.
The report is refused, with nothing linked, when a key is unknown, closed, its own task, or would close a cycle, or beside `finished`.
The app never reads the report's words for a wait.
Removing a `blocks` wait through `link_tasks remove` clears both its graph edge and any standing baseline diagnosis reference to that owner, preserving the failed readings and diagnosis evidence.
Other dependency owners and historical diagnoses whose waits no longer stand remain unchanged.

**"Still moving" is decidable because only the host starts a turn.**
`CrewTurns.runTurn` is the one caller of `transport.prompt`, and what feeds it is the task's durable inbox lane.
So there are four in-process witnesses to "will this crewmate move again with nobody acting": `TaskRuntime.state`, the job registry (`hasRunningJobs`), rows pending on the task's lane, and `pendingSettle`.

**One witness set, one gatherer** (the primitives review's F10, captain- approved 2026-09-26).
The sort and the idle ladder read the same typed facts, gathered once by `IdleLadder.witnesses`: cards by task (any open card with actions on it, or the card its `captain` gate names - never an id pattern), guidance as anything its lane will still deliver including a row waiting out the honest retry's backoff (`InboxStore.hasDeliverable`), a job only inside its bound (`JOB_BOUND_MS`), the captured settle, and the gate.
A `captain` gate is the captain's turn while the card it names is up and the first mate's while none is - never the crewmate's - and a wait its crewmate declared is the captain's while any card of the task is up, the first mate's while none is; an `at-time` gate is a wait (moving).
A delivery child that still has work to run is a witness the ladder alone reads (`reviewOpen`, INF-1876): an idle retained reviewer does not count as moving work for the builder.
The host delivers routine handoffs directly, and an unchanged report still takes the ordinary sort so a dispute or blocker reaches an owner.
The next witness is added once.

**Whether those four are COMPLETE is a property of the backend**, and it is declared, not guessed: `ControlProfile.backgroundWork` (`src/core/session/session.ts`).
Pi says `host` - its crewmate's bash is the host's own tool, so a background job is in the registry and its exit is a lane row, and all four empty means nothing will ever start the next turn.
Claude says `client`: the client keeps its own work, so the host sees activity but never a provable stop.
So does a crewmate on a computer that runs work, whatever its backend, and a task whose transport is gone.
Such a backend's own count of its background work stands in for the job list where it gives one (`background_work_changed`: a Claude client's list, a computer's Pi job count), so a running background task is still a moving witness at row 3.
What is left at row 6 is a crewmate that stopped as far as the host can see, and that report wakes the first mate as row 5's does (INF-11): a blocker only the captain can clear, reported with no card up, reaches the first mate at once on every backend, since the host never reads the words that say so.
Not knowing is kept on the record, as the rule's name, and never makes a report quiet.

A review task's events go through the review owner, which delivers routine findings and pass handoffs directly and wakes the first mate for decisions, blocked verdicts and failed handoffs: they are never sorted, so they record nothing here either.
The host returns a builder's changed head, evidence revision or validation state to the same reviewer before the ordinary sort.
A delivered handoff with no other declared work needs no first mate wake; otherwise the report is sorted like any other, at every care (INF-1876).
Row 0c reads the open review's findings or blocked verdict only when the report made no handoff, so the first mate reads the report for a blocker or decision without steering a duplicate review.
An independent repair assessment's report is not sorted at all: it is the host's own verdict on a kept merge (FI3-663, `docs/delivery-rigor.md`), and the host reads it and closes the assessment.

## Self-resolving work waits

INF-1550 implements B and C from INF-1540's approved audit, as the captain's answers to its review (INF-1554, F1 to F7) shaped them.
A work wait is a typed report declaration, `work_wait`: `owner`, the `end` fact, the current `observation`, and `cheapestWay` around it.
Missing ownership or an end produces a stall fact rather than an accepted quiet wait.
Two successive reports with the same owner, end and observation produce `repeated-wait`.
The sorter reads only the current and previous normalized report entries through `TaskService.lastReportEntries`; it does not decode unrelated timeline events or older reports.
A new observation ends that comparison; the host compares declared fields, never report prose.
A check-back with no observable running job and no work-wait declaration produces `wait-without-owner`.
Captain waits keep their existing card and gate semantics.

A stall is the first mate's only when nothing else owns the wait (F3, "if any watcher owns the wait, it is not a stall").
Row 4r sits after every owner the table reads: an open captain card, a running job, guidance its lane will deliver, a captured settle, a watched check or run, work underway, an account hold and a computer out of reach all keep the report quiet.
A row above it that wakes the first mate on its own, such as the gate's row 4, carries the same stall facts on its wake.
A timer is not an owner: a check-back whose claimed job is not running holds nothing (`IdleLadder.unownedTimer`).
The sort, the ladder's witnesses and the timer's end read that one rule, so its timed gate is out of row 3, the ladder climbs past it, and its end neither steers the crewmate nor restarts the idle episode; the ladder's own nudge is the look again.
A crewmate that waits for time to pass starts a background sleep, which counts as its running job and whose end wakes it; the report tool's `check_back` words and the report's reply to a check-back with nothing running tell it so.

These observations live on the task's existing timeline, so a restart retains the comparison.
Reports retain work waits and recovery findings on their durable entries, not a second store.
Empty recovery findings are absent and never change whose turn it is.
The report owner keeps recovery strings within the existing short declaration band and recovery lists within the shared message band, retaining full details through the existing overflow pointer.
Long wait facts keep a content digest so clipping neither merges different observations nor makes identical observations appear new.
Routing reads those kept facts, and a combined stall/findings wake serves the recovery procedure once.

The first mate lists ways forward, takes the cheapest consent-free move, records its choice through the existing task verdict, and reads the next fact before taking another.
When its own ways run out or fail, it commissions one bounded read-only internal step on that project, with the stalled task's goal, branch, refusals and named evidence.
The step reports `recovery_ways` to the first mate and stops, with no captain card or edits.
Each finding names an action, its `approach` (`workaround`, `pass-hold` or `stronger-model`), the hold, evidence and next fact; the host adds the hold's registry basis and `needsConsent` (`recoveryConsent`).
Only a declared workaround can be consent-free (F7): passing any hold or choosing a stronger model needs the captain whatever the hold's basis, and so does a workaround of a consent-basis hold or of sign-in, which rests on an outside fact only the captain can supply.
A finding kept before approaches existed declared none and reads as passing its hold.
A finding whose hold or approach this build does not know, from a work computer on another build or a report saved before that hold was retired, keeps its words with no basis and needs the captain; it never refuses the report (`keptRecoveryWaySchema`).
No label authorizes bypassing a hold, makes a physical impossibility possible, or permits repeating an unknown effect.
Signing, releases, merges, destruction and new access retain their existing consent requirements.
The first mate asks the captain only after every remaining viable way needs that consent.

When the same wait stays stuck after the idle ladder's two wakes, the ladder's last rung raises the host's stall card as for any idle task (F1, "Keep the card for you after the last wake"; "The idle ladder" below).
The card keeps the question it already asks - a declared captain wait's, or none - and adds what the task still waits on: the newest report's work-wait observation.
Beside it the card counts the attempts the first mate recorded as verdicts since that report and quotes the latest; an older verdict is not an attempt at it.
Work that resolved or has an owner gets no card: a new turn ends the episode, and any witness above keeps the ladder from climbing.

A crewmate blocked only by its own host record or a merged host fix absent from the running app files a takeover rather than polling for an alpha.
A takeover's title begins `Take over:`, distinct from a must-merge-first `Continue:` filing (F2).
The first mate reuses an existing takeover or starts this one immediately with `branch_from` naming the old task and the original goal and user words, hands files on with `steer_crewmate files_from`, and links the tasks as related and with a `blocks` link from the takeover to the old task, so the old author waits on its successor.
No blocking edge runs from the old task to the takeover.
A fresh task retains the evidence and consent requirements; it is not permission to retry an unknown effect or bypass failed checks.

## The idle ladder

Captain-approved 2026-09-26 (the idle crew recovery specification, board answers Q1-Q9; it continues FI3-83, which stranded when a provider outage parked the captain's reply under a decision card and nothing ever read it again).
The sort above answers whose turn it is at the moment a crewmate REPORTS.
The ladder is the same question asked of every idle crewmate on every tick, whatever left it idle - a report, a failed turn, a restart, a job that never ends - so the host never has to name the situation.
The only trigger anywhere is the absence of a witness.

**One durable clock per task.**
`TaskService` (the one writer) keeps `idle_since` on the record: set at every idle boundary (a turn ending clean or failed, a resume that went idle), cleared when a turn starts.
Beside it `recovery_rung` (0 none, 1 nudged, 2 woken, 3 card raised), `recovery_count` (wakes sent) and `recovery_at` (when the ladder last acted).
A new turn starts a new episode and resets all of it - except the turn the ladder's own nudge started, which is the ladder acting (the steer is recorded as the supervisor's, and `onlyLadderSteers` reads that off the timeline).
A report, a chat message, a restart or a wall-clock jump does not reset it.

**One reconciler, one order.**
The tick, every idle boundary and the boot sweep call `CrewWatch.reconcileIdle` over every live idle record, with or without a runtime.
The order is the rule's own:

1. Closed: nothing.
   A started task in the backlog (INF-2062, `inBacklog`): the captain's turn, nothing, whatever else stands - it waits for a Start, so it gets no nudge, no wake, no card and no stall line however long it stays.
2. An open card currently waits for its author's answer **and nothing is deliverable on its lane**, no cut-off holds its account, and its computer is not out of reach: nobody's turn.
   Before the card check, as row 0 outranks row 1 above - a reply hides its card on the captain's screen while the core keeps it open, so the card no longer holds the turn, and a reply that can no longer be delivered is a stranded task, not the crewmate's turn.
3. Its crewmate's last report asked the first mate to act (`needs_firstmate`), and the first mate has not acted on the task since (`askedFirstmate`, FI3-714): the first mate's turn, whatever card is up and whatever still moves, as row 0a outranks them in the sort - and after an unanswered captain reply, which the crewmate answers first.
   Nothing nudges the crewmate, which already did its part, and no card goes up; "A request the first mate leaves unanswered is raised again" below says what the ladder does instead.
   Work its crewmate declared finished with no card of its own up asks for the first mate's close the same way (`finishedNoCard`, INF-1428): its crewmate has nothing left to do.
4. A card with actions is up on the task - a crewmate's, a first mate's, or a host card such as the crewmate's sign-in card, which carries its task (`cardWord` counts any card with actions, whoever wrote it; every such card places the `captain` gate, `docs/card-authoring.md`): the captain's turn, nothing.
   Such a task gets no nudge, no wake and no timer however long it stays (FI3-81 "Leave as is").
   So does a wait its crewmate declared while any card of the task, a note included, is up (FI3-435), and work its crewmate declared finished while a card of its own is up (INF-731), or with none once the first mate acted on it (INF-1428): a nudge would ask a crewmate with nothing left to do.
   So does a task whose own browser is in the captain's hands - paused for the captain's help, being taken, or the captain's (`browserWithCaptain`, counted in `decisionCardOpen`; `docs/task-browser.md`, "Taking control"): the captain's Return control is the crewmate's one wake, so the card behind it may already be answered.
5. Moving, nothing: guidance that will still be delivered (including a row waiting out its backoff, `InboxStore.hasDeliverable`), a background job inside its bound, a captured settle, a timed wait on its gate (a due one is the sweep's, on the same tick).
   A streaming turn never reaches the reconciler; the quiet watchdog owns it, and after twenty quiet minutes it first asks the crewmate's live session whether the turn still works, ending one that no longer does as interrupted so it reaches the reconciler (`docs/helper.md`, "Whether a turn works there").
   For a crewmate on another computer the question goes first and the alert after: the "may be stuck" note and the first mate's quiet wake wait for that computer's answer, and go unless the answer ended the turn here.
   That pass also answers the app's own reads still open "ask again", and names the call and any unread steer the turn waits behind (`docs/helper.md`, "What a quiet turn waits on").
6. The gate holds it for the captain and no card is up - a wait its crewmate declared with no card of the task up (INF-11): the first mate's turn.
   The clock is read, but the nudge never fires (the crewmate cannot act): the first wake comes at the nudge's time plus ten and carries the gate's own reason (`held: captain-gate`).
   The repeat and the host's card follow as below.
7. A typed cut-off holds its account (`accountHeld`), or the computer that runs work it runs on is out of reach or not yet caught up (`outOfReach`): moving, nothing - the crewmate's turn comes when the account serves again, or once that computer is back and its work caught up here.
8. Otherwise nobody's turn, and the clock is read.

**A gate change restarts the clock.**
A `captain` gate placed or released on an idle record is an act on it, so `idle_since` restarts there and the rungs start over rather than firing on the next tick.
An ordinary note read or duplicate closure notifies its live author; when that starts a turn, its idle clock runs from the turn's end.
Putting a decision aside neither releases its gate nor starts an author turn, and reading a marked saved answer still waits for explicit Done.
Rung 3 stays terminal.

**The rungs.**
Constants beside `STALL_WAKE_MS`, never settings; each is timed from the rung before, so a clock that already ran long still gets its nudge and ten minutes to answer it.

| Idle for | Rung | What the host does | Ledger |
|---|---|---|---|
| 10 min | 1 | One typed steer to the crewmate, once per episode (`IDLE_NUDGE_TEXT`, `idleNoteNudgeText` naming the newest note while one is up, or `idleThreadNudgeText` in the step-2 case, naming each card whose captain reply waits so the crewmate answers that card rather than another of its own, INF-990 friction 4). A task the first mate declared an internal step (`shape.internal_step`) is asked for its answer and told it takes no merge card (`IDLE_STEP_NUDGE_TEXT`, or the note's words with `step`; FI3-801). Any other task whose deliverable is an answer is told it takes no merge card and asked for its answer card or a report with `finished` (`IDLE_ANSWER_NUDGE_TEXT`, or the note's words with `answer`; INF-1732). Skipped when the last turn failed at the provider: the retry owns that. | `rule:idle-nudge`, routine |
| 20 min | 2 | One wake to the first mate carrying the ways out as a hold does (`holds.ts`, `idle-stall`: steer, park in the backlog, cancel, discard), as typed facts rendered where served (`docs/inbox.md`, "The wake envelope"); while a note is up it names the note, never "no card up", and in the step-2 case it names the cards whose captain reply waits. | `rule:idle-wake`, captain |
| 50 min | 2 | The same wake again, "the second time", if the first was ignored. | `rule:idle-repeat`, captain |
| 80 min | 3 | The host raises its own card on the task, in place of any further wake. | `rule:idle-card`, captain |

A wake is **ignored** when thirty minutes pass with no first mate action on the task, read from its timeline: a steer, an interrupt, or a card of its own (a settle that went through closes the task).
The thirty minutes count from the later of the wake's delivery and the first mate's last such action.
A wake still waiting on the first mate's lane - its seat paused on a cut-off, or the lane backing off after a failed turn - is not ignored: nothing has read it (the owner's Q2 a, W1 S9, backend-neutral).
The ladder holds its clock at each tick the wake still waits (`InboxStore.holdsUndelivered`), so the thirty minutes start at its delivery, and a paused seat's one card speaks for the pause instead of a stall card per idle crewmate.

**The host's stall card** (`card-stall-<task>`, author host, so it presents as attention): a captain decision of 2026-09-26 that revises the card rule
- the first mate let two wakes go, so the work cannot move without the captain.
  Its title says how long ("<title> has been stuck for 1h 20m"), its body what the crewmate last said or the problem its last try ended in, what the ladder already did, what each button does, and that anything else goes in a reply.
  When its newest report declared a work wait, the body also says what it still waits on and the recovery attempts the first mate recorded since ("Self-resolving work waits" above).
  **Nudge** is the nudge again with the captain's authority (host op `continue-task`, naming a note up as rung 1 does), **Back to backlog** parks the task where its wait shows (host op `backlog-task`, `HostOps.moveToBacklog`; `docs/task-board.md`, "A started task in the backlog"; it took Keep waiting's place, the captain's pick on INF-3143's build, since a card holds three buttons), while the minus only puts it aside with its gate still held, **Discard** is the host's `settle discard` with the unlanded-work guard, whose refusal names its ways like any settle refusal (INF-1670: the captain removed Drop task and left nuanced operations to the reply).
  A reply under it goes to the first mate, which answers in its thread (`docs/card-threads.md`, "The stuck alert's reply row").
  While it is up the task is the captain's turn and nothing repeats.
  It leaves on a choice (putting it away keeps its card minimized, and the task's standing line stays), when the task moves (a new turn retires it, unless a reply under it still waits on the first mate's answer), when the task goes back to the backlog, or when the task closes.

**Parking an unchanged blocker** (INF-3143, the captain's direction A, "Park it where it shows up"): every Nudge or steer starts a new episode, so a blocker no steer can change would run the ladder again and again.
The backlog is where such a task rests: the stall card's Back to backlog and the stall wake's park way (`update_task` `start_policy` on-request) both run `HostOps.moveToBacklog`, which takes the stall card down, and nothing on the ladder reads a task in the backlog.
The first mate parks a stalled task on its own judgment when the blocker is one no steer will change, as well as when the captain asks.
News from the app that reaches it there wakes the first mate once per stay (`backlog-news`), so a blocker that changes is not missed.

**The first mate's closing note** (INF-547, the captain's choice of 2026-10-19) is the other card the host raises about work: started work the first mate closed without the captain's click, when it is the answer to the captain's message, at most one for each message (`docs/task-capture.md`, "How a message ends").
It carries the first mate's own sentence, has no actions, places no gate, and no rung reads it (`docs/card-authoring.md`, "Work that closed without the captain's click").
Work no message of the captain's covers gets it only for a merge or a release (INF-1467).

**A request the first mate leaves unanswered is raised again** (FI3-714, filed from FI3-710).
A crewmate's request that the first mate act wakes it once, at the report (row 0a).
A woken turn that ends without acting on it used to leave the request with the crewmate's open card holding the turn, which nothing climbs past.
So while the request stands - from the report that asked until the crewmate's next turn starts - and the first mate has not acted on the task since, the reconciler reads the first mate's turn (step 3).
The first mate has acted when an event of its own lands on the task's timeline after the request - a steer, an interrupt, a card, an answer, a change, a link, a close - never the `decided` record each of its turns about the task leaves, or when a task built on it (its basis, by key or id) or under it (its parent) is created or started since, whether that task is still open or has merged or been dropped (`IdleLadder.firstmateActedSince`, INF-976).
A task created or started before the request answers no later one.
What the act was is never judged, only that one took effect, as answer delivery judges a captain message (`docs/task-capture.md`).
Work declared finished with no card of its own up is raised the same way, from the report that declared it, its `idle-asked` saying it waits for the first mate's close (INF-1428).
The report's own wake (row 0a, or row 1a for finished) counts as rung 2's first wake, sent when the crewmate asked, and the rung's rules run from there.
The clock holds while a wake about the task waits on the first mate's lane.
Each thirty minutes without an act bring a reminder, `idle-asked`, which says the request again in the crewmate's words beside its report (`rule:idle-repeat`), two in all (`ASKED_WAKES`).
The report's wake and each reminder name the work already built on the task, open or closed, with its status, closing reason and change (`TaskService.graph.builtOn`), so the first mate reconciles them before it files or starts more (INF-976).
Nothing nudges the crewmate, and no card goes up: the captain chose on 2026-10-10 that the app reminds the first mate itself rather than ask the captain to send what it can send.
After the last reminder nothing more is sent, and the task's crew line carries its `stalled` fact, as it does from the first reminder on.
An act of the first mate's ends all of it: the next reconcile restarts the clock, once, read off the record - the ladder's last act fell after the request and before the act (`endAnsweredAsk`).

**Every captain turn sees it.**
Once the ladder has acted and while the turn is nobody's, `crew_status` carries `stalled 1h 20m · 2 wakes`, and the task's crew row in the first mate's context carries the time the idle began and the wake count.

**Restarts and sleeps.**
The clock is the saved `idle_since`; a record from before the clock, or one a quit interrupted mid-turn, starts its clock at the first reconcile that sees it.
A record overdue when the app opens acts at the boot sweep, coalesced with its siblings into one first mate turn (`WAKE_COALESCE_MS`); the rung and count survive, so there is no storm.

**A bound on background jobs as proof of life** (the captain's Q9): a running job counts as moving for `JOB_BOUND_MS` (the turn's own two-hour bound) and no longer.
Past it, one wake names the job's command (`rule:job-bound`), once per job even across a restart (`docs/inbox.md`, "Once per fact"), and the job stops counting, so the ladder climbs from its first rung.
Nothing kills the job - the bound demands inspection, never an automatic kill.
The job registry exposes the oldest running job per owner (`JobManager.oldestRunningJob`).

**A check-back on a running job** (INF-1244): a silent job counts as moving for its whole bound, so a crewmate whose turn ends with one running names when it looks again.
Its report's `check_back` carries the minutes until then and what it waits for; the host keeps it on the record (`delivery.checkBack`) and sets the task's `at-time` gate, so the task reads as moving until then (row 3) while its job runs.
At that time the sweep ends the wait with one steer that names the task's oldest running job, its command and how long it has run (`timed-wait-over`); a check-back with no job behind it ends silently ("Self-resolving work waits" above).
A job that ends first, or any other turn, clears it with the rest of the report's declaration.
A turn that ends with a job running, no `check_back` and no wait on the captain or finished work gets one steer asking for a time, once per job (`check-back-ask`, `CrewTurns.askForCheckBack`).
A check-back later than the bound never silences it: the job bound stays the backstop.
`crew_status` and the first mate's crew line carry the oldest job's age and command (`job`), how long ago the crewmate last reported (`reported`) and the check-back (`check_back`), so the first mate reads durations rather than guessing them.
A job this Mac cannot see is named as its runner names it: a computer that runs work names its Pi shell's oldest job with the count (`docs/helper.md`), and work no one named is a Claude client's here or that computer's by name (`unnamedBackgroundWork`).

**A provider outage is not idleness.**
A turn the provider failed releases its guidance for the honest retry (`docs/inbox.md`), so the row stays deliverable and the task reads as moving; the retry's own wakes (the first failure, fifteen minutes still down, recovered) are the first mate's news of it.
A lane stuck at its provider is the exception (`docs/inbox.md`, "Stuck at its provider"): its kept rows are not deliverable, so the task reads as idle and the ladder climbs from it while the first mate has not answered its `provider-stuck` wake.

**Nor is a cut-off.**
A lane whose account a typed cut-off holds keeps its guidance (`docs/inbox.md`, "A lane on a withheld account"), and the hold is its own witness (`accountHeld`), read after the gate: the crewmate's own turn reads as moving, so nothing climbs - not even the thread nudge, which nothing could answer yet - while a card the first mate owes is still owed and its reminders still come.
The account speaks for its lanes: one `provider-cut-off` wake when a typed cut-off pauses them and one `provider-back` when it ends, each once per cut-off even across a restart, each recorded as a `sort` row per task it names (`rule:provider-cut-off`, `rule:provider-back`) with its facts.
The still-down wake stays quiet while a cut-off stands.

**Nor is a computer out of reach.**
A task whose crewmate runs on a computer that runs work, while that computer is out of reach or back and not yet caught up, is its own witness (`outOfReach`, `CrewFacts.outOfReach`), read where `accountHeld` is: its turn goes on there unseen, so nothing climbs and the quiet watchdog skips it, while a card the first mate owes is still owed.
The feed says once that the computer is out of reach and once that its work caught up (`docs/helper.md`, "The home's side").

No model is in the loop (Q5): every step is code over typed state, and the ledger rows are the evaluation set any later model question is measured against, in its own captain call.
Nothing here closes, lands, merges or discards anything.

Two edges carried from the specification: the card map and the card store are written by adjacent synchronous calls, not one transaction - a crash between them is the window the gate sweep already tolerates for first mate decision rows.
A crewmate declares a wait with `report`'s `waiting_on_captain`, which stores `delivery.captainWait` (`TaskService`); a typed wait on work nobody has started is row 2a.
The host does not parse a free-text "I am waiting on X until Y".

## What it writes

Every sort is one `sort` row of the decision ledger (`decisions`, migration 50; `docs/decision-models.md`, "The decision ledger"), with the rule that sorted it in `rule` and the wake's typed facts beside its served text, written through the `CrewTurns.recordSort` seam into `DecisionStore`; the wake rides the store's own transaction, so a decision and its effect still commit together.
Read through `supervision_outcomes`, the view over those rows, a rule's sort still names its rule where the triage model's name used to sit (`model = "rule:<id>"`).
The verdict vocabulary is unchanged: `routine | captain`.
So `flag_missed_escalation` (C3), the miss deriver (C2), the supervision-turn extractor (G1) and the replay scorer all keep reading one ledger - a rule-sorted row simply has no transcript to join, which G1 already reports as a miss with a reason, the way it always did for a host-sorted repeat.

There is no user surface.
No card, no setting, no second feed line: a report is one line, its own.

The supervision session is retired.
Its ledger rows live in `decisions`; Observe does not open the retired session, and that removal deletes no history.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The whose-turn rule (S7c, captain call C7 A "heuristics only", 2026-09-20; `docs/report-sort.md` is the one home; `src/core/orchestrator/reportSort.ts` + `CrewTurns.sortReport` and `CrewWatch.reconcileIdle`).
  A crewmate's report is sorted in CODE from typed state at its call site, never by reading its prose: (0) the captain wrote the newest message in one of the task's card threads - the crewmate's turn, above the card branch because the captain has spoken since that card went up - no wake; (1) an open DECISION card for the task is the captain's turn - a note never holds it, since `cardWord` derives the word from the actions alone - no wake; (2) filings this turn wake; (3) a running job, rows pending on the task's lane or a `pendingSettle` is the crewmate's turn - no wake; (4) none of those and the host can see ALL of this backend's work: nobody's turn, wake NOW with the report's own words; (5) it cannot: wake now too (INF-11), the rule's name keeping that the host could not tell.
  Observability is DECLARED, not guessed - `ControlProfile.backgroundWork` is `host` for Pi (its crewmate's bash is the host's own tool, so a job is in the registry and its exit is a lane row) and `client` for Claude, as it is for a task whose transport is gone.
  The stall check it once armed was replaced by the idle ladder (2026-09-26, "The idle ladder" above): one reconciler over every idle record, on a durable clock.
  Every sort is one `supervision_outcomes` row through the `recordSort` seam with `model = "rule:<id>"` where the retired model's name sat - verdicts stay `routine | captain`, so C3, C2, G1 and the replay scorer keep reading one ledger - and the wake rides the store's transaction.
  A review task still bypasses it entirely and records nothing; its builder is sorted like any task, with its open review's verdict one more witness (INF-1876).
  No user surface: a report is ONE feed line, its own.
  RETIRED with the model: `SupervisionAgent`, `supervisionSession.ts`, `buildSupervisionSystemPrompt`, `createSupervisionTools`, the rolling transcript, the supervision lane, the `supervision_note` event, and the per-task claims (`claimForSupervision`, the claim-queued lane parking, `steerForSupervision`, the bounded settle/interrupt wait) - never bring back a "try again in a moment" refusal.
  Observe no longer lists the retired session; its historical files and exporters remain.
  The replay had to learn two recorded facts for this: the job registry is reconstructed from a crewmate session's own `Still running as background job <id>` / `[job] … finished` pair (without it branch 3 is unreachable and the wake count is an upper bound), and an escalation is scored from the rule's `captain` verdict with one ref alias (`reported:X` also matches the retired prefix's `escalated:X`); an escalation the recording cannot answer stays out of `escalation_precision`'s denominator.
  `reportSort.test.ts`, `crewTurns.whoseTurn.test.ts` and `tests/e2e/report-sort.spec.ts` are the binding tests.
