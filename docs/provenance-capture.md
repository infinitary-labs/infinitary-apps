# Prospective provenance capture (R2)

R2 of the captain-authorized model-training plan: while the app is used normally, the task record captures what an offline reader would otherwise have to reconstruct.
It is the write side; the offline exporters (`docs/dispatch-extractor.md`, `docs/corpus-export.md`, `docs/miss-deriver.md`) are the read side.
Local only, no training, nothing leaves the box.

There is no new table, service, queue or collector.
Everything rides the existing task record through the one task writer (`TaskService`), with the existing actor labels, plus one emission convention for what the host serves a model.

## 1. The served-input frame (a live emission contract)

`src/shared/servedFrame.ts` owns it.
Every input the host serves the first mate (and, ) is a list of typed segments, each opening with the first mate's canonical operational marker - U+2063 (INVISIBLE SEPARATOR) and `FIRSTMATE_OP: ` - followed by `v1 <kind> [<origin>]: `, joined by one blank line:

```
⁣FIRSTMATE_OP: v1 context: [fm-op] context (not the user)
repos[1]{name,repo_id,path,...}:
  ...

⁣FIRSTMATE_OP: v1 wake crewmate-report: [fm-op] crewmate 1 reported on task 3f2a...: ...

⁣FIRSTMATE_OP: v1 user captain: [user]
ship it
```

(`⁣` above is the invisible U+2063.)

- Kinds: `context` (the host's context block), `wake` (one operational inbox row), `user` (the captain's words).
  Supervision serves `wake` then `context`.
- The mark is removed from every segment body before framing, so the only U+2063 characters in a served input are boundaries the host wrote.
  Pasted or quoted text - a crewmate report quoting `[user]`, a captain pasting a header - can never open a segment.
  A reader splits on the mark, never on `[fm-op]` or `[user]`.
- Bodies keep the labels the prompts already speak of (`[fm-op]`, `[user]`, `[wake]`, `[context]`).
  The header is the boundary; the label is wording, and nothing classifies by it.
- Origins: every wake and user segment also carries a `ServedOrigin` - `captain` (served as `user`), `crewmate-report`, `scheduled`, `supervision` (an escalation), or `agent` (any other host operation).
  The emitter stamps it on the durable inbox row (`inbox.origin`, migration 32), the host copies it into the segment header, and the decision record keeps it per segment.
  A text-only reader therefore recovers the same origin from stored session frames.
  Older v1 headers without the origin remain readable with the origin absent.
  Knowledge write authority (`classifyWake`, `src/core/knowledge/origin.ts`), a drain's thinking level, and `supervision_outcomes.wake_kind` all read the stamp.
  Rows queued before migration 32 were translated once from their old wording.
- The `[fm-op]` label stays in every wake body: it is model-facing wording the first mate prompt names, not a user surface (only dev Observe renders it), so keeping it leaves both the served input and the v2.7 contract unchanged.
- A parked captain turn (benched, or a mid-turn steer the session refused) is stored as a typed wake (`captainTurn` in `src/core/orchestrator/wakes.ts`: `facts.kind` `captain-turn`, the words only) with inbox ref `captain-turn` and origin `captain`, and drained as a `user` segment under a fresh context block, never as a wake.
- Text that does not open with the header is pre-frame history: readers keep their legacy rules for it and say so (`kind_basis`).
- The first mate prompt names the frame (contract v2.7): only a `user` part is the captain speaking.

Readers: Observe (`src/core/observe/transcript.ts`), the dispatch extractor (`kind_basis: "structural-frame"`), and the replay engine (`firstmatePromptParts`).

## 2. The decision record (`decided` events)

A policy-step decision is a served first mate turn (captain, drain, or mixed).
The whose-turn rule (`docs/report-sort.md`) is host code rather than a turn, so it serves nothing and opens no decision; it writes its `supervision_outcomes` row and nothing else.
`DecisionCapture` (`src/core/orchestrator/decisionCapture.ts`) opens one when the input is served and finishes it when the turn's asks, inbox rows and effects are settled.
Finishing writes one `decided` event, through `TaskService.recordDecision`, on every task the decision touched, all with the same data and the decision id as `ref`.
Nothing is written on a watchdog tick, an empty poke or a drain that served nothing.

The data is `DecisionRecord` (`src/shared/provenance.ts`, zod schema):

| Field | What it pins |
|---|---|
| `producer` | actor label (`firstmate` / `supervisor` / `host`), role, model, account id, thinking level |
| `contract` | `FIRSTMATE_CONTRACT_VERSION`, the served system prompt sha, and the tool surface sha (name, description and schema of each tool) - stamped per decision, never normalized later |
| `trigger` | `captain` / `wake` / `mixed`, from the frame's own segment kinds |
| `served.prompt` | the served text's sha256, the frame version, each segment's kind, origin, length, and inbox row id/ref; the session file, the Pi entry holding the exact text, and its parent entry (the tip of the prefix) |
| `served.prompt.prefix` | message count and sha256 of the live context the prompt was appended to - after compaction and any failed-turn thinking strip, so what the model was sent rather than a rebuild |
| `served.steers` | captain words steered into the running turn, located the same way |
| `disposition` | `outcome` (`clean` / `failed` / `unreported`), the redacted error, what happened to the inbox rows (`acked` / `released` / `reassigned` / `none`), the asks and where they attached, Pi tool call ids (the exact join to arguments and results in the session), card ids emitted, tasks touched, and for a triage the verdict, the `supervision_outcomes` row id and the first mate's lane row an escalation handed off (the id the consuming first mate decision lists on its wake segment) |

The record copies no served text and none of the captain's words: the exact input lives once, in the producer's own Pi session (durable, never pruned), and the record points at it and fingerprints it.
A decision is anchored only to natural durable tasks: a wake row's task ref, an ask's attached task, or a task acted on by a tool.
A taskless operational wake that touches no task does not invent a synthetic task, anchor, table or persistence shape, so it writes no `decided` event; its served input remains self-describing in the Pi session.
Structured capture for that case is deferred and may be revisited by the supervision-coverage board outcome, because taskless wakes overlap that session-coverage question.

`decided` is capture machinery: it rides the task export and the offline readers, never the feed, the record card (`tasks.detail`) or a `task_event` FmEvent (`taskProtocol.ts`).
Timeline compaction never folds `decided`, `steered` or `interrupted`; those rows and their full data payloads remain verbatim while ordinary timeline events still fold into the compacted head.

## 3. Direct steers and interrupts

Before R2 a steer or interrupt left no durable event.
Now the crew control plane writes one through the task writer at the moment it decides what happened:

- `steered` (`TaskService.recordSteer`, from `CrewSupervisor.steerCrewmate` / `steerInternal`): actor `firstmate` or `captain` (a card choice); the `supervisor` actor, the `supervision` via and the `recorded-queued` delivery were the retired session's and stay in the vocabulary for the record.
  `data` is `SteerEventData` - the delivery outcome (`mid-turn`, `queued-next-turn`, `recorded-retrying`, `recorded-queued`), `via` (`tool` / `card` / `supervision`), the issuing decision, the card id, and the inbox row.
  The message is redacted at capture.
  A refused steer (unknown or closed task) throws as before and records nothing.
- `interrupted` (`TaskService.recordInterrupt`, from `CrewSupervisor.interruptCrewmate`): actor `firstmate` (the tool) or `captain` (the shell's abort); `data` is `InterruptEventData` - mode, `effect`, a redacted error when present, `via` (`tool` / `shell`) and the issuing decision.
  An abort records `requested` before the transport call, then `aborted-turn` on success or `abort-failed` on rejection.
  Effects that need no transport call (`cancelled-idle`, `cancelled-record`, `no-turn`, `already-done`) record once.

Both carry the issuing decision id as `ref` when one exists.
The card-derived captain-contact path (`card_resolved` plus the card's declared actions) is unchanged.

## 4. The contract stamp and a Claude-served record

**The stamp is the role's; the backend only writes it.**
A rolling session's spec may carry a `ContractStamp` - `{version, promptSha, toolsSha, tools?}` on `shape.record.stamp` (`src/core/session/session.ts`).
The seat preset sets one (`firstmateContractStamp` in `src/core/orchestrator/seat.ts`: `FIRSTMATE_CONTRACT_VERSION`, the served system prompt's sha, the tool surface's sha, and `tools`, each tool's own sha), so a Claude-served seat starts over when an update reworded, added or removed a tool (`docs/claude-client.md`).
The crewmate preset sets one too (`crewmateContractStamp` in `src/core/orchestrator/crewSession.ts`: the version `crewmate`, the sha of the prompt exactly as served, the tool surface's sha, and `tools`, each tool's own sha), so a Claude crewmate's conversation starts over when an upgrade changed what it was started under (`docs/claude-client.md`).
The backend adds `instructions_sha` when captain-served instructions are on the session (`docs/sequences.md`) and writes the stamp in its own dialect, again whenever any field changes, never when it is the session's newest one already:

- **Pi**: an `fm-contract` custom entry in the session JSONL, `{version, prompt_sha, instructions_sha?, tools_sha}` (`src/core/pi/session.ts`).
  The dispatch extractor carries `version`, `prompt_sha` and `instructions_sha` into its records, not `tools_sha` (`docs/dispatch-extractor.md`).
- **Claude**: a `contract` line in the record's sidecar, the same fields (below).

A Pi crewmate's session writes no `fm-contract` entry: Pi serves the current prompt on every request, so nothing compares it.
A Claude-served seat's and a Claude crewmate's sidecar hold their `contract` lines, with `tool_shas`, beside their `served` ones; Pi's `fm-contract` entry names no `tool_shas`, since Pi serves each tool's current description on every request.

A Claude-served session has no Pi JSONL.
Its record is the app's copy of the client's own transcript in the spec's record dir - the seat's `userData/firstmate/claude/<sessionId>.jsonl`, a crewmate's `crewmates/<taskId>/sessions/<sessionId>.jsonl` (`SessionRecordStore`, `src/core/storage/sessionRecordStore.ts`; copied at each idle boundary, reattach and client exit, and on each host tick while the client is attached) - and beside it a sidecar, `<sessionId>.served.jsonl`, one JSON line per stamp:

- `{kind: "contract", at, version, prompt_sha, instructions_sha?, tools_sha, tool_shas?}` - written at attach and at each instructions change, only when it differs from the session's newest one (the `fm-contract` entry's job); `tool_shas` when the stamp names each tool's sha.
- `{kind: "served", at, prompt: {textSha256, uuid} | null, steers: [{textSha256, uuid}]}` - written as each prompt settles, with the uuid the client acknowledged each message by.
  The client's transcript records the prompt as its own entry under that uuid and a steer folded into a running turn as an `attachment` (`queued_command`) whose `source_uuid` is that uuid, so a reader joins the two whenever the copy holds them.

The seat's `servedState()` reads the copy as it stands: the prompt's entry, the entry it follows and the chain before it (the prefix), and each steer's attachment.
The prefix's sha256 is that of the chain's JSON, `JSON.stringify(chain)`, and the seat keeps it as the chain grows (`PrefixDigest`, `src/core/claude/prefixDigest.ts`): it hashes only the entries added since the last chain it read, and a chain that does not continue that one is read whole again.
When a recorded session opens and while each turn runs, the seat reads the copy's new lines and hashes its chain one line per turn of the event loop (`SessionRecordStore.catchUp`), so a turn's close parses and hashes only what the turn added and the app's main thread keeps answering.
The client writes its transcript on its own schedule, so a location it has not written yet is null in the decision record (`prefix` too); the sidecar's uuids still find it later.

The offline readers do exactly that (W1 S11): the one session reader (`src/core/storage/sessionReader.ts`) joins each turn to the contract that served it through the sidecar's uuids - a prompt by its own entry, a folded steer by its attachment's `source_uuid` - never through a location the decision record carried, and hands the session to the replay, the extractor and the corpus export in the Pi dialect (`docs/dispatch-extractor.md`).

## Tests

`firstmateAgent.test.ts` ("provenance (R2)") drive the real agents, supervisor, TaskService and SQLite and assert on the durable events; `firstmateSession.served.contract.test.ts` checks the served location and prefix against real Pi and a mock provider; `servedFrame.test.ts` pins the convention's round trip and forgery resistance; the extractor and Observe tests read framed turns.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Prospective provenance (R2, `docs/provenance-capture.md`) is the write side of the offline exporters and adds no table or service.
  Every input the host serves the first mate is FRAMED by `src/shared/servedFrame.ts` - segments opening with U+2063 `FIRSTMATE_OP: v1 <kind> [<origin>]: `, the mark stripped from bodies - so any reader splits on the mark and never on `[fm-op]`/`[user]` text (Observe, the extractor, the replay engine all do; a parked captain turn rides inbox ref `captain-turn` and drains as a `user` segment).
  Who a segment came from is its typed `ServedOrigin` (captain | crewmate-report | scheduled | supervision | agent), stamped by the emitter on the inbox row (migration 32), serialized in wake/user frame headers, and carried onto the segment and decision record; origin classification (`classifyWake`) reads only that stamp - never add a marker-text origin rule back.
  The `[fm-op]`/`[user]` labels remain model-facing wording.
  A served turn is a decision: `DecisionCapture` writes one `decided` task event (data `DecisionRecord`, `src/shared/provenance.ts`; `ref` = decision id) on each task it touched when the turn settles - never on a tick - and `decided` never reaches the feed, the record card or a `task_event` FmEvent.
  Taskless operational wakes invent no anchor; their structured capture is deferred as documented.
  Timeline compaction exempts `decided`, `steered`, and `interrupted`, preserving their full payloads while ordinary rows fold.
  The crew control plane writes those actor-labelled control events with the issuing decision as `ref`.
  The record fingerprints and locates served text (`ModelSession.servedState`), never copies it.
