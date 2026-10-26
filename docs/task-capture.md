# Task capture: every captain ask lands in a task

Task-system phase P1 (design record `fm3000-task-system-design-s1/report.md`, section 6; captain requirement 1 and decision D1).
P0 made a task a durable record; P1 makes sure nothing the captain says falls outside those records.

## The rule (D1, captain's words)

"if it was an 'answer' to something, that 'something' should have been a task at some point, right? in that case, it should attach to that task. become its own task only when it's truly an independent one-off trivial prompt from the captain that has no connection or consequences to anything else."

So: attach first.
An ask about existing work lands on that work.
A task of its own exists only for a genuinely standalone one-off, and only when the model asserts it.

## Mechanics

1. `inf:converse` opens a `captain_asks` row before the first mate turn runs (`TaskService.openAsk`, policy in `src/core/orchestrator/askCapture.ts`).
   The hint is the task the open card points at: an explicit `taskId` on the turn (the P4 record card), else the visible card's `taskId`, else the decision row a visible first mate decision card carries.
2. The first mate's tool calls attach the current ask to the task they act on, with `attached_via = tool:<name>`:
   - `spawn_crewmate` -> the new task; `steer_crewmate`, `interrupt_crewmate`, `settle_task`, `update_task` (including `start_now`) -> the named task.
   - `emit_card` with `task_id` -> that task: a note is an `answered` event carrying the body, a decision a `card_raised` event whose resolution `act()`/`close()` record as `card_resolved`.
   - `emit_card` decision without `task_id` -> a new `decision` task, open, captain gate `ref = card id`, living exactly as long as the card is on the stack: the captain's choice closes it `done/answered`, a dismiss `dropped/cancelled`, a `close_card` `dropped/superseded`, and the sweep closes one whose card is gone anyway `dropped/superseded`.
     Nothing parks it and nothing brings the card back (cards/tasks/agents P0; migration 28 closed every park row and logged it in `park_row_backfill`).
   - `emit_card` note without `task_id` requires `standalone: true` (lint refusal otherwise, `NOTE_NEEDS_TASK_REFUSAL` in `src/core/pi/cardLint.ts`); it files a `question` task born `done/answered` with the body as outcome.
     Revising the card in place revises the same row.
   - The operate tools that still file through `filingOperations` in `firstmateAgent.ts` are `schedule_prompt`, `record_knowledge` (`docs/knowledge.md`), `flag_missed_escalation`, `flag_duplicate`, `personalize` and `install_plugin` (`setup_repo` and `unregister_repo` are retired); each files an `operation` task `done/settled` with the tool result as outcome, in the repo's project or Scratch.
3. At turn end (`AskCapture.endTurn`) every open ask the backend read closes, apart from one whose words wait on the lane for a retry.
   One nothing attached goes to the hinted task, else becomes a standalone `question` task in Scratch titled by the ask's first sentence with the turn's closing text as outcome; either way `attached_via = host:fallback`.
   A turn that failed at the provider or paused on a cut-off puts the captain's words it read back on the lane, so their messages stay open, and the turn that serves those words again attaches and closes them.
   A message whose words a failed turn keeps for no retry (the live words of a turn that threw, which Retry sends again as a new message) is marked `failed` and still filed.
   A message refused before any turn (standing directions unreadable, no session) closes alone, the same way.
   A quit mid-turn is reconciled at the next boot the same way, apart from a message whose parked words are still on the lane (`AnswerDeliveryCheck.waitingOnLane`), which stays open for the turn that serves them.
   Its question task's outcome reads "hit a problem: the app closed before this turn ended".
   A normal quit leaves the turn it cuts as a crash does: the session it lets go of settles that turn, and a turn that settles once the agent is disposed files no message, acknowledges no lane row and judges nothing.
4. Operational `[fm-op]` wakes open no ask and get no fallback.
   Their tool calls still write the task-side records.

Turn scope is the asks whose inputs the backend witnessed with `input_read`: Pi when the user message enters context, Claude at its acknowledgement.
A captain steer opens its ask immediately, but in-flight tools keep attaching to the previously read ask until the steer is read.
An unread ask stays open without a task attachment or reply from the earlier turn, and its parked captain turn supplies its own read witness later.
Only a turn end that names an ask closes it (`AskCapture.endTurn` takes the asks it ends), so nothing else files a message before the turn that reads it.

## Context block and prompt

The `[fm-op]` context block carries a bounded task index (`tasks (live only; task_id for tools; ...)`: per project counts plus up to 12 rows, 36 total; needs-you first, then active, then open) and an `about:` line when a hint exists.
Closed work is not listed here - it was noise on every turn - and stays reachable on demand through the `tasks` tool's `status: closed`.
`FIRSTMATE_PROMPT_CORE` gained one rule before the six classes: every turn is about a task, find it first, pass its `task_id`, standalone only for a genuine one-off.
The C5 dispatch extractor parses the new lines as noise (`tests/extract-dispatch-corpus.test.ts` pins that the fleet parses identically).

## Attribution quality

`attached_via` is the metric: the share of `host:fallback` rows in `captain_asks` says how often the model failed to name the task.
The floor is code; the ceiling is the prompt, the index, the about line and the pin-by-card.

## Answer delivery

A captain message the first mate read and then did nothing visible about is a hidden answer: its closing words are never a card, and they become the reply line only when something took effect (`docs/composer.md` "The last turn"), so the captain sees no sign it was heard.
The host checks each message for one thing - **at least one action took effect after the first mate read it** - and never whether the answer is right (`src/core/orchestrator/answerDelivery.ts`, the pure rule; `answerDeliveryCheck.ts`, the stateful check; `FirstmateAgent` records the facts).

What counts, recorded where the call succeeds (a typed result, never the words) for every message the running turn had read when it took effect:

- a card shown or revised (`emit_card`, the Settings hand-over card, the app's approval card for a held `use_integration` call);
- the closing words written into the card's replies, for a reply under a first mate card or a done task's kept note (`CardService.recordFirstmateThreadAnswer` returns whether it wrote);
- work started, steered, stopped or settled (`spawn_crewmate`, `steer_crewmate` - including a steer the app only saved because the crewmate's account is held, which FI3-592 owns the status of - `interrupt_crewmate`, `settle_task`, a task dropped or started, a link changed);
- a setting or operation recorded (`create_task`, `update_task`, `schedule_prompt`, `remember`, `forget`, a `record_knowledge` write that changed the collection, `personalize`, `install_plugin`, a flag, an applied `app_change`, which `cancel_schedule` is, a `use_integration` change or send that ran);
- a card closed (`close_card`), and a reaction (`emote`).

Never counted: a refused or thrown call, a lookup (`crew_status`, `tasks`, `locate_project`, `app_state`, `supervision_log`, `knowledge`, `integrations`, a `use_integration` read), a `record_knowledge` call repeating an earlier request, a graph refusal returned as text, and a reaction after a refused card (a refused `emit_card` is saved as an attempt with its typed reason, `crewmate-owns` or `card-refused`, and voids a later reaction).
A message that arrives mid-turn is judged only by actions after it; a steer the session never read goes back on the lane carrying its message id, with none of this turn's facts, and the turn that serves it judges it.

The state is saved on `captain_asks` (migration 62): `delivery` (`pending`, `held`, `covered`, `retrying`, `unresolved`, `legacy`), `delivery_facts` and `notice_card_id`.
Every row from before the migration is `legacy` and never checked.
`TaskService` is the only writer.

The check runs at the turn's end, after reply capture and the first mate's close-out, so the normal output is saved first:

1. Covered: `covered`, quietly.
2. A failed or paused turn judges nothing: its messages are `held`, the failure keeps its card and its honest retry, and the turn that serves the words again judges them (parked rows carry the message id in their `captain-turn` facts).
3. Otherwise one retry: the typed `answer-missing` wake (`docs/inbox.md`), once-name `answer-repair:<askId>`, served alone at the captain thinking level.
   During it every tool that starts, steers, stops or closes work or changes a setting answers with a refusal as text (`ANSWER_ONLY_REFUSED_TOOLS`); `emit_card`, `close_card`, `emote` and the lookups stay.
4. A retry that also leaves no action raises one task-less host notice, `card-ask-<askId>`: the captain's own words escaped, a typed reason when one is known, **Ask again** (default; host op `ask-again`, a fresh captain turn with the same hint, linked `retryOf`) and **Leave it** (runs nothing).
   It never quotes closing words, refusal text or an error, and the host's own record for it files no crewmate task.

Boot reconciles from the saved facts: a message stranded mid-turn is judged as uncovered, a retrying message whose wake was served is judged now, and a message whose parked words are still on the lane waits for them; the once-name and the fixed card id rule out a second retry or notice.
Operational wakes and card clicks open no message and are never checked.
The local model's own no-output check is separate: it looks only at the messages its own turn read.
The replay and the developer evaluations wire the agent with `answerDelivery: "observe"`, which judges nothing; the replay's observational `asks_without_action` row reads the recording (`docs/replay-harness.md`).

## Pictures stay with the task

A captain message's pictures, however they reached the input (pasted, dropped or chosen), are kept as the message's own copies when it is accepted (`docs/composer.md`, "Files"), and its ask row keeps their references in `images_json` (id, name, type, size, SHA-256 and the copy's path under `<userData>/attachments/`, never the bytes).
A row an older build saved holds the types alone and has no copies to name.
Whatever task the message attaches to, by a tool or by the fallback, holds its pictures: `TaskService.pictures` reads them from every `ask` event on the task, in the order the messages attached, so a message about two tasks lands on both.
The `tasks` query by key lists them by name and copy (`pictures`).

The crewmate that takes the task is briefed with them (`CrewSupervisor.briefPictures`): the task's own pictures, then those of the work its brief carries forward - its basis, the task it was discovered or escalated from, the attempt it replaces - each picture once by digest.
As many as one message may carry (`TURN_IMAGES_MAX`) ride the first turn as images; the brief's pictures section, right under the captain's words, names every copy by its path in the task’s `temp/handover/` folder on the computer running it, says how many did not fit, and counts a copy that is gone instead of sending its name as if it were there.
The brief's inbox row keeps the riding copies (`attachments-kept`), so a retried or re-presented first turn carries them again (`docs/inbox.md`, "Pictures ride the row by reference").
`spawn_crewmate` hands the current message's pictures to the brief directly, because the brief goes out before the message attaches to the new task; a planned task reads them from its record whenever it starts, after a relaunch too.
Supported text attachments also keep typed references to their complete overflow copies (name, path, size and digest) on the ask, alongside the picture references in `images_json`.
A task reads those references from its asks and the same source tasks at dispatch; an immediate spawn also receives the current ask’s references before capture attaches it.
Both pictures and complete text files go through the existing verified hand-over writer here or the source-file order there, with private file permissions and digest-qualified names.
A remote computer that cannot receive handed files refuses the start with an update request; a missing or changed text copy refuses the start rather than supplying only its preview.
No helper task is filed, and unsupported files that the composer enters as ordinary path text are not attachments and are not copied.
A `steer_crewmate` carries the current message's pictures with the first mate's guidance, kept on its row the same way; a copy that is gone leaves the guidance to go as words, since they are the first mate's own.
A reply under a crewmate's card already goes straight to that crewmate with its copies (`docs/card-threads.md`), and a reply under a first mate card is a captain message like any other.

## What capture does not do

No card renders a task id.
An open first mate decision card does not light the rail: the strip counts working, idle and queued crew, never decisions.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Capture (task-system P1, design section 6, captain decision D1 - "attach first"; `docs/task-capture.md`): every `inf:converse` opens a `captain_asks` row BEFORE the turn runs (`src/core/orchestrator/askCapture.ts` over `TaskService.openAsk`); the first mate's tools attach it to the task they act on (`attached_via = tool:<name>`), and `AskCapture.endTurn` files whatever is still loose - on the hinted task (the open card's task, or the turn's `taskId`), else as a standalone `question` task in Scratch (`host:fallback`; the share of these is the attribution metric).
  `emit_card` needs `task_id` or `standalone: true` for a note (lint refusal), a task-less decision files an open `decision` task keyed by its card id (the choice, a dismissal or a close_card closes it; nothing parks it), and the operate tools file `operation` tasks through one helper.
  `[fm-op]` wakes open no ask.
  Never add a second ask writer, and never let a first mate card with `task_id` count as the crewmate's card (`cardEmitter` in `crewSupervisor.ts` reads the emitter off the id: `card-fm-` vs `card-<taskId>-`).

Catalog changes, including project settings, file their operation once in the core dispatcher.
`appActionRecorded` attaches a first mate turn’s ask to that operation; `filingOperations` does not wrap them.
Theme, panel arrangement and panel instructions (a `direction` scoped to the personal workspace) use `app_change`; removal stays in `personalize`.
