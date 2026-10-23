# Card body authoring contract

The contract between agents and the card surface (decision D-9).
Each kind lives in `src/core/prompts/cardContract.ts`:

- **`CARD_AUTHORING`** - what a card IS and how it should look.
  Every persona renders its reader’s text exactly once (`buildCrewmateSystemPrompt` on Pi and Claude; `buildFirstmateSystemPrompt`) and no descriptor repeats a sentence of it.
  Crewmates keep the full text word for word; the first mate’s `FIRSTMATE_CARD_AUTHORING` omits only playable previews, moving-figure rules, demos, working-copy pictures and preview styles, because its cards are static SVG (FI3-566, the captain’s approved cut).
  The system prompt is the only channel that arrives whole on every backend, and it is where the deliverable is already defined.
- **`CARD_MECHANICS`** - how to CALL the tool.
  It stays in the `emit_card` description, under the 2,048-character cap the Claude client silently truncates at; `claudeToolSurface.test.ts` is the guard that what the transport serves equals the source.
- **`HANDOFF`** - what a choice on a plan or investigation authorizes, who builds it, and what the builder starts from (contract v4.41; "The handoff" below).
  Every persona renders its reader’s text exactly once beside `CARD_REPLY`, and no other text an agent reads repeats a sentence of it.
- What THIS task's answer should look like is none of these: the host renders it into the brief (`renderAnswerShapeSection`).

`piResources.test.ts` pins both directions of the split.
The persona prompts otherwise carry only policy: when a card is allowed at all.
This document explains the same rules for people and names the host mechanisms behind them; where it and the constants disagree, the constants are what the model was told, so fix this file.

## One card

Via the `emit_card` tool (`src/core/pi/cardTool.ts`).
There is one card shape on the wire (cards/tasks/agents P1, captain ruling D1 a): a title, a body, and the actions the author declares.
Nothing declares a kind.
What a card *is* follows from what it carries, and the host derives the chrome from that (`cardPresentation` in `src/shared/cards.ts`):

| what the card carries | how it reads | body |
|---|---|---|
| actions | a **decision** (the "Decision" chip) | one-sentence answer, then evidence - or a working preview |
| no actions | a **note** (the "Note" chip) | a semantic HTML fragment: one fact |
| actions, authored by the app itself | **attention** (the agent-down set: sign in, out of quota, a refusal, a paused or moved seat, a failed turn; and a crewmate stuck past the idle ladder) | the host's own copy |

One general rule decides between the first two (contract v4.1): a card whose answer implies any potential next step for the captain, even an optional one, is a decision with the step the emitter would take marked `default`; only a pure fact with no next step is a note.
A decision offers 2-3 declared options and marks exactly one `default`; the card carries exactly what its author declared (no automatic `Later`), and the shape lint refuses any other count.
An available crewmate shows its own findings and decisions on its own card, rather than reporting only for the first mate to relay them.
A note is never a progress update; routine progress belongs in the quiet feed, and emitting zero cards is correct when nothing needs them.

Every card has a close control in its chrome, and closing is the keep: the card leaves the stack and nothing runs.
A crewmate's card's close is told to its author, which judges what it meant (`docs/card-threads.md`); a first mate card's close wakes nobody.
So a card never offers a "Keep" or "Dismiss" button of its own.

### The preview is the decision

A decision's body may be a working preview: an interactive HTML mock of the thing being chosen, which is what the retired `live-prototype` kind used to be.
It is not a separate kind.
**When a card shows options, the options are that card's actions.**

Such a card is a decision because it has actions: the same chrome, exactly the declared actions, one `default`.
Two things read the body's shape instead (`isPreviewBody` in `src/shared/cards.ts`: the body carries a `<style>` sheet, a `<canvas>`, or a `<script>` outside every `<figure>`) - the shape lint leaves a preview's markup alone, and the first mate's on-screen-card line quotes no excerpt from it.
A body without one of those is prose, and is held to the prose rules however it is laid out.
A script inside a figure only moves that figure (FI3-796, the captain's yes), so its card keeps the shape lint, the change bars, the excerpt and the width rule; it still runs on the mount path, as every scripted body does.

## Actions and effects

An `emit_card` action is `{ id, label }` plus optional flags (`cardActionSchema` in `src/shared/cards.ts`):

- `default: true` marks the step the emitter would take.
  The host renders it as the primary button - never whichever option happened to be listed last.
  A decision marks exactly one.
- Every declared action closes its card.
  The captain asks for a revision by replying under the card ("Replying to a card" below), never by a button, so no decision offers a Revise or Explain more button.
  `keeps_open` is retired (contract 4.65): `emit_card` does not offer it, and it refuses a call that still passes it, because dropping the flag silently would turn a revise button into a closing choice.
  Migration 73 removes each saved keep-open action from cards still open and returns a streaming card to ready.
- `effect` says what the host does on the click (captain ruling D2).
  The host dispatches on the effect and on nothing else - an action id is a name, and no id has semantics of its own.
  An action with no effect is a reply: the click returns to its author as the user's choice.
- `danger: true` renders the destructive variant.
  A `settle discard` is always danger; danger outranks the default's primary.

The effects an agent may declare:

| effect | what the host does |
|---|---|
| `{ kind: "settle", mode: "merge" }` | Settles the card's task by the repository's delivery posture: on a direct-pr repository it re-checks every check on the proposed change's head, puts the change in where the project lives - merges the pull request on GitHub, fast-forwards the default branch onto the sent-up working copy on a plain Git host, never forced (`docs/forge.md`) - and only then removes the task worktree; on a local-only repository it merges the task branch into the current checkout and removes the worktree. The agent never learns which - one effect, one button, labelled "Merge the pull request" or "Merge the branch" by the posture the brief named, and, where a click keeps the captain's approval (`docs/delivery-rigor.md`, "A kept merge approval"), "Merge when checks pass" while the pull request's checks are still running and "Merge after fixing errors" once they failed, unless the captain's override passes the checks at the card's version. |
| `{ kind: "settle", mode: "discard" }` | Removes the worktree without merging. Unlanded work is refused unless `confirm: true` is set, which an author sets only when the body already says the branch holds unlanded commits or uncommitted edits. |
| `{ kind: "open", target: "settings" \| "subscriptions" \| "projects", sign_in? }` | The shell opens Settings on that section. `sign_in` names the host whose sign-in Settings -> Projects starts on arrival (github.com's lands on Settings -> Integrations, which owns it, `docs/integrations.md`), exactly as a "Not signed in to <host>" refusal's way names it (contract v4.9), so the code is already on screen. |

A settle effect needs the card's `task_id`.
A crewmate whose task has its own browser may also give the card one door to it, `browser_button`, which is not an action: the host draws it as chrome between the body and the buttons, and its click opens the task's browser view without answering the card (`docs/task-browser.md`, "From a card").
With `browser_page` the same button opens an HTML page from the task's project in that browser instead, with the captain in control, and needs no browser open (`docs/task-browser.md`, "A page from the project").
The same crewmate may ask the captain to take that browser over with `browser_handoff` - the site, why, and what it does after - on an ordinary decision whose one `{ kind: "open", target: "browser" }` action opens the view with the captain in control; the host pauses the browser before the card goes up (`docs/task-browser.md`, "Asking for help").
A third effect kind, `host`, carries the app's own operations (re-run an account's sign-in, move the flagship, retry the failed first mate turn) and belongs only to the cards the app authors; every emit boundary refuses it from an agent.

Completed captain-requested work gets an outcome card before the final report.
Without a change of the task's own to put in, it is a factual note naming what happened and how it was verified, with no settle action; the first mate can then close or continue the task.
Answer tasks already deliver their card; internal reviews and hand-off steps deliver their report, and personal-workspace builds explicitly remain report-only.
With a change to put in, the completion card has two actions: the merge (`default`, `settle merge`) and the discard (`danger`, `settle discard`).
The host writes that pair (captain lock 3): a crewmate declares one action carrying `settle merge` and the host replaces every settle action with the merge labelled for the task's posture and the discard beside it (`CrewSupervisor.withCompletionActions`).
A `request_merge` action is not that pair: the host labels it Merge the pull request and leaves the crewmate's other actions, including Not now, so a pull request the task did not open is not discarded with the task (`docs/forge.md`, "A requested merge").
A review that skips the branch rules labels it Merge, skipping the rules, and after the lint the host adds what the click does at the end of the body (`.inf-call`): the version, every rule it may skip and every failed check (`docs/forge.md`, "A merge past the branch rules").
A `request_write` action is a crewmate's ask to send a write it kept: the host labels it Send it to GitHub, after the host's own name, leaves the crewmate's Not now, and after the lint adds the exact call at the end of the body (`docs/forge.md`, "A write that asks").
It does this before the lint, so the lint reads the card the captain will actually get: a completion decision that declares only the merge gives the two actions a decision needs, and one more of the crewmate's own still fits.
The crewmate is told to declare no labels, so its `emit_card` schema asks for none on either backend; every other action the host keeps needs a label of its own, and one without words refuses the card (`labeledActions`).
The first mate's schema still asks every action for a label, because no host words its buttons.

Two things the host deliberately does not take over.
`confirm` on the discard is a claim about what the BODY says, not a fact the host holds, and setting it would destroy unlanded work without the captain choosing; left off, a destructive discard returns the structured `unlanded-work` refusal and its ways out, which is the captain's confirmation.
And a non-settle action the author declared - its own deferral, a question it wants answered alongside - survives untouched: a card carries exactly the actions its author declares beside the completion pair.

There is still no keep button; closing the card keeps the crewmate idle and the worktree and any PR open.
Clicking a settle action never comes back as a steer: the host runs it and reports the outcome to the first mate, which re-settles or raises a decision when the outcome is a refusal.
Do not put settle effects on intermediate questions, and if a completion card is already open reuse its `emit_card` id so it updates in place.

Cards minted before P1 carried these semantics as reserved action ids (`keep`, `merge-pr`, `land`, `discard`, `open-settings`, ...).
Migration 29 rewrote every open card's actions into effects (`legacyActionEffect`, logged in `card_effect_backfill`; closed cards are history and untouched), and the replay harness applies the same translation to the cards its recorded sessions emit.

## The host's settle facts

On any card carrying a `settle` effect, the host appends its own fact strip (`CrewSupervisor.settleFacts`, captain ruling D4 of the v2.0 audit; restyled at v2.7 by the captain's design pass, 2026-09-19): one labeled single-line cell per fact - the project (or "Default workspace"), the crewmate's model right after it (the task record's model
- what the session reported at dispatch, kept current when the backend moves the work to another model (`CrewSupervisor.recordServedModel`), review F1 - by its catalog display label), the task's effective care (Quick, Default or Careful, including a per-task ask), the PR number as a link when one is recorded on the task, and the CI state with a `StatusDot`-language dot and how long the checks have run or took by the host's own times (`running for 15m`, `passed in 14m · 5m ago`, `docs/forge.md` "The checks cell's time") - or "not read yet" on a direct-pr task no check has read yet.
  Since v3.6 it also carries the HOLDS the host placed on the task: the CI rounds and the review rounds it counted, each against its cap, with the head CI last went red on in the cell's title and a failed dot once the cap is standing.
  The prompts used to ask an agent to type out a round count it cannot see; here the captain reads it off the card.
  An Override cell (`override`) names the holds the captain's recorded words pass, with the captain's words and how long in its title, and says the merge goes without live proof when they pass it (`docs/delivery-rigor.md`, "The holds").
  When the checks started and when they were last read (`Started 9:01 PM · read 9:13 PM`) and a review's risk note ride the cells' `title` attributes, never lines of their own; the branch is deliberately not shown.
  It is rendered from the task record every time the card is emitted or revised; the host refreshes open strips on task changes and their running times on the shared tick.
  Host fact refreshes update both the shown and staged card without an author revision or thread message, so the card, record and paired view read the same delivery facts.
  The shown strip takes a refresh in place: its frame keeps the one document it was born with and the bridge rewrites only what changed (`markup`, `docs/ui-plugins.md` "Bridge v2"), so a press on its pull request link that the minute's refresh lands in still opens the pull request (FI3-1093).
  Each cell names its fact in `data-fact` (one of `SETTLE_FACTS`, `src/shared/cards.ts`), so a test finds a fact by what it is (`factsStrip` in `tests/e2e/stack.ts`), never by its label's words.
  The stage lifts the strip out of the body (`splitSettleFacts`, `src/shared/cards.ts`) and shows it in a sandboxed frame of its own at the start of the card's action row, left of the buttons, so a long body never scrolls it out of view; a past card shows the body whole, strip last.
  A finished code-work completion decision or note opens at **Why**, then **What changed**, **Before**, **After** (contract v4.37, FI3-253); the title alone carries the answer, with no answer line before Why.
  This is a loose outline, not a recipe for each section: Why gives the ask or defect, preferring the captain's original intent, wording or framing when available (contract v4.38).
  Paraphrase faithfully and quote only exact words; otherwise use factual motivation.
  What changed gives the change, Before one sentence on how it stood then a picture of each changed view as it stood, and After each result picture beside the sentence it describes, and what was checked (contract v4.69).
  A card asks for as many pictures as the change needs, never one: a view in both sections keeps the same order and caption.
  Something new sits in a figure marked `data-inf-new`, which the card stylesheet draws with a New tag and which needs no Before picture.
  The mark goes on the figure, never on the picture inside it: the stylesheet draws the tag as `::before`, which an `img` cannot carry.
  A change nobody can see carries one sentence in an element marked `data-inf-no-picture`.
  The crewmate takes the Before pictures before its first edit (`docs/delivery-rigor.md`, `docs/testing.md` "Capturing pictures").
  Out of scope for the host's picture checks: a side-by-side layout, a capture command, recordings and any check that a picture is blank or framed alike.
  Every crewmate is instructed to open each picture and demo poster with its image-reading tool before attaching it, and to write alt text from what the file shows rather than the capture script's intent.
  It retakes a mostly blank, half-drawn or cut-off capture unless that is the intended subject, which its alt text then names.
  When it cannot inspect a file, it leaves it off the card and reports the gap.
  This is agent judgment, not a pixel threshold or a host refusal.
  What is left closes after After when it bears on the decision, otherwise in `<details>`, not a fifth heading.
  Answer cards, previews included, keep their own shape.
  The report keeps its five evidence headings; future github.com pull requests, gitlab.com merge requests and their completion cards share the saved story (`docs/forge.md`, "Saved change stories"), while other hosts and existing PRs keep the five-heading description.
  The card never copies the host's strip.

## The risk chart

A merge card shows its crewmate's assessment of the change's risk as a radar at the card's top right (FI3-1127's plan, built in FI3-1128).
It has seven dimensions, clockwise from the top, each at three levels in words: Blast radius, Behavior, Undo, Evidence, Sensitivity, Novelty and Dependencies (`RISK_WORDS`, `src/shared/risk.ts`).
There is no overall level anywhere - not on the chart, the strip, the task record or the feed - so nothing sums the seven up: the shape and the dots are the reading.

**The declaration.**
A crewmate's completion decision passes `risk`, a top-level `emit_card` parameter whose own description carries every rule, so it reaches a Claude crewmate whole (`docs/claude-client.md`).
It rates every dimension `low`, `medium` or `high`, with `why`, one line of at most 100 characters.
The card tool refuses a decision with a `settle merge` action and no risk, a risk with a dimension left out or a level off the scale, and a risk on any other card, each in words that name the fix (`RISK_MISSING_REFUSAL`, `src/core/pi/cardTool.ts`), at every care level.
The refusal is recorded like any other ("A refused completion card").
The first mate's schema has no risk, so its cards carry none.

The app validates the declaration and adds no measurements of the change.
The assessment rides the card (`Card.risk`, `cards.risk_json`) and the task's delivery facts (`delivery.risk`), and a revision replaces both.

**The chart.**
The card's chrome draws it (`RiskChart` in `src/renderer/src/design/cards/`), never the body: 128 px tall, level with the headline's top and flush with the card's content edge, as wide as its labels need (216 px for the seven names), with rings 80 px across (`riskRadarGeometry`).
Three faint rings and the axes are in the line tokens, the shape of the levels is in the accent, and each dot is in its level's color from the checks: low `--ok`, medium `--warn`, high `--danger`.
The headline and the revised line give way by the chart's width.
The body carries the app's spacer at its start (`INSET_SPACER`), floated right and as big as the chart's box over the body, which the stage measures and sends the frame (the bridge's `inset`, as `--inf-inset-width` and `--inf-inset-height`), so Why and What changed flow around the chart.
From the third heading on - Before, After and every section below - each heading clears the spacer (`CARD_INSET_STYLE`), so those take the body's whole width.
A body the stage prepares before its chrome joins keeps clear of the box a one-line headline leaves (`riskBodyInset`), so the body keeps one document when the chrome arrives.
The chart scrolls away with the top of the body, clipped at the headline's top.

**Reading it.**
Each dot is a target and a Tab stop of its own, in the radar's order, right after the card's close.
Resting on it, or the keyboard's focus, lights its label on the outer ring and opens its note to the left of the chart, level with the dot: the dimension and its level in words, the crewmate's line.
Leaving it, Esc - which closes nothing else - or a scroll of the body lets the note go, and a dot the keyboard reaches scrolls the body back to its top.
A past card keeps the chart of the version the captain saw.
`tests/e2e/risk-chart.spec.ts` reads the chart through `riskChart` in `tests/e2e/stack.ts`: each dot's `data-risk-dot` and `data-risk-level`, and its note's `data-risk-note`.

## The picture check

For a crewmate card whose action merges, `lintCrewmateCard` reads only what the body declares, under the Before and After headings (`COMPLETION_PICTURES_REFUSAL`, `src/core/pi/cardLint.ts`): a `data-inf-no-picture` element with words in it passes; otherwise After holds at least one picture, and when any After picture is not inside a `data-inf-new` element Before holds at least one too.
It never counts above one, never matches pictures to views and never reads the change.
A demo counts by its poster, the one `<img>` in its figure, and only once the host verified the recording beside it ("What contains a body", "Demo recordings"), which happens before the check reads the card.
A task at the Quick care level (the stamped tier on the task record) is exempt.
Notes, the first mate's own cards and answer cards, previews included, are not checked for pictures.

On every crewmate card, at every care level, the check refuses a `data-inf-new` mark on an element that cannot draw the New tag (`untaggedNewMarkRefusal`): `img`, `svg`, `video`, `canvas`, `iframe`, `object`, `embed` and `input` generate no `::before` box in the card frame, so a picture marked itself would show no tag and read as a missing Before picture.
The refusal names the fix, the figure that holds it.

## The shape lint

Both boundaries - the crewmate's `emit_card` (Pi or Claude) and the first mate's - run the shape rules in `src/core/pi/cardLint.ts`, reading the body with htmlparser2.
It asks about SHAPE, never about safety: the frame is what contains a body (below), so nothing here is load-bearing for containment.
A rule refuses only what the host may hard-code (`docs/principles.md`, "Build the agent's reach, never its verdicts"): a typed fact it holds, consent for an effect, a physical limit, or a product fact the captain ruled.
How a card is worded, how long it runs, how it opens, where its evidence sits and what its buttons are called are its author's verdicts, which the card contract states as goals and no rule refuses (INF-484 move 5).
A refused card is never shown, and the refusal text names the fix:

- a typed fact: a body that arrived entity-escaped (`&lt;p&gt;` where `<p>` was meant, with no real element in it) is refused as exactly that, asking for raw tags - the Sep 15 Claude crewmates sent such bodies and were told about sentence counts four times running;
- a product fact (D-9): a card with actions is a decision: it gives 2 or 3 actions (`CARD_MECHANICS`) and has exactly one `default`.
  The count reads the card the captain gets, so a crewmate's completion decision counts the host's merge and discard pair (never the host's Review carefully beside them, `docs/delivery-rigor.md`), and the host's saved sign-in on a request card is added after the lint (`docs/task-browser.md`, "Saved sign-ins"), because the crewmate never learns that a site is saved.
  The refusal names the rule, the actions it counted and the fix: one action needs the other choice beside it, or a note with no actions when nothing is asked; four or more keep the two or three that matter.
- consent: a decision that is not a preview asks a `required` radio, checkbox or select question unpicked (contract 4.56): one that arrives `checked` or `selected` is refused, with the question's name and the fix - leave it unpicked and mark the recommendation `data-inf-recommended` ("Questions in the body" below);
- consent: a decision that is not a preview ends every radio group, select and group of two or more checkboxes with a Something else row (FI3-1002): one without the row and without `data-inf-options-only` is refused, with the question's name and the row to add ("Something else" below);
- consent: an action whose id or label reads like a merge or a landing carries a `settle` effect - a "Merge the pull request" button with no effect would run nothing when clicked, which is exactly the Sep 4-5 dogfood failure - and no action from an agent carries the host's own effect;
- consent, at the crewmate boundary only: a declared `settle merge` decision has **Why**, **What changed**, **Before**, **After** headings in order; `COMPLETION_CARD_HEADINGS` in `src/shared/cardHeadings.ts` is their shared home, and `bodyHeadings` reads the markup, not mentions in prose; the refusal names the first missing or misplaced heading and its repair; completion notes follow the standing instruction alone because the host cannot distinguish them from other notes;
- a product fact (INF-680): a decision, a preview included, that names a control or stages a setting `anything_else` is refused, because that is the answer the app's own Anything else? box rides ("Anything else?" below);
- a product fact: measurable figure text that would draw under 11px in the usual 750px column is refused, and the refusal names the repair: a full-width drawing of at most 750 units, or larger type, and a pixel width for a smaller drawing.
  It does not measure the narrow card, and it does not refuse a small drawing stretched to 100 percent.

The five headings are not asked of a completion card's open body.
They remain required in the report, which `scoreRigor` reads through `reportEvidenceHeadings`, and in legacy PR bodies or those on hosts without saved stories.
A saved-story completion names its published revision in `emit_card presentation`, supplies its title field, and omits body, body_file, risk and required_actions.
A push after publication needs a new revision prepared and published at the pushed version first, and each completion refusal says so (`docs/forge.md`, "Saved change stories").
The saved story's title wins over the title field, and its risk and required actions supply the host's controls.
A conventional title's breaking marker (`!:`) is metadata, not excited copy; the saved title keeps it.
Version-2 saved stories use Why, What changed, Before and after, and Checked, with commands and unfinished work folded (`docs/forge.md`, "Saved change stories").
Both surfaces use the same conventional title; code versions stay in typed data, never rendered prose, by author instruction rather than a refusal check.
Each view's caption sits above its own table on the card: Before and After head a changed view's columns, a new view's table is headed New, and empty sections disappear.
Version-1 stories keep their existing drawing; the report, legacy descriptions and free-form completion outline stay unchanged.
The host renders its body from the same version as the PR and keeps the risk chart, requirements and merge controls under their existing owners.
The card's table holds recordings too, as their posters; in the pull request picture-only pairs sit side by side and any pair containing a recording stacks to fit GitHub's and GitLab's native players.

The lint asks for shape, never for the absence of words: there is no progress-phrase ban list, and the merge-claim rule is a consistency check on an action, not a ban on what a body may say.
The first mate's boundary adds typed facts - attach-first (`task_id` or `standalone`), the closed-task choice refusal (a card with actions cannot name a closed task, whose click would refuse every choice; the refusal names the ways out, each keeping the closed task as the `basis` of the work that follows: a follow-up from `create_task`, or no `task_id`) and the settle-needs-task rule - and two ceilings, marked as such in the code because each compensates for a first mate that did not follow its instruction: the carded-task refusal below, and the merge-card refusal while a task's own crewmate still owes its completion card.
There is no CI gate and no PR-link rule at either boundary since v2.0: the crewmate's completion card is the one merge decision and the first mate never authors one for a crewmate's task (ruling D3), and a settle card's facts are the host's line above.

The task's final report needs no tool: its record shows a sandboxed body with plain reports safely wrapped and links preserved.

## A refused completion card

A crewmate's completion card - any card it emits that declares a settle effect - can be refused on its way up: its checks have not passed (`CrewSupervisor.pendingCiGate`), the CI cap holds it, a reviewed task's review has not passed, the shape lint above, or the card tool's own checks on its size, id, pictures and risk.
A revision of the completion card already on the stack is the one exception to the checks: it goes up while they run, and its merge waits for them (`docs/delivery-rigor.md`, "A kept merge approval").
The crewmate reads the refusal as the tool's error text, and the card never reaches the stage.
FI3-401 is why that is not enough: on PR #549 the gate refused a card a second after the crewmate asked, the crewmate still reported "Completion card emitted", and the first mate relayed the card and later explained its absence with a mechanism that does not exist.

So the host keeps the refusal as a fact.
The card tool hands every refusal of such a card to `CrewmateToolDelegate.onCardRefused`, whichever step made it, and the supervisor records it on the task (`TaskService.recordCardRefusal`): `delivery.cardRefusal` holds the card's title, when, a typed `reason` (`checks`, `ci-cap`, `review`, `shape` or `other`) and `why`, the host's own words, and the timeline gets a host note.
It stands until a completion card goes up, which clears it.
While it stands, the crewmate's report wake names it after the report - the card, when, why, that it did not reach the captain, and that none of the crewmate's cards is on the screen when none is - and `crew_status` carries it as `cardRefused`.
Nothing reads the report's words; the fact sits beside them.
A task on the personal workspace or an answer task has no completion card, and its settle refusal already says so, so it records nothing.
A completion card a work computer sent to the home whose answer never came is not a refusal either: the home may already show it, so the card tool records nothing, and the crewmate reads that it may already be up and what to check (INF-370 R1; `docs/helper.md`, "Lost contact").
A card whose request never went out is still recorded as refused.

## Revising a card

`emit_card` accepts an optional `id`: kebab-case, namespaced by the emitter (for example `fm-feed-scroll`).
The rule for reusing it is the captain's: when new information or a decision augments or highly overlaps an open card, revise that card by passing its id; when it is a distinct finding or decision, a new card is right.
There is no one-card-per-topic cap - several open decisions on one task are legitimate.

- If a card with that id is still open, title, body, and actions are replaced in place.
  The stack does not grow and the card keeps its position.
  The version it replaced is kept in `card_revisions` (`CardStore.history`), so a revision is one card with history.
  The host marks what is new since the captain last saw the card ("What changed since you looked" below); the author never does.
- If none is open, a new card is created as usual.
- App-raised singletons (`card-fm-auth`, flagship quota cards) are only overwritten when the id matches that singleton.

Every emitter sees what is on screen: the first mate's context block lists each task's open cards, and a crewmate's report wake names its cards.
On a task whose crewmate already has a card open, the first mate's `emit_card` is refused with "steer the crewmate to revise card X (same id)" - it adds to the crewmate's card through the crewmate, never beside it.

When the captain says a card repeats an earlier one, the first mate's `flag_duplicate` stamps `duplicate_of`, `duplicate_note`, and `duplicate_at` on the card, closes it, and writes one feed line.
It has no user surface; the label feeds the duplicate metric.

## HTML bodies

Every ready card body renders as HTML inside `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).
It renders VERBATIM: there is no sanitizer, no tag allowlist and no CSS allowlist (captain decision, 2026-09-15).
Card chrome - the derived chip, title, close, pager, and footer actions - remains host-owned React.
Streaming task results stay plain text until complete so incremental updates do not replace the frame document.
The hooks a body writes are Infinitary's (`data-inf-*`, the `inf-*` classes, `inf.action` and `inf.stage`); a body written before the rename with Firstmate 3000's `data-fm-*`, `fm-*` and `fm.*` renders and answers the same (`docs/ui-plugins.md`, the bridge's hooks).

For finished code-work completion cards the title carries the answer and the body opens at Why under the outline above; other cards lead with a brief answer.
Explain visually wherever a picture carries a point better than prose.
When an explanation has several parts, give each part a figure beside the short sentence it illustrates rather than crowding them into one drawing.
Keep prose needed to follow the answer in the open.
Reserve `<details>` for evidence, exact code paths, qualifications, and other material for a reader who digs.

Figures are free-form: no shape is prescribed, and all of SVG renders.
Give an SVG a `viewBox` and `width="100%"` at 750 units, or a pixel width when it is smaller; use theme tokens so it follows light and dark.
Reserve `--accent` for the single most-current or lit element within each figure - one accent per figure, not one per card - use non-accent tokens for everything else that figure draws, and use `--ok`, `--warn`, or `--danger` only for real state.
A visual needs no caption when its meaning is already clear.
Supporting prose can use semantic paragraphs, short headings (`h1`-`h6`), lists, tables, and code.

### What contains a body

The frame does, and only the frame (`docs/live-prototype-security.md` is the security review):

- **No network.**
  The frame CSP is `default-src 'none'`.
  No external image, font, stylesheet, media, frame, worker, `fetch`, websocket or beacon resolves, whatever the markup says.
  A project's own font reaches a preview only by reference (Fonts by reference, below).
  An `<img src="https://...">` simply never loads.
- **No identity, no parent.**
  The frame has an opaque origin: no storage, no cookies, and the app window and its bridge are unreachable.
- **Only hash-pinned scripts run.**
  A body's own inline `<script>` runs on the mount path (next section), because the host hashes it where the author put it.
  A `<script src>` never loads, a script injected at run time never executes, and `on*` handler attributes never fire - they are not pinned.
- **Pictures by reference.**
  `img-src` admits `data:` and the host's own frame scheme, and nothing else (card pictures, phase 2).
  A picture is markup: `<img src="<path>" alt="<what it proves>">`, where the path is relative to the working copy or absolute inside the task's evidence folder (`userData/crewmates/<taskId>/evidence/`, named in the crewmate's instructions: evidence lives there so it is never committed) wherever it belongs in the body.
  At the `emit_card` boundary the host (`verifyCardImages`, `src/core/pi/cardImages.ts`) walks the body with htmlparser2 and, for every `<img>` whose `src` is a path, refuses an absolute path outside the evidence folder, a working-copy escape (symlinks included), a file that is not a structurally valid PNG, JPEG or WebP, one over 8 MB, missing alt text, or pictures totalling more than 64 MB on one card - there is no count cap.
  It copies each verified file to `userData/crewmates/<taskId>/cards/<taskId>-<32 hex>.<ext>` and rewrites only that tag's `src` (to `app-frame://images/<that name>`), `width` and `height` (from the file's own header); every other byte of the body stays verbatim, and one failure refuses the card.
  The host's own startup note names its hero pictures through the same checks (`keepPictureFile`), kept by content under the reserved owner `release-notes` (`docs/release-notes.md` "Its pictures").
  The frame scheme's `images` host serves exactly those names (`src/main/frames/frameProtocol.ts`), so no picture's bytes ride the body, SQLite or the `inf:cards` push, and the card row records each picture's id, alt, size and group (`cards.pictures`).
  A `data:` picture and any other URL are left as written; the frame loads the first and nothing else.
  The first mate has no working copy, so a path in one of its cards is refused.
- **Groups.**
  Several `<img>` inside `<figure class="inf-pictures">` are one group, laid out by the frame stylesheet alone (`FRAME_BASE_STYLE`): the first leads under the plain `img` rule (never past the body's width; over 360 px tall, shrunk to fit 360 px and letterboxed on `--bg-1`, whole), the rest are 88 x 60 thumbnails cropped to their top, five shown and a mono `+N` tile counting the rest, and the author's `<figcaption>` is the group's caption.
  A lone picture is a group of its own; a card holds as many groups as the answer needs.
  Because it is only the stylesheet, a body's own `data:` pictures in the same figure look identical.
- **The viewer.**
  A click on any picture in any body opens it large in the picture viewer, host chrome over the whole window (card pictures, phase 3; the design skill's `components/cards/PictureViewer.prompt.md`).
  The bridge posts one `image` message with the clicked index and the pictures of its group - the `figure.inf-pictures` it is a direct child of, else the picture alone - each with src, alt and natural size, so the viewer pages within that group, captions each picture with its alt, and fits it to the window with a click (or `Z`, `Enter`, `Space`) to 1:1 and a drag or the wheel to move.
  A click on a group's `+N` tile opens it at the first picture the strip does not show.
  A picture inside a link, a button, a `summary`, a `label` or a `data-inf-action` element is that control's, and a body script that handles the click first (`preventDefault`) keeps it.
  The host shows only its own `images` copies and `data:` raster pictures; any other source opens nothing.
- **Demo recordings.**
  A crewmate may attach a demo to any card - an answer, plan, decision or note, not only a completion card - when behavior over time makes the answer clearer; use a still figure when motion adds nothing.
  A demo shows behavior a still cannot - a drag, a keyboard journey, motion, progress, recovery from an error: `<figure data-inf-demo="<path to the recording>">` holding exactly one `<img>`, its poster (a frame of the recording, the same shape), and a `<figcaption>` naming the action and its result.
  Its paths follow the picture rules - relative to the working copy, or absolute inside the task's evidence folder - and are never a URL.
  The recording is a silent H.264 MP4 in one video track, 8-bit 4:2:0 (High, Main or Baseline profile), at most 30 seconds, 16 MB, 1920 x 1080 (either way round) and 30 frames a second; the working target is 5 to 15 seconds at about 1280 x 720 and 24 frames a second, and `+faststart` lets it start before it has loaded.
  When no MP4 can be made, the recording may instead be a GIF that plays once, the shorter and smaller fallback: at most 10 seconds, 8 MB, 1280 x 720 (either way round) and 10 frames a second, with no loop instruction (FFmpeg's `-loop -1` writes none).
  At the `emit_card` boundary `verifyCardImages` verifies the recording and its poster as one attachment: the poster as any picture, the recording's own boxes (`readDemoVideo`, `src/core/videoFormat.ts`: an `ftyp` first, every box in bounds, not fragmented, one track and no sound, H.264, within the limits, every sample inside its media data), the poster's shape against the recording's, and then the host's probe (`src/main/mediaProbe.ts`): a hidden window of its own, sandboxed, with no preload and an in-memory session that answers only that one recording and refuses every network request and permission, must decode an opaque picture at the recording's start, middle and end within five seconds, at the size and length the boxes state.
  The player can say it holds a picture a moment before its decoder has handed it over to be drawn, so while the player still says so, the probe draws again until the picture comes, within the same five seconds; a player that reports an error, or no picture, is refused at once.
  A GIF goes through no probe: `readDemoGif` (`src/core/gifFormat.ts`) walks it from its header to its trailer, decodes every frame's picture data to the frame's last pixel, times each frame as Chromium shows it (a delay of 10 ms or less is shown for 100 ms), and refuses a loop instruction (a `NETSCAPE2.0` or `ANIMEXTS1.0` block), a still of one frame, and anything past its limits.
  A GIF named by a plain `<img>` is refused as a picture, with the demo figure as the fix: it moves, so it is never a picture.
  A failure at any step refuses the whole card with what to fix, and nothing is copied.
  Recordings and pictures share the card's 64 MB.
  The host copies the recording to `userData/crewmates/<taskId>/cards/<taskId>-<32 hex>.mp4` (or `.gif`) and rewrites only the figure's `data-inf-demo` (to `app-frame://media/<that name>`) and `data-inf-demo-duration` (its length in milliseconds, from the file); the poster's own record on the card carries the recording's id, kind (`mp4` or `gif`), size, length, byte size and SHA-256 (`CardPicture.demo`).
  The frame scheme's `media` host answers those names a byte range at a time (206, or 416 past the end; `src/main/frames/mediaResponse.ts`); a card's own frame still loads no media.
  In the body the bridge draws a Play button with the length under the poster (`Play · 12 s`); the button opens the picture viewer playing the recording one pass, and the poster opens it resting on the poster.
  An MP4 plays in the viewer's `<video>` with Play, Pause, Replay and a seek slider.
  A GIF is drawn only once Play is pressed, as an `<img>` of the served copy laid over its poster, at a fresh address each press so it starts from its first frame; its control reads Play, Stop and Replay, Stop takes the animation away, and once its verified length has played the poster returns with Replay.
  The viewer plays only a recording the card's body names, starts it at once only on the captain's own press (the window's user activation, which a body's script cannot give), pauses an MP4 and stops a GIF when the window is hidden and never loops either; its keys are its controls' own (the design skill's `PictureViewer.prompt.md`, "A demo").
  The first mate has no working copy, so a demo in one of its cards is refused like a picture; an `app-frame://media/` address copied from another card is refused too, since a demo names a file, never a URL.
- **Fonts by reference.**
  A preview draws a project's screens in that project's own typeface: an `@font-face` rule in its `<style>` sheet names a font file in its `src` `url()` - a path relative to the working copy, or an absolute path inside the task's evidence folder, where a crewmate saves a font its project links from an address.
  `font-src` admits only the host's own frame scheme, so a font named any other way loads nothing.
  On the srcdoc vehicle it admits only that scheme's `fonts` host, which serves the design system's typefaces (`SRCDOC_FRAME_CSP`, `src/shared/plugins/containment.ts`), so a kept font loads only on the mount vehicle, however a body names it.
  At the `emit_card` boundary `verifyCardImages` reads every `<style>` sheet (`fontFaceUrls`, `src/core/pi/fontFaces.ts`: each `url()` inside an `@font-face` block, comments and strings skipped) and, for each one that names a path, refuses a path outside its homes (symlinks included), a missing file or one that is not a regular file, one over 8 MB, one that is not a WOFF2, WOFF, TrueType or OpenType font by its own signature, a font collection, a WOFF2 or WOFF whose header does not state the file's own size, a table directory or table outside the file (`readFont`, `src/core/fontFormat.ts`), and fonts that with the card's pictures and recordings total more than 64 MB.
  Each real file is read, counted and loaded once, however many rules name it and however its path is spelled.
  It then loads all of the card's fonts together in the host's probe (`src/main/mediaProbe.ts`): one hidden window of the kind demo recordings play in, whose policy admits only those files as fonts, must load each as a web font within five seconds on a clock of its own, through the same sanitizer a card's frame uses (`src/main/typefaceProbePage.ts`).
  A font that does not load or stalls refuses the card by its own name, with the sanitizer's own words when it gave any (`TYPEFACE_UNREAD_WORDS`); a window that answers for none of them within seven seconds refuses the card for all of its fonts.
  One failure refuses the whole card with what to fix, and nothing is copied.
  The host copies each font once to `userData/crewmates/<taskId>/cards/<taskId>-<32 hex>.<woff2|woff|ttf|otf>`, the hex the first 32 of its bytes' own SHA-256 and the kind the one those bytes state, so the same font keeps one name in every version of a card and a revision that leaves it alone does not read as a changed preview; it rewrites only that `url()` token (to `url("app-frame://typefaces/<that name>")`); every other byte of the sheet stays as written, the rule's `format()` hint included.
  Each copy is written whole, through a temporary file renamed over its name, and a copy already holding exactly those bytes is left alone (`keepContentFile`), here and on a home a computer that runs work sends it to.
  The frame scheme's `typefaces` host serves exactly those names to GET alone, typed `font/woff2`, `font/woff`, `font/ttf` or `font/otf`, with `access-control-allow-origin: *` (a frame's origin is opaque and a font load is a CORS fetch) and `nosniff`.
  A body that names a kept font rides the mount vehicle, as a scripted body does, so the font engine reads the file in a renderer process of its own (`cardBodyMounts`, `src/renderer/src/cards/prototypeSrcdoc.ts`).
  A font named by a URL - `data:`, `https:` or another card's `app-frame://typefaces/` address - is left as written; the frame loads only the last, which reaches a font the captain already has.
  The copies never ride the body, SQLite, the `inf:cards` push or the human-supervision export, which copies pictures only; they stay beside the task's pictures until the Settings purge.
  Only a preview carries one, since an `@font-face` needs a `<style>` sheet and a sheet makes a body a preview.
  The first mate has no working copy, so a path in one of its cards is refused.
  A crewmate on a computer that runs work has its fonts checked and loaded there, and each kept copy goes home before the card (`inf:work:typeface`, `docs/helper.md`), to a home on protocol 8.9 or later; a paired view asks the home for one by name (`inf:cards:typeface`, `docs/view.md`).
  A system typeface a project names but does not ship (Apple's rounded face, say) is not a file, so a preview cannot load it.
- **The host's own actions stay the host's.**
  A `data-inf-action` button or an `inf.action(id)` call raises one of the card's declared actions - EXCEPT any action carrying an effect (`settle`, `open`, or the app's own `host` op).
  Those are run by the host from the footer button the captain clicks, are never declared to the frame, and are checked again against the current card when dispatched; a body that raises one is refused.

### Style

Prefer the design system, so a card looks like the app: design-token CSS variables (`--fg-1`, `--accent`, `--line-2`, `--font-mono`, ...) and the helper classes `inf-mono`, `inf-muted`, `inf-row`, `inf-grid`, `inf-panel`.
This is a preference, not a filter.
A preview or a drawing of a project's screens takes that project's own look, read from its source: its colors, type, spacing and controls, which for Infinitary's own screens is this design system.
It may bring its own `<style>` sheet, its own classes, ordinary CSS lengths and colors, and `data-*` hooks its script reads, and it restyles every element it draws, since the frame stylesheet dresses whatever it leaves bare.
It loads the project's own font files by reference (Fonts by reference, above).
The card's own answer, explanation and questions keep the app's look.
The crewmate's instructions say this; the first mate's copy of them does not, since it never draws a preview.

The vocabulary beyond plain text:

- Disclosure: `<details>` (optionally `open`) with a `<summary>`, for evidence the reader may skip.
- Inline emphasis: `<mark>` for the one thing to notice, `<kbd>` for keys.
- Figures: inline `<svg>`, wrapped in `<figure>` with an `aria-label` and an optional `<figcaption>` when it adds value.
  All of SVG renders - any shape, path, gradient, filter, marker, and wrapped text via `<foreignObject>`.
  Give it a `viewBox` and `width="100%"` at 750 units, or a pixel width when it is smaller, so the card only shrinks it.
  Draw whatever figure the explanation calls for (Figures, below).
- Pictures: an `<img>` naming a file in the crewmate's working copy (PNG, JPEG or WebP, alt saying what it proves), which the host verifies and serves; several in a `<figure class="inf-pictures">` are a group.
  A `data:` picture the body carries itself also renders.
- Fonts: a preview's `@font-face` naming a WOFF2, WOFF, TTF or OTF file in the working copy or the evidence folder, which the host checks, loads and serves (Fonts by reference, above).
  Nothing else loads.
- Sizing: whatever units the body needs; relative ones follow the card.

Links open through the app's safe external opener: https anywhere, plus http to loopback (`localhost`, `127.0.0.1`, `[::1]`) and to genuine `.localhost` subdomains, single-level or nested (`http://app.localhost:1355`, `http://task-1.soapbox.localhost:1355`).
Public http, lookalikes such as `localhost.example.com` or `evillocalhost`, other schemes and addresses without a scheme are ignored without feedback.
Write a link as an explicit `<a href>`; bare URL text inside HTML is not auto-linked.
A link opens only from the captain's own click or Enter on it: a body's script that clicks its own link, or posts the bridge's `link` message, while focus is elsewhere opens nothing (`docs/keyboard.md`, "Cards and frames").

A `<button data-inf-draft="words">` starts the captain's message for the captain: the captain's press puts its words, one line of at most 500 characters, at the start of the message box under the card, with the caret after them and focus in the box, and sends nothing (FI3-1164; the welcome's starters).
Words already typed stay after them, and a second such press replaces the first one's words while the box still starts with them.
The bridge posts the press as its `draft` message, and the window takes it only as it opens a link: from the card on screen, its frame holding the window's focus, so a script that clicks the button or posts the message while focus is elsewhere moves nothing.
While the message box is held - a recording, the dictation key's pick, the first-launch gate - a press does nothing, as Go to the main message does.

### Scripting

A body may carry inline `<script>` elements, in any card.
A script is for behavior - drawing a `<canvas>`, toggling a view, wiring a control to a declared action - never for loading anything: a `<script src>` never runs, and `fetch`, external images, workers, and every other network path fail under the frame policy.

- The body's inline scripts stay where they are written and run in document order, each pinned by its own hash.
  They share the frame's one global scope, so do not declare the same name twice across scripts; a syntax error stops that script alone.
- Scripts run when the card is first shown, after its whole markup is read, as if each were `defer`.
  The app may load a card's page before it is shown and holds its scripts and its CSS and SVG animations until then, so nothing of the card's own plays unseen.
  A `DOMContentLoaded` or `load` listener a script adds still runs once; `document.write` does not work.
- The bridge is `window.inf`: `inf.action(id, value?)` raises a declared action (the same ids as the card's `actions`; anything else is refused, and a value may be 4KB); `inf.theme` is the current theme and `inf.onTheme(listener)` fires when it changes - read token colors from `getComputedStyle(document.body)` again then.
  A button that starts the captain's message needs no script: `data-inf-draft` (above) is the bridge's own.
  Height follows the document on its own; there is nothing to call to resize.
  There is no drawing helper: a script that wants a figure writes the SVG itself.
- The card must still read without its script: the frame renders the markup first, and a script that fails leaves only the markup.
- A script that moves a figure sits inside that `<figure>`, one per figure in its own scope (`document.currentScript.closest("figure")` finds it), and the card stays prose; a script anywhere else makes the card a preview (The preview is the decision, above).
  It moves on the captain's press or drag, one pass, never on arrival and never in a loop, and reads `--dur-med` or `--dur-slow`, which the frame zeroes under reduced motion, so every move is then a cut; a duration written into the script is not zeroed (Figures, below).
- A script that never yields (a tight loop, an animation that blocks) is stopped after a few seconds: the body shows "This card stopped responding." with a Retry, and the rest of the app is unaffected.
- Body size, script included, is capped at 64KB.

Mechanism and the security review: `docs/live-prototype-security.md`, "Agent scripts in card bodies".

### Figures

No figure shape is prescribed.
Draw whatever the explanation calls for - a diagram, a chart, a picture of the thing itself - and let the design system make it look like the app.
A drawing of a project's screens is the one exception: it takes that project's own look (Style, above).
An explanation with several parts gets several small figures, each beside the sentence it illustrates, rather than one crowded drawing; a single figure is right only when the explanation has one part.

The design skill states the whole rule (`.claude/skills/infinitary-design/components/viz/Viz.prompt.md`); in brief:

- **Scaling.**
  A full-width drawing is 750 units wide with `width="100%"`, so one unit is one pixel in the usual card.
  A smaller drawing takes its pixel width, not 100 percent, so the card only shrinks it.
  `role="img"` and an `aria-label` that says what it shows.
- **Color.**
  Every color is a theme token through `style` (`fill:var(--accent)`, `stroke:var(--line-2)`), so the figure follows light and dark.
  Set `fill="none"` on open connector paths, polylines, and lines; give arrowheads and intentionally filled paths an explicit fill.
  The card frame defaults unmarked connectors to no fill, but spelling it out keeps a bent line hollow even outside that frame.
  Do not set fill on the root drawing: it would paint an open bend if the frame rule were absent.
  `--accent` marks the single most-current or lit element within a figure - that figure's one focal point - with `--accent-dim` as the fill under its accent stroke.
  The budget is one accent per figure, not one per card: a card with several figures may light one element in each, and no figure carries two.
  Everything else uses `--fg-1..3` and `--line-1..2` for text, marks, rules, and borders; `--bg-0..3` for fills behind the drawing; and `--ok`, `--warn`, `--danger`, or `--idle` for real state.
  A literal color is fine where no token would say more.
- **State.**
  `--ok`, `--warn`, `--danger`, and `--idle` carry real state, never decoration, in `StatusDot`'s language: `ok` filled `--ok`, `running` an `--accent` ring, `warn` filled `--warn`, `failed` filled `--danger`, `idle` a `--idle` ring.
  Let shape carry the state too - a tick in the passing dot, a cross in the failing one.
- **Type.**
  Labels use the app's own sizes, never larger than body text unless the number is a deliberate display: unsized labels at 12.5px, 14px for the one that matters, 11px mono for micro labels.
  In the usual card those sizes draw as declared.
  In a narrower card they shrink with the drawing, under 11px, which is accepted.
  At emit time the card refuses measurable text that would draw under 11px in the usual 750px column (SVG text, `tspan`, and flowing text in `<foreignObject>`).
  A 1,000-unit drawing turns 11px into 8.3px there; use a drawing of at most 750 units, or larger type.
  Do not shrink the viewBox to pass the check: a 350-unit drawing at 100 percent is capped at its own units.
  Text does not wrap in SVG: keep labels short, cut a long one to its column, or use `<foreignObject>` for real flowing text.
  The size check does not guess whether labels spill or interpret arbitrary scripts.
- **Weight.**
  Thin strokes, generous space, no chart junk.
- **Motion.**
  A figure plays only when a press shows what one still drawing cannot hold - the same thing in two places, as a card moving through a stack or crew arriving on a ring, or more states than panels would fit.
  A figure with one value the reader would vary takes one control that redraws it.
  Every other figure stays still, a timeline, a chart, numbered steps and a flow among them; a cursor or highlight sweeping a drawing that already shows every state adds nothing.
  Previews are exempt: they draw something that does not exist yet.
  It moves on the captain's press or drag, one pass from one state to the next, never on arrival and never in a loop, through a stepper for arrivals, a scrubber for a moment, one pass for a move, or one control for a value.
  Its controls are unnamed buttons and ranges inside the figure, so the footer never sends them as answers.
  The resting markup is the whole explanation without the script, its labels SVG text in the markup where the 11px check reads them; the check does not read what a script draws.
  Its script sits inside the figure and its style in attributes: a `<style>` sheet makes the card a preview.
  `CARD_AUTHORING` carries the rule; the recipe is the design skill's Motion section.

There is no helper to call.
Every mark is ordinary SVG that any body - scripted or not - can carry.

### Card width

Cards default to wide (800 px), per the accepted FI3-479 plan.
A body stays regular (560 px) only when it is text-only and under 600 visible characters: paragraphs, lists, headings, links and folded details, with no drawing, picture, table, code block or question.
Whitespace is collapsed and entities decoded; closed details contribute their summary, not their folded contents.
The rule reads the resolved author's body, not the host facts strip, on every emit and revision, including the first mate and app-authored cards.

Stored `regular` is a short plain note; absent width is default-wide.
Explicit `wide` or `full` preserves content-required room: wide for tables of 4+ columns, code lines over 60 characters, verified pictures 900px or wider, picture groups or previews; full for tables of 6+ columns or pictures 1,600px or wider.
An author's wide/full hint can only widen.
One host note sets its own: the welcome is regular, the width its 520-unit picture was drawn for (`addRecordedFirstmateNote`, `docs/first-launch.md` "The welcome").
Each paged card keeps its own width.

Settings → Appearance → Default card size offers Usual, Wide, Full and Maximized (`appearance.defaultCardSize`, optional for older saved records).
Usual is the initial choice and preserves the content-based rule above.
Wide and Full set a minimum opening width, without narrowing a card that needs more room; the window and thread still bound the space available.
The captain's edge drag wins over either minimum, and resetting the drag returns to the saved opening size.
Maximized opens every newly shown entry in the existing maximized view, including task records, past cards and panel cards.
Restore, Escape and Go to the main message restore the current visit without changing the setting; revisions preserve that override, while paging, reopening Settings and restarting use the saved choice again.
This is a presentation choice of the computer showing the cards, persisted through the existing appearance writer and kept local by `ViewLook` when controlling another first mate.
The host's stored width and the author's width hints do not change.

Default-wide cards yield to docked panels, up to 800px, folding panels only when less than 560px remains.
Content-required or dragged widths still fold panels below 720px as before.
Regular cards now fold panels when they cannot retain their requested width (FI3-489); this also applies to a drag of 560px or less.
The fold is temporary and restores the saved panel choices when the card leaves.
A lone card offers Show panels edge tabs only when returning it to regular would unfold the panels, using the same placement rule and measured docked clearance.
At narrower widths, including the minimum window with expanded panels, the tabs are absent rather than offering a click that leaves the panels folded.
Dragging from 480px to full and double-click reset are unchanged.
Full is capped at 1,040px.
The prompt stays 560px.
Reply threads retain their current shared-space ladder and 400px threshold; 750-unit labels can shrink below 11px beside a reply or in a short window.
This change does not introduce a new reply folding rule.

Prose keeps its 66ch measure.
Full-width drawings are authored at 750 units, with the lint's 11px check measured in that wide column; smaller drawings use a pixel width.
The bridge caps drawings at their own units, never enlarging them.
The 750px column is the authoring reference; the stable scrollbar gutter can reduce actual drawing room (735px in the windowless test), so even a nominally wide card can scale a drawing slightly.

### Styling

The app injects its design-token stylesheet (colors, typography, spacing, effects) plus a base layer.
Available hooks:

- CSS variables: the full token set (`--fg-1`, `--fg-2`, `--fg-3`, `--accent`, `--line-1`, `--bg-1`, `--surface-input`, `--font-ui`, `--font-mono`, `--radius-m`, ...).
  Both themes work; the frame follows the app theme via `data-theme`.
- Elements: semantic text, tables, code, buttons, and form controls.
- Classes: `inf-mono`, `inf-muted`, `inf-row`, `inf-grid`, and `inf-panel`.
- Inline `style` attributes and a body's own `<style>` sheet both apply; the body's rules come after the design system's, so they win.

### Raising actions

Put `data-inf-action="<action-id>"` on an accessible button and declare the same id in the card's `actions`.
A click posts the action to the app; the app forwards only declared ids to the orchestrator.
Decision footer actions remain canonical; an in-body action is only a visual shortcut to the same declared action.

One exception, and it is a hard one: any action that carries an EFFECT - a settle, an `open`, or the app's own `host` op - is run by the host, so only the host's own footer button raises it.
Such an id is never declared to the frame, and a body that raises it (by button or by `inf.action`) is refused with `action_not_declared`.
A card cannot merge its own PR.

### Task keys

A task key a body writes as text (`FI3-572`, in prose or in `inf-mono`) becomes a link to that task with no markup from the author (FI3-594; the design skill's core rule "Task keys" and ResponseCard, "Task keys in a body").
Resting on it opens the task's summary beside the card, and a click opens the task the way a click on its Tasks row does.
Only a key that is exactly a recorded task's key links: a key-shaped word that names no task stays text, and so does a lowercase key or one inside a link, a button, a toggle's summary, a label, a form control, a drawing, a `role=button` element, a draft button or a `data-inf-action` element.
The card's own task's key stays text too, since opening it would only bring the same card forward (FI3-1271).
The host finds the keys: `taskKeysIn` (`src/shared/taskKeys.ts`) reads the body's candidates, the window's one store (`taskKeyIndex`, `useTaskLinks` in `src/renderer/src/cards/taskLinks.ts`) keeps those the board or the search of earlier work answers with that exact key, and the bridge wraps them where text writes them (`tasks` and `task` messages, `docs/ui-plugins.md`).
The same store links the keys in the card's title, its action error line and its thread's lines (`KeyedText`, `src/renderer/src/cards/TaskKey.tsx`), the card's own task's key aside.
A key gesture is navigation, never an action: it runs no effect, so it works on a past card too.

The card's own task has one door on the card: its key leads the head's meta line (INF-358; the captain's "on all the decision cards we should figure out how we give the user a way to go to the task from there", and "let's make sure the task key is added to all decision cards about a task, so it's not inconsistent").
`useCardTask` (`src/renderer/src/cards/cardTask.ts`) reads which task a card is about from the board the window holds: the card's `taskId`, which every crewmate card and every host card about a task carries, or for a first mate decision that named no task the decision row the app filed for it, the row whose waiting decision is the card; a card about no task draws none.
`CardTaskKey` draws it in the quiet look: resting opens the task's summary, and the captain's click or Enter opens the task's record in front of the card (`openRecord` with `from`), never `openTask`, which would only bring the same card forward.
Hide or Esc on that record, or on the task's other tabs opened from the card, returns to the card while it is still shown (`docs/task-card-tabs.md`, "From a card").

### Knowledge references

In a build with knowledge to show, a concept's or a finding's id a body writes as text (`f-ejtt2f`, in `inf-mono` beside the claim it backs) becomes a compact reference to that entry, led by its standing's dot, with no markup from the author (FI3-1150; the design skill's ResponseCard, "Knowledge references in a body").
A click or Enter opens the Knowledge browser's inspector on that entry; it records no use and runs no effect.
Which findings an answer cites is its author's call, told by the `knowledge` tool's description, never inferred by the host: `knowledgeIdsIn` (`src/shared/knowledge.ts`) reads the body's candidates, `useKnowledgeLinks` (`src/renderer/src/cards/knowledgeLinks.ts`) keeps those `knowledge.refs` answers, and the bridge links them as it links task keys (`docs/knowledge.md`, "References in an answer").
A stable build links none, and the body reads as written.

### Pull request numbers

A pull request a body names by its number is a link to its page, written `<a class="inf-mono" href="its page">PR #N</a>` (FI3-1307, the captain's "i feel that should be a consistent experience whenever we render a PR number").
The rule is the author's: `CARD_AUTHORING` tells both personas to write the link, and the host reads no number out of a body.
The page comes from a tool's answer, never a guess: a task's is the `change` on its `tasks` row (`docs/task-record.md`, "Pull requests in the record"), and a crewmate also has its own in the `open_change` and `check_change` answers and any other's in a `github_read` answer.
A number whose page no answer gave stays plain mono, and a title holds no link.
The frame stylesheet draws a link in mono as every pull request link the app draws (`a.inf-mono`): `--accent`, underlined only while the pointer rests on it, with the focus ring, and a click opens the page through the safe opener above.
How often recorded cards follow it is scored by hand (`pr_link_share`, `docs/replay-harness.md`), never linted.

## Questions in the body

Contract 4.22 (inline decisions; `fm3000-card-decisions-width-s1`, proposal 1 under the captain's Q1 B of 2026-09-28: "i want the author to have more flexibility in how each question is presented").
A decision often carries several calls, not one.
The footer offers one choice; the body asks the rest with ordinary HTML form controls, beside the paragraph each is about, and the captain answers all of them before one footer click sends them together.
Clicking inside the card never sends anything.

The author writes the questions and presents them however they read best - radio buttons, checkboxes, a `<select>`, a `<textarea>`, a text field, a preview's own controls.
`emit_card` gains no parameter.
The form carries the two closed facts the host needs, and the bridge reads them in the frame:

- **A question is a `name`.**
  Every control of one question shares it; a control with no name is not a question.
- **Choices arrive unpicked; the recommendation is a mark** (contract 4.56, FI3-517 direction A: "highlight recommended options but always still require user explicitly choosing it").
  A radio, checkbox or select question is written with nothing `checked` or `selected`, a select opens on an empty `<option value="">Choose</option>`, and the input or `<option>` the author recommends carries `data-inf-recommended`, which the app tags Recommended without picking it.
  The bridge compares the captain's pick with the marked options to say whether an answer is `changed` or `as proposed`.
  A text field's proposal is still its own `value` (a hidden field's, its first value), and a preview's controls keep their current settings.
  A card with no mark - one written before 4.56 - falls back on `defaultChecked` and the `selected` option.
- **`required` marks a question the captain must answer.**
  An answer is there when the control is non-empty, or when the question is not `required`.
- **Every question with options has a way out** (FI3-1002, the captain's way B: "each author writes its own row, and the app checks for it").
  The author ends each radio group, select and group of two or more checkboxes with its own row worded Something else and marked `data-inf-write-in`: one more radio or checkbox with the question's name, or the select's last `<option>`.
  A question whose options are the only possible answers carries `data-inf-options-only` on its `<fieldset>` or `<select>` instead.
  "Something else" below says what the app does with each.
- **A `<label>` bound to each option** is how a pick reads in words.
  The wake quotes the label text of each picked radio, checkbox or option with its value beside it; an option with none reads as its value alone.
- **The question's own words** (contract 4.34) sit in the `<legend>` of a `<fieldset>` around its options, or in a `<label>` bound to a lone field.
  Names and option values stay short and stable - a word, not a sentence - so a revision keeps the captain's picks and the record reads the same question across versions.
  Nothing refuses a card without them; the footer click records the question as "no prompt" instead (`docs/card-evidence.md` "Question definitions").

The card lint (`preansweredRefusal` in `src/core/pi/cardLint.ts`) holds the first fact at the emit boundary: on a decision that is not a preview, a `required` question whose radio or checkbox is written `checked`, or whose select opens on an option with a value - one marked `selected`, or the first enabled option a dropdown picks by itself - is refused, with the question's name and the fix.
It groups and reads `required` the way the bridge does: by name, a disabled control is no question, and one required control makes its question required.
Optional questions, text fields, notes and previews pass.

A body may also stage a JSON snapshot under a name with `inf.stage(name, value)` (`undefined` unstages it): a preview's tuned look, say.
It joins the answers as one more question, always `changed`, and is worded as JSON.

The host side (`src/shared/plugins/bridge.ts`, `FrameController`, `HomeScreen.tsx`'s `StackedCard`):

- The bridge watches the named controls only after the host's `form` message, which only a card body's mount sends.
  On every `input`, `change` and document change it posts the one-way `answers` message: `answered`, `of`, `changed`, `picked`, and the answers themselves, which are the shell's draft.
- The footer shows the count - "2 of 3 picked · 1 changed" - as its queue group; words written under Something else count as a pick.
  Only the default closing button waits for required answers; it stays focusable and clicking or pressing Enter focuses the first empty required question without sending.
  Other choices send whatever is picked.
  Options marked `data-inf-recommended` get an app-drawn tag without changing their selected state; unmarked legacy cards still use their authored defaults.
- A footer click asks the frame for a fresh reading (`collect`, so a field a script filled is read as it is now), falls back on the last reading when the frame cannot answer, and sends `{ answers }` as `inf:cards:act`'s value (protocol 1.35.0).
  The whole set may weigh at most 64 KiB of JSON, an envelope for the shell's reading of every question, not the frame action value's bound; the chrome says so rather than cut it.
- The core (`CrewSupervisor.act`) words the answers into the choice's own wake - the `card-choice` steer, an isolated captain-origin `[user]` choice on a Chrome-clicked first mate card (with card/task identity), or a script-fired operational choice - one line each: `- read-scope: "Every project your sign-in can see" (all-visible), changed`.
  A closing choice records them on the card row (`cards.answers_json`, migration 54) and the task's `card_resolved` event (`data.answers`); the first mate's resolutions context line and a build brief grounded in the task (`renderBasisSection`) carry them the same way.
- A revision keeps the captain's picks by name: every new document of the card gets the shell's draft back with the `form` message, and the bridge reapplies each choice answer, including recommended picks, whose name the new body still has (an option that no longer exists is left at the new proposal).
  A renamed question starts fresh; a revised proposal never overrides a pick.
- The same `collect` reply carries the question definitions the fresh reading saw - each name's prompt, kind, options with their labels and the authored proposal - which the core records beside the choice and never words into the wake (`docs/card-evidence.md`).
- Picks are shell draft state, like a reply draft: a restart loses them and the card returns as written - unpicked, its recommendations tagged (the captain's Q4 A).
- Closing a card with ×, with any unsent picked answer, asks once, in a popover under the ×: "You picked 2 answers.
  Closing will discard them." with Keep answering and Discard and close (the captain's Q3 A; where and how it asks is the captain's Build it of 2026-10-04).
  The card's own action row and fact strip stay as they are while it asks.
  Escape, a click anywhere else, including in the card's body, or the × again keeps the card and its picks.
  A picked answer is the captain's own, the bridge's `picked` count: a pick in a question marked `data-inf-recommended`, or any answer changed from the author's proposal.
  Before the first send, an untouched prefilled text field or unmarked legacy default is the author's, so that card closes at once.
  After a successfully accepted thread reply or footer choice, the shell compares current answers by name and values, including write-ins, with that send rather than the authored proposal.
  Only differing answers ask for confirmation; changing back to the last sent values closes without asking, while clearing a sent answer is an unsent edit.
  A failed send never advances that comparison, and a revision keeps it alongside the draft.
  Closing is still the keep and sends nothing.
  Previews keep their settings, answered counter and changed-answer close confirmation, which counts settings ("You changed 1 setting."); text fields retain the existing changed-text revision behavior.

What this gives up against host-drawn questions, stated so nobody rediscovers it: two authors' questions can look different, nothing lints a missing recommendation, an option without a bound `<label>` reads as its value alone, and a Something else row's words are the author's to get right.
The frame stylesheet dresses a plain `fieldset`, `legend`, radio and checkbox rows and a `textarea` on-brand; an author restyles them freely.

### Something else

FI3-1002 (the captain: "when we author cards and give a choice for the user, we should always give a way for the user to write something that's none of the provided options").
The captain's Approve and build chose the author's own row with the app checking for it, the words "Something else", a field shown only once the row is picked, radio buttons, dropdowns and checkbox groups alike, an opt-out with a mark on that question, and no row on a preview's controls.

- **The check.**
  The card lint (`writeInGaps` in `src/core/pi/cardLint.ts`) refuses a decision that is not a preview when a radio group, a select with an option, or a group of two or more checkboxes has no `data-inf-write-in` row and no `data-inf-options-only` on its `<fieldset>` or `<select>`.
  The refusal names the question and the row to add.
  It groups the way the bridge does; a lone checkbox, a text field, a disabled question, a note and a preview pass, and the row's words are the instruction's, never checked.
  A card stored before the check keeps its body as written.
- **The field.**
  The bridge gives each row a text field of its own, after the row's label or under the select, with no `name`: one line that grows to three, at most 500 characters (`CARD_WRITTEN_MAX`), placeholder "Say what you want instead", named "Your own answer to:" and the question's wording.
  It shows only while the row is picked, and picking the row moves focus into it, except when the bridge restores a revision's draft.
  Picking another option hides it and keeps its words, which are sent only with the row.
- **The answer.**
  The row is never an option value: `values` holds only the author's options, and the trimmed words ride the answer as `written`, which makes it `changed`.
  An empty field is no answer, so a required question with only an empty Something else keeps the default waiting, and the default's click focuses the field.
  The footer counts a written answer as picked and changed, and the close confirmation counts it as a pick.
  `cardAnswerLines` words it after any picks: `- key_app: written in: "Try once after a minute, then tell me", changed`.
  The same line reaches every reader of answers (the card-choice wake, the first mate's choice, the resolutions line, a basis brief and a reply's settings), and `cards.answers_json` and `card_resolved` keep `written`.
  `CARD_AUTHORING` tells the author that an answer marked written in is the captain's own words, followed like a reply, with a question on the card only when they cannot be followed.
- **The opt-out.**
  `data-inf-options-only` on a question's `<fieldset>` or `<select>` passes the check.
  It is the author's mark for the check alone: the app draws nothing for it, because a tag saying so gave the captain nothing to act on (the captain, 2026-10-09: "this is not useful / actionable to the user at all").
- **Revisions and past cards.**
  A revision gets the written words back by name under its own Something else row, and a body that no longer has one leaves the question at its proposal.
  A past card shows the field with the words that were sent; a restart loses an unsent draft like any pick.

### Anything else?

INF-680 (the captain: "every decision card has a "anything else?" input box at the bottom of the card body, so i can leave additional comments before clicking one of the action buttons").
The captain's Approve and build chose a box pinned between the body and the buttons, the label Anything else? with the hint "sent with the button you click", 4,000 characters, five lines, and every card with buttons whose author can read a reply, merge cards and previews included.

- **Which cards.**
  A card draws the box when it has buttons and its author can read a reply (`cardTakesAnythingElse` in `src/shared/cards.ts`): a crewmate's card about its task and the first mate's card.
  A note, the app's own cards, a task's record and a panel card draw none.
- **The box.**
  It is host chrome (`AnythingElseBox`, `src/renderer/src/cards/AnythingElseBox.tsx`), in a row of its own under a hairline after the body and its attachment, so it stays in view however long the body is.
  Its field starts at one line and grows to five, then scrolls; it holds 4,000 characters (`ANYTHING_ELSE_MAX_CHARS`, a reply's limit), and its count shows from 80 percent of that, as a reply's does.
  Typing sends nothing and Enter adds a line.
  In a card too short for both, the box gives way before the body: the middle keeps one `--space-4` of room so the body stays in sight (a frame out of sight never draws), and the box's row shrinks and scrolls (`ResponseCard`).
- **The answer.**
  Whichever footer button the captain clicks carries the trimmed words as one more answer, `{ name: "anything_else", values: [], changed: true, written }` (`withAnythingElse`), on the path every answer takes: the author's wake, the card row, the task's `card_resolved` event, the first mate's resolutions line and a basis brief.
  On a merge or discard the app runs the click and the first mate reads the words on the card's resolutions line, because the crewmate's task closes.
  The box never counts in the footer's picks and never holds up the default.
  A reply carries the words among its settings, and the box keeps them.
  A frame's own answers stay at 500 written characters (`CARD_WRITTEN_MAX`); only the box writes more.
- **The name.**
  `anything_else` is the app's: the shape lint refuses an author's control or staged setting of that name, and a crewmate's `CARD_AUTHORING` says the app adds the box.
  The first mate's fixed context has no room for that sentence, so it reads the box's words by the written-in rule it already has.
- **Closing, revisions and past cards.**
  The close asks first while the box holds words the card has not sent ("You wrote a comment.
  Closing will discard it.").
  A revision keeps the words, because they belong to the card's id; a restart loses them, as it loses picks.
  A past card shows the words that were sent, read-only, and no box when none were.

## An answer task's card is its deliverable

On a task whose deliverable is an ANSWER (`WorkShape.deliverable`, Task B of the crew-posture rationalization; `docs/delivery-rigor.md`), the card is the whole shipment: the brief says so, the task commits nothing, and a card carrying a `settle` effect is refused at the boundary the way the personal workspace's is.
The captain's choice on it CLOSES the task `done/answered`, because the deliverable was produced and the captain answered it.
The captain's close control is not a choice: like every crewmate card's close it reaches the crewmate (FI3-435, captain's answer "Send it to the crewmate like every other card"), which reports `finished` once the captain has read it and nothing is left, and the first mate then closes the task with `settle_task answered`.
So the card carries the answer itself rather than a pointer to it: a builder spawned with `basis` naming that task receives this body verbatim, saved whole in a file its brief names, and any agent can read it back with the `tasks` query by key.

## Replying to a card

Every card is the head of a thread with its AUTHOR (`docs/card-threads.md`).
`CARD_REPLY` is the third constant in `cardContract.ts` and the third thing every persona includes exactly once: revise the card when the captain's words change what it should say (same id), answer in prose when nothing on it changes, and a reply is prose only and resolves nothing.
A crewmate's `reply(card_id, text)` is the prose half; `emit_card` under the same id is the other, and the host puts one "revised: …" line in the thread when it lands.

## Closing a card

`close_card` WITHDRAWS a card of your own.
A note may be closed freely.
Close a decision only when the choice no longer applies.
Only the card's own author may close it: the first mate its own cards (`card-fm-…`), a crewmate the cards it emitted - the on-the-captain's-behalf close retired with the close rule (cards-as-threads phase 1).
Unknown ids fail loudly.
Prefer closing an obsolete card over stacking a correction, and prefer revising it over either.

## A card places the gate

A card with actions is a captain decision, so it is on the record the way every captain decision is (the owner's call 3 on the primitives review, 2026-09-26: "every card with actions places the captain gate on its task; host cards file an operation task").
A card with actions and a task id - a crewmate's (`addCrewmateCard`), the first mate's (`addFirstmateCard`), or the host's own, including the stall card and the crewmate's sign-in card, which now carries its task - places the `captain` gate on that task with the card id as its ref (`IdleLadder.syncCaptainGate`; `docs/task-graph.md` "Gates on active rows").
A host card with actions and no task files an open `operation` row gated on the card (`TaskService.fileHostCardTask`), so it has a row for "waiting on you" to count.
A note places nothing on its own; its crewmate places the gate by declaring `waiting_on_captain` in its report, naming the note (`docs/report-sort.md`).

The card leaving releases the gate: a choice with its action as the reason on the `card_resolved` event, the captain's close with `dismissed`.
The close wakes no first mate (the captain's Q4a stands for its own cards; a crewmate's card's close is that crewmate's next turn) and is an act on the record: the task's idle clock restarts at the close, so the ladder's first rung acts ten minutes later, not on the next tick (`docs/report-sort.md`).
The stall card follows the same rule; its rung 3 stays terminal.
No reader of whose turn it is finds a card by its id pattern any more - a card is found by its task.

## Work that closed without the captain's click

The captain's words on INF-547: "the tasks were done but i never got any update."
Started work that closes without the captain's click leaves them one card about it, and only their close takes it down.
A crewmate whose task merges on its own shows its completion story before the merge, on a note with no actions: the same saved story a merge offer carries, with no button, risk chart or required actions (`CrewSupervisor.addCrewmateCard` refuses a saved-story note on a task that asks first).
A crewmate on the personal workspace shows what it built on a note the same way, and the done close keeps notes.
Every close the first mate makes of started work carries its one sentence: `settle_task` takes a top-level `closing_sentence` for every mode but `answered`, `interrupt_crewmate` takes it for `cancel`, and both refuse such a close without one.
The sentence is a fact of the close (`closingSentence` in its timeline data).
When the close leaves nothing of the task on the stack, the sentence goes up as the first mate's own note, titled with the task's key and its outcome (`merged`, `released` or `dropped`), with the pull request linked after a merge (`SettleService.leaveClosingNote`).
A captain's click carries no sentence, an answer task's close takes none, and a task no crewmate started gets no note.
The note has no actions, so it places no gate and nothing in the whose-turn sort reads it.
Activity's line for a drop the first mate made reads `Dropped:` and the same sentence (`droppedLine`), and an `update_task` drop's reason is that sentence too.

## Copy rules

Sentence case everywhere, factual tone, data in mono, no exclamation points, no emoji (design skill content fundamentals).

Five sentence habits (contract 4.58, FI3-542): one fact per sentence in at most 25 words; one name per thing, with the full name where two things share a number ("stable 1.4", "alpha 1.4-alpha.2"); the doer named ("I updated three tests"); the thing said literally, with no figure of speech; and three or more actions in a row as a numbered list.
The design skill's `copy/Vocabulary.prompt.md` ("How a line reads") is their home and says where they came from.
They are scored by hand on recorded cards (`clear_copy_share`, `docs/replay-harness.md`) and never linted.

A time of day is the captain's local time (FI3-1006): `CARD_AUTHORING` tells both personas that every time they write for the captain, on a card, in a reply or in a report, is in the captain's time zone unless the captain asks for another, converted from UTC and never UTC alone.
They are told the zone: the first mate's context block carries `captain_time_zone` each turn, and a crewmate's prompt ends with the same fact, named when its session opens.
It is this Mac's zone with its offset from UTC at that moment, such as `America/Los_Angeles (UTC-07:00)` (`src/core/prompts/timeZone.ts`), so a model need not know the zone's daylight-saving rules.

Title and body must make sense with no prior conversation.
The captain is multi-tasking.
Name the work in plain language (what changed / what they are deciding), not only a PR number or SHA.
A finished code-work completion card uses Why / What changed / Before / After, with verification inside After and remaining work after it when decision-relevant, otherwise in details.
The project, crewmate model, care, PR link, checks and holds are the host's settle facts strip, so the body does not repeat them.
SHAs and job timings are optional detail, not the lead.
Decision options stay 2-3, sentence case; labels can stay short if the body already states the choice.

## A playable preview

An ask for a prototype, a mock-up or a try is a plan whose card carries a playable preview (FI3-872).
The sequences document's plan line says so, and the first mate core sends the ask there, so it lands as a read-only plan step: an answer task (`docs/sequences.md`).
Those two sentences are the only places the word prototype reaches the first mate; `CARD_AUTHORING` speaks of a preview.

A playable preview is a decision body that draws the thing being chosen with its own controls ("The preview is the decision" above).
Its settings ride a hidden named field or `inf.stage(name, value)` as a compact JSON snapshot with stable names and units.
The 4,096 UTF-8 bytes named in the authoring instructions are an authoring budget for that snapshot, not a limit shared with the other answers.
Controls update the preview and the renderer's draft only: no author turn and no durable submission, and an unsent draft disappears on restart.
The footer choices and author-directed replies submit the current settings.
A preview ships nothing: its author's scratch stays private in its working copy, and the author revises the same card as feedback arrives.
It closes like every plan card, with **Approve and build**, **Save and defer** and **Abandon** ("The handoff" below).

The click-to-send capture of contract 4.20 and before - a body button calling `inf.action("use-settings", value)` - is retired from the contract.
The path stays for cards already stored: the optional fourth `inf:cards:act` argument still carries a frame value (protocol 1.23.0), the core still bounds it and refuses frame-triggered effects, and the wake still quotes it as `Card action value (JSON)`.

## The handoff

`HANDOFF` is the fourth constant in `cardContract.ts` (contract v4.41): what a choice on a plan or investigation authorizes, who builds it, and what the builder starts from.
The host decides none of it - it records the closing choice and answers, verifies the basis and mints the brief - so the judgment is the agents'.
One source marks reader-specific passages: `FIRSTMATE_HANDOFF` omits five planner/builder passages and `CREWMATE_HANDOFF` omits seven first-mate-only passages.
Both retain shared authorization boundaries, submitted settings and merge consent; the first mate also retains the opening sentence naming all plan buttons and the shared click/reply/next-owner guidance.

- A ready plan for a product change offers **Approve and build** as its default, and a ready plan for an operation offers **Start the next step**, each beside **Save and defer** and **Abandon**; a plan with a preview offers the same three for a product change.
  Choosing that default queues the approved pieces with their prerequisites; the existing queue starts each when its blockers clear.
  A piece that includes a captain-only action starts normally, and its crewmate asks on a card when it reaches that action, without a separate filing hold.
  Queued means `when-ready`; Backlog means `on-request`, waiting for the captain's word, with no separate plan mark.
  Work the captain reserved to start personally, or moved back to Backlog after approval, stays there until fresh authorization; older approval cannot queue it again.
  A question card and a design-only exploration are declared facts on the card, not a reading of its sentences.
  The captain asks for changes by reply, so a plan card carries no revise button.
- **Save and defer** keeps the agreed plan and authorizes no build.
  In that turn the first mate reuses the plan's planned successor, or files one with `create_task` on request, titled "Build the saved plan: …", with the plan as `basis`, the implement constraint and the plan's original words; never a second, and with no card or reminder.
  The build waits in the Tasks backlog until the captain presses Start on its record (`docs/sequences.md`, "A plan saved for later").
  **Abandon** files nothing; either click closes the plan with its spec and answers kept, as every closing choice on an answer does.
- The captain's Start on a saved build, or the captain's words to build it, authorizes it, and its basis's Save and defer choice is not a refusal.
  The builder first checks the plan against the current code and asks one specific question on a card only when something the plan relied on changed or a question was left unanswered.
- The captain's **Approve and build** submits the current values, including unchanged defaults, and authorizes implementation, not merging; the captain's explicit build or ship words do the same, in a reply too, with no second approval.
  Selection, praise, finish/keep, dismissal, script-triggered actions, a preview's own report, settings capture and controls do not; feedback revises the preview.
- A planner never edits product code: on an approval by reply it reports the approval words and current settings with needs_firstmate, and the first mate starts a builder grounded on that answer.
- The first mate starts the builder without planning again, naming the answer's task as `basis`; the host carries its report, card, thread, choice and latest answers into the brief (`docs/sequences.md`).
- The latest submitted values supersede earlier ones; the builder records and acknowledges the resolved spec, product settings apart from demo-only ones, before product edits and without reopening approval.

Merge, discard, stronger-model and unrelated-work requests keep `CARD_REPLY`'s close-and-report-verbatim routing; merge permission is unchanged.
Until v4.40 the rule was restated in the first mate core, three `CARD_AUTHORING` paragraphs, `CARD_REPLY`, the sequences seed and the brief's basis section, in three vocabularies (audit FI3-377).
`piResources.test.ts` pins that every persona carries its reader’s text once and that none of those texts, no tool description and no basis section repeats a sentence of it, and checks that each fact still reaches every agent that acts on it.

Whether a first mate acts on it is scored on recordings: the replay gate's `approval_handoff_share` counts the builders grounded on a plan that the first mate's answer to a hand-labelled captain choice started, starting from the real FI3-309 to FI3-310 session (`docs/replay-harness.md`, "The plan-to-build handoff").
A recording keeps the judgment it was made with, so a new text is measured on a new recording or by the account evaluation (`docs/account-evaluation.md`).
Save and defer has no recording yet, so the approval-handoff evaluation's `save-and-defer` case measures it: no start, and one build planned on request with the plan as its basis (`docs/replay-harness.md`).

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Card rule (product): a card is allowed only when work cannot move forward without a captain decision or the captain cannot move forward without seeing that fact; forbid all progress, CI-wait, and status cards (they belong in the feed).
  A card that implies a next step is a decision with that step as its `default`; on any card carrying a settle effect the host appends the project, the crewmate's model, the task's effective care, the proposed change, the checks' state and any hold of its own - the CI and review round counts against their caps, contract v3.6 - as the labeled fact strip (`CrewSupervisor.settleFacts`, v2.0 ruling D4, restyled at v2.7), so bodies never repeat them and the lint asks for none of them; a revision keeps the replaced version in `card_revisions` (migration 24).
  `keepsOpen` is retired (orchestrator contract v4.65, `src/core/prompts/contract-revisions/README.md`): no prompt or tool description offers it and `emit_card` refuses it; migration 73 removes the old actions from open cards before the click path is removed.
  A card carries exactly the actions its author declares (cards/tasks/agents P0, captain rulings D1-D8): no automatic Later, no park; a deferral is an action the author offers and its reminder is `schedule_prompt`.
  The ONE exception is the completion pair (contract v3.6, captain lock 3): a crewmate declares a `settle merge` action and the host replaces every settle action on that card with the merge labelled for the posture plus the danger discard, leaving the author's non-settle actions untouched - the labels and the count were facts the host held and an agent was transcribing, and `confirm` is deliberately not host-set, because it is a claim about the body and auto-confirming would destroy unlanded work without the captain choosing.
  The only host-authored cards are the agent-down set (`card-auth-*`, the paused seat's cards - `card-fm-no-headroom` titled per class, `card-fm-refused` "<provider> is not answering your first mate right now" with "Try <provider> again" (host op `try-again`) and "Open settings", the flagship-move card, and `card-fm-move-back` "Move your first mate back to <provider>?"
  (W1 S9, `docs/architecture.md` §16.8; a refused card never says signing in again clears it) - `card-fm-quiet`, the first mate failure card), `card-forge-<host>` (a sign-in where projects live that the host refused), `card-ask-<message>` - the answer-delivery notice (`docs/task-capture.md` "Answer delivery": "Your first mate has not answered your message", the captain's own words escaped, with Ask again and Leave it), `card-project-setup-<project>` - the setup card a first mate proposal puts up (`docs/fleet.md` "Asking the first mate to add a project": "Add <name> as a project?" with Add project, which reads the card's own answers, and Not now; closing it is Not now), and `card-stall-<task>` - the idle ladder's rung 3 (captain decision 2026-09-26, `docs/report-sort.md` "The idle ladder"): after two wakes about a stuck crewmate went ignored the work cannot move without the captain, so the host raises one card with Continue, Drop task and Discard; every other host moment - a refused settle, a dead gate, a reasoning wait, a quiet crewmate, a steer past its budget - is a feed line plus one `[fm-op]` wake.
  One card shape on the wire (cards/tasks/agents P1, ruling D1 a): `cardSchema` is strict with no `kind` and carries `author` (crewmate | firstmate | host); the chip is derived (`cardPresentation`: actions = decision, host author = attention, none = note) and the store's `kind` column is history (new rows write `card`).
  An action's `effect` is the only host semantics - `settle {merge|discard}` (merge resolved by the task's posture in `mergeModeFor`, so no agent learns merge-pr from land), `open {settings|subscriptions}` (and `open {browser}` on a crewmate's request card, `docs/task-browser.md` "Asking for help"), and the host's own `host` ops on the agent-down cards - and `CrewSupervisor.act` dispatches on it, never on an action id; an action with no effect is a reply to its author, and there is no keep button because closing is the keep.
  A card body has NO sanitizer (captain decision 2026-09-15, direction C; review in `docs/live-prototype-security.md`, authoring in `docs/card-authoring.md`): it renders verbatim and the boundary is the sandbox, the frame CSP (`default-src 'none'`, every script by hash, `img-src data: app-frame:` - the body's own pictures and the host's verified copies) and the host's bridge validation - measured end to end by `tests/e2e/card-containment.spec.ts`, which is the corpus the deleted allowlists used to be tested against.
  Never reintroduce a tag/attribute/CSS allowlist: it degraded honest markup and stopped nothing, since a body runs its own script anyway.
  Tokens and helper classes are an authoring PREFERENCE the prompts ask for, never a filter.
  The one thing the removal ADDED is the effect gate: an action carrying an effect is never declared to the body's frame (`bridgeActionIds`), so only the captain's click on host chrome settles a task.
  Migration 29 stamped `cards.author` by id pattern and rewrote every OPEN card's reserved ids into effects (`migrateLegacyActions`, logged in `card_effect_backfill`; closed rows untouched); the replay engine translates recorded reserved ids the same way, and `fake_merge_buttons` counts a merge-shaped action with no settle effect.
- Card pictures by reference (card pictures phase 2 of the locked plan `fm3000-card-images-proposal-s1`; `docs/card-authoring.md` "What contains a body" is the one home): a picture is an `<img src="<working-copy path>" alt>` in the body and `emit_card` has no `images` parameter.
  `verifyCardImages` (`src/core/pi/cardImages.ts`) verifies each (PNG, JPEG or WebP, 8 MB each, 64 MB a card, no count cap), copies it to `crewmates/<taskId>/cards/<taskId>-<32 hex>.<ext>`, rewrites only `src`/`width`/`height`, and hands `cards.pictures` (migration 41) to the row; the frame scheme's `images` host serves those names alone (`@shared/cardPictures` mints and parses them).
  A group is `figure.inf-pictures`, laid out by `FRAME_BASE_STYLE` alone so a `data:` group looks the same.
  `src/core/pi/cardImages.test.ts` binds the copy and the rewrite, and `tests/e2e/card-picture-fit.spec.ts` a picture shown whole in its card.
  Phase 3, the viewer: the bridge's `image` message (any `<img>` click, or a group's `+N` tile) carries the clicked index and its group's pictures; `viewablePictures` admits only the host's minted copies and `data:` rasters; `design/cards/PictureViewer.tsx` (design skill `PictureViewer.prompt.md`) is window-wide host chrome whose keys are a window capture listener, so they never reach the stack or the shell's Escape; `tests/e2e/card-pictures.spec.ts` is its binding test.

When a crewmate must put its own change in before the rest can proceed, an intermediate card cannot do that: it files the rest as `Continue: …`, names the filing in its report in a turn without a card, waits for the first mate's steer after triage, then names it in the completion-card body and says it starts once the change is in.
A card in the report turn suppresses that report wake.
Only the ordinary completion decision puts that change in.
If a later landing belongs to no task, the continuation may ask once for that outside change with an effect-free plain-reply button.

## Editable card body files (contract v4.49)

Crewmates are asked to write every card body as a UTF-8 HTML file in `crewmates/<taskId>/card-bodies/`, beside the evidence folder and outside the working copy.
The host names this folder in both runtimes' instructions.
`emit_card` takes exactly one of `body_file` or inline `body`; inline bodies are still accepted.
`body_file` may be absolute or relative to that task's body folder.
Real paths (including symlinks) must stay inside it, and the file must be regular and UTF-8.
The existing 65,536-character limit applies after reading; encoded reads are also bounded.

Showing remains explicit: the author writes or edits the file, then calls `emit_card` with its title, actions and stable id.
No watcher publishes unfinished edits.
The app snapshots the file at the call, then runs the unchanged picture verification, lint and card-service checks, persisting the resolved HTML rather than a live file reference.
A refusal leaves the file available to edit and retry.
Pictures named in the file are still relative to the working copy or absolute inside evidence, not relative to the body file.
`card-bodies` is separate from `cards`, the host's verified picture copies.
The first mate has no file tools and keeps a required inline body.

This is piece 1 of the accepted FI3-472 plan; pieces 2 and 3 are the next section.

## What changed since you looked

Pieces 2 and 3 of the accepted FI3-472 plan (the captain's settings: change bars, compared with the version last seen, removed parts counted only).
A revised card says what is new to the captain, and the author marks nothing: the host compares the two versions itself.
The visual rules are the design skill's (`components/cards/ResponseCard.prompt.md`, the revised line).

- **Seen.**
  The window reports the version of the card it shows on the stage while it is visible and focused (`inf:cards:seen`, `useSeenReport`; focus inside a card's own frame counts).
  `CardService.seen` records it once per offer as a `seen` observation (`docs/card-evidence.md`), and only for the version the stage shows - a late report about a replaced version changes nothing.
- **Compared with what.**
  The version on the stage is compared with the newest version seen on the card's lifecycle other than itself.
  Revisions that land while the window is away accumulate into one comparison; seeing the new version does not move it, so the marks stay until the next revision or until the card leaves.
  A card never seen before it was revised is simply new, and a card that left and came back under the same id starts a new lifecycle with nothing seen.
  A crewmate's revision is compared when it reaches the stage at its close-out, as everything on a card is.
- **Part by part.**
  `cardParts` (`src/core/orchestrator/cardChanges.ts`) reads a body through htmlparser2, the shape lint's parser: a part is the outermost paragraph (`p`, `pre`, `blockquote`), list item (`li`, `dt`, `dd`), table row, figure (`figure`, or a lone `img`, `svg`, `canvas`, `picture`) or question (`fieldset`, `label`, a `role="group"` or `radiogroup` container).
  Headings, containers and bare text only hold parts.
  Two parts match when their markup does - tag names, attributes in any order, text with whitespace collapsed - as a multiset, so a part that only moved is not new.
  The name of a host picture copy (a fresh random name on every call) and the host's fact strip and follow-up rows are ignored.
- **What the captain sees.**
  The snapshot carries `Card.changes`: when the shown version was written, how many parts are new and how many of the seen version's parts are gone, and where each new part starts in the body.
  The card's head draws "Revised 14:02 · 2 parts new · 1 removed" under the title; the body's frame draws a 2 px accent bar beside each new part, in a gutter it borrows from the card's padding so the text does not move (`cardBodyMarkup`, `CARD_CHANGES_STYLE`).
  More than half the parts new reads "Rewritten 14:02" with no bars; a playable preview (a body with its own style sheet, canvas, or a script outside every figure) gets the line and no bars.
  A figure that moves by its own script is a part like any other, and the mount path draws its bars as srcdoc does; a change to the script alone is no change.
  A change only to the title or the buttons gets the line alone, and a change only to what the host itself rewrites gets nothing.
- **What the crewmate is told (FI3-627).**
  The captain's reply is best met by editing only the parts the captain's words changed, so the comparison above can mark them; the `body_file` parameter and the card body folder note nudge toward that and allow a full rewrite when the answer itself changed shape (the opening sentence then says what changed).
  It is a nudge, never a rule.
  When a crewmate revises a card the captain has seen, the `emit_card` result also carries the app's own count (`CardService.revisionChanges`, the same comparison against the newest seen version, read on the newest write instead of the stage's): parts new and removed, and "Rewritten" with no change bars when over half is new.
  A playable preview gets the counts only, a card never seen gets none, and nothing is refused.
  The author may redo a needless rewrite as edits before it closes out, while the captain has not been shown the card.
- **Nothing else.**
  No new table, no setting and no previous-version switch; when a card reaches the stage, its checks, pictures and size limit are unchanged.
  `CardService.snapshot` works the comparison out once per shown version.

Tests: `src/core/orchestrator/cardChanges.test.ts` (parts, matching, the rewrite threshold, pictures, facts, previews, a moving figure), `cardService.test.ts` "what changed since the captain looked" (accumulation, stale looks, a crewmate's close-out, restart and a card leaving), `src/renderer/src/cards/revisedLine.test.ts`, `prototypeSrcdoc.test.ts`, and the journeys `tests/e2e/card-changes.spec.ts` (a first mate card through a small revision, a reload, two revisions while the window is away, a rewrite, a preview and a figure that moves on a press, with the bars measured beside their parts and the text unmoved) and `tests/e2e/card-body-file.spec.ts` (a crewmate's file-backed revision marks its one new paragraph).

## Revision links in the thread

Each revised thread line keeps links for that revision alone, comparing its saved offer with its immediate predecessor, separately from the since-last-seen line and bars above.
The author need not mark changes or supply selectors.
Keeping unique heading or section ids stable helps older links find their current areas; otherwise the host uses an unambiguous unchanged heading path and never guesses.
Every new list releases at the author's close-out, and an older link navigates the current card rather than a historical copy.
`docs/card-threads.md` owns persistence, matching, unavailable targets and navigation.


## Declared continuity

The `emit_card` description tells both authors to leave `holds_place` unset unless the use case requires continuous attention on the card.
An author may set `holds_place: true` for such an interactive card to keep its place across thread replies.
A reply keeps the shown card and opens its thread; every choice still closes it immediately, with no waiting drawing.
Each newly arriving marked card comes forward, even over another card, including a closed stable id raised again by its author.
A revision or a thread answer does not bring a card forward after the captain paged away.
The declaration is optional and stored as `Card.holdsPlace`; a revision without it removes it, and unmarked cards are unchanged.
This is generic card behavior, not a lesson type or a new action effect.

## Required actions after merging

New completion offers declare `required_actions`, including an empty list when none exist (`docs/required-actions.md`).
The host draws their action, target and consequence outside the scrolling body beside Merge.
A declaration grants no execution permission; a successful merge creates durable captain confirmation records, not crewmate continuations.

## Review finding attribution

The first mate passes `review_task_id` when relaying an independent review's findings on its builder's `task_id` (INF-63, accepted direction B).
The host refuses a missing or unrelated review, stores the resolved review task id and draws Review finding beside the card's kind.
Every first mate card about a task names the task after its key; a card about no task retains first mate.
Review-finding cards show the host's task facts beside the buttons, including the verdict, reviewed version and risk, even while the review stays open.
The native phone reader shows the same label and task name without running the body or offering buttons.

## Minimize a card

Minimize card is the neutral minus before Maximize on every live decision, note and attention card, including maximized cards and cards with threads.
It changes only the card’s optional saved `minimized` fact, through `CardService.setMinimized` and the views-only `inf:cards:minimize` request.
It is independent from `awaiting`, resolution, offers, task status, the captain gate and the idle ladder; no message, feed line or notification is emitted.
The Mac stack and pager omit minimized cards, while the phone’s read-only list is unchanged.
Every Mac showing this first mate shares that fact, including after a restart.
A crewmate's revision or answer brings the card back unread when that crewmate's turn ends, never at a report mid-turn (INF-926); the first mate's own answer brings it back at once.
Task records, past cards, the task board, browser views and crewmate views keep Hide and have no Minimize.

The renderer keeps answers and reply drafts in their existing in-session stores while a card is minimized.
`useCardReadingPlace` keeps its body’s reading place across remounts for the same run, for live cards, task records (`record:<task>`) and past cards (`past:<card>`); the stack's retirement leaves the last two alone, and closing a record or past card forgets its place.
A person's own wheel, touch or key before a saved place is reachable ends the pending restore.
A record also keeps the sections the captain opened, per task, and hands them to its frame at birth (`openSections` view state), until the record is closed, which reopens compact; a live card's own `<details>` still reload closed.
Bringing it back focuses the card at the default size; a restart drops unsent drafts as before.
The first mate’s asked `show-card` action uses `inf:cards:show`: an open card returns, and a closed card opens read-only.
The first mate has no minimize action.
