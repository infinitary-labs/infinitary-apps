# The dev-only local-model orchestrator (roadmap 1.7)

A private, unpackaged-only way to put a local model in the first mate's seat, so the captain can get a felt read on how a local model handles real supervision before any collected label is evaluated (captain decisions 2026-09-21; plan section 1.7).
It is a precursor to PoC-2, not a substitute for it, and it is not a feature: no shipped setting, no surface in a packaged build, no terms, nothing collected.

## What it is

An unpackaged dev checkout (`pnpm dev`, or an e2e launch of `out/`) runs the first mate - and only the first mate - on a named OpenAI-compatible endpoint.
Two ways make the same choice:

- **Settings → General → "Local model (dev checkout)"**: a switch, the endpoint, the model.
  The section renders only while the core says the control is available, which it never does on a packaged build.
  The row persists across launches of the checkout; a change binds at the next idle moment, and turning it off puts the first mate back on whatever it was on.
- **Two environment variables**, for a headless run:

```
INFINITARY_LOCAL_ORCHESTRATOR_URL=http://localhost:11434/v1 \
INFINITARY_LOCAL_ORCHESTRATOR_MODEL=qwen3:8b \
pnpm dev
```

`INFINITARY_LOCAL_ORCHESTRATOR_KEY` names a bearer for an endpoint that wants one; Ollama ignores it and the default placeholder `local` is sent.
The row speaks when it is on (a bad row seats nothing and the section says why, rather than falling back to the environment); otherwise the environment does.
The section shows an environment-named seat as "set by the environment for this run".

The one home is `src/core/orchestrator/localOrchestrator.ts`:

- `resolveLocalOrchestrator({ isPackaged, env, setting })` is the gate.
  A packaged build answers nothing whatever the environment or the row says - there is deliberately no `=1` override, unlike Observe - so a notarized release carries no way to re-point its orchestrator.
  Unpackaged, a seat needs both the URL and the model, and the URL must be http(s).
- `LocalOrchestratorService` owns the seat at runtime: it boots from the row and the environment, is what `inf:settings:local-orchestrator:get|set` read and write (`src/shared/localOrchestrator.ts` is the wire shape; `PROTOCOL_VERSION` 1.17.0), rebuilds the seat when what the row resolves to changes, hands it to the first mate, and on a packaged build holds nothing, reads no row, and refuses every write outright - the section is absent because `view().available` is false, not because the window chose to hide it.
- `createLocalOrchestratorSeat` writes a models.json for one custom provider (`local`, `api: openai-completions`, the same shape the e2e mock provider uses) under `userData/dev/local-orchestrator/` and creates a `ModelRuntime` of its own over it through the one factory (`createModelRuntime`).
  The person's app-scoped `models.json` is never touched.
- The seat reaches the first mate as `FirstmateAgentOptions.localOrchestrator` at boot and through `FirstmateAgent.setLocalOrchestrator` after a write: `resolveModel` returns its model outright and the session binds to its runtime, and the pre-turn admission ladder and the explicit account pin are skipped while it is set.
  A change binds at an idle boundary the way an explicit pin applies - idle now, the rolling session is detached and the next turn re-opens the same file over the new runtime; mid-turn, the pre-turn admission check does it - never mid-turn.
  The persisted model pin (`firstmate-model`) is left exactly as it was: turn the row off or unset the variables and the previous seat is back.
- Crewmates never see the model.
  It is outside the routing pool (`availableModels`), the slot record and the quota catalog; a crewmate routes as it always did, which is what makes the read a read of the orchestrator alone.
- The first-run gate treats the seat as a model that can answer (`gateOpen` is false while it is set, and follows a Settings write), and every seat change is one feed line: `Your first mate is running on <model> at <host> for this dev checkout; crewmates route as usual.`, or `Your first mate is back on its usual model; the local seat is off.`

## Ollama context and failure safety

Select the installed base model, not an alias.
At session attachment, `src/core/pi/ollamaProfile.ts` identifies Ollama through its native API and prepares a private configuration of that model.
Preparation is lazy and retryable: an unavailable server does not prevent boot or access to Settings.
Other OpenAI-compatible endpoints retain the existing transport.

- The alias is deterministic from the canonical base name, its digest and the context size, with an app-owned prefix.
  `/api/create` uses `from` plus `parameters.num_ctx`, the API equivalent of a Modelfile `FROM` and `PARAMETER num_ctx`; it never rewrites the original tag or downloads weights.
  Existing matching aliases are reused, including a previously admitted smaller one; a base-tag update produces a new identity.
  Successful aliases are retained because another app instance can be using them; only unsuccessful candidates created by the current preparation are removed.
  A conflicting existing alias is refused, never overwritten or deleted.
- The target is the smaller of 65,536 tokens and the model's trained maximum, with 65,536 as the minimum viable fallback.
  Tools support and a sufficient trained window are required.
  An empty native chat with the inference runner's `shift: false` loads each candidate without inference; `/api/ps` must confirm the requested context and at least 95% GPU/Metal residency by reported allocation size.
  Thus the serving machine admits the allocation, not a guess from the client's RAM; a CPU-spilling or unavailable configuration is not silently used.
  This is an admission check, not a promise against later memory pressure or a guarantee of inference speed.
- The alias's `/api/show` **parameter line** is the serving context source, verified against the actual allocation; the trained maximum is only an upper bound.
  The local runtime and generated model definition carry that context and the existing 8,192-token output cap.
  The user's base name remains the session/model identity and the Settings/feed label.
  There is no alias control or additional user setting.
- Pi remains the session and compaction owner.
  Local sessions use a 12,288-token reserve and retain 4,096 recent tokens, rather than Pi's default 20,000-token retained tail, which is too large beside the first mate's fixed prompt in a 64k window.
  Before a captain prompt, Pi's session-compaction `estimateTokens` estimates the normalized **incoming** message, live history, system instructions and tool schemas once; when needed it runs Pi's compactor and rechecks before inference.
  The instructions and tool schemas are the fixed part of every request, held under the existing ceiling in `tests/firstmate-fixed-context.test.ts`, which also checks the conversation space left in a 64K window (`docs/orchestrator-contract.md` "The fixed-context budget").
  The adapter checks every subsequent request too, including tool follow-ups and the summarizer.
  A bounded overflow can engage Pi's own compaction retry; recovery is allowed to finish before a failure card is raised.
- Estimation alone is not a no-truncation guarantee.
  Ollama's `/v1` route ignores the necessary controls, so the identified Ollama runtime uses `src/core/pi/ollamaStream.ts`, a Pi native-chat adapter with `truncate: false` and `shift: false` on **every** request.
  An underestimated input is rejected by the serving tokenizer, not silently shortened.
  This boundary requires Ollama 0.34.2 or newer, the first version verified here; older servers must be updated rather than trusted to interpret unknown flags.
  The adapter preserves the model's native thinking default, because models disagree on boolean versus effort-valued thinking controls; thinking and visible output share the output cap and five-minute request bound.
- An unservable model, failed preparation, impossible compaction, incomplete stream, output exhaustion or unrecovered provider error reaches the existing first mate failure card and Retry.
  On a captain turn, plain closing text alone is not a visible answer: a local turn with no card, task-attributed action, emote, or card-thread response fails visibly too.
  Timeouts cancel manual compaction too; a failed preflight cannot later submit the captain's prompt.
  This is not a judgment of answer quality; a valid action can still be a poor response.
- Settings writes are serialized, and a model change during preparation is applied before inference.
  The existing chooser preserves typing made after a save began, rather than letting an older response erase the other field.

No renderer protocol, prompt contract, account binding, crew routing or packaged-build gate changes for this path.

## Reading the result

Observe (Settings → Observe, development and alpha builds) lists the first mate's session with `local/<model>` as its model, and the transcript is the same rolling session JSONL every first mate turn writes.
The qualitative read the plan asks for - how the local model classifies, dispatches, sorts reports and answers with a default - is read there and off the cards it authors, against the same card contract every seat is held to (`docs/card-authoring.md`).

## Evidence

- `src/core/orchestrator/localOrchestrator.test.ts`: the packaged refusal, the parse rules, the row's precedence over the environment and its stated problems, the service's boot/on/off round trip, and the real consumer - Pi resolves the named model with the named endpoint off the written file.
- `src/core/core.boot.test.ts` ("the dev-only local orchestrator"): the whole core booted unpackaged with the environment set seats the first mate (the gate closes, the feed line lands, the files sit under `userData/dev`); booted unpackaged with nothing set, the Settings write seats it and unseats it with the gate following; booted packaged with the SAME environment it seats nothing, the view says no control, and the write is refused.
- `src/renderer/src/settings/LocalSeatSection.test.tsx`: the section renders nothing while the control is unavailable, and the switch plus the two fields when it is.
- `tests/e2e/local-orchestrator.spec.ts`: the built app, no account and no custom provider of its own, with the mock provider standing in for Ollama.
  Named by the environment, the gate never opens, the feed names the seat, and a captain turn reaches the endpoint as a first mate request for the named model while the persisted pin stays null; named from Settings, the switch closes the open gate, the captain's turn goes to the endpoint, and turning it off puts the gate back.

- `src/core/pi/ollamaProfile.test.ts`: alias reuse/update identity, trained and hardware bounds, refusal/cleanup, and generic endpoint fallback.
- `src/core/pi/ollamaSession.test.ts`: real Pi and native HTTP, tool/result/image transport, persisted pre-send compaction, timeout cancellation without late inference, and terminal failures.
- `src/core/orchestrator/firstmateAgent.turns.test.ts`: a Settings change during slow preparation serves the latest choice.
- `tests/firstmate-fixed-context.test.ts`: the fixed part stays inside its budget by the same pre-send check, which admits a working conversation on the 64K minimum and refuses one token past the room.
- `tests/e2e/ollama-context.spec.ts`: the built app renders the answer without exposing the alias; preparation, no-answer, thinking-only, malformed/refused actions, output-limit and overflow failures show Retry; Retry recovers, and a successful operation ends on its answer card.

## What it is not

Not a way to run a local model for crewmates, not a shipped setting, not a shipped capability, and not PoC-2's bar: the plan's 1.3 keeps its own evaluation.
The section's words are the dev checkout's, outside the plain-language vocabulary of roadmap 1.5 by design; nothing about it reaches a packaged build's surface, and the packaged build cannot enable it.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The dev-only local-model orchestrator (roadmap 1.7, captain decisions 2026-09-21; `docs/local-orchestrator.md` is the one home): an UNPACKAGED checkout runs the first mate - only the first mate - on a named OpenAI-compatible endpoint (Ollama or its equivalent), so a local model can be felt in the orchestrator's chair before any collected label is evaluated.
  Two ways make the same choice: Settings → General → "Local model (dev checkout)" (a switch, the endpoint, the model - the row persists across launches of the checkout and speaks when it is on) and the `INFINITARY_LOCAL_ORCHESTRATOR_URL` / `_MODEL` variables for a headless run.
  `resolveLocalOrchestrator` (`src/core/orchestrator/localOrchestrator.ts`) is the gate and the BUILD is the switch: a packaged app answers nothing whatever the environment or the row says, with deliberately no `=1` override, `LocalOrchestratorService` (the seat's one runtime owner, behind `inf:settings:local-orchestrator:get|set`, `PROTOCOL_VERSION` 1.17.0) reads no row and refuses every write on it, and the section renders only while `view().available` is true - `core.boot.test.ts` boots the core packaged with the environment set and the write asked to prove all three.
  The seat is its own `ModelRuntime` over a models.json the core writes under `userData/dev/local-orchestrator/` (the e2e mock provider's custom-provider shape, through the one runtime factory), never the person's models.json; it reaches the agent as `FirstmateAgentOptions.localOrchestrator` at boot and `FirstmateAgent.setLocalOrchestrator` after a write - `resolveModel` returns it outright, the session binds to its runtime, the admission ladder and the account pin stand down, and a change binds at an idle boundary the way an explicit pin applies, never mid-turn - while the persisted `firstmate-model` pin is untouched, so turning it off restores what was there.
  Crewmates never see the model (outside `availableModels`, the slots and the quota catalog); the first-run gate closes on it and follows a write; every seat change is one feed line.
  Not a feature: no shipped setting, nothing collected, and the section's words are the dev checkout's, outside the 1.5 vocabulary by design.
  `tests/e2e/local-orchestrator.spec.ts` runs a real captain turn through it against the mock provider both ways.
