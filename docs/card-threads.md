# Cards as threads

Every card is the head of a thread between the captain and the card's AUTHOR.
What he types under a card goes to that author, and the author always answers with one short message in the thread, whether or not the card changes.
When the card should change too, the author revises it and passes the answer as `emit_card`'s `reply`: the head re-renders and the thread shows the host's `revised:` line, then the author's answer.

Captain-approved on the Lavish board on 2026-09-20 ("cards-as-threads over a decision model - ship it"); the decided design is section R4 of `fm3000-card-close-decision-model-s1/report.md`, R1-R3 carry the review rounds in his own words, and `board/thread-prototype.html` is the shell prototype he reviewed.
This file is the one home for the feature as built (phase 1 and phase 2).

Only a card's own author withdraws it.
The captain's close resolves the card; a reply may dismiss it temporarily without resolving it.
The first mate does not close someone else's card to relay the captain's words (`CardService.close` refuses that and names the door).

## The record

`card_messages` (migration 38): card id, who (`captain | crewmate | firstmate | host`), text, at.
`CardStore` owns it beside `card_revisions`, and a thread dies with its card - `deleteForTask` removes both in one transaction, so the D-13 purge and a task's own close need no new rule.

`CardService.addMessage` is the single writer: the captain's reply, an author's prose answer and the host's own "revised" line all go through it, so nothing writes a thread row without the `inf:cards:thread` push that paints it.

A captain reply on a crewmate's card is a captain STEER to that crewmate - the same control-plane path a card click takes - stamped `via: "thread"` (`steerViaSchema`) with the card's id, carrying `THREAD_STEER_PREAMBLE` and then his words verbatim.
Delivery is not awaited, exactly as a card click's round-trip is not: the message is on the record the moment it is typed, and a delivery failure is a feed line rather than a lost reply.

A line the captain types in a task's Crewmate tab rides the same lane as his own steer, stamped `via: "crewmate-tab"`, with no card and no thread (`docs/task-card-tabs.md`, "Typing").
While the captain's kept merge approval stands on the task, his reply, like his line in the Crewmate tab, is guidance that holds that merge until the crewmate declares its impact (`docs/delivery-rigor.md`, "A kept merge approval").

A reply resolves nothing.
The buttons stay pinned, and a card still leaves the stage on a button, a settle, the captain's close, the author's withdrawal, or a note's seen-collapse - all host code.

The captain's close of a crewmate's card on a live task reaches that crewmate the same way (FI3-435, captain-approved 2026-10-01): a captain steer stamped `via: "card"` with the card's id, the typed `card-closed` wake ("The captain closed your card ... without choosing.").
A close is not a choice, so the author judges what it meant by instruction - read and finished, still waiting on him, or a passing note - and its report declares it (`waiting_on_captain` or `finished`, `docs/report-sort.md`).
The host reads none of it.
The captain's close of a crewmate's card kept shown after his reply holds through the answer the crewmate is still writing (FI3-693): until that crewmate closes out, `emit_card` under the card's id is refused in words that send the answer to its report, so the answer does not open the card again.
After the close-out the crewmate may raise the id again, a new card, as after any close.
The first mate's own cards keep Q4a: their close wakes nobody and the next context block lists it.

A reply does hand the turn to the author, and the shell shows it: an ordinary card leaves the stack until its author answers and closes out, and the card a close would bring up comes up instead - the first unread card, else the first card (the captain's FI3-711 answer: one rule for a close and a reply).
An author may declare `holds_place` on `emit_card` (`Card.holdsPlace`): a reply then keeps that card shown with its thread beside it.
Each newly arriving marked card comes forward, including the same stable id raised again after a choice, but a revision or thread answer never undoes the captain's paging away.
Every choice still closes the card immediately; nothing keeps its page running while its author writes.
Cards without the declaration retain their existing stage rules.
The shell moves on as soon as the reply is taken, so the departing card never opens its thread on the way out (`replyLeaving`).
A lone card stays put with the thread beside it, and its body, scroll and reply field stay the same elements as the thread opens: only the surface's columns change.
Its reply field keeps the focus through the send, so a second reply is typed straight away (`docs/composer.md`, "The card reply row").
A reply sent while the card's Anything else? box holds words carries them among its settings, as the answer `anything_else`, and the box keeps them for the button the captain clicks later (`docs/card-authoring.md`, "Anything else?").
The author's answer redraws it at the close-out - see the next section.
A refused reply moves nothing and keeps the draft.

## When a card reaches the stage

Captain-approved on a board in two rounds on 2026-09-27 ("ship it", verdict "Ship it as recommended"; the decided design is sections 0, 6 and R2 of `fm3000-card-return-closeout-r1/design-excerpt.md`).
**One rule for every crewmate card** (the captain's Q1 A and Q5 A): a crewmate's card - new, revised, or answered in its thread - reaches the stage at the crewmate's CLOSE-OUT after its last write: its next `report`, or its idle (its resumable turn ending), whichever comes first.
Cancellation and terminal session failure close the task and retire all its open cards, including hidden replies and pending revisions, without releasing them onto the stage.
Card rows, revisions and threads remain on the record; they do not return after restart.
A recoverable provider-failed turn or interruption is still an idle boundary, not a task close.
Emission also rechecks the task at publication, so a completion check that finishes after closure cannot recreate a retired choice.
A task that closes done keeps its crewmate's notes and the first mate's notes (cards with no actions) on the stack until the captain closes them.
A note asks nothing, so the close does not answer it, and an unread note must not vanish (FI3-419, FI3-1581).
A question card still comes down with the close, and a dropped or cancelled task still retires everything.
The crewmate is gone, so a captain reply on its kept note goes to the first mate, as on its own cards: its closing words land in the note's thread (`recordFirstmateThreadAnswer`), its turn's end releases the wait (`closeOut`), and the WI-12 refusal does not send it to steer a crewmate that is gone, so a card of its own on that task shows.
A captain reply removes an ordinary card from the stage until the answer and close-out.
The view declares whether the card leaves at send time through the optional fourth `inf:cards:reply` argument, so records, past cards and collapsed notes do not count.
That decision survives reload and restart; a later arrival does not dismiss a lone card that stayed.
A kept reply stamps `Card.sentBackAt`, retaining the shown version until close-out.
Older views omit the argument and keep the earlier stamped behavior.
A marked continuity card keeps its stack order and shown place; the same stamp still establishes that it has reached the stage.
Every write in between lands on the record and paints the thread; the card does not redraw.
A card already on the stage that its crewmate revises keeps showing what it showed and redraws in place at the close-out.
A card awaiting an answer never collapses into its task record while it waits.

**The first mate's own cards** keep working as they did (the captain's Q3 A): they go up and redraw at once, its turn's end is its close-out, and its closing words are its thread answer - for the reply its turn was about and, since contract v4.14, for one it read mid-turn - unless it revised the card, whose `reply` is then its answer.
Those closing words are one sentence, and the same words show as its reply line beside the captain's message (INF-772, the captain's "both places"; `docs/composer.md` "The last turn").
When the answer needs a crewmate, that crewmate shows it on its own card; the first mate answers the thread with one line naming it, never a new card.

**The hidden state lives in the core** (the captain's Q4 A): `Card.awaiting` on the card snapshot - `answer` while the captain's line is the newest on the thread, `close-out` while the author has written and not yet closed out, absent on a card the stage shows; a card waiting for its first close-out is off the stage, while a reply with other cards removes it until the answer; kept replies and legacy stamped cards remain on it.
`CardService` is its one writer: the captain's line sets `answer` (`addMessage`), any later line ends it (the author's answer, or the host's `revised:` for a revision), every crewmate write holds a new or hidden card for its close-out, and `closeOut` - called from the crewmate's `report` and its resumable turn's end, and the first mate's turn end - releases what waited on that author.
`snapshot()` is the stage: a card on it whose author has written again is pushed as the version the stage showed until the close-out.
The columns are `cards.awaiting` (migration 52) and `cards.sent_back_at` (migration 59), so the send-time departure decision survives a restart and a reload; the restart is itself every author's close-out, so a card that only waited on one reaches the stage at boot.
`sentBackAt` is a kept or legacy reply's time: `snapshot()` sorts an ordinary waiting stamped card after every other one, oldest stamp first (`compareStack`), so cards that arrive later sort in front of it and a second reply sends it back again.
The optional declaration lives in `cards.holds_place` (migration 77); null preserves legacy behavior, and a revision without it removes it.
The author's close-out clears the stamp: the answered card returns to its original place, unread unless it is the shown card.
A captain reply's hold is pushed at once rather than in the core's 60 ms push window, so the window always sees the wait that the close-out ends, however fast the author answers.
Bands sort by priority, oldest creation time first within each band.
A click resolves against the version on the stage.

What reads it: the renderer shows a card only when it is on the stage (`visibleCards`) and has no door of its own - a thread message never brings a card forward, and an ordinary card's return is an arrival: onto the stage when nothing else is shown, else without displacing the shown card, unread, with the notice pulse; a kept or legacy waiting card is also an arrival when its `awaiting` clears.
A newly visible marked card instead becomes the shown card, already read, at its author's close-out.
The core's push moves the stack: `reconcileStack` sees the shown card leave - a close, withdrawal or task closure - and `departureIndex` picks what comes up: the first unread card in stack order, else the first card, passing over the card a reply removed (a lone card stays).
The only other mover is the reply's own acceptance, which applies the same rule early (above).
Unread is the session's "new" badge, never a saved fact.
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

**The contract** (v4.14): the crewmate's thread steer preamble and `CARD_REPLY` say to do the work his words need first, answer once - revise the card, or reply when nothing on it changes - then report, because the card comes back when you are done; never acknowledge or announce.

## The waiting line

FI3-592, grounded on FI3-643 (the captain folded a waiting line for every reason into FI3-592).
While the captain's line is the newest on a crewmate's card (`awaiting: "answer"`) and its author's turn is not running, the thread's message list ends with one quiet sentence in the app's voice where `working` would be: that the reply is saved, what holds it, who goes next and, for a held account, the way back.
It is derived, never a message: a host line would end the reply's wait (`addMessage`), and the card keeps showing what it showed.

The line reads the task's work posture, the typed state the Tasks dot reads (`CrewSupervisor.workPosture`; `threadWait` and `threadWaitWords` in `src/shared/threadWait.ts`), and the task's assignee, both off the sequenced board (`useThreadWait`).
Nothing reads anyone's words.

- `access`: the reply is kept, not sent.
  The posture carries the typed cut-off (`WorkPosture.hold`: its class, the provider and a spent allowance's reset), so the line names the way back the cut-off contract gives (`docs/quota.md`, "Typed cut-offs"): the reset, on its own; signing in again; another login or an updated client for a refusal - and, where the wait can be long, asking the first mate to move the work to another model.
  For a task on a computer that runs work the hold also says where that computer's own sign-in is (`where`, "on Mac mini"), and the line names it: "Claude needs you to sign in again on Mac mini."
  It never offers a Retry that cannot clear the hold.
- `checks`: the author waits for the checks and answers when they finish (the check watch's wake).
- `job`: the author waits for its own background work.
- `settlement`: the task is being merged or discarded.
- `guidance`: nothing else holds the author, and it has not answered yet.

A running turn shows `working` alone.
When the hold ends, the checks finish or the author's turn starts, the posture moves and the line with it, with no thread message; the author's answer - a reply, or the host's `revised:` line
- ends the wait and the line.
  Every input is persisted (the card's hold, the account's cut-off, the task's check watch), so a restart or a reload shows the same line.
  A first mate card has none: the paused seat writes its own saved line for every message it keeps (`docs/architecture.md` §16, "A paused seat").

The author's side says the same.
A revision of the open completion card goes up while its checks run, carrying that answer with it (INF-834 friction 4).
A new completion card the checks refuse while a captain reply waits on one of the task's cards asks for the thread answer now - one line saying what it did and who goes next - and the card update once they pass (`CrewSupervisor.waitingReplyNote`).
`HANDOFF` (contract 4.70) answers a reply that only authorizes a build the same way: one thread line naming who is next, the card unchanged.
An answer task's author then reports the approval with `needs_firstmate` (contract 4.73), which wakes the first mate to start the builder.
While the first mate has not acted on that task since, the idle ladder raises the request again, with the card still up (`docs/report-sort.md`, "A request the first mate leaves unanswered is raised again").

## The contract both agents read

`CARD_REPLY` in `src/core/prompts/cardContract.ts` is ONE text, included exactly once by every persona beside `CARD_AUTHORING` (the captain's Q4 B: "this is not just crewmate - firstmate should largely share the same contract").
It says: always give one short answer (one to three sentences); also revise the card when the reply changes what the card should say (same id, `emit_card` with the answer as `reply`); answer with `reply(card_id, text)` alone when nothing on the card changes; a reply is prose only - no actions, no script, no figure; and a reply resolves no card.
Explicit build words authorize implementation, not merging; settings alone authorize neither.
Since v4.14 it also says when: the work comes first and the answer once, because the card comes back only when its author is done.
`piResources.test.ts` pins that every persona carries it once and no tool description repeats a sentence of it, the same structural pin `CARD_AUTHORING` has.

While a captain reply waits on the author, `emit_card` under that card's id without `reply` is refused as tool text naming the fix, and the card and thread stay unchanged (`CardService.upsertEmitted`).
An author that answers first with `reply(card_id, text)` may revise afterwards with no `reply`, because the answer already landed.
The app reads only that typed state, never the words of the answer.

A crewmate gains one output for that answer: `reply(card_id, text)` (`crewmateTaskTools.ts`, Claude twin in `claudeTaskTools.ts`), beside `report` / `emit_card` / `note_progress` / `file_followup`.
Its description carries call mechanics only.
The first mate's tool count is unchanged at 24
- there is no first mate `reply` tool; it answers the same two ways through `emit_card` and its closing words.

## First mate card threads (phase 2)

A captain reply on the first mate's own card is a captain TURN about that card, not a steer.
`cardTakesReplies` is true for a first mate author; `CrewSupervisor.replyToCard` files the captain's message and calls `converseAboutCard` (`FirstmateAgent.converse` with `aboutCardId`).
The about line replaces the maybe-hint:

`about: card <id> (<presentation>) "<title>" - the captain replied in its thread`

The first mate answers through the same `CARD_REPLY` shape: revise the card under the same id with `reply` (the host writes "revised:", then the answer) or leave closing words as prose (`recordFirstmateThreadAnswer`, only when the newest thread message is still the captain's).
A parked idle turn keeps the card on its inbox ref (`captain-turn:card:<id>`); a mid-turn reply rides the existing steer with the about line in context, and since v4.14 the turn's closing words answer it too, because the card now waits for an answer across restarts.
Closing words written into a card's replies count as the action the answer-delivery check looks for (`docs/task-capture.md`); a reply the turn answered with nothing is retried once, under the same card.
Contract v4.2 is unchanged; the wire bump is protocol 1.19.0 for images on `inf:cards:reply`.

### A card with no reply row

One first mate card takes no reply: the welcome (FI3-1164, the captain's word: "for this particular card, let's disable "reply to this card" input box at the bottom. otherwise it's overwhelming").
The host marks it when it presents the note (`Card.replies` false, the `cards.replies` column; `addRecordedFirstmateNote(..., { replies: false })`), and `cardTakesReplies` reads it as no, whoever the author is.
The window draws no reply row under it and refuses the Reply commands with "This card takes no reply"; `CrewSupervisor.replyToCard` refuses one with "takes no reply".
Its words send the captain to the message box under the card, so the first-run hint ends on a message sent from there (`docs/first-launch.md` "The welcome").
Every other card keeps its row as its author allows.

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
The whose-turn rule then wakes the first mate (`docs/report-sort.md`, row 0a) for the turn that runs the settle it would have run had he typed the same words in the main input.
A build he approves by reply under an answer task's card is relayed the same way, with the card left up (`HANDOFF`).
Without the declaration the report sorts like any other, and on a backend the host cannot watch it wakes nobody.

That is the captain's Q2 as he corrected it: "crewmate should not answer the user with 'not mine'. it should just close the card and pass the decision to firstmate to execute."

## How the first mate learns

It is never woken for a thread message (the captain's C9 A).
Two bounded facts reach it on whatever turn comes next:

- **"thread activity since your last turn"** - a context-block section beside `renderCaptainResolutions`, one line per card: who wrote last, the first ~120 characters, how many messages, and who owes an answer now.
  That last fact is `CardService`'s typed `ThreadOwed`, read from the same current `answer` hold as the whose-turn rule (`CardStore.awaitingAuthor`), never from who wrote last.
  The line ends `awaiting the author` while an open card holds for its author, `awaiting your answer` when the first mate is the one that answers (its own card, or a note a done task kept), `no answer owed` on an open card without the hold, and `card closed, no answer owed` once the card is resolved.
  So a captain message a withdrawn or reopened card kept reads as owing nothing.
  Bounded exactly like the resolutions (8 lines, 6 h), with the same watermark, so a busy conversation cannot swell the block.
- **`thread:` on the task's crew line** - `2 messages, last from captain`, from `CardService.threadFact`; `crew_status` carries the same field.

The whose-turn rule gains one fact (`reportSort.ts`): an unanswered captain message in a thread is the CREWMATE's turn, so its report wakes nobody.
It is branch 0, above the open-card branch, deliberately - the captain has spoken since that card went up, so the card no longer holds the turn.

## The shell

The design skill owns every visual rule (`.claude/skills/infinitary-design/components/cards/CardThread.prompt.md`); `src/renderer/src/cards/CardThread.tsx` implements it and `threadGeometry.ts` holds the ladder's arithmetic.

While a card has no thread, "reply to this card…" is the very bottom of the card, under the action row and one hairline above it (the captain's tweak 3).
A card with no author to reach - the host's own agent-down set - has no reply row at all, and neither has the welcome ("A card with no reply row", above).

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
The shell's `closedThreadIds` holds the cards collapsed in this window, and `entryView` (`src/renderer/src/app/HomeScreen.tsx`) draws such a card lone, its reply row at its foot with the thread's latest line above it (`ThreadCue` in `CardThread.tsx`); a click or Enter on that line, or ⌘\ again, opens the thread (`openThread`).
The reply slot never leaves the card's tree, so the draft, pictures, chips and the body's state survive both moves.
A focused reply field keeps the focus; otherwise the card layer focuses what undoes the move, the latest line or the collapse, ringed when a key moved it.
Collapsing gives up what folded the docks, so in a narrow window they come back, and the folded docks' edge tabs collapse the thread the same way.
A thread push that holds a message the window did not have opens the thread again (`applyThread`): the author's answer, a host line, or the captain's own reply sent from the collapsed row, so nothing written goes unseen.
A read that brings nothing new, such as a window catching up, keeps the collapse.
The collapse is shell state for the card while it is up, like a dragged width: `applyCards` drops it with the card, and nothing is saved or sent to the author.

`threadGeometry.test.ts` is the binding evidence: the R3.1 table at 960 / 1200 / 1440 / 1728 with both docks, one dock and none, and `card-threads.spec.ts` measures the real shell against it - folded at the default 1200 (expanded docks reserve a 600px centered stage) and beside the docks at 1728, clear of the rail.
The collapse's rules are `store.test.ts`'s, its controls `CardThread.test.tsx`'s, and `card-threads.spec.ts` drives it by keys, its own controls and a new line.

One sharp edge paid for there: `--rail-docked-left|right` are REGISTERED (`@property`, `syntax: "<length>"`) because the ladder reads them.
An unregistered custom property computes to its own token stream, so `--rail-docked-left: var(--rail-width)` reads back through `getComputedStyle` as the literal `max(300px, 20vw)` and parses as `NaN`; the ladder then placed the pair as if nothing were docked and it sat under the rail.
`useShellLayout` also observes the STAGE's size, because a rail docking or undocking is not a render of the card layer.

## Ready decisions and choice admission

Task waiting follows the version the stage shows, not the durable head (`docs/task-record.md`, "Ready waiting is a presentation projection").
New crewmate cards still release at report or idle, whichever comes first; report can release a decision while its author keeps working.
A reply hides it at once.
Acknowledgement or an unreleased revision does not redraw it.
An unanswered reply keeps its send-time visibility across restart; restart releases close-out.
These release and durable-gate policies are unchanged.

Other thrown action/reply refusals keep their reason, but the preload removes Electron's remote-method wrapper and error-class prefix before the shell or an embedded card receives them (`src/preload/readableRequest.ts`, shared with Settings' directly displayed request failures).
A failure with no usable reason gets a short choice/reply-specific fallback.
This does not change acceptance receipts, the wire contract, or the shell's refusal recovery: choices stay open and replies return with their unsent words and pictures kept.

A hidden or associated closed-task card refuses an action before resolution, author guidance or an effect.
The emit boundary agrees, so no choice shows that this would refuse: a card with actions whose `task_id` names a closed task is refused at emit (the first mate's lint names its ways out, `CardService` holds it for every author), while a note may still name a closed task.
A choice naming no action declared by the shown offer also refuses before bookkeeping, leaving both the card and its task open; an unseen action from a pending revision is not yet offered.
Refusal is typed internally and transported as `refusal` text, not the empty acceptance receipt: the shell retains an open card and shows the refusal without a transport wrapper, rather than removing it optimistically.
Valid choices still use the shown offer, including when a newer stored revision changes its actions.
Gate-backed decisions/operations use their existing typed card-raised task association after closure (closure clears the live gate).
Submission metadata, required-answer rules and routing are unchanged.
Cancellation and terminal session failure retire the task's open cards through `SettleService.closeRecord`, as ordinary settle closure does through `closeTask`.

## Tests

- `tests/e2e/task-card-retirement.spec.ts` - a shown decision disappears on running cancellation or actual terminal client exit and stays retired after restart; cancellation of a restored idle task retires its decision without reopening the session.
  `crewSupervisor.test.ts` joins closure with cards and task detail, covering hidden cards, pending revisions, preserved history/threads, unrelated choices and resumable failure/interruption.
- `tests/e2e/card-threads.spec.ts` - phase 1's three scenarios (a reply that revises the card in place, a reply answered in the thread, and "merge it" under a completion card landing as the first mate's settle) plus phase 2: a captain reply on a first mate card revises it / lands as prose, and an image rides a thread reply on a transport that supports it.
  The stage rule's case A: with two cards, a reply removes the card and an acknowledgement does not return it, a reload keeps it away, and the report brings the answer, unread; a lone card stays on the stage.
  A lone replied-under card closes from its own X and stays closed through its crewmate's answer; `cardService.test.ts` holds the refusal until that crewmate's close-out.
- `tests/e2e/stage-reveals.spec.ts` - a close and a reply both bring up the first unread card, the answered card comes back as news, and with nothing unread the first card comes up; a reply under a lone card keeps its body as the captain left it.
  `store.test.ts` owns `departureIndex`, `dismissalSuccessor` and the reply's early move.
- `crewSupervisor.test.ts` ("a card reaches the stage at its author's close-out") - the design's recorded exchanges A, B and C replayed at their offsets through the real card, thread and report paths; `firstmateAgent .test.ts` - case D on the first mate's own card and the mid-turn capture; `cardService.test.ts` - the hide across a restart.
- `tests/e2e/thread-waiting.spec.ts` - a reply under a Claude crewmate's card that meets a refusal shows the held waiting line, keeps it across a restart, and loses it to the crewmate's answer once another login serves.
  `threadWait.test.ts`, `CardThread.test.tsx` and `workPosture.test.ts` own the wait per posture, its words and the row; `crewSupervisor.test.ts` the typed hold on the posture and the checks refusal's thread answer.
- `crewSupervisor.test.ts` ("the card thread") - the steer's shape and its `via: "thread"` record, the refusals, the host "revised" line, the crewmate's own reply, the whose-turn fact, the context facts, a first mate card routing to a captain turn, and an image on a crewmate steer.
- `firstmateAgent.test.ts` - the about-card line and the prose capture at turn end.
- `cardStore.test.ts`, `reportSort.test.ts`, `threadGeometry.test.ts`, `observeService.test.ts` / `observe.frame.test.ts` (threads on the detail header).

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Cards as threads (phase 1, captain-approved 2026-09-20 "cards-as-threads over a decision model - ship it"; the decided design is R4 of `fm3000-card-close-decision-model-s1/report.md`, `docs/card-threads.md` is the one home).
  Every card is the head of a thread between the captain and the card's AUTHOR: what he types under a card goes to that author, and the author always answers in the thread; a revision under the same id carries that answer as `reply`, after the host's one `revised: …` line.
  A reply RESOLVES NOTHING - the buttons stay pinned and a card still leaves on a button, a settle, the captain's close, the author's withdrawal or a note's seen-collapse.
  Sending takes the card off the stage until the author has answered and closed out - its report or its idle, the first mate's turn end - held in the core as `Card.awaiting` ("When a card reaches the stage", 2026-09-27).
  The record is `card_messages` (migration 38, owned by `CardStore` beside `card_revisions`, dying with its card in `deleteForTask`'s transaction) and `CardService.addMessage` is its ONE writer, so no row lands without the `inf:cards:thread` push that paints it; a captain reply on a crewmate's card is a captain STEER to that crewmate - the path a card click already takes - stamped `via: "thread"` with `THREAD_STEER_PREAMBLE` and his words verbatim, delivered fire-and-forget the way a click's round-trip is.
  `CARD_REPLY` (contract v4.2) is the shared contract, stated ONCE the way `CARD_AUTHORING` is and included by every persona (`piResources.test.ts` pins both directions); the crewmate's `reply(card_id, text)` is its prose half on Pi and Claude, and the first mate's tool count stays 24.
  The settle hand-off carries NO classifier: nothing in the host reads the captain's words - a crewmate asked to put a change in, discard it, route a stronger model or take on unrelated work closes its own card and reports those words verbatim, and the whose-turn rule routes that report to the first mate, which runs the settle.
  The first mate is never woken for a thread message; it reads the bounded "thread activity since your last turn" context section beside `renderCaptainResolutions` (8 lines, 6h, same watermark) and the `thread:` fact on each crew line.
  RETIRED with it (captain's Q3 A): the close rule at `piResources.ts:92`, and `close_card` on the captain's behalf - only a card's own AUTHOR withdraws it now and the captain's × is the only dismissal, so `closeCard` refuses a first mate close of anyone else's card; the Jev pre-step and the relay classifier were the alternatives this replaced and are not built.
  The shell is one CONTAINER for the pair (one surface, border, radius, shadow; a single hairline between columns; thread `clamp(0.4*stage,288,360)`, card `min(560, stage-32-thread)`), the reply row is the very bottom of the card until the first message, and below a 400px card the docked rails FOLD - `html[data-rails-folded]` zeroes their width while they keep their panels, which is why `--rail-docked-*` (what they ask for) is a different variable from `--occupied-rail-*` (what they take): reading the effective one would make the ladder circular.
  `threadGeometry.test.ts` reproduces the captain's R3.1 table at 960/1200/1440/1728; `tests/e2e/card-threads.spec.ts` is the binding flow.
  Phase 2 (`PROTOCOL_VERSION` 1.19.0; contract stays 4.2): a captain reply on the first mate's own card is a captain TURN with the card as its about line (`converseAboutCard`, `TurnPayload.aboutCardId`) - the first mate answers through the same `CARD_REPLY` shape (revise same id, or closing words as prose via `recordFirstmateThreadAnswer`; no first mate `reply` tool, count stays 24); images ride `inf:cards:reply` / `steer(text, images)` where the transport can carry them (Pi native, Claude Agent SDK user-message image blocks) and degrade with `ATTACHMENTS_DROPPED_NOTE` where they cannot (the durable inbox); Observe's session detail lists open threads (`CrewSupervisor.observeThreads`, `[data-observe-threads]`).

## Current settings on replies

Author-directed replies carry the current named form answers as context alongside the captain's words and pictures, read fresh from the mounted body when available.
A partial reading is allowed for feedback; the same 64 KiB answer bound applies.
Submitted values reach the durable thread, card observations and crew steer record and supersede earlier submissions in a basis handoff.
The thread shows the captain's words alone, with the settings as one quiet collapsed line under them (FI3-617; the design skill's `CardThread.prompt.md`).
A reply is saved as its author reads it - his words, then "Current settings (context, not permission):" and the `cardAnswerLines` lines (`replyWithSettings`) - and its `message_ref` observation records the answers.
`CardStore.messages` reads the two apart: where the saved text holds exactly the app's own rendering of the recorded answers, `CardMessage.text` is his words and `CardMessage.answers` the settings, and anything else is shown whole with no `answers`.
The author's wake, the first mate's own turn about its card and a basis brief's thread still read words and settings together; the first mate's thread-activity line quotes his words.
Changing how `cardAnswerLines` words an answer leaves replies saved before the change shown whole.
Words written under a question's Something else row ride a reply like any pick: `written in: "…"` in the author's settings lines, and in curly quotes after the picks in the thread's settings rows (FI3-1002); a written answer is never sent as a reply on its own.
Control changes alone start no turn and remain unsaved renderer-memory drafts, lost on restart.
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
