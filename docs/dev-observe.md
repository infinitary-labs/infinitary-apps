# Dev observe

Development observability for Infinitary, in development and alpha builds.
The captain uses this to watch every agent session live: transcript, token usage, and enough structure to see how the orchestrator loop is working, what went wrong, and where to optimize.

This document is the information architecture.
The implementation must follow it.
It is a dev-only doc; it is not user-facing.

## Why this exists

The product UI is cards-not-chat.
That is correct for the captain's day-to-day work and wrong for debugging the agent loop.
When a turn fails, an auth token dies, a crewmate burns unexpected tokens, or the first mate spawns the wrong work, the cards do not show the transcript that caused it.

Observe is the missing pane: a structured view over the session logs the app already writes.

## Hard gate

Observe is impossible to ship as a user-facing feature of a stable release.

Enabled when any of:

- Electron `app.isPackaged === false` (source / `electron-vite` / unpackaged e2e),
- the running build is an alpha (captain, 2026-10-09: "i'd like to enable the "observe" tab in alpha builds"), or
- `INFINITARY_DEV_OBSERVE=1` (explicit local override, including a packaged stable build you are debugging on this machine).

One predicate decides it, `isObserveEnabled` (`src/core/observe/gate.ts`).
It reads the running build's own version, never the update channel it follows: a packaged build is an alpha only when the logical version it reports is exactly `X.Y.Z-alpha.N` (`isAlphaVersion`), and any other version, malformed or unknown included, counts as stable.
Never a Settings toggle, never a persisted flag, never a default-on stable path.
A user who never sets the env var and runs a notarized stable build must not see the tab, must not get the IPC, and must not leak transcripts off-box.
`tests/e2e/observe-gate.spec.ts` holds both sides through emulated installed builds: an alpha offers the tab and answers its reads, and a stable build offers no tab and refuses them.

The offline transcript tools (`docs/corpus-export.md`, `docs/replay-harness.md`, `docs/supervision-extractor.md`, `docs/kind-classifier.md`) reuse only the gate's development half, `isDevObserveEnabled`: an unpackaged build, or `INFINITARY_DEV_OBSERVE=1`.
They have no running build's version to read, so an alpha does not open them.

The renderer asks main `inf:observe:enabled` and only then paints the tab.
Main handlers for list/detail/live throw if the gate is off.
The preload still exposes the methods (the frozen API is one shape); the gate is the handler.

## Implementation (phase 1 of the UI plugin system)

Observe is the app's first Tier-2 contribution (`docs/ui-plugins.md`): a template in a sandboxed frame the shell serves, not a React tab.
The pane is `src/renderer/src/plugins/builtin/observe/observe.html` (markup and its own stylesheet, tokens only) plus `observe.frame.js` (the frame script, checked as JavaScript against the bridge's types), and it reads through the read catalog alone: `observe.sessions` (polled every 2s and on fleet events), `observe.session` (the selected id), and `observe.live` (the selected session's in-flight turn, which the core now holds in `src/core/observe/liveBuffer.ts` - so a pane opened mid-turn sees the stream).
Selecting a row is a resubscription with a new id, never an action.
The e2e (`tests/e2e/dev-observe.spec.ts`) drives it through `iframe[title="Observe"]`.

Hidden windows stay hidden: `INFINITARY_USER_DATA_DIR` already suppresses `BrowserWindow.show()`.
Observe adds no extra window.

## Sources of truth (do not invent a store)

| Need | Source |
|---|---|
| Main (orchestrator) transcript | The attached seat's session file: Pi JSONL at `settings.firstmate-session-file` under `userData/firstmate/sessions/`, or, while the Claude seat serves, the app's copy of its transcript under `userData/firstmate/claude/` (W1 S11). The one session reader (`src/core/storage/sessionReader.ts`) tells the two apart by the file's first line; a Claude-served session is read by the same parser as a Claude crewmate's, and the row's backend chip says which seat wrote it |
| Pi crewmate transcript | Pi JSONL at `task_execution.session_file` (`userData/crewmates/<taskId>/sessions/`) |
| Claude crewmate transcript | The app's copy of the client's transcript, `userData/crewmates/<taskId>/sessions/<task_execution.session_file>.jsonl` (the session contract's step 6); before the first copy lands, and while it holds a turn's tail the copy has not caught up with, the JSONL Claude's own client writes: `<account store>/projects/<encoded cwd>/<task_execution.session_file>.jsonl` (`src/core/observe/transcriptSource.ts` picks; `src/core/claude/claudeTranscript.ts` locates the client's; `src/core/observe/claudeTranscript.ts` reads either) |
| Task / repo / status / start | `tasks` row (already the crew registry) |
| Token usage (input / output / cache / cost) | `usage_events` aggregated by `task_id` |
| Live stream | Existing `inf:event` union, with first mate Pi events fanned out under `taskId: "firstmate"` |
| Card threads (cards-as-threads phase 2) | `card_messages` via `CardService.observeThreads`: open cards on this session that already have a message. Detail only, never the list. The first mate session = firstmate-authored cards; a crewmate session = that task's |

`usage_events.task_id` is `"firstmate"` for the orchestrator's own burn and `"supervision"` for the retired supervision session's (both already recorded that way).
Crewmate rows use the task id.
The retired supervision session is not listed or selectable in Observe, even with a stored pointer or kept file.
Its files, setting, usage history, deterministic outcome ledger and offline export paths are preserved; removing its presentation deletes no evidence.

`task_execution.session_file` is the backend's opaque resume token, not always a path: a Pi JSONL path for Pi crewmates, the minted session id for Claude.
`src/core/observe/transcriptSource.ts` resolves a local row to a readable file by the backend of the account it ran on; treating the column as a path rendered every non-Pi crewmate as a blank pane (captain report, 2026-09-05).
For a task on another computer, it locates this Mac's copied record and reads its dialect with `sessionDialectAt`, the same first-line reader the task's Activity uses.
That computer's account is not registered on this Mac, so a missing account id never decides which parser reads the copy.

No second JSONL, no extra SQLite table, no hosted backend, no Umami events that carry transcripts (telemetry stays coarse; D-12).

## Information architecture

Home: the **Observe** tab on the Settings screen, beside General, Appearance, Projects and Intelligence (`settingsSections` in `src/renderer/src/plugins/builtin/manifest.ts`; the subscriptions section's label is Intelligence).
Settings is already a shell state, not a route.
The tab is omitted entirely when the gate is off.

### Layout

Two panes, one job.

```
┌ Observe ────────────────────────────────────────────────────┐
│ Development and alpha builds only. Transcripts stay local.  │
├──────────────────────┬──────────────────────────────────────┤
│ MAIN                 │ First mate  [main] [streaming]       │
│  [main] ● streaming  │ The first mate you talk to. Captain  │
│  First mate          │ turns, cards, spawns, and            │
│  The first mate you  │ escalations land here.               │
│  talk to…            │ xai/grok-4.6 · 12.4k in              │
│ ──────────────────── │                                      │
│                      │ 12:04:01  context                    │
│                      │           repos: infinitary          │
│                      │ 12:04:01  you                        │
│                      │           look at the quota burn     │
│                      │ 12:04:03  spawn_crewmate             │
│                      │ 12:04:11  assistant                  │
│ CREW                 │           commissioned ab12.         │
│  ○ failed [claude]   │ 12:04:11  in 1.2k · out 80 · cache 0 │
│    flaky test        │                                      │
│  ○ idle [pi]         │                                      │
│    readme            │                                      │
└──────────────────────┴──────────────────────────────────────┘
```

- **List (left, ~280px).**
  Groups in order, each separated by a rule: `MAIN` (the first mate session), `CREW` (crewmates, newest first), `REVIEW` (reviewers), and `PANELS` (personal mounts).
  Empty groups are omitted.
  Main carries an accent kind chip and a one-line role description.
  Crewmate rows carry a mono backend chip (`pi` / `claude`).
  One row per session / task.
  No raw JSONL dump, no nested tree of every JSONL entry type.
- **Panels are not sessions.**
  A personal panel (`docs/personal-panels.md`) has no transcript and no turns, so `PANELS` lists MOUNTS: one non-selectable row each, carrying the panel's state (on a rail / waiting on its data / refused), its rail, its compiled version, what its `server.ts` exported, the reads it declared, and the compiler's message when one refused.
  When the host-owned switch has the captain's panels off the group says so, with the reason and where the switch is - an empty group and no group at all would read the same.
  It rides `personal.mounts` (the snapshot the core already pushes) and `shell.preferences`; no new channel, no new store.
- **Detail (right, the rest).**
  The selected session's timeline plus a sticky header of identity and totals; the header repeats the kind chip and, for Main, the role description.
  Empty state: "Select a session."
  A selected session is never a blank pane: when no transcript can be read the pane says why (`transcriptNote` - no session yet, Claude has not written the file yet, the account was removed or its provider is no longer offered, the file is gone) and shows the brief from the task row; a transcript with no turns yet says "No turns recorded yet."

The Settings column is the Intelligence wide shell (up to 1080px, including side padding) on every tab, including Observe, so the split is readable.
Its width cap includes both side gutters and fits the scroll region at the app's minimum window width, including when a vertical scrollbar takes space.

### Session row (scan)

Each row, in order of visual weight:

1. Status badge (dot + label).
   Failures and auth problems use `--danger`.
2. Title: "First mate" or the task title.
3. Identity line, mono: task id · repo name or `default workspace` · model.
4. Recorded usage, mono: known token sums with per-category coverage, estimated dollars with pricing coverage, and usage record count.
5. Start clock (`hh:mm:ss`).
   End clock when the task is terminal.

Statuses: `streaming` (running), `idle`, `done` (a closed `done` record whose session is kept), `failed`, `cancelled` (dropped), `interrupted`, `no session` (the first mate has not opened a JSONL yet).

Auth failures get an extra `auth` badge.
A failed row is visually hotter than an idle one so the eye lands there first.
The badge means "this session's latest provider-reported error is an auth failure": it is classified only from real auth signal (`src/shared/authFailure.ts` - a 401/403 status, a provider auth error code, Pi's pre-flight credential text; for a Claude transcript, only the typed `error` the client writes beside its words), never from tool errors or substrings of free-form text, and a later completed turn clears it.

### Detail pane (read)

Sticky header:

- Kind: main vs crewmate (with the backend for a crewmate)
- Status badge (same as the row)
- Session model `provider/id`, from the live seat or saved transcript rather than a latest ledger row.
- Task id
- Repo
- Start / end
- Recorded totals from `usage_events`: input, output, cache read, cache write, and estimated cost.
  Both the list and header call ledger rows usage records, never conversation turns; a Claude completion can write several model records and supporting calls belong to the same task.
  Each token category shows Not available when no record reports it, a known zero when reported, and its reporting count when coverage is partial.
  Estimated cost sums only positive saved estimates, just like Usage; historical zeros and missing prices are unpriced, not free.
  Pricing coverage counts records, not the share of dollars, and cannot detect usage that was never recorded.
  The header separates the session model from recorded usage by model, with each provider/model's own sums and coverage.
  Provider-reported, requested and historical model labels remain distinct; historical labels may combine models and are never reconstructed.
  With no readable transcript, only a single recorded model can supply a fallback session label; mixed ledger models never choose one by timestamp.
  The published legacy `usage.turns` field remains a record count for older clients; new readers use the additive `records`, `reported`, `priced` and `models` facts.
- Open card threads on this session (`threads` on the detail, one line per card: title, message count, who wrote last).
  Empty threads are omitted.
- For a crewmate, how the work was routed (intelligence-bucket routing S5): the policy rule that chose the slot (`rule R5`), the tier it asked for (`tier high`), the tier the ladder actually served when that differs (`served medium`), and the kind with the stamp that established it (`fix (classifier:xai/grok-4.6)`).
  The tier is COMPUTED from the work's shape, so the model alone never says why a session is running where it is.
  Absent facts are simply not rendered - Observe invents no tier - and the main session carries none, because it is not routed by the policy.
  Beside them what the task DELIVERS (`delivers answer`, Task B of the crew-posture rationalization - an answer task ships nothing and its card is the deliverable) and the delivery rigor (delivery rigor phase 3): the tier the host derived (`rigor reviewed`), a builder's latest review verdict with its risk (`review pass · risk low`), and on a review task the builder it reads (`reviews Fix the meter test`; its rule is `R9`, the reviewer placement).
  This is the only surface in the app that renders a rule, a classifier, a deliverable, or a rigor as recorded; the one user-facing echo is the crewmate summary's readout, which shows the served level and says the routing decision in the captain's words (`docs/routing.md` "Why this model").

The list's **Review** group (delivery rigor phase 4): a review task is a crewmate session, but it reads a change instead of making one and its row answers a different question, so the reviewers sit together with each row carrying its verdict and the change it read (`findings · risk medium · reviews Ship the meter fix`), or `awaiting verdict` while none is back - never a blank, which would read as a row that failed to load.
The verdict lives on the BUILDER's delivery facts, and a review task reads it only while that builder still names it, so a superseded review never claims a later verdict.
The fleet-wide counts over the same records are `docs/delivery-rigor.md` "Numbers", not a surface.

Timeline, newest at the bottom (reading order of the loop):

| Kind | How it looks | Why |
|---|---|---|
| Context | muted, compact `[fm-op] context` block | See what the first mate thought the fleet/repos/quota were |
| You | primary text after `[user]` | The captain's actual turn, not the wrapper |
| Op | muted operational `[fm-op]` inbox line | Crew reports, failures, card answers coming back |
| Assistant | secondary text | The model's visible reply |
| Tool | mono name; danger if `isError` | spawn / steer / bash / compact / retry |
| Usage | mono chip after a turn | Per-turn burn, next to the totals in the header |
| Error | danger banner, not a buried line | Auth and provider failures must be obvious |
| Streaming | last assistant/tool row updates live | Deltas before JSONL has committed the message |

Thinking deltas are omitted.
They add noise without explaining the loop.

Very long tool output is truncated (8k characters) with a count of omitted characters.
Images and binary blobs are dropped.

### Seeing the loop

A first mate user JSONL message is one Pi user turn.
Current sessions carry the structural served-input frame owned by `docs/provenance-capture.md`; Observe splits its `context`, `user`, and `wake` segments rather than inferring speakers from text they may quote.
Pre-frame history keeps the legacy parser.
Context (repos, crew, quota) renders as a muted context row, every `user` segment as the captain's turn, and every `wake` segment (crew report, interruption, failure) as an op row.
Context alone never becomes an op row.

That split is the point of the pane: you can watch "captain spoke → the first mate spawned → crewmate reported → the first mate noted" without grepping JSONL.

Crewmate sessions are simpler: the brief is the first user message, then tools and the report.
A Claude crewmate reads the same way from Claude's own JSONL (one line per content block; usage is shown once per message).

S7c replaced the supervision session with the whose-turn rule in the host (`docs/report-sort.md`).
A report now reaches MAIN in its own words; there is no supervision session to observe.

Reading cost: `ObserveService.read` reads files asynchronously, with one serialized read per session, so list and detail cannot race cache replacements.
List reads use the same Pi and Claude parsers in summary mode: model, times and redacted errors retain their meaning without materializing or redacting unrelated conversation bodies.
Only detail reads materialize turns; a full detail cache supplies subsequent list summaries too, and selecting a summary-only session upgrades its cache.
Both parsers yield between batches of 64 Ki characters, letting input run during long reads rather than processing every file in one uninterrupted main-thread task.
The task's brief is parsed only for an unreadable selected transcript, never for every list row.
An unchanged file is stat'd asynchronously, not read or parsed again.
Path, mtime, ctime, size, inode and parser identify a cache entry; append, truncation, replacement and rotation invalidate it.
Missing/unreadable files evict rather than cache a failure.
The cache retains at most one parsed result per listed session, with no turns in summary-only entries.
Changed files still receive a complete read, and a selected history still arrives in full; batching does not truncate history or change redaction.
Closed records and their JSONL remain readable after the worktree is gone (D2).

Rendering cost: the frame keeps both scrollers and uses measured, variable-height windows for transcript and session rows, including Review.
Only the viewport and one viewport of overscan mount; all data still arrives through the existing reads.
Unchanged pushes do not rebuild DOM.
Changed rows are keyed, live rows update separately from recorded rows, and the visible row plus its pixel offset anchors history across measurements, resizes and prepends.
Streaming follows the bottom only while the reader is there; changing sessions resets to the new session's bottom.
Arrow keys, Home and End reach offscreen sessions; Enter selects.
Browser find and cross-window text selection only cover mounted rows, not the full history.
`tests/e2e/observe-windowing.spec.ts` exercises 6,581 turns and 280 crew records through the built app; `observe-frame.spec.ts` exercises live updates, resize, compaction, focus and selection through the real frame program in Chromium.

## Live vs historical

- Opening a session reads JSONL + `usage_events` (historical, authoritative).
- While the tab is open, the core's live buffer (fed by `assistant_delta`, `tool_start` / `tool_end`) is re-read for the selected session on each of those events and pushed into the frame, and the list refreshes on task lifecycle / first mate busy / turn end.
- On `turn_end` (or `turn_failed`), the buffer clears and detail reloads from JSONL, so the live rows cannot drift from the file.

The first mate's Pi session events were previously consumed only for burn tracking.
Observe requires those events to be fanned out as `FmEvent`s with `taskId: "firstmate"` so the orchestrator is as watchable as a crewmate.
The home activity feed already ignores `assistant_delta` / `tool_*` / `turn_end`; this fan-out must not change cards, routing, or the locked orchestrator loop.

## Redaction

The pane is for the captain on this machine, not for paste-into-chat.

Never render:

- Provider API keys, bearer tokens, PEM private keys, `Authorization` headers
- The first mate or crewmate **system prompt** (ResourceLoader; if a JSONL line nevertheless contains it, replace the line with `[system prompt redacted]`)

Do render:

- User text, `[fm-op]` context, tool names, assistant text, usage, errors
- Repo names and task titles (local-dev, already on disk)

Redaction runs in main before IPC.
The renderer must not be handed raw key material "to be careful with".

## Visual system

Use the design skill.
Tokens only (`--bg-*`, `--fg-*`, `--accent`, `--danger`, `--font-mono`, `--text-xs` labels with `--tracking-label`).
Sentence case.
Uppercase micro-labels (`MAIN`, `CREW`, `REVIEW`, `STREAMING`).
The retired supervision session has no presentation here or in the product UI.
Mono for ids, models, tokens, clocks.
No emoji.
No second chromatic family.
Failures are the one hot thing on the screen (`--danger` / `--warn`).
Motion is a status dot, not a spinner on every row.

## Out of scope

- Changing the orchestrator loop, tool surface, or character animation
- A hosted debug backend, log drain, or extra session store
- Shipping the tab behind a user-visible setting
- Showing thinking tokens, raw Pi event JSON, or the full system prompt
- A second window

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Observe (Settings → Observe) is gated on `app.isPackaged === false`, an alpha version, or `INFINITARY_DEV_OBSERVE=1`, never a user-facing setting.
  It reads existing session JSONL + `usage_events`; see `docs/dev-observe.md`.
  It groups Main, Crew, Review and personal panel MOUNTS (not sessions).
  The retired supervision session is neither listed nor selectable; its historical files and deterministic outcome ledger are untouched.
  Transcript and session rows are windowed in the existing Tier-2 frame with persistent scrollers, measured heights and reading anchors; unchanged pushes leave DOM alone.
  `ObserveService.read` caches unchanged main and crew files, uses metadata-only list reads, and yields during parsing; see `tests/e2e/observe-windowing.spec.ts` and `observe-frame.spec.ts`.
  `task_execution.session_file` is the backend's resume token, not always a path: `src/core/observe/transcriptSource.ts` resolves it per backend (Claude's is the app's copy under the task's `sessions/`, else the client's own JSONL in `~/.claude`, `src/core/claude/claudeTranscript.ts`), and a selected session is never a blank pane - `transcriptNote` says why when nothing can be read.
