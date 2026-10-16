# The dispatch extractor (PoC-2 capture, C5)

An offline dev tool that reconstructs the first mate's own **six-way classify-first orchestrator turns** - the G3 (dispatch class) / G4 (restraint) / G5 (output contract) dataset - from data the app already writes.
No schema change, no product surface, no telemetry, nothing leaves the box.

Design record: `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3 (C5) and Appendix C.2.
PoC-1 had to hand-build a 40-record synthetic dispatch corpus; the captain's ordinary usage produces this one for free.

## Run it

```
pnpm extract:dispatch --out corpus.jsonl
pnpm extract:dispatch --user-data /path/to/exported/userData --out corpus.jsonl
pnpm extract:dispatch --session-file one.jsonl --db firstmate.db
```

`scripts/extract-dispatch-corpus.ts` runs straight through Node 24's type stripping - no build step - which is why its relative import carries an explicit `.ts` and `tsconfig.node.json` sets `allowImportingTsExtensions`.

Every input is a parameter with a sensible default (`--user-data`, `--sessions`, `--claude-sessions`, `--db`, `--session-file`), so an **exported copy** of another machine's userData runs identically.
Nothing hardcodes one machine's path; the default is the platform userData dir, or `INFINITARY_USER_DATA_DIR`.
Reads are read-only: the extractor never writes to the app's own files.

## Sources (do not invent a store)

The same sources of truth Observe uses (`docs/dev-observe.md`):

| Need | Source |
|---|---|
| The orchestrator's turns and every tool call with its **arguments** | Pi session JSONL under `userData/firstmate/sessions/`, plus the rolling file named by `settings.firstmate-session-file`; and a Claude-served seat's sessions under `userData/firstmate/claude/` (W1 S11), each read through the one session reader (below) |
| What a spawn produced, and the repo posture behind it | `tasks` ⋈ `repos` (the task id comes back in `spawn_crewmate`'s own tool result) |
| What the captain did with a card | `cards.resolved_at` + `cards.chosen_action`, read against the card's own `actions_json` |
| Which work a card is about, and who resolved it | `task_events` (`card_raised` / `card_resolved`, actor-labelled), the `cards.task_id` column, the host-filed `decision` record gated on the card id |
| A card revised in place | `card_revisions` (WI-12) |

Observe's parser deliberately drops tool arguments and truncates results, so the extractor reads the raw entries itself and reuses only Observe's redaction - a corpus must never carry a live key or a system prompt.
Because a dispatch record carries **tool arguments**, assistant text and strings this tool composes out of them, redaction is a property of the finished record.
A turn stays raw in memory while card ids, titles, revisions, and task ids are matched; then the one `buildRecord` return boundary applies `redactDeep` (`src/core/observe/redact.ts`) to the complete record.
It walks nested objects, arrays and keys and consumes complete plain, quoted, shell-quoted, and backslash-escaped assignment values.
Redacting each input on its way in would both break lineage and miss a credential assembled by a join.

## The three turn shapes

The host puts three different body shapes in front of the model.
Their visible text all opens with the same `[fm-op] context (not the user)` block.
Current blocks are built as one JavaScript object and serialized in TOON; the extractor decodes that object, while retaining the legacy line parser for old sessions:

| Shape | Text | `kind` |
|---|---|---|
| captain | `<context>` + `[user]` + words | `user` |
| captain carrying pending wakes (the wake diet, WI-13) | `<context>` + `[fm-op]` wakes + `[user]` + words | `mixed` |
| operational drain (`FirstmateAgent.drainInbox`) | `<context>` + `[fm-op]` wakes, no `[user]` line | `op` |

Since R2 the host frames every served input (`src/shared/servedFrame.ts`, `docs/provenance-capture.md`): each segment opens with U+2063 and a `FIRSTMATE_OP: v1 <kind> [<origin>]:` header, so a framed turn is read by its segments alone and exports `kind_basis: "structural-frame"`, with the wakes in `ops`, the context in `context` and the captain's words in `user` - whatever any of them quotes.
Everything below applies only to pre-frame history.

For that history the parser trusts one fact: a host-framed message begins with the context header at byte zero.
Context/wake splits and the captain boundary are inferred from the historical delimiters after that point.
Each unambiguous wake is kept verbatim and in order in `ops` (and joined in `op`); the context block stays in `context`.

The historical frame is not self-delimiting.
A multiline context value and a wake can both begin a paragraph with `[fm-op]`, while a wake can quote a line that looks like `[user]`.
A captain boundary is established only when exactly one candidate carries the host's paragraph join and there are no competing marker candidates.
A wake payload introduced by an open-ended report marker also owns any quoted framing that follows it.
Otherwise the turn remains `op`, no captain input is invented, and the record carries `kind_unknown: true`, `kind_basis: "ambiguous-framing"`, `framing_ambiguity: "user-boundary"`, and the complete redacted source in `framed_text`.
This terminal fallback is the common explicit bucket for framing evidence the historical format cannot settle.
R1 intentionally narrows no further for history; R2's structural framing settles it for every turn served since.

In legacy, pre-frame sessions, `self-source:` normally establishes the context's fixed tail, but the host may append a visible-card line and an `about:` line after it, and both embed arbitrary titles.
If text follows `self-source:`, a later `[fm-op]` candidate can still be context, so it stays verbatim in `context` and is also listed in `ambiguous_wakes`; it does not by itself change `kind`.
The same conservative rule applies to a candidate before `self-source:`.
Such a record carries `kind_unknown: true` and `kind_basis: "ambiguous-context"`.
This is an explicit weak reading of genuinely ambiguous evidence, not an invented wake.
`op` is determined by the absence of an established host `[user]` boundary.
Once that boundary is established, its payload is isolated before wake parsing, so `[fm-op]` text pasted by the captain remains in `user`.

## What a record is

One JSONL object per orchestrator turn, shaped to stay comparable with PoC-1's dispatch corpus and its `run_gates` scoring rows:

- **The turn**: `at`, `kind` (`user` / `op` / `mixed`, above), `model`, `contract` (the `{ version, prompt_sha }` the rolling session recorded before the turn in its `fm-contract` custom entry - written by `src/core/pi/session.ts` from the seat preset's stamp whenever the contract version, the served prompt, the tool set or the captain's served sequences change (the entry's `tools_sha` is not carried into the record); `null` for a turn older than contract v1.1, which is v1; since v4.6 it also carries `instructions_sha`, the sha of the sequences document served after the prompt (`docs/sequences.md`), absent on an older session), `kind_basis`, `kind_unknown`, `framing_ambiguity`, `framed_text`, `ambiguous_wakes`, the `[fm-op] context` block both raw and parsed back into `fleet` (repos with their delivery/autonomy, crew, quota line), the `ops` the turn carried, the captain's `user` words, the assistant text.
- **The dispatch decision**: `names`, `calls` (name + arguments + the tool's reply), `cardKinds` / `cardTitles`, `inferred` (PoC-1's names-only `inferClass`, which leaves `answer-or-ask` ambiguous), `observed_class` (that ambiguity resolved by the card's word: `decision` → ask, `note` → answer; a recorded `kind` is kept verbatim, and a card emitted under the one card shape of cards/tasks/agents P1 is a decision when it has actions), and `classes` for a turn that legitimately composed more than one.
- **G4 restraint** counts: tool calls, consults, spawns, steers, cards, decision cards, note cards.
- **G5 contract**: `doneClose` (a brief non-empty close; empty output is not a close), `turnFailed`, and the raw `emit_card` arguments so an eval can run the real `src/core/pi/cardLint.ts` rather than a copy of it.
- **`outcome`**: the joined `tasks` and `cards` rows.
  A card join carries the work it is about (`task_id` + `task_via`), how the row was reached (`joined_via`), the card's **declared actions** verbatim, the `chosen_effect` those actions give the captain's click, `effect_source` (`declared`, or `legacy-id` when a pre-P1 reserved id had to be interpreted), `captain_contact`, `resolved_by` from the timeline's actor label, `revisions`, `actions_version` (`revision`, `current`, or explicit `unknown`), and a `resolution` of `open` / `acted` / `dismissed` / `retired` / `unknown`.
  Revision title/body/actions are selected at the matched `emit_card` tool-result timestamp, after the store write the result observed; revision titles also participate in the last-resort title join, but only when that title's version actually covers the emit instant; a future card with the same title is never a candidate.
  A task join carries the routing shape beside the task's own columns: `shape` (the `WorkShape` the host routed from - the kind and how it was established, the basis and whether it was verified, the captain's premium ask or model override), `tier` (the slot asked for, `tasks.difficulty`) and `rule` (the policy row that read the shape, from `routing_decisions.rule`) and `served` (the slot the ladder actually answered with, from `routing_decisions.served`, S5 - equal to `tier` when nothing fell back, so a downgrade is a join rather than a regex over the reasons prose).
  That group is the label a kind classification can be scored against; every field is `null` on a task routed before the column that carries it, never a guessed kind or an assumed serving.
  Beside them `rigor` is the delivery rigor the host stamped on the shape (phase 2): `quick`, `standard` or `reviewed`, and `quick` - never `null` - on a row with no shape or a shape from before the rigor existed, because nothing derived one then and the crewmate was told no procedure, so quick is what it shipped at.
  `deliverable` reads the same way (Task B of the crew-posture rationalization): `answer` for work that finds something out and lands one card, `change` for work that ships one - and `change`, never `null`, on a row shaped before the axis existed, which is what it shipped.
  The review facts ride beside it (phase 3): `review_of` (the builder a review task reads, off its shape), `review_verdict` and `review_risk` (the latest verdict recorded on a builder's delivery facts, `tasks.delivery_json`), each `null` where the record carries none - a pre-phase-2 database has no review anywhere and exports every one of them null, never a guessed verdict.
- **`label`**: `gold_class` (the class the first mate actually took, or `null`), `weak: true` always, `unknown`, `basis`, a `confidence` of `corroborated` / `observed` / `contradicted`, and the `evidence` behind it.

## Cards are read by their actions, never by an id

One card shape since cards/tasks/agents P1: an action's `effect` is the only host semantics, and ids are free-form.
So the record reads the card's own `actions_json`, and a reserved-id table would mislabel every current card:

- on a current card, the captain's click names one of the card's declared actions → **acted**, even when its free-form id is `close`; the action's effect says what it did - a `settle` is host-owned teardown, an `open` is shell navigation, and only an action with **no** effect ever reached a crewmate as a steer;
- an unmatched `close` is the current card's captain dismissal (the X control); pre-P1 `keep` / `later` / `dismiss` controls are interpreted as dismissals before historical declared-action matching;
- only an unmatched value is eligible for the withdrawal fallback; an emitter's `close_card`, `duplicate`, `recovered`, or a settled task retiring its cards is **retired**, while a current declared action with one of those free-form ids is still **acted** by its own effect.

The record's own `card_resolved` event is the authority on *who* closed a card and how: `dismissed` is chrome dismissal, `closed` an emitter withdrawal, and a declared action id a choice.
This matters when a current action legally uses the id `close`.
A taskless card has no such event, so the host-filed linked decision record supplies the same evidence through `closed_reason` (`cancelled`, `superseded`, or `answered`) and its close actor.
The host writes an emitter's free-text `close_card` reason straight into `chosen_action`, making the actor and event evidence decisive.
History is still read as history: an id from before P1 is interpreted through the one shared table (`migrateLegacyActions`, the mapping migration 29 ran), the recorded id stays verbatim in `actions`/`chosen_action`, and the derivation is flagged `effect_source: "legacy-id"` rather than being presented as a current card.

## A shape is not an intent

A card with actions *reads* as a decision - that is how the host dresses it, not what the first mate set out to do.
A turn whose class rests on nothing but an emitted card's shape therefore exports with `gold_class: null`, `unknown: true` and `basis: "card-shape"`, with the reason in `evidence`.
Only a turn that exercised a class-bearing tool carries a (still weak) gold class.
`emote` is auxiliary throughout: it changes no card, task or consult state, so it never carries a class and never makes a turn unclassifiable.

## One reader, either seat (W1 S11)

Every first mate session file is opened through `src/core/storage/sessionReader.ts`, the one reader the replay engine, the corpus export, the kind-classifier scorer and dev Observe share.
It tells the dialect from the file's own first line, never from its path: a Pi session opens on its `session` header, and every line the Claude client writes names its session.
A Pi file is handed over exactly as written.
A Claude-served session - the app's copy of the client's transcript and the served sidecar beside it (`docs/provenance-capture.md` section 4) - is handed over in the Pi dialect, so `extractTurnsFromJsonl` reads one shape:

- a `user` line with words is the served prompt, and a `queued_command` attachment is a steer the client folded into the running turn; Pi records both as a user message, so the steer is a turn of its own either way;
- `tool_use` blocks become `toolCall`s without the seat's `mcp__infinitary__` prefix, the client's several lines of one assistant message are one message, and `tool_result` blocks become `toolResult` messages;
- the model rides each assistant message as `anthropic-claude/<id>` (the client writes no model entry of its own);
- the contract comes from the sidecar as an `fm-contract` entry.
  The client writes its transcript late, so the join is by the uuid the seat gave each message, kept in the sidecar's `served` stamps; a turn no stamp names takes the contract stamped last before it.

A sidecar (`<sessionId>.served.jsonl`) is never read as a session of its own.

## Copied session history

Pi sessions are append-only trees, and both `SessionManager.fork` and a branch copy the parent's entries **verbatim, ids included**.
A sessions directory also tends to accumulate backup copies of itself.
Two mechanisms, reported separately:

- **backup copies**: two files carrying the same session header `id` are the same session twice.
  The most complete one is read; every other copy is listed in `backupCopies` with the turns it would have double-counted in `backupRecordsExcluded`.
- **copied entries**: an entry id already read is history, not a second turn (`copiedEntriesExcluded`).

## Version fidelity

A turn is exported at the contract version its own session recorded, and an unstamped turn stays unstamped (`contract: null`).
The version this checkout serves is reported once, separately, as the export's `exporter_contract_version` - never stamped onto a historical turn.

## The labels are weak, on purpose

Real usage has no gold annotator, so the label is what the first mate did, corroborated - or not - by what the tables say happened:

- **corroborated**: every task the turn named exists, and/or a decision card was answered with a real action.
- **contradicted**: a `steer_crewmate` / `settle_task` / `spawn_crewmate` named a task with no row, or a decision card was dismissed with no action taken.
- **observed**: everything else, including every record extracted with no database.
  An absent join is absent evidence, never counter-evidence.

A dismissed **note** card is not a contradiction - notes are dismissed by definition.
Confirming these weak labels in bulk (the PoC-0 flagship-judge pass) is downstream work, not this extractor's.

## Tests

`tests/export-corpus-corrections.test.ts` drives the **real export CLI** over a fixture userData in today's host shapes and asserts on the exported files: op turns stay ops, a mixed turn keeps both halves, the current decision joins its work, a settle effect is not a steer, a card-shape class stays explicitly unknown, the backup copies are excluded, history keeps its own contract version, and no planted credential survives in any field.

`tests/extract-dispatch-corpus.test.ts` builds a fixture userData with the app's **own** migrations and stores (`openDatabase`, `TaskStore`, `CardStore`) plus a fixture Pi JSONL covering all six classes, an `[fm-op]` wake, a failed provider turn, a live-key redaction, and a trailing partial write.
The schema under test is the real one; only the rows are fixtures.
Its classification cases hold the action catalog: `app_change` is operate, `app_state` alone a read, and a `configure_repo` recorded before the catalog replaced it is still operate.
They hold the captain's labels and a panel from elsewhere too: `flag_missed_escalation`, `flag_duplicate` and `install_plugin` are each operate.
`record_knowledge` is operate as well, `knowledge` alone a read, and every tool the first mate holds today has a class, so none of its turns exports as `other`.
A new first mate tool joins one of the class sets in `scripts/extract-dispatch-corpus.ts` in the change that adds it, or its turns export as `other`; that test reads `FIRSTMATE_TOOLS` and fails on a tool with no class.
The replay engine keeps its own tool sets, which the same change updates (`docs/replay-harness.md`, "What it replays").

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The dispatch extractor (PoC-2 capture C5, `scripts/extract-dispatch-corpus.ts`, `docs/dispatch-extractor.md`) is an OFFLINE dev tool over data the app already writes: Pi session JSONL joined to `tasks`/`repos`/`cards`, emitting the six-way classify-first turns as a weakly-labelled JSONL corpus, each stamped with the contract `{ version, prompt_sha }` the rolling session recorded (`fm-contract` custom entry, null = v1 and stays null - a historical input is never re-badged with the version this checkout serves, which the manifest reports separately as `exporter_contract_version`).
  No schema change, no product surface, nothing leaves the box.
  Its inputs are all parameters (`--user-data`/`--sessions`/`--db`) so another machine's exported userData runs identically.
  C2, C4, C5 and G1 are the `scripts/*.ts` files: Node 24 type-strips them with no build step, which is why their relative imports carry an explicit `.ts` and `tsconfig.node.json` sets `allowImportingTsExtensions`.
