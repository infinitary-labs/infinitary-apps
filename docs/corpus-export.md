# The corpus export (PoC-2 capture, C4)

One local command that packages everything Infinitary has already captured into an eval/training corpus: the **supervision** decisions from the tables, **pre-S7c archived** supervision turns, the first mate's **dispatch** turns, and R2's provenance events.
The supervision-turn extractor is a reader of pre-S7c exports only (`docs/supervision-extractor.md`): the app no longer writes supervision transcripts, while current whose-turn outcomes still appear in the `supervision_outcomes` compatibility view (`docs/report-sort.md`).
No schema change, no second store, no product surface, no telemetry, nothing leaves the box.

Design record: `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3 (C4) and Appendix C.2.
It depends on C1 (migration 15's provenance columns), C5 (the dispatch extractor, `docs/dispatch-extractor.md`), and G1 (the supervision-turn extractor, `docs/supervision-extractor.md`).
It calls both extractors rather than re-implementing them.

## The hard gate

This command moves transcripts, which is exactly what Observe's gate exists to contain, so it reuses that gate's development half verbatim - `src/core/observe/gate.ts`, `isDevObserveEnabled` (`docs/dev-observe.md`, "Hard gate"):

- Electron `app.isPackaged === false`, **or**
- `INFINITARY_DEV_OBSERVE=1`.

Nothing else: an alpha build, which opens Observe's tab, does not open this command.
Never a Settings toggle, never a persisted flag, never a default-on packaged path.
The gate is checked **before a single file is read**: a blocked run opens no transcript, creates no output directory, and exits 3.

There is no Electron `app` in a script, so packaged-ness is read off where the script actually sits (`detectPackaged`): a packaged build ships filtered git-tracked source (no test fixtures or draft data terms) as `Contents/Resources/self-source/` and its code inside `app.asar`, a checkout does not.
`INFINITARY_PACKAGED=1` can only ever *tighten* that answer - nothing can declare a build unpackaged.

## Run it

```
pnpm export:corpus --out ./corpus
pnpm export:corpus --user-data /path/to/exported/userData --out ./corpus
INFINITARY_DEV_OBSERVE=1 pnpm export:corpus --out ./corpus   # a packaged build you are debugging
```

Every input is a parameter with a sensible default (`--user-data`, `--sessions`, `--claude-sessions`, `--supervision-sessions`, `--db`, `--session-file`), so an **exported copy** of another machine's userData runs identically - the live corpus lives on whichever machine the captain dogfoods on.
Reads are read-only; the export never writes to the app's own files.
`--supervision-sessions` names pre-S7c archives only; its default is `<user-data>/supervision/sessions` for retained historical files.
No supervision directory is required for a current export.

## What it writes

Five files in `--out`:

| file | contents |
|---|---|
| `supervision.jsonl` | one record per `supervision_outcomes` row, with C1 provenance, the `cards` and `tasks` joins, and the label |
| `supervision-turns.jsonl` | G1's pre-S7c archive reader: historical outcomes joined to archived inputs and trajectories (`docs/supervision-extractor.md`); rows without transcripts remain with null input or an explained miss, never invented turns |
| `decisions.jsonl` | R2's provenance rows - every `decided`, `steered` and `interrupted` task event, verbatim (`dataset: "provenance-event"`, with its `event_id`, `task_id`, `actor`, `ref` and parsed `data`), so a reader need not go through `pnpm export:tasks`. Tables only; empty before R2 |
| `dispatch.jsonl` | C5's dispatch records, unchanged (`docs/dispatch-extractor.md`): both seats' first mate sessions, a Claude-served one under `firstmate/claude/` read through the one session reader like a Pi one |
| `manifest.json` | counts, the class/verdict/confidence tallies, the provenance slices, the contract-version tally, the supervision-turn joins and misses (with the `fleet` tripwire warnings), the provenance-event tally, the routing rollup (below), what was excluded as copied session history, the sources, and how the gate opened |

Each JSONL file is written one record at a time and is never built as one string, since a full record's `dispatch.jsonl` outgrows the longest string Node can hold.
The frozen pack's checksum and size per file are taken from the same lines as they are written.

`--human-supervision` is current card evidence, independent of the retired supervision session.
With `--human-supervision` the pack also carries the card evidence view: `human-supervision.jsonl` (one episode per card lifecycle), `human-supervision-labels.jsonl` (empty), the pictures those offers show and their demo recordings under `assets/pictures/`, and a `human_supervision` manifest section with a checksum per file.
That run is staged and renamed into place and refuses a nonempty `--out` (exit 4); without the flag nothing above changes.
`docs/card-evidence.md` "The export" is its one home.

### A supervision record

- **The decision**: `at`, `wake`, `wake_kind`, `observed_verdict`, `summary`, `steered`.
- **`provenance`**: `model` / `prompt_sha` / `tools_sha` from migration 15, plus `versioned` - false for a row written before C1 landed.
  A corpus that cannot be sliced by prompt version is not a usable training corpus, so the manifest tallies `by_model` and `by_prompt_sha` too.
- **`task`** and **`card`**: the `tasks` ⋈ `repos` posture and the card the escalation produced.
  Its descriptive `title` / `body` / `actions` come from the version at the outcome (`description_version`, with an explicit creation fallback when the outcome predates the card); `resolution_actions`, `chosen_effect`, and contact semantics come from the version at `resolved_at` (`resolution_version`).
  Missing versions stay `unknown`, never borrow a nearby shape.
  The join also says who resolved it (`resolved_by`, from the record's actor-labelled timeline), gives a `resolution` of `open` / `acted` / `dismissed` / `retired`, and carries the captain-confirmed duplicate label (`duplicate_of` / `duplicate_note` / `duplicate_at`, migration 25, stamped by `flag_duplicate`; `null` is no label, never a confirmed non-duplicate).
  Dispatch records carry the same three fields on their card joins.
- **`label`**: `gold_verdict`, `weak`, `confidence`, explicit `unknown` / `basis`, the C3 miss fields, and the `evidence` behind it.

The `task` join also carries how the work was routed (intelligence-bucket routing S5): `shape` (the `WorkShape` the host computed at commission, which carries the classifier's own stamp as `kind_source`), `tier` (the slot the policy asked for), `rule` (the policy row that answered, R0-R8, R9 for a reviewer placed away from its builder's provider, or R10 for bounded fact retrieval) and `served` (the slot the ladder actually answered with).
Whether a verdict should have reached the captain is not independent of what the work was taken to be, or of how strong a model was serving it.
Every field is `null` on a row routed before the column that carries it - never a guessed kind and never an assumed serving.

### The routing rollup

`manifest.routing` summarizes the same facts across the whole database: `by_tier`, `by_served`, `by_rule`, `by_kind_source` (the stamp verbatim, e.g. `classifier:xai/grok-4.6`) and `by_kind_source_class` (folded to classified / abstained / failed / skipped / unstamped), plus `escalated_lineages` and `metrics` - the S5 numbers scored by `scripts/interaction-metrics.ts`, the same home the replay gate uses (`docs/replay-harness.md`), so a dogfood export and a replay report never disagree about what a downgrade or an escalated lineage is.
A task without a work shape, or with a recorded null `started_at`, was never dispatched and is left out of the denominator rather than counted as an unknown tier.
A policy edit can give queued work a shape without dispatching it; closed-policy snapshots are outcome history, never routing provenance.
Databases predating `started_at` keep their historical shape-based reading.

### The rigor rollup

`manifest.rigor` is its twin for how carefully the fleet shipped (delivery rigor phase 4): `by_rigor`, `reviews` with `by_verdict` and `by_risk`, `reviewed_changes`, `cap_hits`, `overrides_by_hold` (each override the captain's words declared, counted under each hold kind it passed; `docs/agents-reach.md`), and `metrics` - the phase-4 numbers scored by the same `scripts/interaction-metrics.ts`, so a dogfood export and a replay report cannot disagree about what a review round or a cap hit is.
`docs/delivery-rigor.md` "Numbers" is the one home of what each row counts.
The inputs are records the app already writes: the work shape's `rigor`, the delivery facts (the PR, `ciRounds`, the caps), the `review` and `cap_reset` timeline events, the `note` rows that carry an override, a review task's own recorded report, and the merge cards.
A database older than the tiers exports the same way - its shaped rows read as `quick`, it has no reviews, and every review number is `null` rather than zero.
A task whose deliverable is an ANSWER (Task B) is out of every rigor denominator - it ships nothing, so it can carry no evidence contract, spend no CI round and hit no cap - and is reported by its own share, `deliverable_share_answer`.

### The labels, and which one is gold

- **confirmed** (`weak: false`) - the captain flagged this routine verdict as a missed escalation (`flag_missed_escalation`, C3).
  The one non-weak label in the set, and `gold_verdict` becomes `captain`.
- **corroborated** - an escalation whose card the captain answered with a real action in its resolution-time version, even if the outcome-time version was still a note.
- **contradicted** - an escalation whose card the captain **dismissed** with no action taken.
  A card the host or its emitter *withdrew* (`retired`) is not a dismissal: nobody ever answered it, so it contradicts nothing.
- **observed** - everything else, including every routine row.
  An unflagged routine verdict is **no label**, never a confirmed negative: deriving under-escalation from later trouble is C2's job, deliberately not this export's.

Every record and the manifest go through `redactDeep` (`src/core/observe/redact.ts`) on the way out, so a corpus file can never carry a live key or a system prompt - not in a nested tool argument, not in assistant text, and not in a string this export composed out of two halves.
Redaction is a property of the written output, never a claim about every call site.

## Version fidelity

The manifest tallies `dispatch.by_contract_version` from what each session itself recorded, counting an unstamped turn as `unstamped`.
The version this checkout serves is reported once, separately, as `exporter_contract_version`.
A historical input is never re-badged as current - that would date the corpus to the export rather than to the evidence.

## Copied session history

`dispatch.excluded` reports what was left out and why: `backup_copies` (files carrying a session id another file already carried - the sessions directory copied, restored or synced twice) with the `backup_records` they would have double-counted, and `copied_entries` (entries a forked session carries verbatim from its parent).
See `docs/dispatch-extractor.md`.

## Tests

`tests/export-corpus-corrections.test.ts` drives this **real CLI** over a fixture userData written in today's host shapes and asserts on the exported files: operational turns stay operational, a captain turn that carried wakes keeps both halves, the current decision joins its work, a settle effect is not a steer, a withdrawal is not a dismissal, a card-shape class stays explicitly unknown, backup copies are excluded, history keeps its own contract version, and no planted credential survives in any field.

`tests/export-corpus.test.ts` builds a fixture userData with the app's **own** migrations and stores (`openDatabase`, `TaskStore`, `CardStore`, `DecisionStore`) plus a fixture Pi JSONL, and proves the gate both ways: a packaged build with the flag unset (or set to anything but exactly `1`) exports nothing and creates no directory, and an unpackaged build - or a packaged one with `INFINITARY_DEV_OBSERVE=1` - writes the expected JSONL.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- The corpus export (PoC-2 capture C4, `scripts/export-corpus.ts`, `docs/corpus-export.md`) is the one command that packages the capture for an eval/training run: `supervision_outcomes` (C1 provenance + C3's confirmed-miss label) joined to `cards`/`tasks` (with WI-14's duplicate label), plus C5's dispatch records - it CALLS the C5 extractor, never re-implements it - and, the same way, G1's `supervision-turns.jsonl` (`scripts/extract-supervision-turns.ts`, `docs/supervision-extractor.md`: a pre-S7c archive reader only, joining historical inputs by R2 decision id, else by `(task_id, wake, at)`, retaining rows without transcripts and explaining misses, with a `task_id='fleet'` warning for the historical taskless-wake coverage gap) and R2's `decided`/`steered`/`interrupted` rows verbatim as `decisions.jsonl`.
  `redactDeep` blanks any key ending in `session`, so a record never names a field `session`.
  It reuses Observe's development gate verbatim (`isDevObserveEnabled`), checked BEFORE any file is read, because it moves transcripts; `detectPackaged` stands in for `app.isPackaged` in a script and `INFINITARY_PACKAGED=1` can only tighten it.
  An unflagged routine row is no label, never a confirmed negative - deriving under-escalation is C2's job.
- Offline exporter evidence rules are owned by `docs/dispatch-extractor.md`, `docs/corpus-export.md`, and `docs/miss-deriver.md`; `tests/export-corpus-corrections.test.ts` drives the real CLI over current host shapes and is the binding regression suite.
