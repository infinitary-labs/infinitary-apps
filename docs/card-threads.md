# Cards as threads

Every card is the head of a thread between the captain and the card's AUTHOR.
What the captain types under a card goes to that author, and the author always answers with one short message in the thread, whether or not the card changes.
When the card should change too, the author revises it and passes the answer as `emit_card`'s `reply`: the head re-renders and the thread shows the host's `revised:` line, then the author's answer.

Captain-approved on the Lavish board on 2026-09-20 ("cards-as-threads over a decision model - ship it"); the decided design is section R4 of `fm3000-card-close-decision-model-s1/report.md`, R1-R3 carry the review rounds in the captain's own words, and `board/thread-prototype.html` is the shell prototype the captain reviewed.
This file is the one home for the feature as built (phase 1 and phase 2).

Only a card's own author withdraws it.
Minus puts decisions and pending notes aside and reads ordinary completed notes; it never chooses or ends work.
The first mate does not close someone else's card to relay the captain's words (`CardService.close` refuses that and names the door).

## The record

`card_messages` (migration 38): card id, who (`captain | crewmate | firstmate | host`), text, at.
`CardStore` owns it beside `card_revisions`, and a thread dies with its card - `deleteForTask` removes both in one transaction, so the D-13 purge and a task's own close need no new rule.

`CardService.addMessage` is the single writer: the captain's reply, an author's prose answer and the host's own "revised" line all go through it, so nothing writes a thread row without the `inf:cards:thread` push that paints it.

A captain reply on a crewmate's card is a captain STEER to that crewmate - the same control-plane path a card click takes - stamped `via: "thread"` (`steerViaSchema`) with the card's id, carrying `THREAD_STEER_PREAMBLE` and then the captain's words verbatim.
Delivery is not awaited, exactly as a card click's round-trip is not: the message is on the record the moment it is typed, and a delivery failure is a feed line rather than a lost reply.

A line the captain types in a task's Crewmate tab rides the same lane as the captain's own steer, stamped `via: "crewmate-tab"`, with no card and no thread (`docs/task-card-tabs.md`, "Typing").
While the captain's kept merge approval stands on the task, the captain's reply, like the captain's line in the Crewmate tab, is guidance that holds that merge until the crewmate declares its impact (`docs/delivery-rigor.md`, "A kept merge approval").

A reply resolves nothing, except a line its crewmate signs off ("Signing off" below).
The buttons stay pinned; explicit choices, task endings and author withdrawals retire cards, while minus puts them away.

The captain’s minimize corner is presentation only (INF-1879): a decision or a note stays open, and a note is read only by its own Done or Got it (INF-2794).
A minimized decision or pending note sends no close steer, and consent waits rather than becoming a refusal.
Reading an ordinary completed note still notifies its live crewmate author through the existing durable turn path; that acknowledgement never completes its task.
A crewmate that already declared its work finished is not given that turn, since nothing is left for it: once no card of its own is up, the idle ladder wakes the first mate for its close at once (`IdleLadder.finishedRead`, INF-2718; after an update, INF-2662's turn ran in a fresh conversation that raised the closed note again).
A marked saved answer keeps its receipt and ending for explicit Done.
The host draws Done on a marked answer note and in its record; Done alone receipts that answer.
Putting a decision away retains the card’s drafts and the task’s gate until an explicit choice, withdrawal or task ending.

A card the captain answered with a choice stays answered (INF-1389 friction 1, the captain's "Start now"): `CardEmits.refuseAnsweredRevision` (`cardEmit.ts`) reads how the card ended (`CardStore.past`) before an emit under its id opens it again.
While the choice still waits on the author's lane, not yet handed to a turn (`InboxStore.holdsUndeliveredChoice`, the first mate's lane for its own cards and the task's lane for a crewmate's), every emit under the id is refused, and the refusal carries the choice and the answers to the card's questions, because that revision was written without them.
Once the author has heard the choice, an emit with actions under the id is refused, since it would ask the same question again: a new question is a new card with its own title.
One without actions only tells the captain something, such as which crewmate took the work, and shows as a note.
A note the captain closed with its Got it or Done stays closed (INF-2718, the captain's pick "Refuse re-showing a closed note"): every emit under its id is refused and nothing is shown, so a crewmate whose conversation restarted cannot raise it again, and something new goes on a new card.
A decision the captain closed without choosing, or a card a script or its author closed, can still come back under its id.

A reply does hand the turn to the author, and it never moves the card (INF-770 direction A, captain-approved 2026-10-21): the card stays shown in its place with the thread beside it, the pager and the arrows do not change, and the waiting line says who answers next.
The minimize minus puts the card away and says what stays on rest (`docs/card-authoring.md`, "Put a card aside").
An author may declare `holds_place` on `emit_card` (`Card.holdsPlace`): each newly arriving marked card comes forward, including the same stable id raised again as a note after a choice, but a revision or thread answer never undoes the captain's paging away.
Every choice still closes the card immediately; nothing keeps its page running while its author writes.
The card's body and scroll stay the same elements as the thread opens: only the surface's columns change.
Its field moves from above the card's buttons to the thread's foot and keeps the focus through the send and the move, so a second reply is typed straight away (`docs/composer.md`, "The card reply row").
The card's buttons move with it, under the field: `StackedCard` draws them into the thread column's reply slot (`choicesIn`), so a button plainly carries the field's words, and its keys and Go to the card's buttons still find them there.
The field is the card's one place to write (`docs/card-authoring.md`, "The card's one field"): Enter or Chat sends its words as the reply, and words left in it when the captain clicks a button go with that choice instead.
The author's answer redraws it at the close-out - see the next section.
A refused reply moves nothing and keeps the draft.

## When a card reaches the stage

Captain-approved on a board in two rounds on 2026-09-27 ("ship it", verdict "Ship it as recommended"; the decided design is sections 0, 6 and R2 of `fm3000-card-return-closeout-r1/design-excerpt.md`).
**One rule for every crewmate card** (the captain's Q1 A and Q5 A): a crewmate's card - new, revised, or answered in its thread - reaches the stage at the crewmate's CLOSE-OUT after its last write.
A new card's close-out is its next `report`, or its idle (its resumable turn ending), whichever comes first.
The one exception waits for a merge, not its crewmate: the story note of a task that merges on its own stays in its close-out wait until the merge has a result, and shows once with its merged or close line (INF-2533; `docs/card-authoring.md`, "Work that closed without the captain's click").
A card the stage has already shown in its lifecycle - one the captain replied under, put aside, or is reading while its crewmate revises it - waits for its crewmate's idle, so it comes back or redraws once, with the last write, never at a report while its crewmate works on (INF-926; INF-797: "it should come back when the crewmate's turn is finished").
Cancellation and terminal session failure close the task and retire all its open cards, including hidden replies and pending revisions, without releasing them onto the stage.
Card rows, revisions and threads remain on the record; they do not return after restart.
A recoverable provider-failed turn or interruption is still an idle boundary, not a task close.
Emission also rechecks the task at publication, so a completion check that finishes after closure cannot recreate a retired choice.
A task that closes done keeps its crewmate's notes and the first mate's notes (cards with no actions) on the stack until the captain closes them.
A note asks nothing, so the close does not answer it, and an unread note must not vanish (FI3-419, FI3-1581).
A question card still comes down with the close, and a dropped or cancelled task still retires everything.
The crewmate is gone, so a captain reply on its kept note goes to the first mate, as on its own cards: its closing words land in the note's thread (`recordFirstmateThreadAnswer`), its reply naming the captain's message answers it, its turn's end after that answer releases the wait (`closeOut`), and the WI-12 refusal does not send it to steer a crewmate that is gone, so a card of its own on that task shows.
A captain reply keeps the card on the stage, in its place, until the answer and close-out.
Every reply stamps `Card.sentBackAt`, retaining the shown version until close-out; the stamp survives reload and restart, and a later arrival does not dismiss the card.
The optional fourth `inf:cards:reply` argument an older view sends, whether the card was leaving, is read no more.
Every write in between lands on the record and paints the thread; the card does not redraw.
A card already on the stage that its crewmate revises keeps showing what it showed and redraws in place at its crewmate's turn end.
A card awaiting an answer never collapses into its task record while it waits.

**The first mate's own cards** keep working as they did (the captain's Q3 A): they go up and redraw at once, and its turn's end is its close-out.
Its closing words are its line in the thread - for the reply its turn was about and, since contract v4.14, for one it read mid-turn - unless it already wrote a line there since the captain's.
They name no captain message, so they answer none: a handoff such as "I asked a crewmate to find out" leaves the question open (the captain's "Only a line that says it answers it; a handoff stays open"), and its answer is an `emit_card` reply naming the message in `answers_message`.
Those closing words are one sentence, and the same words show as its reply line beside the captain's message (INF-772, the captain's "both places"; `docs/composer.md` "The last turn").
When the answer needs the crewmate of the task the card is on, the first mate steers it with the card's id and asks it to answer in that thread with `reply`, and answers the thread with one line naming it, never a new card (INF-1273: an answer on a separate card waited 22 minutes for its crewmate's turn to end).
`CardService.replyFromCrewmate` accepts a card whose `taskId` is the crewmate's task, whoever wrote it, so the line paints in the first mate's thread at once while the crewmate works on; the card keeps its author, choices and place.
A card on no task, or on another task, refuses that reply.

**The hidden state lives in the core** (the captain's Q4 A): `Card.awaiting` on the card snapshot - `answer` while the captain's line is the newest on the thread, `close-out` while the author has written and not yet closed out, absent on a card the stage shows; a card waiting for its first close-out is off the stage, while a replied-under card, stamped, remains on it.
A card an older version sent away on a reply carries no stamp and stays off the stage until its author answers.
`CardService` is its one writer: the captain's line sets `answer` (`addMessage`), a later line naming that message in `answers_message` ends it, every crewmate write holds a new or hidden card for its close-out, and `closeOut` - called from the crewmate's `report` and its resumable turn's end, and the first mate's turn end - releases what waited on that author.
A report passes over every card with an `available` offer in its lifecycle (`CardStore.lastAvailableOffer`): only the turn's end releases those.
`snapshot()` is the stage: a card on it whose author has written again is pushed as the version the stage showed until the close-out.
A crewmate's answer or revision on a card the captain put aside (`Card.minimized`, "Put a card aside" in `docs/card-authoring.md`), never its interim line or a line or revision that leaves the captain's question waiting, saves the card as no longer aside, while `snapshot()` keeps it aside until that crewmate's turn ends (`asideUntilTurnEnd`, memory only), so a restart, itself a close-out, brings it back too.
The columns are `cards.awaiting` (migration 52) and `cards.sent_back_at` (migration 59), so the hold survives a restart and a reload; the restart is itself every author's close-out, so a card that only waited on one reaches the stage at boot.
`sentBackAt` is the reply's time; it no longer moves the card in the stack's order (`compareStack`).
The optional declaration lives in `cards.holds_place` (migration 77); null means an ordinary arrival, and a revision without it removes it.
The author's close-out clears the stamp: the answered card redraws in its place, unread unless it is the shown card.
A captain reply's hold is pushed at once rather than in the core's 60 ms push window, so the window always sees the wait that the close-out ends, however fast the author answers.
Bands sort by priority, oldest creation time first within each band.
A click resolves against the version on the stage.

What reads it: the renderer shows a card only when it is on the stage (`visibleCards`) and has no door of its own - a thread message never brings a card forward, and an ordinary card's return is an arrival: onto the stage when nothing else is shown, else without displacing the shown card, unread, with the notice pulse; a replied-under card is also an arrival when its `awaiting` clears, unread unless it is the shown card.
A newly visible marked card instead becomes the shown card, already read, at its author's close-out.
The core's push moves the stack: `reconcileStack` sees the shown card leave - a close, withdrawal or task closure - and `departureIndex` picks what comes up: the first unread card in stack order, else the first card.
A reply never moves the stack.
The initial snapshot restores unread cards from the card owner's lifecycle `seen` observations, without an arrival pulse or a continuity jump.
Paging clears the window's unread mark; the existing stage report records a look durably when the window is visible and focused.
Hiding a record keeps its own rule: the first card comes up.
Open records stay ahead of cards for paging; if only records remain, the first record shows.
Unseen departures and arrivals never displace the entry being read.
The native notifier notifies when a waiting card's `awaiting` clears, as for an arrival.
A click on a waiting card resolves against the version on the stage.
Observe and the tests read the same snapshot.

The whose-turn rule, the idle ladder and the first mate's thread activity lines also read the persisted `answer` hold through `CardStore.awaitingAuthor`, restricted to open cards.
They do not read `close-out` as an unanswered reply: the author has already written.
Historical captain messages stay on the thread through withdrawal and same-id reopening, but do not create an obligation in the new lifecycle.

**While the author works**: an ordinary card waits off the stack, and one feed line at reply time on a crewmate's card - `You asked crewmate N under "<title>"` through `broadcastEvent` (the captain's Q2 A); a first mate card's reply already has its "Captain: ..." line.
The card's return is its own notice.
The task timeline records each crewmate card's stage moment as its `card_raised` event, written at the close-out with the close-out that released it (`data.closeOut`: `report`, `idle`, `restart`), and again on a return after the captain's reply (`data.returned`), so the replay can count a late return.
A return is never written at `report`.

**The contract** (v4.14): the crewmate's thread steer preamble and `CARD_REPLY` say to do the work the captain's words need first, answer once - revise the card, or reply when nothing on it changes - then report, because the card comes back when you are done; never acknowledge or announce.
A thread line shows as soon as it is sent, so `CARD_REPLY` and the steer preamble say to answer once the research the question needs is done, before unrelated work (INF-1273); only a card body or revision waits for the author's close-out (INF-926).

**An interim line** (INF-990 friction 3: replies asking for code changes went 26 and 41 minutes with no sign of work): when the work will take more than a few minutes, the crewmate's steer preamble tells it to post one line first with `reply` and `interim` true, saying what it is doing.
The line paints in the thread at once, like any author line, but it is declared, never inferred: `CardService.addMessage` keeps the card's `answer` hold, so the reply still waits, the waiting line or `working` follows, a revision without `reply` is still refused, and the whose-turn rule and the idle ladder still see an answer owed.
An interim line records no answer either: one that names the captain's message keeps no `answers_message`, so the author's later line naming that message is the answer, never a comment kept behind it (INF-2730).
Migration `clearInterimAnswers` cleared the message an older build kept on such a line, found by the line's own `message_ref` observation, and left every other line as it was.
Under a card nobody waits on, `interim` is an ordinary reply.
The mark crosses from a computer that runs work too: `inf:work:reply` carries `interim`, so a crewmate there keeps the reply waiting the same way (INF-1623).
An interim line never brings back a card the captain put aside, and neither does a handoff or a revision whose `reply` is a progress note: the card comes back with the final answer (`addMessage`, the revision's `aside`).
The rule lives in the steer preamble and the tool's `interim` parameter, both crewmate-only, so the first mate's contract is unchanged.

**A revision names the message it answers** (INF-2884, the captain's "refuse a revision whose answer neither names your message nor is marked as a progress note"): while the captain's reply waits, a crewmate's `emit_card` revision whose `reply` neither names that message in `answers_message` nor is marked `interim` is refused, and nothing is written (`CardEmits.upsertEmitted`).
Without the refusal the unmarked answer showed in the thread while the stage kept the version the captain replied under, beside "has not answered yet", since only a named line ends the hold.
The crewmate's `emit_card` has its own `interim` parameter, so a revision made while it works on is a progress note like an interim line, and `inf:work:card` carries it.
The steer preamble's do-this sentence says the answer names the captain's message in `answers_message`, by the number its per-card line gives.
Putting a card aside never asks to discard an unanswered reply; its hold and draft remain until its author answers.

**Signing off** (INF-2845, the captain's direction A): a reply resolves nothing, except a crewmate's line marked `signs_off`.
When the captain's line under its answer says they need nothing more from it, in whatever words, the crewmate answers it naming the message in `answers_message` with `signs_off` true.
The card leaves the stack as read, the message takes it as its answer, and the answer task closes as answered (`docs/task-capture.md`, "How a message ends").
The crewmate judges the words; the rule's one home is the thread steer's preamble (`THREAD_STEER_PREAMBLE`), which reaches a Claude crewmate with the captain's line, and the tool's top-level `signs_off` parameter says only what the mark does.
No code, test or instruction keeps a list of phrases.
The host refuses the mark with its reason and writes nothing on a card with a merge, a write or a browser hand-off for the captain, on one still `asking` or `continues`, on an interim line, and anywhere but the crewmate's own answering card of an active answer task.
The mark crosses from a computer that runs work in `inf:work:reply`'s `signsOff`, only to a home that lists `thread-sign-off`.

## The waiting line

FI3-592, grounded on FI3-643 (the captain folded a waiting line for every reason into FI3-592).
While the captain's line is the newest on a crewmate's card (`awaiting: "answer"`) and its author's turn is not running, the thread's message list ends with one quiet sentence in the app's voice where `working` would be: that the reply is saved, what holds it, who goes next and the way on - for a held account the way back, otherwise "Put the card aside to go on; it comes back when the answer lands."
(INF-770).
It is derived, never a message, and the card keeps showing what it showed.

The line reads the task's work posture, the typed state the Tasks dot reads (`WorkPostures.workPosture` in `workPosture.ts`; `threadWait` and `threadWaitWords` in `src/shared/threadWait.ts`), and the task's assignee, both off the sequenced board (`useThreadWait`).
Nothing reads anyone's words.

- `access`: the reply is kept, not sent.
  The posture carries the typed cut-off (`WorkPosture.hold`: its class, the provider and a spent allowance's reset), so the line names the way back the cut-off contract gives (`docs/quota.md`, "Typed cut-offs"): the reset, on its own; signing in again; another login or an updated client for a refusal - and, where the wait can be long, asking the first mate to move the work to another model.
  For a task on a computer that runs work the hold also says where that computer's own sign-in is (`where`, "on Mac mini"), and the line names it: "Claude needs you to sign in again on Mac mini."
  It never offers a Retry that cannot clear the hold.
- `checks`: the author waits for the checks and answers when they finish (the check watch's wake).
- `job`: the author waits for its own background work.
- `settlement`: the task is being merged or discarded.
- `guidance`: nothing else holds the author, and it has not answered yet.

A running turn shows `working` in its place.
On a crewmate's card the captain replied under, `working` is followed by what the crewmate did last since the captain's newest line: its task record's Now line (`nowOf`, `docs/task-record.md` "The Now line"), usually the description it gave the command it runs (`useReplyDoing`).
The thread reads it off `tasks.detail` only while that turn runs, and that read re-reads on each of the crewmate's calls (`tool_start`, `tool_end`), so the line follows the work command by command; before its first doing since the reply, `working` stands alone.
A collapsed thread's latest line shows the same words in place of the newest message.
The message list holds its scroll at its foot as a message, the waiting line or `working` arrives, each on its own: on the first mate's card its busy flag lands a render after the captain's reply, so `working` scrolls the list again (INF-1231, `tests/browser/thread-working-reveal.test.tsx`).
When the hold ends, the checks finish or the author's turn starts, the posture moves and the line with it, with no thread message; the author's answer - a line naming the captain's message in `answers_message` - ends the wait and the line.
Every input is persisted (the card's hold, the account's cut-off, the task's check watch), so a restart or a reload shows the same line.
A first mate card has none: the paused seat writes its own saved line for every message it keeps (`docs/architecture.md` §16, "A paused seat").

The author's side says the same.
A revision of the open completion card goes up while its checks run, carrying that answer with it (INF-834 friction 4).
A new completion card the checks refuse while a captain reply waits on one of the task's cards asks for the thread answer now - one line saying what it did and who goes next - and the card update once they pass (`CrewmateCards.waitingReplyNote`).
`HANDOFF` (contract 4.70) answers a reply that only authorizes a build the same way: one thread line naming who is next, the card unchanged.
An answer task's author then reports the approval with `needs_firstmate` (contract 4.73), which wakes the first mate to start the builder.
While the first mate has not acted on that task since, the idle ladder raises the request again, with the card still up (`docs/report-sort.md`, "A request the first mate leaves unanswered is raised again").

## The contract both agents read

`CARD_REPLY` in `src/core/prompts/cardContract.ts` is ONE text, included exactly once by every persona beside `CARD_AUTHORING` (the captain's Q4 B: "this is not just crewmate - firstmate should largely share the same contract").
It says: always give one short answer (one to three sentences); also revise the card when the reply changes what the card should say (same id, `emit_card` with the answer as `reply`); answer with `reply(card_id, text)` alone when nothing on the card changes; a reply is prose only - no actions, no script, no figure; and a reply resolves no card.
Explicit build words authorize implementation, not merging; settings alone authorize neither.
Since v4.14 it also says when: the work comes first and the answer once, because the card comes back only when its author is done.
`piResources.test.ts` pins that every persona carries it once and no tool description repeats a sentence of it, the same structural pin `CARD_AUTHORING` has.

While a captain reply waits on the author, `emit_card` under that card's id without `reply` is refused as tool text naming the fix, and the card and thread stay unchanged (`CardEmits.upsertEmitted`, `cardEmit.ts`).
While one of a crewmate's cards waits on its answer, a new card carrying `reply` - a new id, or none - is refused naming the card that waits, since the reply rides only a revision of that card and would otherwise be lost (INF-990 friction 4).
A `reply` under another of its cards succeeds, and its receipt names the card that still waits.
A revision's `reply` lands right after its `revised:` line whenever the card has a thread, whether or not a reply still waits, so an earlier line that ended the wait never makes the answer vanish (INF-1623).
Every revision made while answering carries its own answer (the captain's "every"): an author that answered, with `reply(card_id, text)` or a revision's `reply` naming the message, and revises again before its close-out without `reply` is refused, card and thread unchanged (`answeringUntilCloseOut`, memory only).
After the close-out, a revision nobody asked about needs no `reply`.
The app reads only that typed state, never the words of the answer.

A crewmate gains one output for that answer: `reply(card_id, text)` (`crewmateTaskTools.ts`, Claude twin in `claudeTaskTools.ts`), beside `report` / `emit_card` / `note_progress` / `file_followup`.
Its description carries call mechanics only.
The first mate's tool count is unchanged at 24
- there is no first mate `reply` tool; it answers through an `emit_card` reply naming the message, and its closing words are a line that answers nothing.

## First mate card threads (phase 2)

A captain reply on the first mate's own card is a captain TURN about that card, not a steer.
`cardTakesReplies` is true for a first mate author; `CardActions.replyToCard` files the captain's message and calls `converseAboutCard` (`FirstmateAgent.converse` with `aboutCardId`).
The about line replaces the maybe-hint:

`about: card <id> (<presentation>) "<title>" - the captain replied in its thread as message <n>; answer it with an emit_card reply on this id naming answers_message <n>, since your closing words alone leave it open`

The first mate answers through the same `CARD_REPLY` shape: `emit_card` under the same id with `reply` and `answers_message` (on a revision the host writes "revised:", then the answer).
Its closing words land as prose (`recordFirstmateThreadAnswer`) only while the reply still waits and it wrote no line there since the captain's, and they leave the question open.
A parked idle turn keeps the card on its inbox ref (`captain-turn:card:<id>`); a mid-turn reply rides the existing steer with the about line in context, and since v4.14 the turn's closing words land under it too, because the card now waits for an answer across restarts.
Closing words written into a card's replies count as the action the answer-delivery check looks for (`docs/task-capture.md`); a reply the turn answered with nothing is retried once, under the same card.
Contract v4.2 is unchanged; the wire bump is protocol 1.19.0 for images on `inf:cards:reply`.

### A card with no reply row

One first mate card takes no reply: the welcome (FI3-1164, the captain's word: "for this particular card, let's disable "reply to this card" input box at the bottom. otherwise it's overwhelming"), so it draws neither the field nor Chat.
The host marks it when it presents the note (`Card.replies` false, the `cards.replies` column; `addRecordedFirstmateNote(..., { replies: false })`), and `cardTakesReplies` reads it as no, whoever the author is.
The window draws no field on it and refuses the Reply commands with "This card takes no reply"; `CardActions.replyToCard` refuses one with "takes no reply".
Its words send the captain to the message box under the card, so the first-run hint ends on a message sent from there (`docs/first-launch.md` "The welcome").
Every other card keeps its row as its author allows.

### The stuck alert's reply row

One host card takes a reply: the idle ladder's stuck alert (`card-stall-<task>`, INF-1670, the captain's word: "i would remove the "drop task" option and leave nuanced operations to the reply").
The host names its answerer when it raises the card (`Card.answeredBy` "firstmate", the `cards.answered_by` column), and `cardTakesReplies`, the phone's `takesReplies` and `CardActions.replyToCard` read that field, never the id.
A reply there is a captain turn about the card, the same as a reply on a first mate card, and the first mate answers it with an `emit_card` reply naming the message (`CardThreads.firstmateAnswers`, `cardThreads.ts`).
It is never a thread the task's crewmate owes (`CardService.threadsAwaitingAuthor` leaves it out), so no nudge or reminder names it.
While the answer is owed the alert stays up even if the task moves (`IdleLadder.withdrawStallCard`); once it lands, the next move takes the alert down as before.

## Images on steers (phase 2)

Pi's `steer(text, images)` already existed.
The Claude Agent SDK accepts the same bytes as user-message image blocks (`{ type: "image", source: { type: "base64", media_type, data } }`) on both `prompt` and `steer`.
An accepted reply to a crewmate owns copies of its pictures (`src/core/attachments.ts`) and its inbox row names them, so a queued or retried steer, a resumed task and a restart all still carry the bytes (`docs/inbox.md`, "Pictures ride the row by reference"); a copy that is missing blocks the delivery visibly instead of sending words alone.
Only a row an older build wrote says its pictures were dropped (`ATTACHMENTS_DROPPED_NOTE`).
The thread line names what rode along (`[attached 1 picture: name]`).

`inf:cards:reply` takes the same union converse does (words, or `{ text?, images? }`).
An image-only reply is stored as `"sent a picture"`.
The reply row pastes pictures the way the main input does, and takes dropped and chosen files exactly as it does (`docs/composer.md`, "Files"): supported files as named chips, an unsupported format as its path typed into the reply, always to this card's recorded author.
Its field is the composer's own (`ComposerField`, `docs/composer.md` "The card reply row"): the same keys, growth to 5 lines, and the count and refusal against `CARD_REPLY_MAX_CHARS`.
Thread messages keep their line breaks.

## Thread in Observe (phase 2)

Observe's session **detail** (not the list) carries `threads`: open cards on that session that already have a message.
The first mate session lists first-mate-authored cards; a crewmate session lists that task's.
Empty threads stay off the pane.
`CardService.observeThreads` is the source; the frame paints one header line per thread (`[data-observe-threads]`, `"Title: N · last who"`).
Observe stays in development and alpha builds only (`docs/dev-observe.md`).

## The settle hand-off, with no classifier

"merge it", "land it", "discard it" typed under a crewmate's card is not the crewmate's to run, and **nothing in the host reads those words**.
The crewmate's own instruction does the routing: it closes its card and carries the captain's words verbatim into its `report` and declares, in `needs_firstmate`, what the first mate must do.
The whose-turn rule then wakes the first mate (`docs/report-sort.md`, row 0a) for the turn that runs the settle it would have run had the captain typed the same words in the main input.
A build the captain approves by reply under an answer task's card is relayed the same way, with the card left up (`HANDOFF`).
Without the declaration the report sorts like any other, and on a backend the host cannot watch it wakes nobody.

Words that pass one of the app's holds, or tell the crewmate to go on without asking, are relayed the same way, with the card left up (INF-1216).
The crewmate judges whether they are such words; if so, it reports them with `needs_firstmate`, naming the card, and carries on with what they already allow.
The first mate records them as the captain's override in that relay turn with `update_task override` and `from` naming the card, and the host takes the words from the captain's own reply on the task's record (`docs/delivery-rigor.md`, "The holds").
A click on one of the card's buttons is relayed the same way, and the host takes the button's words from the card's record.
A line the captain types in the task's Crewmate tab is relayed the same way, with `from` as `crewmate-tab`.

That is the captain's Q2 as the captain corrected it: "crewmate should not answer the user with 'not mine'. it should just close the card and pass the decision to firstmate to execute."

## How the first mate learns

It is never woken for a thread message (the captain's C9 A).
Two bounded facts reach it on whatever turn comes next:

- **"thread activity since your last turn"** - a context-block section beside `renderCaptainResolutions`, one line per card: who wrote last, the first ~120 characters, how many messages, and who owes an answer now.
  That last fact is `CardService`'s typed `ThreadOwed`, read from the same current `answer` hold as the whose-turn rule (`CardStore.awaitingAuthor`), never from who wrote last.
  The line ends `awaiting the author` while an open card holds for its author, `awaiting your answer` when the first mate is the one that answers (its own card, or a note a done task kept), `no answer owed` on an open card without the hold, and `card closed, no answer owed` once the card is resolved.
  So a captain message a withdrawn or reopened card kept reads as owing nothing.
  Bounded exactly like the resolutions (8 lines, 6 h), with the same watermark, so a busy conversation cannot swell the block.
- **`thread:` on the task's crew line** - `2 messages, last from captain`, from `CardService.threadFacts`; `crew_status` carries the same field.
  The roster visits the open card stack once and reads counts, last authors and their timestamps in one batch scoped to its tasks, without hydrating message bodies.
  Each card's last message is the newest written row; equal timestamps across cards keep their existing insertion-order tie behavior.
  The batch lives for that roster read only, so a new reply or a card closure is visible at the next read even inside one task projection.
  The separately bounded recent-thread context still reads its full newest messages.

The whose-turn rule gains one fact (`reportSort.ts`): an unanswered captain message in a thread is the CREWMATE's turn, so its report wakes nobody.
It is branch 0, above the open-card branch, deliberately - the captain has spoken since that card went up, so the card no longer holds the turn.

## The shell

The design skill owns every visual rule (`.claude/skills/infinitary-design/components/cards/CardThread.prompt.md`); `src/renderer/src/cards/CardThread.tsx` implements it and `threadGeometry.ts` holds the ladder's arithmetic.

While a card has no thread open beside it, its one field, reading "anything to add?", sits above the button row under one hairline, and Chat sits at the right edge of that row (INF-924; `docs/card-authoring.md`, "The card's one field").
A card with no author to reach - the host's own agent-down set - has no field and no Chat at all, and neither has the welcome ("A card with no reply row", above); the stuck alert has both ("The stuck alert's reply row", above).

The first sent message opens the thread beside the card in ONE container (tweak 1): one surface, border, radius and shadow, a single `--line-2` hairline between the columns, the pair centred as one object.
For card and thread sizing, stage width is the window minus twice the larger expanded rail, so one-sided panels never shift the pair.
Thread `clamp(0.4 × stage, 288, 360)`, card `min(W, stage − 32 − thread)`, where W is the card's own width - 560 for a regular card, more for a wide or full one or one the captain dragged (`docs/card-authoring.md` "Card width").

When the pair would leave the card under 400px the docked panels FOLD (tweak 2): `html[data-rails-folded]` gives the rails' width back to the stage and a 4px edge tab at each folded side says the panels are one click away - the click collapses the thread, which returns them.
Collapsed panel headers stay visible but reserve no card clearance.
The create-your-own-panel slot reserves it as an expanded panel does, so a wide card never covers it.
The rails keep their panels while folded, which is why `--rail-docked-*` (what they ask for) is a different variable from `--occupied-rail-*` (what they take): reading the effective one would make the ladder circular and the pair would oscillate.

In place is the last rung - a segmented control in the card's head swaps the body for the message list - and needs a stage under 720px, which the app's own 960px window minimum puts out of reach.

### Collapsing the thread

The captain folds an open thread back into its card (FI3-1130): the thread head's Collapse thread, ⌘\ or command search's "Show or hide the card's thread" (`cards.thread`, `docs/keyboard.md`).
The shell's `closedThreadIds` holds the cards collapsed in this window, and `entryView` (`src/renderer/src/app/stage/entryView.ts`) draws such a card lone, its field above its buttons with the thread's latest line above it (`ThreadCue` in `CardThread.tsx`); a click or Enter on that line, or ⌘\ again, opens the thread (`openThread`).
The draft, pictures and chips belong to the card's id in the shell, so they survive both moves, and so does the body's state.
A focused field keeps the focus in its new place (`ReplyRow` carries it across the move); otherwise the card layer focuses what undoes the move, the latest line or the collapse, ringed when a key moved it.
Collapsing gives up what folded the docks, so in a narrow window they come back, and the folded docks' edge tabs collapse the thread the same way.
A thread push that holds a message the window did not have opens the thread again (`applyThread`): the author's answer, a host line, or the captain's own reply sent from the collapsed row, so nothing written goes unseen.
A read that brings nothing new, such as a window catching up, keeps the collapse.
The collapse is shell state for the card while it is up, like a dragged width: `applyCards` drops it with the card, and nothing is saved or sent to the author.

`threadGeometry.test.ts` is the binding evidence: the R3.1 table at 960 / 1200 / 1440 / 1728 with both docks, one dock and none, and `card-threads.spec.ts` measures the real shell against it - folded at the default 1200 (expanded docks reserve a 600px centered stage) and beside the docks at 1728, clear of the rail.
The collapse's rules are `stackActions.test.ts`'s, its controls `CardThread.test.tsx`'s, and `card-threads.spec.ts` drives it by keys, its own controls and a new line.

One sharp edge paid for there: `--rail-docked-left|right` are REGISTERED (`@property`, `syntax: "<length>"`) because the ladder reads them.
An unregistered custom property computes to its own token stream, so `--rail-docked-left: var(--rail-width)` reads back through `getComputedStyle` as the literal `max(300px, 20vw)` and parses as `NaN`; the ladder then placed the pair as if nothing were docked and it sat under the rail.
`useShellLayout` also observes the STAGE's size, because a rail docking or undocking is not a render of the card layer.

## Ready decisions and choice admission

Task waiting follows the version the stage shows, not the durable head (`docs/task-record.md`, "Ready waiting is a presentation projection").
New crewmate cards still release at report or idle, whichever comes first; report can release a decision while its author keeps working.
A reply hides it at once.
Acknowledgement or an unreleased revision does not redraw it, and neither does a later report: the crewmate's turn end does (INF-926).
An unanswered reply keeps its send-time visibility across restart; restart releases close-out.
These release and durable-gate policies are unchanged.

Other thrown action/reply refusals keep their reason, but the preload removes Electron's remote-method wrapper and error-class prefix before the shell or an embedded card receives them (`src/preload/readableRequest.ts`, shared with Settings' directly displayed request failures).
A failure with no usable reason gets a short choice/reply-specific fallback.
This does not change acceptance receipts, the wire contract, or the shell's refusal recovery: choices stay open and replies return with their unsent words and pictures kept.

A hidden or associated closed-task card refuses an action before resolution, author guidance or an effect.
The emit boundary agrees, so no choice shows that this would refuse: a card with actions whose `task_id` names a closed task is refused at emit (the first mate's lint names its ways out, `CardService` holds it for every author), while a review relay may still name a closed task and a note may name one in `related`.
A choice naming no action declared by the shown offer also refuses before bookkeeping, leaving both the card and its task open; an unseen action from a pending revision is not yet offered.
Refusal is typed internally and transported as `refusal` text, not the empty acceptance receipt: the shell retains an open card and shows the refusal without a transport wrapper, rather than removing it optimistically.
Valid choices still use the shown offer, including when a newer stored revision changes its actions.
Gate-backed decisions/operations use their existing typed card-raised task association after closure (closure clears the live gate).
Submission metadata, required-answer rules and routing are unchanged.
Cancellation and terminal session failure retire the task's open cards through `TaskClosing.closeRecord`, as ordinary settle closure does through `closeTask`.

## Tests

- `tests/e2e/task-card-retirement.spec.ts` - a shown decision disappears on running cancellation or actual terminal client exit and stays retired after restart; cancellation of a restored idle task retires its decision without reopening the session.
  `crewSessions.lifecycle.test.ts`, `settleOwners.discard.test.ts` and `cardActions.merge.test.ts` join closure with cards and task detail, covering hidden cards, pending revisions, preserved history/threads, unrelated choices and resumable failure/interruption.
- `tests/e2e/card-threads.spec.ts` - phase 1's three scenarios (a reply that revises the card in place, a reply answered in the thread, and "merge it" under a completion card landing as the first mate's settle) plus phase 2: a captain reply on a first mate card revises it / lands as prose, and an image rides a thread reply on a transport that supports it.
  The stage rule's case A: with two cards, a reply keeps the card shown with its thread, an acknowledgement and a reload leave it in its place, and the crewmate's turn end after its report redraws it with the answer in place.
  A lone replied-under card is put aside without a warning and remains open for its author's answer; `cardService.test.ts` covers its release at that author's close-out.
- `tests/e2e/stage-reveals.spec.ts` - a close brings up the first unread card, a reply keeps its card shown while the unread card waits, and with nothing unread the first card comes up; a reply under a lone card keeps its body as the captain left it.
  `stackActions.test.ts` owns `departureIndex`, `dismissalSuccessor` and the reply that moves nothing.
- `crewmateCards.emit.test.ts` ("a card reaches the stage at its author's close-out") - the design's recorded exchanges A, B and C replayed at their offsets through the real card, thread and report paths, each answered only at its turn's end, and a card put aside that its crewmate answers mid-turn; `firstmateAgent.turns.test.ts` - case D on the first mate's own card and the mid-turn capture; `cardService.test.ts` - the kept card across a restart.
- `tests/e2e/thread-waiting.spec.ts` - a reply under a Claude crewmate's card that meets a refusal shows the held waiting line, keeps it across a restart, and loses it to the crewmate's answer once another login serves.
  `threadWait.test.ts`, `CardThread.test.tsx` and `workPosture.test.ts` own the wait per posture, its words and the row; `cardActions.settle.test.ts` and `crewmateCards.completion.test.ts` the typed hold on the posture and the checks refusal's thread answer.
- `cardActions.settle.test.ts` ("the card thread") - the steer's shape and its `via: "thread"` record, the refusals, the host "revised" line, the crewmate's own reply, the whose-turn fact, the context facts, a first mate card routing to a captain turn, and an image on a crewmate steer.
- `firstmateAgent.capture.test.ts` - the about-card line and the prose capture at turn end.
- `cardStore.test.ts`, `reportSort.test.ts`, `threadGeometry.test.ts`, `observeService.test.ts` / `observe.frame.test.ts` (threads on the detail header).

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Cards as threads (phase 1, captain-approved 2026-09-20 "cards-as-threads over a decision model - ship it"; the decided design is R4 of `fm3000-card-close-decision-model-s1/report.md`, `docs/card-threads.md` is the one home).
  Every card is the head of a thread between the captain and the card's AUTHOR: what the captain types under a card goes to that author, and the author always answers in the thread; a revision under the same id carries that answer as `reply`, after the host's one `revised: …` line.
  A reply resolves nothing but a crewmate's signed-off line; the buttons stay pinned and explicit choices, task endings or author withdrawals retire cards.
  A reply keeps the card shown while its author answers; a revision is released at its writer's close-out, held in the core as `Card.awaiting` ("When a card reaches the stage").
  The record is `card_messages` (migration 38, owned by `CardStore` beside `card_revisions`, dying with its card in `deleteForTask`'s transaction) and `CardService.addMessage` is its ONE writer, so no row lands without the `inf:cards:thread` push that paints it; a captain reply on a crewmate's card is a captain STEER to that crewmate - the path a card click already takes - stamped `via: "thread"` with `THREAD_STEER_PREAMBLE` and the captain's words verbatim, delivered fire-and-forget the way a click's round-trip is.
  `CARD_REPLY` (contract v4.2) is the shared contract, stated ONCE the way `CARD_AUTHORING` is and included by every persona (`piResources.test.ts` pins both directions); the crewmate's `reply(card_id, text)` is its prose half on Pi and Claude, and the first mate's tool count stays 24.
  The settle hand-off carries NO classifier: nothing in the host reads the captain's words - a crewmate asked to put a change in, discard it, route a stronger model or take on unrelated work closes its own card and reports those words verbatim, and the whose-turn rule routes that report to the first mate, which runs the settle.
  The first mate is never woken for a thread message; it reads the bounded "thread activity since your last turn" context section beside `renderCaptainResolutions` (8 lines, 6h, same watermark) and the `thread:` fact on each crew line.
  Only a card's own author withdraws it, so `closeCard` refuses a first mate withdrawal of someone else's card; the captain puts cards away through minus and ends work through explicit controls.
  The shell is one CONTAINER for the pair (one surface, border, radius, shadow; a single hairline between columns; thread `clamp(0.4*stage,288,360)`, card `min(560, stage-32-thread)`), the card's one field sits above its buttons until the first message (INF-924), and below a 400px card the docked rails FOLD - `html[data-rails-folded]` zeroes their width while they keep their panels, which is why `--rail-docked-*` (what they ask for) is a different variable from `--occupied-rail-*` (what they take): reading the effective one would make the ladder circular.
  `threadGeometry.test.ts` reproduces the captain's R3.1 table at 960/1200/1440/1728; `tests/e2e/card-threads.spec.ts` is the binding flow.
  Phase 2 (`PROTOCOL_VERSION` 1.19.0; contract stays 4.2): a captain reply on the first mate's own card is a captain TURN with the card as its about line (`converseAboutCard`, `TurnPayload.aboutCardId`) - the first mate answers through the same `CARD_REPLY` shape (revise same id, or resend it unchanged, with a `reply` naming the captain's message; its closing words via `recordFirstmateThreadAnswer` are a line that leaves the question open; no first mate `reply` tool, count stays 24); images ride `inf:cards:reply` / `steer(text, images)` where the transport can carry them (Pi native, Claude Agent SDK user-message image blocks) and degrade with `ATTACHMENTS_DROPPED_NOTE` where they cannot (the durable inbox); Observe's session detail lists open threads (`CardService.observeThreads`, `[data-observe-threads]`).

## Current settings on replies

Author-directed replies carry the current named form answers as context alongside the captain's words and pictures, read fresh from the mounted body when available.
A partial reading is allowed for feedback; the same 64 KiB answer bound applies.
Submitted values reach the durable thread, card observations and crew steer record and supersede earlier submissions in a basis handoff.
The thread shows the captain's words alone, with the settings as one quiet collapsed line under them (FI3-617; the design skill's `CardThread.prompt.md`).
A reply is saved as its author reads it - the captain's words, then "Current settings (context, not permission):" and the `cardAnswerLines` lines (`replyWithSettings`) - and its `message_ref` observation records the answers.
`CardStore.messages` reads the two apart: where the saved text holds exactly the app's own rendering of the recorded answers, `CardMessage.text` is the captain's words and `CardMessage.answers` the settings, and anything else is shown whole with no `answers`.
The author's wake, the first mate's own turn about its card and a basis brief's thread still read words and settings together; the first mate's thread-activity line quotes the captain's words.
Changing how `cardAnswerLines` words an answer leaves replies saved before the change shown whole.
Words written under a question's Something else row ride a reply like any pick: `written in: "…"` in the author's settings lines, and in curly quotes after the picks in the thread's settings rows (FI3-1002); a written answer is never sent as a reply on its own.
Control changes alone start no turn and send nothing; they stay a draft on that computer, kept across a restart until the card closes (INF-2710).
What a reply's words or settings authorize is the handoff's (`HANDOFF`, `docs/card-authoring.md` "The handoff").

## Links on a revision

Each new host revision row keeps a typed `revision` in `card_messages.revision_json`: its lifecycle, source offer, immediate predecessor, ordered named-area destinations, removed count and release state.
`CardService` computes it when the author writes, never from the row's prose or time, and releases every list from that turn at the ordinary close-out, including successive writes before it.
Restart releases lists whose author turn ended, but keeps an unanswered captain hold.
Legacy host rows show “Change links unavailable”; nothing reconstructs their association.

The comparison is independent of the last-seen bars.
`cardNavigation` reuses `cardParts`' parsed, normalized multiset matcher, extends it with heading context, and compares verified picture and recording digests where available.
Moves, whitespace, attribute order and host decorations do not produce new parts.
Unheaded changes are Change N; repeated headings receive numbers.
Removed parts are counted without targets; a rewrite or a body beyond the 512-part bound gets Whole card, and an interactive preview gets Preview updated.
A reworded line counts as edited, not new (INF-1623, direction C): a part gone and a part new under the same heading path pair one for one, so they name their section, never count toward Whole card, and are not counted as removed.
The pairing reads only where each part sits, never its words.
Title, heading-only and button changes target those regions.

Every row shows three links, then N more and Show fewer, without a comparison caption.
An older link goes into the current card: the core carries its unique stable area id or unambiguous unchanged heading path through the intervening saved offers.
It prefers the original changed part if it survives, otherwise the area's heading.
A missing or ambiguous area stops that identity; a renamed heading needs its unique stable id to keep it.
Later content cannot resurrect a lost identity by coincidence.
The original link stays, and activation explains unavailability without scrolling.
The thread projection names the exact displayed offer, so a stale projection never moves another revision.

A press opens only ancestor disclosures, briefly highlights its destination, and scrolls the card's own reading area with context above the target.
The thread stays still, unrelated disclosures and form drafts stay intact, and a revision arriving never activates a link.
Keyboard activation focuses the destination; Escape returns to its originating link without closing the card.
The newest navigation owns that way back from the moment it starts, so an Escape taken before its reveal settles returns to its link, never an earlier one.
Reduced motion cuts the scroll.
Go to the next revised area is a keyboard command without a default key; it follows the selected row and defaults to the newest released list.
A collapsed thread retains its ordinary opening control.
Navigation submits no reply or choice and opens no external page or other card.

The opaque frame receives a bounded reveal request through the existing bridge, bound to its document, offer and a host-generated numeric target.
It opens disclosures and returns destination geometry; the shell validates the response and scrolls its own container.
No arbitrary selector, fragment navigation, history viewer or second scroller is introduced.

## Shared cards

INF-2214 found the fleet's talk on cards "pretty broken" (the captain's words): a crewmate that knew the right path could neither correct a required action's card nor answer under it.
The captain approved shared cards ("Any crewmate or first mate, without a per-card permission grant.") and responses by default; INF-2225 built them.

Any first mate or crewmate may write on a card it did not author, with no grant.
`CardService.targetOf` reads what an id names for its caller before any id prefix makes a new card: a card on the record is `own`, `foreign` or `closed`, an unused id in the caller's own namespace is `new`, and any other unused `card-` id is `unknown` and refused, never filed as a new card.
A writer reads the card first with `tasks card` (`CardService.cardRead`): its words, revision, lifecycle, choices, the captain message it waits on, and its thread with message ids.

`emit_card` on someone else's card is one of two writes (`CardService.contribute`).
With `expected_revision`, the revision the writer read, it revises the card's words in place.
Without it, the call writes its `reply` alone and leaves the card as it was.
Either way the card keeps its author, task, lifecycle, source offer and answerer, so editing never hands the work to the writer, files the card on the writer's task, withdraws or reopens it, or runs, approves, completes or settles anything.
A revision on a card that has changed since the writer read it is refused with the current revision, and nothing is written.
A stable `operation_id` sent again returns the first result instead of writing twice; the same id on another card is refused.
`contribution_reason` says why, one line.

Some words have their own owners, and a revision of them is refused in words that name the right path.
A closed card keeps its offered words, choices and decision history.
A required action's words change only through `revise_required_action` (`docs/required-actions.md`, "Correcting the words").
The app's own cards are not prose anyone revises.
A choice that carries an effect is checked against its own task, checks and version, so only its author's path changes it, and a saved change story belongs to its own crewmate.
Each of those still takes a reply in its thread when it has one.

The record keeps who really wrote (migration `addCardContributions`).
A thread line written by anyone but the card's answerer carries its contributor in `card_messages.contributor_json`: the first mate, or the crewmate by its task, with the host's own label such as "the crewmate on INF-12".
A revision's `revised:` line carries it too.
`card_contributions` keeps each contribution's operation id, card, writer, task, reason, time and the typed result it returned.
Rows written before this change name no contributor, and nothing guesses one.

Captain replies still go to the card's own answerer: the author, or the first mate for its own cards and for a crewmate's card whose task has closed.
Any line, the answerer's own included, ends a captain question only when it names that message with `answers_message` and the card is waiting on it (the captain's "Only a line that says it answers it; a handoff stays open").
A line without it - a handoff, a comment, the host's `revised:` - ends nothing, as the answerer's own interim line ends nothing, even one that names it; anyone else's interim mark is dropped, so their line is an ordinary one.
The answer is saved on the line (`card_messages.answers_message`), so when the card's own answerer, queued behind the steer, comes to the same question, the host tells it who already answered and with what (`CardService.answeredByContributor`), and its own line is kept as a comment.
A response a crewmate's `reply` correlates with the line is saved once with it (`crew_responses.card_message_id`), so a report naming the same response notifies nobody a second time (`docs/inbox.md`).

A closed card takes a dated clarification alone: a reply that is marked as written after the card closed, reopens nothing and changes no choice.
A revision or an `answers_message` on a closed card is refused.

A write the stage holds from someone else, a revision of a card the stage shows or an answer that names the captain's question, reaches the captain with its writer's own turn.
The host keeps that writer (`contributedUntilCloseOut`) and releases the card when it closes out, as an author's own revision waits for its close-out, never with an unrelated turn of the card's author.
It keeps the writer for the card's current lifecycle alone, so a card that leaves the stack and comes back under its id starts a lifecycle no writer holds.
The author's own close-out still ends what its turn held, so its next turn revises without a reply, and the writer's close-out then releases everything the card holds, the author's answer with it.
A revision the stage takes at once, such as the first mate's on a card that waits on nobody, holds nothing and waits for no one's turn.

The receipt is read from the typed result the host saved (`CardMutation`, `cardMutationText`), never written ahead of it: `created`, `revised`, `reply-only`, `unchanged` or `refused`, with the current revision, what stayed as it was, whether the captain sees it now or when the writer's turn ends, and what the line did to the captain's question.

Desktop and phone show the same words under such a line, from one owner (`contributorWords` in `threadWords.ts`, generated into `PhoneCardWords.contributor`): "Revised by …" under a revision's line, "Written by …" under a reply, and ", after the card closed" on a clarification.

An older computer is refused rather than trusted to drop the new fields (`SHARED_CARDS`, `src/shared/contract-changes/shared-cards.md`).
A computer that runs work refuses these writes and reads to a home without the change.
A home refuses a write on someone else's card from a work computer without it before writing anything.
A desktop view without the change gets thread lines without the contributor, the answered message and the clarification flag, in every answer and push that carries them (`THREAD_CHANNELS` in `src/core/connection/connection.ts`); a phone ignores fields it does not know.
