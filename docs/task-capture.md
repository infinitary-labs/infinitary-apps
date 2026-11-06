# Task capture: every captain ask lands in a task

Task-system phase P1 (design record `fm3000-task-system-design-s1/report.md`, section 6; captain requirement 1 and decision D1).
P0 made a task a durable record; P1 makes sure nothing the captain says falls outside those records.

## The rule (D1, captain's words)

"if it was an 'answer' to something, that 'something' should have been a task at some point, right? in that case, it should attach to that task. become its own task only when it's truly an independent one-off trivial prompt from the captain that has no connection or consequences to anything else."

So: attach first.
An ask about existing work lands on that work.
A task of its own exists only for a genuinely standalone one-off, and only when the model asserts it.

## Mechanics

1. `inf:converse` opens a `captain_asks` row before the first mate turn runs (`TaskService.capture.openAsk`, policy in `src/core/orchestrator/askCapture.ts`).
   The hint is the task the open card points at: an explicit `taskId` on the turn (the P4 record card), else the visible card's `taskId`, else the decision row a visible first mate decision card carries.
2. The first mate's attributing tools accept `ask_id`: a message this turn has read, any open message a finished reply has read (INF-2664), or the empty string for operational work unrelated to a captain message.
   Which message work serves is the first mate's to declare: its description tells it to name the message on work that comes from a click on its card or a report on its work.
   The host checks only typed facts (`AskEnding.nameRefusal`): a message still waiting for its own step is refused as unread, and one that has ended - answered, or its notice closed - is refused with a reason saying it ended.
   Omission uses the latest read message for ordinary direct-request calls.
   The host pins that selection for the action's whole asynchronous execution (`withAskAttribution` and `AskCapture.withAsk`), including pictures and complete text files carried in a brief, and attaches only that selected ask with `attached_via = tool:<name>`:
   - `spawn_crewmate` -> the new task; `steer_crewmate`, `interrupt_crewmate`, `settle_task`, `update_task` (including `start_now`) -> the named task.
   - `emit_card` with `task_id` -> that task: a note is an `answered` event carrying the body, a decision a `card_raised` event whose resolution `act()`/`close()` record as `card_resolved`.
   - `emit_card` decision without `task_id` -> a new `decision` task, open, captain gate `ref = card id`, living as long as its choice remains open, including while put away: the captain’s choice closes it `done/answered`, explicit Dismiss in its record closes it `dropped/cancelled`, `close_card` closes it `dropped/superseded`, and the sweep closes one whose card is gone anyway `dropped/superseded`.
     Putting it away retains the open card and its Tasks row; Show the card brings it back (cards/tasks/agents P0; migration 28 closed every park row and logged it in `park_row_backfill`).
   - `emit_card` note without `task_id` requires `standalone: true` (lint refusal otherwise, `NOTE_NEEDS_TASK_REFUSAL` in `src/core/pi/cardLint.ts`); it files a `question` task born `done/answered` with the body as outcome.
     Revising the card in place revises the same row.
   - The operate tools that still file through `filingOperations` in `firstmateTools.ts` are `schedule_prompt`, `record_knowledge` (`docs/knowledge.md`), `flag_missed_escalation`, `flag_duplicate`, `personalize` and `install_plugin` (`setup_repo` and `unregister_repo` are retired); each files an `operation` task `done/settled` with the tool result as outcome, in the repo's project or Scratch.
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
A captain steer opens its ask immediately, but an in-flight action keeps its selected source even when the steer is read.
New actions can name any message this turn has read, or any open one a finished reply has read; unrelated operational actions select no message rather than inheriting the turn's captain words.
An unread ask stays open without a task attachment or reply from the earlier turn, and its parked captain turn supplies its own read witness later.
Only a turn end that names an ask closes it (`AskCapture.endTurn` takes the asks it ends), so nothing else files a message before the turn that reads it.

## Context block and prompt

The `[fm-op]` context carries the started work in `crew`, the unstarted work as a `backlog` count per project, and an `about` line when a hint exists (`docs/orchestrator-contract.md`, "What a context carries").
Unstarted and closed work are not listed here and stay reachable on demand through the `tasks` tool.
`FIRSTMATE_PROMPT_CORE` gained one rule before the six classes: every turn is about a task, find it first, pass its `task_id`, standalone only for a genuine one-off.
The C5 dispatch extractor parses the new lines as noise (`tests/extract-dispatch-corpus.test.ts` pins that the fleet parses identically).

## Attribution quality

`attached_via` is the metric: the share of `host:fallback` rows in `captain_asks` says how often the model failed to name the task.
The floor is code; the ceiling is the prompt, the index, the about line and the pin-by-card.

## Answer delivery

A captain message the first mate read and then did nothing visible about is a hidden answer: its closing words are never a card, and they become the reply line only when something took effect (`docs/composer.md` "The last turn"), so the captain sees no sign it was heard.
Each message saved from INF-1610 piece 2 on is followed until a card the captain accepts answers it ("How a message ends" below); a message saved before it keeps the older rule, which only checked that at least one action took effect after the first mate read it.
The host never judges whether an answer is right (`src/core/orchestrator/answerDelivery.ts`, the pure rule and the served words; `askEnding.ts`, how a message stands; `answerDeliveryCheck.ts`, the stateful check; `FirstmateAgent` records the facts).

What the first mate did is recorded where the call succeeds (a typed result, never the words) for every message the running turn had read when it took effect:

- a card shown or revised (`emit_card`, the Settings hand-over card, the app's approval card for a held `use_integration` call), with the card's id;
- the closing words written into the card's replies, for a reply under a first mate card or a done task's kept note (`CardService.recordFirstmateThreadAnswer` returns whether it wrote), with the card's id;
- work started, steered, stopped or settled (`spawn_crewmate`, `steer_crewmate` - including a steer the app only saved because the crewmate's account is held, which FI3-592 owns the status of - `interrupt_crewmate`, `settle_task`, a task dropped or started, a link changed);
- a setting or operation recorded (`create_task`, `update_task`, `schedule_prompt`, `remember`, `forget`, a `record_knowledge` write that changed the collection, `personalize`, `install_plugin`, a flag, an applied `app_change`, which `cancel_schedule` is, a `use_integration` change or send that ran);
- a card closed (`close_card`), and a reaction (`emote`).

Never recorded: a refused or thrown call, a lookup (`crew_status`, `tasks`, `locate_project`, `app_state`, `supervision_log`, `knowledge`, `integrations`, a `use_integration` read), a `record_knowledge` call repeating an earlier request, and a graph refusal returned as text.
A refused `emit_card` is saved as an attempt with its typed reason, `crewmate-owns` or `card-refused`, and voids a later reaction.
A message that arrives mid-turn is judged only by actions after it; a steer the session never read goes back on the lane carrying its message id, with none of this turn's facts, and the turn that serves it judges it.

The state is saved on `captain_asks` (migration 62): `delivery` (`pending`, `held`, `covered`, `retrying`, `unresolved`, `legacy`), `delivery_facts` and `notice_card_id`.
Every row from before migration 62 is `legacy` and never checked; every row from before piece 2's migration is unfollowed and keeps the older rule.
`TaskService` is the only writer.

The check runs at the turn's end, after reply capture and the first mate's close-out, so the normal output is saved first:

1. A failed or paused turn judges nothing: its messages are `held`, the failure keeps its card and its honest retry, and the turn that serves the words again judges them (parked rows carry the message id in their `captain-turn` facts).
2. A followed message is `covered` while its own work runs, while a card that can answer it is up, or once its answer is accepted; a message with none of these is missing its answer.
3. A missing answer gets one retry: the typed `answer-missing` wake (`docs/inbox.md`), once-name `answer-repair:<askId>`, served alone at the captain thinking level.
   During it every tool that starts, steers, stops or closes work or changes a setting answers with a refusal as text (`ANSWER_ONLY_REFUSED_TOOLS`); `emit_card`, `close_card`, `emote`, `link_tasks` and the lookups stay.
4. A retry that still leaves the answer missing raises one task-less host notice, `card-ask-<askId>`: the captain's own words escaped, a typed reason when one is known, **Ask again** (default; host op `ask-again`, a fresh captain turn with the same hint, linked `retryOf`) and **Leave it** (runs nothing).
   Ask again loads and verifies the message's retained pictures before accepting the fresh turn, preserving their names alongside the original words and complete text-file references; a picture-only message is sent too.
   A missing or changed picture refuses the whole resend and explains in Activity that the message needs to be sent again with the picture, rather than sending only its words or remaining pictures.
   Older messages with no retained picture copies keep their text-only retry.
   It never quotes closing words, refusal text or an error, and the host's own record for it files no crewmate task.
   The message, and every message joined to it, ends `unresolved`.
5. A card that can answer the message, offered on the stage after its notice, takes the notice back (`AnswerDeliveryCheck.withdrawNotices`, run whenever a card goes up, is revised or leaves its close-out hold, and on every sweep): every message of its chain is `covered` again and waits on that card.
   A crewmate's card still held for its close-out takes nothing back until it reaches the stage, since the captain sees neither until then.
   While its notice is up the first mate may still name the message on work, so that work's card can be the one.
   The message keeps `notice_card_id`, so if it goes unanswered again the same notice comes back, with no second retry.
   An author's explicit withdrawal rechecks coverage through the existing answer-delivery sweep, without accepting the answer on the captain's behalf.
   Putting a decision aside keeps its answering offer available and does not withdraw it.
   A newer message that joined the chain after the notice was taken back has its own one retry, and its own notice.
   A notice the captain answered, with Ask again or Leave it, is gone, and its message stays ended.

Boot reconciles from the saved facts: a message stranded mid-turn is judged as uncovered, a retrying message whose wake was served is judged now, and a message whose parked words are still on the lane waits for them; the once-name and the fixed card id rule out a second retry or notice.
Operational wakes and card clicks open no message and are never checked.
The local model's own no-output check is separate: it looks only at the messages its own turn read.
The replay and the developer evaluations wire the agent with `answerDelivery: "observe"`, which judges nothing; the replay's observational `asks_without_action` row reads the recording (`docs/replay-harness.md`).

## How a message ends

INF-1610, from the captain's words: "i like the idea that each captain ask has a "thread" and perhaps each "thread" has to have a card as its conclusion".
A message may run any number of tasks and cards; the plans, questions and consents along the way stay as they are, and the message ends on a card the captain accepts as its answer (`src/core/orchestrator/askEnding.ts`).
The host reads only typed facts: the saved message, the task graph, the cards and the captain's own response, never the words of a card or a message.

What piece 2's migration adds to `captain_asks`: `followed` (every message saved from then on), `continues`, `answer_card_id` with `accepted_at`, `answered_at` and `crewmate_asked_at`.

- **Its work.**
  The tasks the message attached to, and every task that carries their work on: parts, builds on a plan (`basis`), retries, branches taken from them, replacements (`replaced-by`) and a stronger model (`escalated_to`), walked by `TaskService.capture.askCoverage`, which reads each message's tasks once for the whole chain.
  Attribution and escalation edges are read as typed metadata, without decoding each task's entire timeline.
  Coverage reads only task identity, title, status, close reason and creation/start times from the task row, and child identities in their existing order, without composing specifications, shapes, execution or delivery payloads.
  One `openChains` read shares these task fields and successor edges across its roots; these facts are discarded after the synchronous read and invalidated by task writes, including rollback.
  A cold card dismissal or choice uses the same narrow readers without needing a board read to prime them; acceptance still uses the complete batched message membership.
  A terminal answer-task choice still reads its own task's shape for eligibility; it does not compose the other covered tasks.
  The message's own work is the part of it the first mate's tools acted on for the message (`acted` on the same read), and anything filed or started after it; a task the message only pointed at, such as the card it was typed under, which nobody acted on since, is not working on it.
- **Joining.**
  A message about open work of an earlier message that has not ended joins it (`continues`), set once when it first attaches; the earliest is the root, and the root with every message that joined it ends together.
  A later attachment, such as the first mate naming the message on other work, never moves it under another chain.
  An answer once recorded never moves: work linked afterwards belongs to the newer message.
- **A card that can answer it.**
  A card about its work that its author marked `answering`, a completion card's merge, the app's merge line on a story note, or a card the first mate showed for the message; it counts only when it was shown since the newest message of the chain.
- **Accepted.**
  The captain's choice on a decision about its work that is not still asking (`asking`, `continues`), or Done on a note that can answer it, with no reply of theirs waiting under it (`CardService` reports each response through `captainResponded`).
  Putting a taskless note or an already-completed task's note away as read also acknowledges the message when the note qualifies as its answer; this ends no work.
  Reading an active task's note accepts nothing: a saved answer still waits for explicit Done.
  An explicitly answering crewmate card on an active answer-deliverable task also counts when its admitted choice qualifies to close that task, even with `asking` set.
  Ask acceptance and task completion for that admitted answer-task choice share `taskResultResponse`; continuing cards, held writes, browser handoffs and pending replies do not qualify.
  The author judges whether the requested result is supplied, including a ready plan that offers further work, rather than a prerequisite question or consent.
  The host checks attribution, the admitted choice and offer freshness, never card meaning or button wording.
  CardService saves choice acceptance through TaskService in the resolution transaction before task closure, preserving the original offer and submitted answers.
  The normal `answer_task_closed` handoff remains pending until the first mate recovers and handles the choice; acceptance alone neither authorizes nor proves later work.
  A choice counts whether it lands before or after the reply that showed the card finishes: `captainResponded` also reads the chains whose reply is still running.
  A decision closed without a choice answers nothing; a reply, a question or a new message keeps the message open.
  Work the choice started keeps the message working until it ends; then the accepted card still answers it.
  The step that handles the click joins that work to the message only when the first mate names the message on it (`ask_id`).
  Closing the first mate's own card is never an acceptance; when `close_card` closes the card a message a step has read was waiting on, and leaves it with no answering card up and no work running, its answer says so, as a fact and never a refusal.
  The first mate's answer in the thread of the card the message was typed under is accepted; so is a reaction to a message that asks nothing, the first mate's own judgment.
- **Answered.**
  An accepted answer becomes `answered_at` once the first mate has nothing queued that could start more work for it.

Who writes a missing answer, in the captain's order:

1. The crewmate whose task is the message's last running work: when it reports finished with no answer accepted or up, its report is refused once (`CREWMATE_ANSWER_ASK`), saved as `crewmate_asked_at`; its second finished report stands.
2. The first mate, through the retry above, once all of the message's work has ended with no answer: the wake names the work that ended (`workEnded`), and the first mate shows the answer or links the task that took the work over with `link_tasks`.
3. The app's one notice.

At most one closing note: when work closes without the captain's click, `TaskClosing` asks `AskEnding.closingPlace` where its outcome goes.

- The accepted or recorded answer is revised with the outcome line and comes back to the stack only when the work was dropped after the captain accepted it.
- Other running work of the message, or a handover, puts up nothing.
- Work another task carries on closes done with no outcome of its own, so it puts up nothing; when the task carrying it closed first, that task's held-back outcome is placed once (`docs/task-record.md`, "Work carried on by another task").
- An answering card that is up is revised, and so is the task's own card shaped as an answer that is still up, even when a later message asked about it.
- Otherwise the app's one closing note goes up, marked as the answer.
- Work no message of the captain's covers, such as work the fleet started, puts up a note only when it merged or released and nothing of the task is on the stack.

Open-chain reads select unfinished roots and their complete membership together through `TaskService.capture.openAskChains`, decoding each message once instead of reloading each root and its members after listing the open messages.
Open turns and already-ended members remain in those chains, so freshness and pending-delivery checks still read the newest message; each call reads current storage, with no retained chain cache.
The first mate's turn facts list the open messages (`open_asks`): each one's id, when it was sent, how it stands and the work that still runs for it, newest first and bounded like the task list, with a notice still up counted as unanswered.
They never repeat the captain's words, which are in its conversation.

## Pictures stay with the task

A captain message's pictures, however they reached the input (pasted, dropped or chosen), are kept as the message's own copies when it is accepted (`docs/composer.md`, "Files"), and its ask row keeps their references in `images_json` (id, name, type, size, SHA-256 and the copy's path under `<userData>/attachments/`, never the bytes).
A row an older build saved holds the types alone and has no copies to name.
Whatever task the message attaches to, by a tool or by the fallback, holds its pictures: `TaskService.capture.pictures` reads them from every `ask` event on the task, in the order the messages attached, so a message about two tasks lands on both.
The `tasks` query by key lists them by name and copy (`pictures`).

The crewmate that takes the task is briefed with them (`CrewBrief.briefPictures` in `crewBrief.ts`): the task's own pictures, then those of the work its brief carries forward - its basis, the task it was discovered or escalated from, the attempt it replaces - each picture once by digest.
As many as one message may carry (`TURN_IMAGES_MAX`) ride the first turn as images; the brief's pictures section, right under the captain's words, names every copy by its path in the task’s `temp/handover/` folder on the computer running it, says how many did not fit, and counts a copy that is gone instead of sending its name as if it were there.
When a copy is gone, the section tells the crewmate to say so plainly and ask the captain to send it again, rather than answer without it.
The brief's inbox row keeps the riding copies (`attachments-kept`), so a retried or re-presented first turn carries them again (`docs/inbox.md`, "Pictures ride the row by reference").
`spawn_crewmate` hands the action's selected message's pictures to the brief directly, because the brief goes out before the message attaches to the new task; a planned task reads them from its record whenever it starts, after a relaunch too.
A spawn on a project that runs on Automatic starts through the queued start at once, so that start carries the message's pictures and files too (`dispatchQueuedTask`'s `message`, INF-2422); one that waits for room reads them from its record when it starts.
Supported text attachments also keep typed references to their complete overflow copies (name, path, size and digest) on the ask, alongside the picture references in `images_json`.
A task reads those references from its asks and the same source tasks at dispatch; an immediate spawn also receives the selected ask’s references before capture attaches it.
Both pictures and complete text files go through the existing verified hand-over writer here or the source-file order there, with private file permissions and digest-qualified names.
A remote computer that cannot receive handed files refuses the start with an update request; a missing or changed text copy refuses the start rather than supplying only its preview.
No helper task is filed, and unsupported files that the composer enters as ordinary path text are not attachments and are not copied.
A `steer_crewmate` carries the action's selected message's pictures with the first mate's guidance, kept on its row the same way; a copy that is gone leaves the guidance to go as words, since they are the first mate's own.
A reply under a crewmate's card already goes straight to that crewmate with its copies (`docs/card-threads.md`), and a reply under a first mate card is a captain message like any other.

## What capture does not do

No card renders a task id.
An open first mate decision card does not light the rail: the strip counts working, idle and queued crew, never decisions.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Capture (task-system P1, design section 6, captain decision D1 - "attach first"; `docs/task-capture.md`): every `inf:converse` opens a `captain_asks` row BEFORE the turn runs (`src/core/orchestrator/askCapture.ts` over `TaskService.capture.openAsk`); the first mate's tools select the read message they address through `ask_id` (empty for unrelated operational work) and attach it to the task they act on (`attached_via = tool:<name>`), and `AskCapture.endTurn` files whatever is still loose - on the hinted task (the open card's task, or the turn's `taskId`), else as a standalone `question` task in Scratch (`host:fallback`; the share of these is the attribution metric).
  `emit_card` needs `task_id` or `standalone: true` for a note (lint refusal), a task-less decision files an open `decision` task keyed by its card id (a choice, explicit Dismiss or close_card closes it; putting it away does not), and the operate tools file `operation` tasks through one helper.
  `[fm-op]` wakes open no ask.
  Never add a second ask writer, and never let a first mate card with `task_id` count as the crewmate's card (`cardEmitter` in `crewSupervisor.ts` reads the emitter off the id: `card-fm-` vs `card-<taskId>-`).

Catalog changes, including project settings, file their operation once in the core dispatcher.
`appActionRecorded` attaches the action's selected ask to that operation; `filingOperations` does not wrap them.
Theme, panel arrangement and panel instructions (a `direction` scoped to the personal workspace) use `app_change`; removal stays in `personalize`.
