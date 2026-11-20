# The supervision-turn extractor: pre-S7c archives only

`pnpm extract:supervision` is an offline reader of **pre-S7c exports only**, not a source of current model turns.
The app no longer writes `userData/supervision/sessions/`; the whose-turn rule sorts reports without a model session (`docs/report-sort.md`).
The reader stays available for archived transcripts and databases, including the committed replay fixtures.
It joins historical **decisions** (`supervision_outcomes`) to their **inputs and trajectories**: the served wake and context, `crew_status` and its result, and the assistant text.
No schema change, no product surface, no inference, nothing leaves the box.

Current whose-turn outcomes still appear in the `supervision_outcomes` compatibility view with `model = "rule:<id>"`, but have no model transcript.
The reader does not drop rows from a mixed database: a decision with no served input keeps `transcript` and `served` null, and an unmatched row carries a miss reason.
For example, a row with no session coverage reports `outside-session-coverage`; `session-entry-missing` means a decision named an entry the archive does not contain.
A missing transcript is never reconstructed or treated as a new supervision session.

## Run it

```
pnpm extract:supervision --user-data /path/to/pre-S7c/userData --out turns.jsonl
pnpm export:corpus --user-data /path/to/pre-S7c/userData --out ./corpus
```

Every input is a parameter: `--user-data`, `--supervision-sessions` (default `<user-data>/supervision/sessions`), `--db` (default `<user-data>/firstmate.db`), `--session-file` (repeatable, overrides the directory).
The historical rolling-session pointer in `settings` (`supervision-session-file`) is read too, even when it sits outside the sessions directory.
The default userData path remains supported for retained archives, not for collecting new supervision turns.
An exported copy of another machine's userData runs identically.
`export:corpus` uses this same archive reader for `supervision-turns.jsonl`, while its `supervision.jsonl` also contains current rule outcomes (`docs/corpus-export.md`).
Replay's `--supervision` option preserves these archives only when exporting a fixture; it never replays them (`docs/replay-harness.md`).

## The gate and redaction

It moves transcripts, so it uses Observe's development gate (`isDevObserveEnabled` in `src/core/observe/gate.ts`, `docs/dev-observe.md` "Hard gate") exactly as C4 does, checked **before a single file is read**: an unpackaged build, or `INFINITARY_DEV_OBSERVE=1`.
A blocked run reads nothing and exits 3.
Every record goes through `redactDeep` as a whole on the way out, so a key in a nested tool result or an argument never survives.

Because `redactDeep` treats any key ending in `session` as a credential, the record names the transcript location `transcript` (with the Pi header id as `header_id`), never `session`.

## The join

One record per triage turn.
Every record says what its join rests on (`join_basis`), strongest first:

| `join_basis` | Rule |
|---|---|
| `decision-id` | A `decided` task event whose `producer.role` is `supervision` (R2). `disposition.outcomeId` joins the outcome row, `served.prompt.entryId` the session entry (preferring the file whose name matches `served.sessionFile`, so a path recorded on another machine still joins), and `disposition.toolCalls[].id` the calls and their results. A host-sorted repeat joins its row with `transcript` and `served` null: no model was served. |
| `text-exact` | History before R2 has no decision record. An outcome row joins the unclaimed served turn with the same **task** (the context segment's `[context] task <id>` or the `report_outcome` call's `task_id`), the same **wake payload** (the served `[wake] ` line is the row's `wake` column verbatim), at its **time** (the row's `at` inside the turn's first and last entry timestamps, ±`TURN_TIME_SLACK_MS`). A `report_outcome` call matching the row's verdict and summary breaks ties. |
| `text-prefix` | The same join for either known historical truncation shape: a stored `capWithOverflow` marker whose head prefixes the served wake, or the legacy 160-character excerpt exercised by `fleet-captain-only`. Other shorter prefixes do not match. |
| `unjoined` | Nothing joined. `miss.reason` says why. |

Nothing is dropped: every outcome row and every served turn yields a record, so "all turns joined or each miss explained" is a property of the output.
Backup copies of a session (the same header id twice) are excluded like C5 does (`splitBackupCopies`), and a fork's copied entries are read once.

Miss reasons:

| Reason | Applies to | Meaning |
|---|---|---|
| `outside-session-coverage` | row | no session read covers the row's time (a trimmed or missing transcript) |
| `wake-served-at-another-time` | row | the wake was served on the task, but not at this row's time |
| `no-matching-turn` | row | no served turn carries this wake on this task |
| `outcome-row-missing` | decision | the record names an outcome id this database does not hold |
| `served-entry-unlocated` | decision | the decision recorded no session entry (the turn failed before it reached the tree) |
| `session-entry-missing` | decision | the named entry is in no session read |
| `not-a-wake` | turn | the served text has no wake shape |
| `turn-failed` / `unreported` | turn | the turn failed, or ended clean without `report_outcome` (handed to the first mate) |
| `report-refused` | turn | `report_outcome` was refused, so no row exists |
| `no-outcome-row` | turn | reported, but no row matches `(task_id, wake, at)` |

The summary (stderr) and C4's `manifest.json` (`supervision_turns`) tally joins, misses, unjoined rows and unjoined turns.

## The taskless-wake tripwire

A historical taskless supervision wake touches no task, so no `decided` event can anchor it.
Its outcome uses `task_id = 'fleet'`.
Every `fleet` outcome row raises a **warning** (stderr, and `manifest.supervision_turns.warnings`) to identify this archive coverage gap, not to request new live capture.

## A record

- **Identity and join**: `id` (`decision:<id>`, `outcome#<n>` or `turn:<entry>`), `join_basis`, `miss`.
- **The decision**: `outcome_id`, `task_id`, `verdict`, `summary`, `wake_kind`; `decision` (R2 only: id, actor, trigger, outcome, inbox fate, `handoff_inbox_id`, account, thinking level, `text_sha_matches` - whether the recorded fingerprint matches the session entry - and `unmatched_tool_call_ids`).
- **The input**: `transcript` (file, header id, entry and parent entry ids) and `served`: typed `segments` with a `frame_basis`:
  - `structural-frame` - an R2 framed input, split by its own marks, preserving each segment's typed `origin` when present;
  - `reframed-exact` - pre-frame history split where the joined row's stored wake ends: the host wrote `[wake] <payload>\n\n<context>`, so the boundary is known even when a report quotes `[context]`;
  - `reframed-marker` - split at the first `\n\n[context] ` (no exact row to locate it; a quoting wake would move it);
  - null - no wake shape, the raw `text` is kept instead.
    Historical reframed segments have no `origin` because none was recorded.
    `text_sha256` fingerprints the served text.
- **The trajectory**: `crew_status` (each call's id, args and result), `report_outcome` (the call that filed this row), `other_tool_calls` (`steer_crewmate`, `tasks`, extra reports), `assistant`, `turn_failed`, `error`, `model`.
- **Provenance**: `contract` `{version, prompt_sha, tools_sha}` and `prefix_message_count` from the R2 decision - **null before R2, never re-badged** with the version this checkout serves; `row_provenance` is the outcome row's own migration-15 stamp, verbatim (its `tools_sha` is over tool names only, a different thing).
- **The label**: C3's `missed_escalation` / `missed_note` / `missed_at`, verbatim.
  Null is no label, never a confirmed negative.
- **Timestamps**: `served_at`, `ended_at`, `outcome_at`, `decision_started_at`, `decision_ended_at`.

## Tests

`tests/extract-supervision-turns.test.ts` drives the **real CLI**:

- over the replay fixtures' independently authored historical-format supervision sessions with their outcome rows loaded into a database built by the app's own migrations - `fleet-mixed` joins 174 of 174 turns `text-exact` with the served wake equal to the stored payload; `fleet-captain-only`'s excerpted stored wakes join 18 of 18 as `text-prefix`; the reconstructions' turns, which have no outcome table, are each explained `no-outcome-row`;
- over a synthetic archive built with current migrations and stores: a historical framed session, the `decided` record written through `TaskService.turns.recordDecision`, and the settings row written through `SettingsStore` - the framed turn joins by id with the served fingerprint matching, a pre-R2 turn whose wake quotes `[context]` reframes exactly, a host-sorted repeat joins by id with no transcript, every other row and turn carries its miss reason, a backup copy is excluded, a planted key is redacted, the `fleet` row warns, and a shut gate reads nothing;
- through C4, which writes the records as `supervision-turns.jsonl` beside `supervision.jsonl`;
- over a current rule outcome with no supervision directory: both exports retain the row without inventing a transcript.
