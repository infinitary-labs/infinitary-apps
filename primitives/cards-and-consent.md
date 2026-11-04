# Cards and consent

A card shows the captain an answer, gathers a decision, or requests one exact effect that only the captain's click on host chrome runs.

## Intended use

Raise a card only when work cannot move forward without a captain decision, or the captain cannot move forward without seeing that fact.
A card with actions is a decision: 2 or 3 declared actions with exactly one `default`, the step its author would take.
A card with no actions is a note: one fact, never a progress update.
A card authored by the host itself reads as attention (the agent-down set, sign-ins, refusals, a stuck crewmate).
Nothing declares a kind; the chrome is derived from what the card carries (`cardPresentation` in `src/shared/cards.ts`).
Every card is the head of a thread between the captain and the card's author (`docs/card-threads.md`).

## When to use it, and when not

Use a card for a decision the work waits on, a finished outcome, a plan or preview to approve, a host-held effect such as a merge, or a captain-only step after merging (required actions).
Never raise a progress, CI-wait or status card: those are feed lines.
The host raises two cards about work: the idle ladder's stall card, after two ignored wakes (captain, 2026-09-26; `docs/report-sort.md`), and the first mate's closing note on started work it closed without the captain's click (INF-547; `docs/card-authoring.md`).
Every other host moment (a refused settle, a dead gate, a quiet crewmate) is a feed line plus one wake, not a card.
Do not build a feature-specific button kind, card kind, stamp or runner: a new feature declares actions and, where the host must act, one of the existing effects.
Do not build a second consent path (a confirm dialog in a panel, a frame-side button that settles, an agent tool that merges): consent is a click on a card's host chrome.
A deferral is an action the author offers, and its reminder is `schedule_prompt` (see [automation.md](automation.md)); there is no automatic Later or park.
A question that needs a structured answer uses the questions in the body ([decision-questions.md](decision-questions.md)), not a new form surface.

## Owner and entry points

- [`CardService`](../src/core/orchestrator/cardService.ts) is the one writer of the card stack and its threads, with [`CardStore`](../src/core/storage/cardStore.ts) beneath it (`card_revisions`, `card_messages`, `card_observations`).
- The wire shape, actions and effects: `cardSchema`, `cardActionSchema`, `cardPresentation` and `isPreviewBody` in [`src/shared/cards.ts`](../src/shared/cards.ts).
- Agent entry: `emit_card` ([`src/core/pi/cardTool.ts`](../src/core/pi/cardTool.ts)), the crewmate's `reply(card_id, text)`, and `close_card` for an author's own card.
- The shape lint at both emit boundaries: [`src/core/pi/cardLint.ts`](../src/core/pi/cardLint.ts).
- Card pictures: `verifyCardImages` in [`src/core/pi/cardImages.ts`](../src/core/pi/cardImages.ts).
- A click: `CrewSupervisor.act` in [`src/core/orchestrator/crewSupervisor.ts`](../src/core/orchestrator/crewSupervisor.ts) dispatches on the action's `effect`, never on its id.
- The card contract has one home per kind in [`src/core/prompts/cardContract.ts`](../src/core/prompts/cardContract.ts) (`CARD_AUTHORING`, `CARD_MECHANICS`, `CARD_REPLY`, and `HANDOFF` for what a choice authorizes); no persona prompt repeats it.

## Operations and lifecycle

- Emit: one card shape on the wire, a title, an HTML body and the declared actions.
- Revise: `emit_card` with the same stable, namespaced kebab-case id replaces the open card in place; the replaced version is kept in `card_revisions` (`CardStore.history`) and the host marks what changed since the captain looked.
- A distinct finding is a new card; there is no one-card-per-topic cap.
- Release: a crewmate's card reaches the stage at its author's close-out (its next report or its idle); a card already shown waits for its author's idle (`docs/card-threads.md` "When a card reaches the stage").
- Reply: the captain's words under a card go to its author as a steer stamped `via: "thread"`; the author answers once, revising with `reply` or answering with `reply(card_id, text)` (`CARD_REPLY`).
- Choose: every declared action closes its card; an action with no effect returns to its author as the captain's choice, and an action with an effect is run by the host.
- Close: the captain's close is the keep; it runs nothing, is not a choice, and reaches a crewmate author as the typed `card-closed` wake for it to judge.
- Withdraw: only a card's own author withdraws it (`CardService.close` refuses the first mate closing someone else's card).
- Every card with actions places the `captain` gate on its task (`IdleLadder.syncCaptainGate`); a task-less host card files an `operation` row (`TaskService.fileHostCardTask`); the card leaving releases the gate (`docs/card-authoring.md` "A card places the gate").
- Evidence: every offer, availability change, admitted action, thread line, exit and stage sighting is appended to `card_observations` by `CardStore.observe`, inside the same transaction as the write it describes (`docs/card-evidence.md`).

## Authority

- Only the captain's click on host chrome runs an effect.
- An action carrying an effect is never declared to the body's frame (`bridgeActionIds` in [`src/renderer/src/cards/bridgeActions.ts`](../src/renderer/src/cards/bridgeActions.ts)), so a body's own script cannot settle a task.
- Effects an agent may declare: `settle merge`, `settle discard` (always danger; `confirm` only when the body says work is unlanded), `open` a Settings section or the task browser, `request_merge` of a stored review, and `request_write` of a kept forge write.
- The `host` effect kind belongs only to cards the app authors; every emit boundary refuses it from an agent.
- An ordinary `request_merge` click keeps its exact reviewed target through a refused merge and an accepted unchanged repair, using the same merge-authorization owner as `settle merge`; rule-skipping clicks remain one-shot (`docs/forge.md`, "A requested merge").
- On a completion offer the crewmate declares one `settle merge` and the host writes the merge-and-discard pair for the task's posture (`CrewSupervisor.withCompletionActions`, captain lock 3).
  A first-mate `settle merge` card on a task with a saved story binds that story once it is published, and is refused before display until then (INF-2490).
  Every merge offer names the change it was shown for, and its click refuses once another change is current.
  First-mate cards, including older restored merge cards, never count as replacement completion offers that end a kept approval.
- What a choice authorizes (`HANDOFF`, contract v4.41): Approve and build authorizes implementation, not merging; Save and defer keeps the plan and authorizes no build; Abandon files nothing.
- Explicit build words in a reply authorize implementation, not merging; settings, selection, praise, dismissal, script-triggered actions and a preview's controls authorize neither.
- Merge, discard, a stronger model and unrelated work asked for under a crewmate's card are not the crewmate's to run: it closes its card and reports the captain's words verbatim with `needs_firstmate`.
- Cards are threads (`docs/card-threads.md`): a reply goes to the card's author and resolves nothing, and the captain's close of a crewmate's card reaches that crewmate, which judges it; nothing in the host reads the captain's words.
- Required actions on a completion offer are display-only: they grant no execution permission, and a confirmation runs nothing (`docs/required-actions.md`).
- A Careful validation question binds its approval to one ordinary action with `emit_card.validation_request` (`docs/delivery-rigor.md`, "Careful live validation"): a check approval is kept on the check by its id while the check declares the same resources and cost per run, and names no sign-in; an effect others can see is approved once and used once; a version's gaps share one host-drawn checklist whose ticked rows the click accepts, on a card with no script or field of its own, and an accepted gap lasts until its check fails or leaves the list.
- Card bodies render verbatim with no sanitizer; never reintroduce a tag/attribute/CSS allowlist.
- Containment is the frame's sandbox, its CSP and the host's bridge validation (`docs/live-prototype-security.md`).
- The card lint asks for shape, never a banned-phrase list: it refuses only a typed fact, consent for an effect, a physical limit or a product fact the captain ruled.

## Compositions

- A finished change's completion decision carries the saved change story and the host's settle facts strip; the merge itself is the delivery path in [projects-and-working-copies.md](projects-and-working-copies.md) and `docs/forge.md`.
- A plan or answer task's card is its deliverable ([tasks.md](tasks.md)); its closing choice and answers are carried into the builder's brief (`docs/sequences.md`).
- Required captain actions become on-request `operation` tasks with a captain gate, owned by `TaskService`, at the merged close.
- App-action handover and proposal cards are host-written cards whose one button runs or opens the catalog line ([app-actions.md](app-actions.md)).
- A task browser handoff is an ordinary decision with one `open browser` action ([task-browsers.md](task-browsers.md)).
- The whose-turn sort and idle ladder read the gate a card places (`docs/report-sort.md`); thread steers ride the durable inbox (`docs/inbox.md`).

## Failure and recovery

- A refused card is never shown; the refusal names the fix (entity-escaped body, wrong action count, missing `default`, a settle on a closed task).
- A choice the shown offer did not declare, or one on a closed task's card, refuses before any bookkeeping and leaves the card open.
- A refused settle comes back to the first mate as an outcome, which re-settles or raises a decision; it never returns as a steer.
- `emit_card` under a card that awaits the author's answer is refused unless it carries `reply`.
- Cancellation or terminal session failure retires the task's open cards without releasing them; notes on a task that closes done stay until the captain closes them.

## Uses

- Completion merge offer: a crewmate's finished change, with the host's merge and discard pair, settle facts, risk chart and required actions.
- Plan and preview approval: Approve and build, Save and defer and Abandon under `HANDOFF`.
- The idle ladder's stall card (`card-stall-<task>`) with Nudge, Keep waiting and Discard, and a reply row the first mate answers (`Card.answeredBy`).
- The first mate's closing note on started work it closed without the captain's click, at most one for each of the captain's messages (`SettleService.placeOutcome`, `docs/task-capture.md` "How a message ends"); work no message covers gets one only for a merge or a release.
- The answer-delivery notice `card-ask-<message>` (`docs/task-capture.md`) and the project setup card `card-project-setup-<project>` (`docs/fleet.md`).
- Required captain actions after a merge, confirmed by their host button (`docs/required-actions.md`).

## Checks

- [`src/core/pi/piResources.test.ts`](../src/core/pi/piResources.test.ts): each contract constant reaches every persona exactly once and no other text repeats it.
- [`src/core/claude/claudeToolSurface.test.ts`](../src/core/claude/claudeToolSurface.test.ts): `CARD_MECHANICS` is served as written.
- [`src/core/pi/cardLint.test.ts`](../src/core/pi/cardLint.test.ts): the shape rules.
- [`src/core/orchestrator/cardService.test.ts`](../src/core/orchestrator/cardService.test.ts) and [`src/core/storage/cardStore.test.ts`](../src/core/storage/cardStore.test.ts): stack, threads, revisions and evidence.
- [`src/renderer/src/cards/bridgeActions.test.ts`](../src/renderer/src/cards/bridgeActions.test.ts): effects never reach the frame.
- [`tests/e2e/card-containment.spec.ts`](../tests/e2e/card-containment.spec.ts), [`tests/e2e/card-threads.spec.ts`](../tests/e2e/card-threads.spec.ts), [`tests/e2e/card-evidence.spec.ts`](../tests/e2e/card-evidence.spec.ts) and [`tests/e2e/required-action-row.spec.ts`](../tests/e2e/required-action-row.spec.ts).
- A PR touching the prompt, the card lint or `src/renderer/src/cards/` runs `pnpm replay:gate` (`docs/replay-harness.md`).

## Where the detail lives

- [`docs/card-authoring.md`](../docs/card-authoring.md): "One card", "Actions and effects", "The shape lint", "Revising a card", "HTML bodies", "A card places the gate", "Work that closed without the captain's click", "The handoff".
- Card pictures: [`docs/card-authoring.md`](../docs/card-authoring.md) "What contains a body".
- [`docs/card-threads.md`](../docs/card-threads.md): the thread record, "When a card reaches the stage", "The contract both agents read", "The settle hand-off, with no classifier".
- Card evidence and its export: [`docs/card-evidence.md`](../docs/card-evidence.md).
- [`docs/required-actions.md`](../docs/required-actions.md): required captain actions.
- [`docs/live-prototype-security.md`](../docs/live-prototype-security.md): why there is no sanitizer.
