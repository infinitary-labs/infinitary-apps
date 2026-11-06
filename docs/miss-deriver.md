# The retrospective miss deriver (PoC-2 capture, C2)

An offline, **tables-only** scan that turns ordinary Infinitary usage into **candidate under-escalation labels** without asking the captain anything.
No schema change, no product surface, no Settings, no card, no telemetry, nothing leaves the box.

Design record: `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3 (C2) and Appendix C.2.
C3's `flag_missed_escalation` writes *confirmed* labels onto `missed_escalation` / `missed_note` / `missed_at`; this deriver never touches those columns.
Its output is a JSONL artifact a flagship judge can later bulk-confirm into gold pairs.

## Run it

```
pnpm derive:misses --db /path/to/firstmate.db --out candidates.jsonl
pnpm derive:misses --user-data /path/to/exported/userData --out candidates.jsonl
pnpm derive:misses --db firstmate.db --window-hours 24
pnpm derive:misses --db firstmate.db --out candidates.jsonl --escalations-out escalations.jsonl
```

`scripts/derive-miss-candidates.ts` runs straight through Node 24's type stripping - no build step - which is why its relative import carries an explicit `.ts` and `tsconfig.node.json` sets `allowImportingTsExtensions`.

Every input is a parameter (`--db`, `--user-data`, `--window-hours`).
The live `firstmate.db` lives on the captain's MacBook; point `--db` at an **exported copy** and the same run works anywhere.
Reads are read-only: the deriver never writes to the app's own files.

## The rule

For every `supervision_outcomes` row with `verdict='routine'` on task T at time t, look forward in a window (default 24h).
If T subsequently produced any of the following, the earlier routine is a **candidate miss**:

Since migration 50 `supervision_outcomes` is a read-only view over the one decision ledger (`docs/decision-models.md`, "The decision ledger"); an older export's table reads the same.
A row that recorded a typed wake carries its facts (`facts_json`), and a failed turn or task is read by them - never by words a report's excerpt happens to quote.
A row with no facts, prose or anything written before the ledger, is read by the host's own wording.

| Spec trigger | Real table signal |
|---|---|
| Captain-escalated outcome | later `supervision_outcomes` on T with `verdict='captain'` |
| `turn_failed` | later outcome whose typed wake facts are a `turn-failed` on T; on a row with no facts, whose `wake` matches the host-written failed-turn op (`CrewTurns.turnComplete`: `turn on task T … failed:`) |
| Task failure | later outcome whose typed wake facts are a `task-failed` on T; on a row with no facts, whose `wake` matches the host-written finish op (`CrewSessions.finish`: `task T "…" failed:`). `tasks.status` has no failed-at, so current status alone is not windowed evidence |
| Captain-resolved card | `cards` with `task_id=T`, `created_at > t` (subsequently produced), `resolved_at` inside the window. A withdrawal - an emitter's `close_card`, a duplicate, a settled task retiring its cards - is skipped |
| Direct control (`direct_control`, R2 forward-only) | a `steered` task event on T after the routine and inside the window with actor `captain` via `card` or `task-card` (a task card's Continue) or actor `firstmate` via `tool`, or an `interrupted` event with actor `captain`. A `requested` interrupt followed by its `aborted-turn` / `abort-failed` is one piece of evidence. A supervisor steer (the triage itself) and a first mate interrupt (its own call) are not captain contact and never count. **Not observable in history before R2**, and nothing pretends older rows exist |
| Historical interruption wake | a later outcome with no typed facts whose wake says `interrupted on task T`. This is generic `interruption` evidence with `actor: "unknown"`, never `captain_interrupt`: the text names no actor and the receipt follows the first mate's own interrupt tool |
| Captain steer via a card | a chosen action the card **declared with no effect**: that is the only observable card branch of `crewSupervisor.act` that reaches the crewmate. An action carrying a `settle` effect is host-owned teardown and an `open` effect is shell navigation - both are the captain resolving the card, neither is a steer. A historical captain-clicked card action `interrupt-task` / `cancel-task` remains attributable `captain_interrupt` evidence |

Card evidence is read off the card's own `actions_json` and the actor/action labels on its `card_resolved` event, never off a table of reserved ids.
The event distinguishes chrome dismissal from a declared action that legally uses the same `close` id.
IDs have been free-form since cards/tasks/agents P1, so "an id I do not recognise" had come to mean "the captain steered".
A pre-P1 reserved id is still read as the history it is, through the one shared mapping (`migrateLegacyActions`).

Direct captain steers and interrupts remain an acknowledged evidence gap for history recorded before R2's forward capture; from R2 on they are the `direct_control` class.
A captain steer through a card can therefore appear twice - as `captain_steer` from the card's resolution and as `direct_control` from the control plane's event - and both carry the card id, so a judge sees they are one click.
Card-derived contact is attributable and consumed; a host-written interruption wake is also consumed but remains explicitly actor-unknown.
The candidate set is therefore incomplete by construction.
A task can also legitimately deteriorate after a correct routine call, so every record is labelled `weak: true`, `confirmed: false`, `confidence: "unconfirmed"`.
A C3 flag already on the row is reported as `routine.c3_flagged` and does not flip that.

## The escalation chain

A pre-S7c database can still derive an escalation outcome from its `decided` event.
From S7c on, a rule-sorted escalation has no chain to follow, and the deriver records that silence.

## Forward-only, and history unchanged

Both R2 classes read only `steered`, `interrupted` and `decided` task events.
A database from before R2 has none, so its candidates, evidence keys and summary are exactly what they were, and `--escalations-out` writes an empty file.
Nothing historical is re-labelled.

## What a record is

One JSONL object per candidate routine, shaped to stay comparable with the C5 dispatch corpus (`label.weak`, redacted text, join evidence):

- **`routine`**: the earlier outcome (id, task, `at`, redacted wake/summary, provenance columns from migration 15).
- **`evidence`**: each later trigger with its kind, timestamp, and a one-line rationale (the later outcome id / card id / chosen action).
  `direct_control` adds `event_id`, `event_kind`, `actor`, `via`, `effect` and `decision`; a followable `captain_escalation` adds `escalation_outcome`.
- **`rationale`**: those lines joined, for a judge that wants one field.
- **`label`**: always under-escalation, always weak, never confirmed.

Wakes and summaries reuse Observe's redaction (`redactObserveText`) so a corpus never carries a live key.

## Tests

`tests/derive-miss-candidates.test.ts` builds a fixture `firstmate.db` with the app's **own** migrations (`openDatabase`) covering the positive cases (routine-then-escalation / turn_failed / task failure / resolved card / card-derived steer / interrupt wake within the window) and the negatives (quiet routine; deterioration outside the window; evidence on another task; a card that already existed before the routine; a captain row as the source).
The schema under test is the real one; only the rows are fixtures.

`tests/derive-miss-candidates-r2.test.ts` writes R2 events through the one task writer (`TaskService.turns.recordSteer`, `recordInterrupt`, `recordDecision`) and drives the real CLI: captain card steers, first mate tool steers and captain interrupts count (the requested/aborted pair once, provided both are in the routine's window), supervisor steers, first mate interrupts and pre-routine events do not, the handoff chain yields `card`, `steer` and `none`, an acknowledged retry wins while released-attempt effects remain represented, C3's columns stay untouched, and a pre-R2 database derives with no new evidence keys, no escalation records and the same summary.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- `flag_missed_escalation` (PoC-2 capture C3, `src/core/pi/supervisionTools.ts`) is the only path from "you should have told me about that" to a durable label: under-escalation is otherwise unobservable, because a routine verdict is one feed line and no captain contact.
  It stamps migration 16's nullable `missed_escalation`/`missed_note`/`missed_at` on the task's newest routine `supervision_outcomes` row (or a named `#id` from `supervision_log`), write-once, `routine`-only, and captain-turn gated by the same wake stamp `remember` uses - the label's value is that the captain confirmed it, so the agent cannot manufacture one on a scheduled or supervision wake.
  Refusals are tool text, never throws.
  No card, no setting, no user surface.
  `flag_duplicate` (interaction P1 WI-14, same file) is its twin for cards: the captain's "this card repeats that one" stamps migration 25's `duplicate_of`/`duplicate_note`/`duplicate_at` on `cards` write-once (`CardStore.flagDuplicate`), the host closes the card with resolution `duplicate` and one feed line - same captain-turn gate, no surface.
- The retrospective miss deriver (PoC-2 capture C2, `scripts/derive-miss-candidates.ts`, `docs/miss-deriver.md`) is an OFFLINE tables-only scan: for every `supervision_outcomes` `routine` verdict it looks forward in a window (default 24h) for a later captain verdict, a host-written `turn_failed` / task-failure wake, a captain-resolved card (including observable card-derived steer/interrupt contact) or an actor-unknown host-written interruption wake, and emits weak candidate-miss JSONL.
  Direct captain steers/interrupts remain an acknowledged pre-R2 history gap; from R2 on, captain card steers, first mate tool steers and captain interrupts are its forward-only `direct_control` class, and a captain verdict's `handoffInboxId` is followed to the consuming first mate `decided` event (`escalation_outcome`, `--escalations-out`).
  A pre-R2 database derives exactly as before.
  Never writes C3's `missed_escalation`/`missed_note`/`missed_at`.
  Inputs are parameters (`--db`/`--user-data`/`--window-hours`) so a MacBook-exported `firstmate.db` runs identically.
  Fixture-tested; no live data required.
