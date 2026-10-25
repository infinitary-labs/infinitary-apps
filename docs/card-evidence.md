# Card evidence: what a card offered and what the captain did with it

The local record of every card decision, kept so a later reader can tell exactly what the captain was shown, what the captain chose from it, what each question asked, and what the task looked like when the captain chose.
It is part of the card's own persistence: no switch, no collector, no network and no new question for the captain.
Nothing leaves the Mac.
Its readers are the opt-in export below and, since FI3-472's change marks, the stage's revised line, which reads the `seen` and `offer` observations back ("What the captain saw").

Design record: `fm-homes/mini-default/data/fm3000-decision-dataset-s1/report.md` (P1-P9, captain authorization 2026-09-29: "alright - pass back to firstmate and authorize an opus crewmate to implement").
This is its first release, D0-D3.
D4 (direct effect outcomes, richer author context) and D5 (a real local qualification run) are not built.

## Why the card row was not enough

A card row holds the card's newest head.
The stage can show an older version while a crewmate's revision waits for its close-out (`docs/card-threads.md` "When a card reaches the stage"), and a click resolves against the version on the stage.
Before this, the resolution landed on the row whose title and body were the revision the captain never saw, a reopen overwrote the earlier lifecycle, and the task's event log compacts after 500 events.
The evidence table below is what keeps those apart.
`tests/e2e/card-evidence.spec.ts` reproduces the stale-offer case through the app and the export command.

## The one table

`card_observations` (migration 57) is append-only and card-owned.
Its one writer is `CardStore.observe`, called only by `CardService` inside the same SQLite transaction as the card or thread write it describes, so a failed write leaves neither the row nor its evidence, and the in-memory stack moves only after the commit.
Every payload is checked against its kind's schema in `src/shared/cards.ts` (`cardObservationPayloadSchemas`) before it is written.

Each row carries the card id, its lifecycle id, the task id if any, the kind, the actor (`captain`, `firstmate`, `crewmate`, `host`, `frame`), the source (`chrome`, `frame`, `close-control`, `thread`, `tool`, `host`, `restore`, `stage`), the offer it is about, the capture version (`CARD_CAPTURE_VERSION`, 1), the app build, and the payload.
`card_capture_epochs` records when each capture version first ran and one random namespace for this installation.

The seven kinds:

| kind | written when | carries |
|---|---|---|
| `offer` | a version of the card is written whose content differs from the last | the whole version: author, title, meta, model, where its task runs, body, actions, pictures, width, its live attachment, a declared asking, design-only or continues fact, and its fingerprint |
| `availability` | the stage's view of an offer changes | `available`, or `waiting` on `answer` or `close-out`, the cause, the offer it replaced, and whether this started or reopened the lifecycle |
| `action` | an action is admitted | the action id and label as the offer declared them, closes / keeps open, the effect, the answers, the question definitions, the display fidelity and the task slice read before the choice |
| `message_ref` | a thread line is written | the message id, who wrote it, and for a captain line the offer the captain was looking at |
| `exit` | a lifecycle ends without an action | dismissed, author withdrawal, host withdrawal, task retired or duplicate |
| `effect_receipt` | never, in capture 1 | the schema a D4 receipt will use |
| `seen` | the window showed an offer on the stage, visible and focused - once per offer, only for the version the stage shows | nothing beyond the offer it names; source `stage`, actor `captain` |

### Lifecycles and offers

`CardService.stamp` gives a card a `lifecycleId` when it is not on the stack, and a new `offerId` when its content fingerprint (sha256 over author, title, meta, model, body, actions, pictures, width, and the live attachment, where its task runs, and a declared asking, design-only or continues fact when it has them) changes.
A card id reused after it left starts a new lifecycle that names its predecessor, so a reopen never rewrites an earlier episode.
The two ids ride the card snapshot to the shell and are persisted on the row (`cards.lifecycle_id`, `cards.offer_id`), so a restart resumes the same lifecycle.

Cards that were open when capture first ran are seeded at boot as `legacy-initial-snapshot`: their offer as it stood, and nothing about how they started.
Nothing older is invented.

### What the captain saw

`seen` is the one kind something on screen reads back: a card's revision is compared with the newest offer seen on its lifecycle, and the difference is the revised line and change bars (`docs/card-authoring.md` "What changed since you looked").
`availability` says what the stage offered, never that anyone looked; `seen` is the window's word that the captain had it in front of them.
The export reads past it: the episode schema does not carry it.

### The past card

`CardStore.past` reads a closed card back for the stage (`inf:cards:past`, FI3-579): the newest `seen` offer on the card's lifecycle, else the offer its closing interaction chose from, else the newest offer, else the row itself; how it ended from the closing `action` or `exit` observation; the answers from that action (the row's `answers_json` as a fallback); and the thread.
Its ending's `by` is that observation's actor, so a choice the body's own script made stays `frame`.
`pastCardEndingWords` (`src/shared/pastCard.ts`) credits such a choice to the card's author by `scriptChooser`, the rule its resolution follows, so the past card, the record's Cards row and the first mate's turn never say the captain chose it.
Its actions travel without their `effect`.
It is a pure read: it records no observation, takes no turn and never reopens the card.

Bringing one forward is `inf:cards:show` (FI3-579 piece 4), the single door behind the `show-card` catalog action: it brings an open card back to the stack, refuses an unknown card in words, and for a closed card broadcasts `past_card_shown` and returns the same read (`inf:cards:show-past` is the closed-card half alone).
It stores nothing, emits no card and runs no effect.
The first mate's call leaves one feed line and operation record; the captain's own gesture leaves none.
What's new brings a closed release note forward the same way, broadcasting `past_card_shown` from `inf:release-notes:show` (`docs/release-notes.md` "Reading a note again").

The record's Cards row (FI3-579 piece 1) lists a task's cards through `TaskDetail.cards`: `CardStore.forTask` reads the rows filed under the task plus the card ids its timeline names (`card_raised` / `card_resolved` refs, which reach a first mate decision's card that carries no task id), newest first.
A closed card reads as the version last seen with `pastCardEndingWords`; an open one, a folded seen note included, reads "On the stage".
A purged card is absent.
The row's link goes through the one door above for a closed card (`window.infinitary.cards.showPast`) and `focusCard` for an open one.
The cross on a card writes one feed line, `You closed "<title>". It stays on KEY's record.`, from `CrewSupervisor.close`; a card with no record to point at keeps the plain "captain dismissed" line.

### The stage

`availability` facts are deduplicated against the log itself (`lastAvailabilityOf`), never a cache, so a restart or a repeated write never doubles one and a rolled-back write leaves nothing stale.
A revision on a shown crewmate card records the shown offer as still `available` and the new head as `waiting` on `close-out`; the close-out records the head `available` with `replaces` naming the offer it took over from.

## What a click carries

The shell stamps each gesture (`src/renderer/src/app/store.ts`): a random 32-hex interaction id, the lifecycle and offer ids of the card it mounted, and for a footer click with a form, whether the reading was `fresh`, a `fallback` to the last draft, or `none`, whether the card was remounted with another offer while it waited, and the question definitions.
It rides `inf:cards:act`, `inf:cards:close` and `inf:cards:reply` as one optional trailing argument (protocol 1.37.0).

The core normally reads that metadata leniently: a missing or malformed submission does not refuse a choice.
For a durable required action's confirmation or a merge with declared requirements, submitted metadata must name the current offer and lifecycle and must not say it remounted (`docs/required-actions.md`).
The host refuses stale or unreadable submitted metadata before it records completion or authorizes merging; a legacy caller that submits no metadata remains supported.
Otherwise it only decides the recorded **display fidelity**:

- `matched` - the shell showed the offer the core dispatched;
- `mismatched` - it showed another one; kept as a mismatch, never repaired with the newest head;
- `legacy-missing` - no submission came (an older shell, a host path);
- `unavailable` - a submission came but could not be read, or named no offer.

A retransmitted submission with the same interaction id is one row (a unique index on card and interaction id); a genuine second click is another.
A choice naming an undeclared action is refused before admission: it writes no `action` observation or resolution, and leaves the card and task unchanged.
Existing historical unrecognized-action observations remain readable.

### Question definitions

A footer click already asks the frame for a fresh reading (`collect`, `docs/card-authoring.md` "Questions in the body").
The same reply now carries what each named question offered, read by the bridge from the DOM (`defineQuestion` in `src/shared/plugins/bridge.ts`), never from the body's HTML text:

- the prompt, taken only from explicit native semantics: a fieldset's `<legend>`, a `role="group"`/`radiogroup` container's `aria-labelledby` or `aria-label`, a lone field's bound `<label>` (without the text of a control it wraps), or one shared first `aria-labelledby` id; otherwise `null` with the gap `no-prompt`;
- the kind (`single`, `multiple`, `text`, `opaque`) and the control;
- every option with its label, whether the author proposed it, and whether it was disabled or had no box;
- whether it also offered a Something else row (`writeIn: true`, FI3-1002; `docs/card-authoring.md` "Something else"), which the options leave out because it is never an option value;
- whether the proposal was authored, the implicit first option of a select, or none;
- the gaps (`no-prompt`, `conflicting-prompt`, `label-truncated`, `duplicate-values`, `mixed-controls`, `opaque`) and whether the definition is complete.

Labels are cut at 500 characters and a whole set at 64 KiB (`CARD_QUESTION_LABEL_MAX`, `CARD_QUESTIONS_MAX_BYTES`).
A set that is too large or does not validate is recorded as the gap `too-large` or `invalid`; a click that fell back on a draft records `no-fresh-reading`.
None of these blocks the choice, and the definitions never reach the author's wake.

Definitions ride only the reading a footer click asked for.
The draft the shell keeps while the captain picks is never recorded: closing a card sends nothing, and a restart loses it, exactly as before.

### The task slice

Before a choice changes anything, `CrewSupervisor.act` reads a frozen slice of the task through `TaskService.decisionContext`: its key, kind, status, activity, parent, gate, delivery posture with the change's head, checks and review state as last observed, whether a settle is pending, its blockers and its asks.
A card with no task records `contextGap: "no-task"`, one whose task is gone `task-missing`.
Nothing later is ever written into it.

## The export

```
pnpm export:corpus --user-data /path/to/a/quiescent/userData --out ./new-pack --human-supervision
```

The flag adds a view to the C4 export (`docs/corpus-export.md`); without it the five files and their meaning are unchanged.
It reuses the export's hard gate, reads the database in one read transaction up to an observation cutoff, and writes:

- `human-supervision.jsonl` - one **episode** per card lifecycle (`scripts/human-supervision.ts`): every offer, the stage facts, every interaction with the offer it named, the thread lines about the card, how the lifecycle ended, and, in a separate `later` namespace, the task as it stood at the cutoff (a temporal join, never a causal one);
- `human-supervision-labels.jsonl` - empty; labels are authored separately;
- `assets/pictures/` - copies of the pictures the offers show, and of the demo recording a poster stands for (a picture's `demo`, with its own asset and checksum), verified by name and containment under the task's card folder, never followed by path;
- a `human_supervision` section in `manifest.json` - schema and normalizer versions, namespace, cutoff, capture epochs and cards with activity after capture began but no evidence, counts by basis, actor, source, fidelity, question completeness and missing marker, the first-inventory funnel, exclusions with their reasons, rights, and a sha256 for every file.

It never infers.
An outcome no observation recorded is `unknown`, never a success or a failure.
Cards written before capture are `legacy-reconstructed` from their final rows, revisions and threads with `display: legacy-missing` and nothing shown or clicked invented.
Every missing fact is named where it is missing (`outcome:unknown`, `pictures:missing`, `context:*`, `questions:*`, `lifecycle:start-unknown`, `offer:not-captured`, `thread:message-deleted`, ...).
Observations from a newer capture version, of an unknown kind, or with an unreadable payload are excluded and counted.

Each interaction lists named eligibility facts - human source, display matched, questions complete, context present, outcome known, labelled - for a use to select on; there is no quality score.

The same database and cutoff produce the same records and file checksums.
The pack is written to a staging directory beside `--out` and renamed onto it only when complete; a nonempty `--out` is refused (exit 4), so a reviewed freeze is never overwritten.
The command prints counts, exclusions and paths, never a card's words.

### Rights and privacy

Every episode and the manifest say `scope: owner-local` and `external_use: not-authorized`.
The export runs the existing credential scrubber over every record and marks an episode it changed as `redacted`; that is best effort, never anonymization.
Body text, scripts and labels are untrusted data: the export never executes them.
Contribution, upload, training and any external use are separate future decisions this does not make.

## Retention, purge and rollback

Completion deletes none of this: evidence outlives the task's close and the event log's compaction.
The one purge owner removes it - `CardStore` deletes a task's cards with their revisions, threads and observations (`deleteForTask`), and `CrewSupervisor.purgeAllTasks` also purges the evidence of task-less cards linked through a decision or operation row (`CardService.purgeEvidence`, which never touches a card still open).
An exported pack is a separate local copy: an app purge does not reach it.

Migration 57 is additive.
A rollback to an older build leaves the tables and their rows in place, and the export reports capture epochs, so an interval an older build ran is never presented as complete.
Never drop the table or rewrite its rows to recover from a capture problem.

## Tests

- `src/core/orchestrator/cardService.test.ts` "CardService evidence" - stale offer, fidelity, retransmit, reopen and restart past 500 task events, exits, offer minting, host reopen, thread refs, a failed write rolled back, legacy seed, purge.
- `src/core/storage/cardStore.test.ts`, `src/core/storage/db.test.ts` - the purge and the schema refusal; migration 57 and its reversal.
- `src/core/orchestrator/crewSupervisor.test.ts` - the frozen task slice and a frame action.
- `src/renderer/src/app/store.test.ts`, `src/renderer/src/plugins/frames/frameController.test.ts`, `src/shared/ipc.test.ts` - the gesture, the mounted offer and the definitions on the wire.
- `tests/export-human-supervision.test.ts` - episodes, legacy strata, pictures and checksums, determinism, redaction, refusal, exclusions, and the CLI gate; `tests/export-corpus.test.ts` holds the default export's five files.
- `cardService.test.ts` "what changed since the captain looked" and `tests/e2e/card-changes.spec.ts` - the `seen` kind: once per offer, stale looks ignored, and the revised line and bars it drives.
- `tests/e2e/card-evidence.spec.ts` - the stale-offer journey through the app and the real export command, every question shape the bridge defines, and no draft kept on a close or a quit.

Author-directed replies also commit their bounded named answers in the existing `message_ref` observation.
Basis handoffs read the newest captain-submitted answers from action or message observations; legacy resolution-only answers remain readable.
Draft control changes alone create no submission.

## Evidence shared with a future pull or merge request

A prepared change story selects publishable evidence explicitly and reuses the retained card-media copies; it never exports an arbitrary card or its thread.
The saved revision supplies the same views, captions, media, verification, risk explanations, required actions and unfinished work to a github.com pull request or gitlab.com merge request and its completion card (`docs/forge.md`, "Saved change stories").
The pull request uses confirmed native attachments; the card uses the retained local files and its inspected recording posters.
The story and receipts survive restart, while task close never deletes hosted attachments.
