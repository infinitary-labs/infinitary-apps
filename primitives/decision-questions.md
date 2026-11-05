# Decision questions

A decision question asks a model one typed, bounded question about handed facts and gets back a closed answer, instead of dispatching a worker to do the work.

## Intended use

Ask for a model judgment the host needs as a typed value: one option from a closed set the question declares (the kind of a piece of work), or one JSON value that fits a schema (a program's `ask()`).
The model generates no free text for the caller, calls no tool, holds no session the caller can see, and reads nothing it was not handed.
Adding a consumer is adding a question, not a model, a transport or a setting.

## When to use it, and when not

Use a decision question when the answer is closed and cheap: a category, a yes/no as a two-option `choice`, or a small JSON value checked by code.
When the work needs tools, files, several turns or a transcript, dispatch a task to a crewmate instead ([tasks.md](tasks.md)).
Do not write a host parser or keyword table to judge what a person meant; give the facts to a decision question or to an agent's instructions ([principles](../docs/principles.md), "Put ambiguous judgments in agent instructions").
Do not add a decision model as a fifth intelligence slot, a `PROVIDER_CATALOG` row or a routing candidate: it is a separate group on the Models board, `route()` cannot see it, and `SLOTS` keep speaking four words ([intelligence-buckets.md](intelligence-buckets.md)).
Do not add a `confidence` or distribution field: a question declares its abstention, and certainty stays inside a native implementation.
Do not confuse this with the decision ledger: a decision model answers a question, while `DecisionStore` records what the host decided (routing, account, sort).
The report path has no `decide()`: whose turn it is is a typed rule, not a model question ([report sort](../docs/report-sort.md)).

## Owner and entry points

`DecisionModels` ([`../src/core/decisions/decisionModel.ts`](../src/core/decisions/decisionModel.ts)) is the core-wide seam any module may ask: it owns the `decisions` settings row, the native model's construction and that row's state, never a question.
Its calls are `decide(caller, state, questions, signal)` for closed answers and `answerJson(caller, instruction, text, signal)` for a JSON answer.
The shapes (`DecisionQuestion`, `DecisionState`, `DecisionAnswer`, `DecisionCaller`, `DECISION_STATE_VERSION`) live in [`../src/shared/decisions.ts`](../src/shared/decisions.ts).
Implementations of the `DecisionModel` interface:

- `AdaptedDecisionModel` (session-backed): renders the question as a byte-stable instruction plus one user message and parses one word back, over the one-question session `questionSessionSpec` ([`../src/core/decisions/questionSession.ts`](../src/core/decisions/questionSession.ts)), walking the routable pool low-first, never premium.
- `JevDecisionModel` (native, [`../src/core/decisions/jev/jevClient.ts`](../src/core/decisions/jev/jevClient.ts)): TypeSafe's Jev, serving the typed question as its own API.
- `OpenRouterDecisionModel` (native through Pi, [`../src/core/decisions/openRouterDecisionModel.ts`](../src/core/decisions/openRouterDecisionModel.ts)), with Pi's side in [`../src/core/pi/decisionModels.ts`](../src/core/pi/decisionModels.ts).

## Operations and lifecycle

A question is `{type, instructions, criteria, abstain?, version, adapterInstruction?}`; `type` is `choice` or `score`, and the app asks only `choice` today.
An answer is `{value, outcome, source?, version, reason?, detail?}`: `outcome` is `answered`, `abstained` or `failed`, and a failed answer still carries the abstention as its `value`.
`reason` is a short machine word (`timeout`, `no-model`, `rate-limited`, `key-rejected`, `schema`); `detail` is prose for the record, such as a native model's certainty or a fallback note.
The answer's `version` is the consumer's contract number plus a hash of the bytes actually served, so a recorded verdict says which question was asked.
A consumer whose wording was tuned against a chat model pins its served bytes (`adapterInstruction`, `adapterText`) so its fingerprint does not move.
The JSON boundary: only the session-backed adapter gives a JSON answer, since a native model answers from a closed option set; `answerJson` returns the model's text, and the caller parses and checks it (`askJson` in [`../src/core/program/programAsk.ts`](../src/core/program/programAsk.ts) asks once more with why, then answers `null`).
Usage lands in `usage_events` under the caller's task, or under its `purpose` when there is no task.

## Authority

Jev is fenced to `src/core/decisions/`: a Biome rule (`biome.json`) lets only that folder import `decisions/jev/`, the home's decision wiring (`homeDecisions.ts`) among it, so nothing else may build a request to that endpoint or read that key.
A native model is off by default: `DecisionModels` builds no client unless the row names it, its egress is on, the consent covers the current `DECISION_STATE_VERSION`, and the user's own key is stored.
The key is entered only in Settings and stored 0600 under `userData/decisions/<id>/` (`DecisionKeyStore`), never in the settings table, an environment variable, a log, a feed line or a card.
Widening the facts sent (`decisionConsent`) re-shows consent and turns egress off until accepted again.
The endpoint is listed as an egress in [architecture](../docs/architecture.md) §1.

## Compositions

- The kind classifier: `DecisionKindClassifier` holds the kind question, its facts and the mapping back to a `KindVerdict`, and owns no model or transport ([kind classifier](../docs/kind-classifier.md)).
- A program's `ask()` is one JSON question through `DecisionModels.answerJson` ([programs.md](programs.md)).
- The adapter opens its session on the session contract's question preset, bound through `SessionBinder`, the same account-to-binding step the seat and crew use ([architecture](../docs/architecture.md) §2).

## Failure and recovery

Every call is bounded by the caller's signal and a 15 s wall clock (`DECIDE_TIMEOUT_MS`) that covers creating the session as well as its turn.
A call never throws: every failure is the question's abstention with a `reason`.
A native model that fails is answered for by the adapter, with one reason line on the record (`WorkShape.kind_detail`), never a card and never a stall.
Only the vendor's own 401 flips the native row to `key rejected`, once per key with one feed line; rate limits, outages and unreadable bodies are transient.
A native reply past 64 KB is `oversized` and never read to the end; an unrecognised body is `schema`, never an answer.
A typed cut-off the adapter's session sees is recorded on the account (`noteCutOff`, [quota](../docs/quota.md)).

## Uses

- Task kind classification at dispatch (`DecisionKindClassifier`, [`../src/core/routing/decisionKindClassifier.ts`](../src/core/routing/decisionKindClassifier.ts)), the one closed-answer consumer.
- A program's `ask(prompt, schema)` (`askJson`), the one JSON-answer consumer.
- Possible: a further closed judgment the host needs as a typed value, added as a new question with its own `version`, not a new model or setting.

## Checks

- [`../src/core/decisions/decisionModel.test.ts`](../src/core/decisions/decisionModel.test.ts): the adapter walk, abstention, fallback and bounds.
- [`../src/core/decisions/openRouterDecisionModel.test.ts`](../src/core/decisions/openRouterDecisionModel.test.ts) and [`../src/core/decisions/jev/jevClient.test.ts`](../src/core/decisions/jev/jevClient.test.ts): the native clients.
- [`../src/core/routing/decisionKindClassifier.test.ts`](../src/core/routing/decisionKindClassifier.test.ts) and [`../src/core/program/programAsk.test.ts`](../src/core/program/programAsk.test.ts): the two consumers.
- [`../tests/e2e/decision-models.spec.ts`](../tests/e2e/decision-models.spec.ts): the binding test, including that a fresh install makes zero requests.
- The Biome `noRestrictedImports` fence on `decisions/jev/` in `biome.json`.

## Where the detail lives

Decision models `docs/decision-models.md`.
Sections of [decision models](../docs/decision-models.md): "What a decision model is", "The interface", "The implementations", "Egress and opt-in", "The surface", "The first consumer", "OpenRouter decision models (FI3-505)".
[Programs](../docs/programs.md), "The dialect", for `ask()`; [the decision ledger](../docs/decision-models.md) "The decision ledger" for what the host records, which is not this primitive.
