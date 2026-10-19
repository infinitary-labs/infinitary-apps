# The durable inbox

Every steer and wake the host delivers rides one durable, lane-per-recipient inbox.
The whose-turn rule that decides whether a report wakes anyone is `docs/report-sort.md`.

## The honest retry

Captain-approved 2026-09-26 (the idle crew recovery specification, Q1: backoff forever).
A delivery attempt is a model turn.
A provider failure spends no attempt.
A task lane has nowhere else to go, exactly as the first mate's lane has none.

- A `turn_failed` that `src/shared/authFailure.ts` does not classify as a sign-in problem releases its rows through `InboxStore.releaseAfterProviderFailure`: the attempt is given back, `failures` counts one more, `failing_since` remembers when the row first failed, and `next_attempt_at` is the backoff - 90 s, 3 min, 5 min, 10 min, then every 15 min, forever (`INBOX_BACKOFF_MS`).
  Nothing is ever parked for a provider failure; the row is delivered on the first attempt after the provider answers.
- A provider error Pi retries inside the same prompt is not a `turn_failed` until that retry fails or is cancelled (`holdingRecoverableAttempt`, `src/core/pi/session.ts`).
  A retry that succeeds is a clean turn: its report is kept, and the guidance is acknowledged.
  Each attempt's measured usage is recorded either way; only the provisional failure and its closing text are withheld.
- The provider answering on a lane - any clean turn - ends its outage (`InboxStore.endOutage`): every row still backing off is due at once.
- Attempts still count what the ladder was built for: a steer or a resume that throws, and a sign-in failure (which also raises the sign-in card, once).
  Three of those still escalate loudly and stop.
  A refusal's row is due one `INBOX_GRACE_MS` after its attempt began; `pending` reads `next_attempt_at` instead of a fixed grace.
  A development or end-to-end run may shorten that grace with `INFINITARY_INBOX_GRACE_MS`, so a journey that quits mid-turn sees its redelivery without waiting 90 s; a packaged build always uses `INBOX_GRACE_MS`.
- Wakes to the first mate, per outage: one at its first failure, one if it is still failing fifteen minutes in (the captain: "'30 minute still down' is too late. can we make it 15?"), and one when an attempt succeeds after two or more failures.
  The still-down wake is once per outage even across a restart (its once-identity, "The wake envelope" below).
  Each failure is still its own line on the task's timeline, and identical repeats keep deduping as they always have.
- Boot's `resetInFlight` already re-delivers, so a quit during an outage heals on its own.
- The Claude crewmate's provider error (a `result` the client marks as an error) is a `turn_failed` too: the session settles the turn the way Pi does and stays steerable, so its lane rows take the same retry instead of the task closing as failed.
  A transport that throws - the client process ending - still closes the task as failed.
- The first mate's lane takes the same retry (W1 S9): a seat turn that failed at the provider releases its batch through `releaseAfterProviderFailure` instead of spending an attempt, and a clean turn ends the lane's outage.
  A spent allowance's rows are never due before its reset (`notBefore`, the cut-off's `resetsAt`).
  A turn that threw still spends its attempt and is due one grace later.
  A typed cut-off pauses the seat instead of retrying (`docs/architecture.md` §16.8): the captain's live words are parked on the lane as theirs, nothing is attempted while it is paused, and the rows are due at once when it serves again or the captain chooses "Try again".
  Any other failed seat turn puts the captain's live and steered words on the lane through the same backoff, so the row is their one copy: the failure card's Retry makes the lane due now instead of re-sending them.

While a lane's guidance is deliverable, the idle ladder reads the task as moving (`docs/report-sort.md`, "The idle ladder").

## A steer no turn took in

One rule for every rolling session, on both backends (the session contract's `takeUndeliveredSteers`, `src/core/session/session.ts`): a steer the session accepted but no turn took in - it landed after Pi's run made its last look at its queue, or no turn of the Claude client acknowledged it - comes back at the turn's end instead of being lost.
Sessions deliver steers oldest first, so what comes back is the newest.

- **The first mate's lane.**
  `FirstmateAgent.redeliverUndeliveredSteers` parks the captain's words the session gave back on the lane as theirs, and the drain serves them as the next turn.
- **A crewmate's lane.**
  The supervisor records the inbox rows of each push it steered (`steeredInboxIds`) and maps the count the session gave back to the newest of them, which assumes a session gives back a suffix of what it was sent.
  Those rows are re-parked, not acked (`InboxStore.reparkUndelivered`): due at once with the attempt given back, so the next turn reads them.
  A task that finishes re-parks them before it lists anything as never delivered.
- **Known tail race.**
  A steer pushed after the Claude client said `idle` but before the session read that `idle` can be delivered twice - the inbox's at-least-once, never a silent loss.

## A turn a quit or crash cut

A quit or a crash cuts the turn a lane's rows were in and leaves those rows in flight: nothing releases them on the way down.
The boot's `resetInFlight` puts them back on the lane and gives each its attempt back, the way a provider failure does, because a cut is not the crewmate refusing the message.
The row counts the cut instead (`cuts`, migration 74), so quitting three times inside one long turn never sets its message aside, and its three tries stay for what the ladder was built for.
It stays due one grace after its cut attempt began, so the next launch's sweep delivers it once that grace has passed.

- **The replay says what it is.**
  On a crewmate's lane, each cut row opens the turn that serves it with `RESTART_REPLAY_NOTE` (`laneTurnText`, `src/core/orchestrator/wakes.ts`): the app closed while the turn on it was running, that turn may already have done part of it, and the crewmate checks what took effect before it repeats a step.
  The message follows word for word; a row the turn carries beside it that no quit cut has no note.
  The excerpts that quote a lane's guidance (`laneText`: guidance set aside, guidance never delivered) carry no note.
- **The first mate's lane** gets its attempts back the same way; its served turn is unchanged.
  A drain the quit catches before its turn starts stops there, so the rows it read stay on the lane undelivered and the next launch serves them.
- **A lane whose turn runs on a computer that runs work** stays in flight at boot, its attempt spent ("A lane on a withheld account", below).
- **What it costs.**
  A turn that itself takes the app down is replayed at every launch, since a cut never spends a try; the three tries still bound every refusal.

## A lane on a withheld account

The cut-off contract on crew lanes (W1 S8; `docs/quota.md`, "Typed cut-offs"): a typed cut-off is a fact on the account, and a crewmate on a cut-off login waits without spending model turns until a fact changes.

- **Held before delivery, on one predicate.**
  A task lane is held while a typed cut-off stands on its account (`IdleLadder.cutOffHolds`, over `AccountVault.cutOff`): a refusal, a lost sign-in, or a spent allowance until the vault clears it at its reset.
  The wakes below read the same predicate, so a lane is held exactly when the first mate has been told.
  A held lane is not attempted at all - no attempt spent, no backoff advanced, no session resumed.
  Every path that delivers a lane checks it: the idle boundary, the tick's sweep, a steer (which answers `recorded-held`: kept, goes out when the account answers again, and the first mate will hear it; a captain reply's card thread says so in its waiting line, `docs/card-threads.md`), a job's result, and a resume.
  A resumed task keeps its account even when it is withheld (`AccountSelector.reselectForResume` reads only `connectedSync`), so the record's account is read too, and the durable fact holds from the first read after a restart.
  The hold is a witness (`accountHeld`) of the crewmate's own turn only: the idle ladder neither nudges it nor wakes about it, but a card the first mate owes (a captain gate with no card up) is still owed, and its reminders still come.
  No new gate kind: the `quota-reset` gate clears only queued rows, and the lane predicate needs no sweep branch.
- **A computer out of reach holds its lanes the same way.**
  A task whose crewmate runs on a computer that runs work is held while that computer is out of reach or back and not yet caught up (`CrewSupervisor.outOfReach`, read inside the same `laneHeld`), on every path above; a steer to its running turn answers `recorded-held` too, and goes into that turn once it is back (`docs/helper.md`, "The home's side").
  The boot's `resetInFlight` leaves such a task's in-flight rows in flight, because its turn went on there; once that computer is back and caught up, a row no turn there took goes back on the lane.
- **A task on another computer is held by that computer's own account.**
  Its crewmate runs on that computer's own sign-in (`docs/helper.md`, "Its own sign-ins"), so no cut-off on this Mac's accounts holds it.
  A cut-off its turn meets there is recorded on that computer's own account, and that computer tells this Mac with its sign-ins, whose rows carry it (`AccountView.cutOff`).
  The one predicate reads the account the task's conversation there is bound to (`CrewMachines.accountOf`, keyed `<account>@<computer>` so it never meets one of this Mac's ids) and the cut-off that computer last said stands on it (`cutOffOf`), so its lane is held on every path above, the same way.
  Before such a turn ends here, this Mac asks that computer its sign-ins again (`DeviceSignIns.refresh`), so the turn ends held even when the word that computer sends unasked comes late.
  The wakes below name it with where it is, "Claude on Mac mini", and a cut-off that computer has said nothing of since this Mac started is neither held nor called over (`known`).
- **Every other reason an account serves nothing holds nothing.**
  No client, an outdated one, or a read that says not connected (Pi or Claude) records no typed cut-off, so the turn is attempted and fails the way it always has: the sign-in card and the failed-turn wake follow.
- **A spent allowance waits for its reset.**
  The turn that meets it also releases its rows with `releaseAfterProviderFailure(ids, {notBefore: resetsAt})`, so even without the hold the next attempt is the later of the backoff and the reset.
- **What the hold cannot stop.**
  A Claude client may start a turn of its own when background work it runs finishes (`startAutonomousTurn`); the host observes it rather than delivering it, so one refused request can still go out.
  It spends no inbox attempt and folds into the standing fact.
- **One wake when it starts, one when it ends** (`IdleLadder.checkCutOffs`).
  `provider-cut-off {provider, class, since, resetsAt?, tasks}` goes out once per cut-off (`once: cut-off:<account>:<since>`) while a cut-off stands on an account with open tasks, naming every one; it replaces the failed turn's own wake (the sign-in card still goes up for a lost sign-in), and the lane's still-down wake does not fire while it stands.
  `provider-back {provider, since, tasks}` goes out once when that cut-off is gone - the same one predicate; a failure after it speaks for itself (`once: provider-back:<account>:<since>`): the lanes' kept rows are due at once (`endOutage`) and delivered, and the sign-in card a held task's turn raised comes down, since nothing is left to sign in to (`crewSignInCardId`).
  The cut-offs already told are read back from their once-names (`InboxStore.wokenNames`), so a restart neither repeats the first nor loses the second.
  Both go out under no task ref, so a task closing never purges them.
  Each writes one `sort` row per task it names, with its facts (`rule:provider-cut-off`, `rule:provider-back`).
- **When it runs.**
  On every tick, when a turn records a cut-off, when the vault records or clears one (`AccountVault.onCutOffChange`), and when a computer that runs work says anything new of its sign-ins (`DeviceSignIns`), so a held lane goes on the moment a fact changes rather than at the next tick.
- **Nothing moves a crewmate on its own.**
  The first mate decides any re-routing with its existing tools (a follow-up on another model).

## Taking back a message

A sender may take back or rewrite a message no turn was handed yet, and never one a turn holds.

- `InboxStore.withdraw(ids)` deletes the rows that are not in flight and answers their ids; a row in flight stays, to be acknowledged or released as usual.
- `InboxStore.revise(id, body)` gives a row that is not in flight a new body, with its id, place, attempts and backoff kept, and answers false for a row in flight or gone.
- `InboxStore.get(id)` reads one row, in flight or not, so its sender can tell where it stands.

Automation is the one sender that uses them (`docs/automation.md`, "Deliveries"): a pause, an edit or a delete takes back a scheduled prompt the first mate has not read, and a later occurrence folds into the one still waiting.

## The wake envelope

The primitives review's P3 (captain-approved 2026-09-26): a wake carries typed facts and the ways out, and is rendered to prose once, where it is served.
The inbox row is the envelope `{v, origin, ref, facts, ways?, text?}`: `origin` and `ref` are the existing columns (the origin is the wake's kind for the reader), and the `payload` column holds `{v, facts, ways}` for a wake whose family has moved onto typed facts, or `{v, text}` for prose (`src/core/orchestrator/wakes.ts`; the store's side is `InboxStore`).

- **One renderer.**
  `renderWake` turns an envelope into its prose, and nothing else composes a wake's sentence: the one drain (`drainWakes`, which the first mate's `servedTurn` frames row by row and a crewmate's lane joins with `laneText`), the steer path's live steer, and the whose-turn ledger row, whose text the replay scorer matches against the served turn.
  It is pure, so every copy is the same bytes.
  `facts.kind` names the template; a fact the host computed with a side effect (an excerpt that spills to an overflow file) is computed once, by the emitter, and carried as the fact.
- **Byte-identical.**
  Moving a family changes no served text: its tests pin every variant's served text to what the prose template produced,

- **Dedupe by what a wake says.**
  A typed wake's identity is `{origin, ref, facts}` - the ref by the lane query, origin and facts as a hash of their key-sorted JSON - so a rebuilt wake with the same facts is not new information whatever its wording.
  Prose keeps the hash of its text, so a row queued or acked before the envelope still dedupes the same prose after it.
- **Migration 48** wrapped every queued row as `{v: 1, text}`; no hash changed and no published view reads the inbox.
  A payload that is not an envelope reads as the prose it is.
  Reversible: each payload back to its rendered prose, with the text's hash.
- **Once per fact.**
  A wake that goes out once per fact names it: `once` on the typed wake (the still-down wake's is its outage, by when it began; the job bound's is its job, by id and start).
  `enqueueWake` records the name for the wake's task in `inbox_once` (migration 49), in the transaction that queues the row, and never queues a wake with that name about that task again; the emitter reads `InboxStore.woken` first, so a repeat spends no ledger row and spills no overflow file.
  The content dedupe above cannot carry this: it sees only a lane's newest row and one ack for five minutes, and these wakes carry per-emission measurements.
  No record that already existed could either - the task timeline is the captain's history, and the whose-turn ledger names no fact and records no outage wake.
  A task's close purges its names with its rows.
  Reversible: dropping the table undoes migration 49.
  A host steer on a task lane can name one too (the check watch's, and a browser return's, by its run, browser and count of returns): `enqueueSteerOnce` records it with the row, about the task, and the emitter reads `woken` before it steers.
- **A captain's Start is a wake (`captain-start`).**
  Start, a drag to Working, Start again and a host card's start-task press hold the task as Starting (`CrewSupervisor.askFirstmateFirst`) and queue `captain-start {move: "start"}` on the first mate's lane with the press's `via` and `panel`.
  The first mate applies the standing directions that bear on the task with `update_task` (`direction` names each one on the history line), then `start_now`, which finishes the held Start as the captain's own.
  The inbox row is the saved copy: after a quit the next shared tick (`resumePendingStarts`) shows the task Starting again, and the row is redelivered as every in-flight row is.
  The app starts the task as it is, and the record's Activity says why, in each case where the first mate cannot answer: its seat is paused or its lane waits out a provider outage when the press happens (typed facts, `FirstmateAgent.cannotAnswerNow`); the turn that read the wake failed or broke; that turn ended clean without starting the task; or the row is gone.
  A busy first mate is none of these: the Start waits for its turn, no timer decides, and unreadable directions hold it as they hold all new work (`docs/knowledge.md`).
  The ready sweep skips a held Start.
  A drag to Queued that waits sends the same wake with `move: "queue"`: directions apply to the record, nothing is held, and the sweep starts the task later.
- **Every wake the host composes is typed.**
  The idle ladder - the nudge (`idle-nudge`, which also rides the stall card's Continue), the stall wake (`idle-stall`), the wake a captain gate owes (`idle-owed`), and their repeats, and the two reminders of a crewmate's request the first mate left unanswered (`idle-asked`, `docs/report-sort.md`); the round caps - the CI cap's one wake (`ci-cap`) and the findings wake the review cap rides (`review-cap`, carrying that wake's `review-verdict` facts as `findings` and the cap's typed `owner`); the honest retry's outage wakes (`outage-failed`, `outage-still-down`, `outage-recovered`), the cut-off wakes (`provider-cut-off`, `provider-back`) and the job bound (`job-bound`); a crewmate's report (`report`, naming its open review when that review's last verdict was findings or blocked), a reviewer's (`review-verdict`, `review-passed`, `review-unstated`, `review-orphan`), a failed turn with no guidance to retry (`turn-failed`), a personal workspace commit that failed at a turn's end (`commit-failed`, `docs/personal-panels.md`) and a failed task (`task-failed`); a settle the captain chose (`settled`) and an answer's close (`answer-closed`); guidance set aside (`guidance-set-aside`); the quiet watchdog (`quiet`, `long-turn`); a queued start (`queued-started`, only for a start whose wait ended - never one the first mate or the captain asked for - naming the model that took work the captain named a model for, and `queued-start-failed`, which says when the captain pressed Start), a wait that can never end (`dead-gate`) and the ask-first wait (`reasoning-wait`); a card choice (`card-choice`, worded for the first mate or the crewmate by `to`, a crewmate's with `browserGone` when its request card's browser was gone, `docs/task-browser.md`; an effect-free closing choice on a first mate card is captain-origin `[user]` speech, not an operational wake), the captain's answer on a setup card (`project-setup`, told once, `docs/fleet.md`); a job's exit (`job-exit`, `[fm-op]` or `[job]`), a schedule (`scheduled`) and the welcome (`welcome`); and the host's steers on a crewmate's lane - a renewed conversation's reason (`conversation-restart`, once per renewal, served first by `laneTurnText` so it rides the message that brought the crewmate back, `docs/claude-client.md`), a captain's thread reply (`thread-reply`), a timed wait's end (`timed-wait-over`), the check watch's wakes (`checks-settled`, the first failed check and the end, `docs/forge.md`), the captain's return of a task's browser, or the captain's grant of a saved sign-in to it (`browser-returned`, with `saved` for the grant; `docs/task-browser.md`), any guidance whose pictures the message keeps copies of (`attachments-kept`, which wraps it and names the copies), and the captain's guidance while his kept merge approval stands (`kept-merge-guidance`, which wraps it inside any pictures and names the mark that holds the merge, `docs/delivery-rigor.md`).
  A row from an older build that could not keep them is `attachments-dropped` and still says so.
  The captain's own turn, live or parked on the first mate's lane, is framed the same way (`captain-turn`: his words under `[user]`, and the pictures' copies it names in `attachments`; a parked copy carries its message's id, `askId`, so the turn that serves it judges that message).
  The answer-delivery retry (`answer-missing`, `docs/task-capture.md` "Answer delivery") quotes the captain's words once for the message nothing took effect after.
  It goes out once per message (once-name `answer-repair:<askId>`), skips the coalescing window, and is served alone: never batched with another row and never carried on a captain's turn.
  Each cap carries the cap it reached, so a queued row words the cap it was about.
  The seams a wake reaches the first mate's lane by (`FirstmateAgent.notifyOp`, `FirstmateHooks.notifyOp`, the ladder's `notifyOp` and `steer`) take only a typed wake.
- **What stays prose** is what an agent wrote, never a sentence the host composed: the first mate's steer and a dispatch brief - and the recorded job result the replay hands `deliverJobResult`, the one seam left wide for it.
- **A row an older build queued** is served as it was: prose as itself, and a `review-cap` from before its findings were typed by its `report` prose.
  A known kind whose facts this build cannot word is served as data, never thrown, so one row cannot wedge its lane's drain.
- **The replay scorer and the miss deriver read a typed wake by its facts** (phase 6 of the primitives plan, with the one decision ledger; the captain's call of 2026-09-26 carried it there).
  A whose-turn ledger row carries the facts of the wake it recorded, and the miss deriver reads a failed turn or task by them.
  The replay engine classifies each LIVE wake by the facts of the row it was served from, in the recorded half's vocabulary; the recordings are text and stay text.
  A prose row, and every row written before the ledger, is still read by its words.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The durable inbox (captain-approved design `firstmate/data/fm3000-inbox-supervision-port-s1/report.md`; a port of firstmate's inbox-doorbell steering, adapted - NOT copied - to the in-process transport).
  The `inbox` table (`src/core/storage/inboxStore.ts`) is fm_inbox generalized to a lane per recipient (firstmate | task id; the `supervision` lane retired with its reader, and rows a previous version parked there are reassigned to the first mate's lane at boot) with ack-AFTER-handling: rows delete only when the consuming turn ends clean, failed turns release for a 90s-grace retry (3 attempts, then task lanes escalate loudly and stop; the first mate's lane waits forever; since 2026-09-26 a turn the PROVIDER failed spends no attempt - "The honest retry" above), and boot resets in-flight rows (at-least-once - a rare duplicate over a silent loss), giving the cut turn's attempt back ("A turn a quit or crash cut" above).
  Every steer path rides it: the dispatch-time brief is the task's first row, a followup-queue backend's guidance and the captain's busy-session turns are durable, a captain turn steered into the first mate's tail (Pi's run already past its last look at its queue, or ended while the turn is still closing) sits unread in Pi's queue with its row acked, so the turn's end takes it back and re-parks it (`FirstmateAgent.redeliverUndeliveredSteers`), a crewmate steer its session gives back at the turn's end (`takeUndeliveredSteers`, on either backend: it landed after the run's last look at its queue) goes back on the lane due at once with its attempt given back (`InboxStore.reparkUndelivered`) so the next turn reads it, and `steer_crewmate` has one honest outcome beyond delivery (`recorded-retrying`; `recorded-queued` was the retired supervision claim's and has no writer).
  A wake carries new information or it does not fire (interaction P0, WI-1/WI-2): a crewmate turn is routed only when it REPORTED - the crewmate `report` tool, else the turn's final message text, which is its session's closing words (`turn_closed`: on Claude, the client's final assistant text, never what its earlier messages streamed), never an earlier turn's text re-sent - so an empty-text end (job result, card click) wakes nobody and the quiet watchdog covers a stuck turn; a report failing `reportPlausibility.ts` is a failed turn, never an outcome.
  Closing a task purges its lane and every wake whose `ref` names it (`InboxStore.purgeTask`, in the close's own transaction via `closeAndPurge`), a wake already in flight for a closed task is acked into a feed line, and a job outliving its task is a feed line; the replays in `tests/fixtures/replay/` pin the counts.
  A wake repeating its lane's last one (same recipient and ref: the newest row, or the newest ack inside `INBOX_DEDUPE_WINDOW_MS`) is not recorded (WI-3, `InboxStore.enqueueWake`, migration 22) - only wake paths use it; steers, briefs, and job results always `enqueue`, and delivery attempts are never deduped.
  The wake diet (P3, WI-13, `WAKE_COALESCE_MS`): the first mate's drain holds the first pending wake 3s for its siblings, then drains pending operational rows as ONE turn (reports, crew failures/stalls, script-fired card choices, queued-task changes, host settles - the five families, `routeCrewEvent` the one router for everything but a report, which `sortReport` answers first); a captain turn is never delayed and carries the pending rows before its `[user]` line, except a Chrome click on a first mate card: that closing choice is its own captain turn with the card id/title and task id, separate from pending operational wakes.
  The window is read from the clock, not a wall-timer, so a replay coalesces from its own frozen clock; `coalesceMs` injects it (0 = immediate) in tests.
  A boot-stranded job is a feed line, not a wake (`services.ts`); a job, or a Claude client's background task, that a restart of a computer that runs work cut off is its crewmate's `job-exit` wake instead, once, saying it never exited (`docs/helper.md`, "Holding a conversation").
  So is each background task a Claude client still ran when the client ended - by itself, or let go of by the quit, here or on that computer - so its crewmate never waits on it: this Mac's crew supervisor tells it at once (`interrupted: client`), and the quit records it on the lane for the next boot's sweep (`quit`, `CrewSupervisor.disposeAll`); a crash here records nothing.
  The replay measures `op_wakes_per_captain_turn` as op TURNS (the report's "turns on operations") and still counts a captain-carried escalation.
  Operational chatter is a feed line, never an `[fm-op]` (WI-5): queued guidance going out as the next turn, guidance a close left undelivered (kept on the task's timeline as a `note` with `data.undelivered`), a job outliving its task, a card the captain dismissed (a crewmate's own card's close is instead a captain steer on that crewmate's lane, the `card-closed` wake, FI3-435), and the receipt of an interrupt the first mate itself requested (fable review Q4a).
  The captain's own clicks wake nobody either: the first mate learns of every real captain resolution - dismiss or Chrome choice - and of every click on a task card's own buttons (Start, Continue, Drop task before or after the start, and the task board's queue and unqueue, written on the task's history with `via: "task-card"`, FI3-695) from the bounded "what the captain did outside this conversation since your last turn" section of its next context block (`renderCaptainResolutions`: one list, newest first, the newest 32 within six hours and a count of the rest); a script-fired choice is recorded with `script:` on the card row and cannot masquerade as that captain resolution.

## Pictures ride the row by reference

An accepted captain message with pictures (main turn or card reply) owns copies of them (`src/core/attachments.ts`) before anything records or acknowledges it.
The inbox row stores the references (id, name, type, size, SHA-256 and a path under the attachments folder), never the bytes.
When the row is served - a prompt, a steer, a resumed task, a drained parked turn - the host reads each copy back and rides it as a Pi `PromptOptions.images` / steer image or a Claude image block.
A crewmate's brief row keeps the captain's pictures its task came with the same way (`docs/task-capture.md`, "Pictures stay with the task").
A copy that is missing or changed does not become words alone: the row stays on its lane, the feed says once that the message is waiting and which picture is unavailable, and it is served when the copy is back.
Delivery is at least once per app message (the row is the one message; a retry never makes a second), with no promise of exactly-once provider inference.
A model that says it takes no pictures refuses them by name (`refuseUnreadablePictures`), keeping the words and the row.

Migration 73 freezes every outstanding `card-explain` envelope as its original prose before removing the live wake kind.
This includes in-flight rows that a restart may deliver again.
The original payload stays in `keep_open_backfill`; delivery metadata and identities remain unchanged.
