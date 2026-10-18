# Decision models

Captain-approved 2026-09-18 ("ok let's ship").
The report path has no `decide()` (`docs/report-sort.md`).

## What a decision model is

A **decision model** answers one typed, bounded question about a piece of state and returns **one value from the closed set the question declared**.
It generates no text, calls no tool, holds no session, and reads nothing it was not handed.

That is the exact opposite of an intelligence slot, which holds models that DO work in a session with tools:

| | Intelligence slot | Decision model |
|---|---|---|
| Unit | a session: persona, transcript, tools, an open goal | one question, one call, bounded facts |
| Output | text and tool calls | one value from a declared set |
| Placement | many offerings across four ranked groups | exactly one model |
| Roles | First mate, crewmate | none; it cannot run a turn |
| Failure | a failed turn, a card, a retry | a fail-soft abstention; never a card, never a stall |

So it is a fifth **group** on the Models board, not a fifth `Slot`.
`SLOTS`, `AUTO_ROUTABLE_SLOTS`, `bucket:` gate refs and `routing_decisions.bucket` keep speaking four words, and `route()` cannot see a decision model at all.

It is also not a provider (design section 4).
A `PROVIDER_CATALOG` row drags in a vault account with its own store and Pi runtime, a row on the accounts list, membership of `availableModels()` and the routing pool, a quota sensor and credential health, and eligibility for the crewmate and first mate roles.
A decision model needs none of that and must never have it: putting Jev in the catalog would put it on the slot board (nonsense), in the routing pool (dangerous), and in front of a sensor with nothing to read.

## The interface

`src/shared/decisions.ts` owns the shapes; `src/core/decisions/decisionModel.ts` owns the seam.

```ts
decisions.decide(
  { purpose: "kind", taskId },      // who is asking, for the ledger
  { facts, adapterText },           // named, bounded facts
  { kind: KIND_QUESTION },          // one or more typed questions
  signal,
): Promise<Record<string, DecisionAnswer>>
```

An answer is `{ value, outcome, source?, version, reason?, detail? }`.

There is **no `confidence` and no distribution** on the interface.
That is the captain's own call (report section 10): the adapter path cannot supply one honestly, and a field one implementation fakes and the other fills is exactly the kind later code learns to trust.
What replaces it:

- **`abstain`** is an option the QUESTION declares.
  The consumer names the answer that means "I cannot tell"; both implementations honour it.
- **`outcome`** (`answered` | `abstained` | `failed`) tells a model that said "I cannot tell" from a call that never happened.
  A `failed` answer still carries `value` - the abstention - so no caller ever handles an absent answer.
- **`reason`** is the short machine word for a failure (`timeout`, `no-model`, `rate-limited`, `key-rejected`, `schema`), so a caller records WHY without parsing prose.
- **`detail`** is free prose for the record: a native model's own certainty (`p=0.93`), or the note that one failed and the adapter answered instead.

A native model that measures its certainty keeps it INSIDE its implementation, uses it to decide when to answer the abstention, and writes it to `detail`.
It never crosses the interface.

Rules every caller gets for free and cannot opt out of:

- the call is bounded (the caller's signal, plus the transport's own 15 s);
- it **never throws** - every failure is the question's abstention;
- the burn lands in `usage_events` under `caller.taskId`, or under the caller's `purpose` when no task exists;
- a native model that fails is answered for by the adapter, never by silence.

## The implementations

**The adapter** (`AdaptedDecisionModel`) is S3's machinery, generalised: any chat model in the routable pool qualifies, because a typed question renders as a byte-stable instruction plus the state as one user message, the abstention is offered as a word among the others, and the answer is one word parsed by code.
Same low-first walk (`orderCandidates`, premium never a candidate, the flagship account only as a last resort), same stateless session, same fail-soft discipline.

A consumer whose wording was tuned against a chat model **pins its served bytes** - `question.adapterInstruction` and `state.adapterText` - so the answer's fingerprint does not move when the class is introduced around it.
The kind question does exactly that, so the fingerprint does not move when the class is introduced around it.

Since W1 S10 a Claude login answers too (the owner's answer 2), so a machine with only Claude signed in classifies work instead of failing soft to `high`.
The session is the question's one-shot on the one session contract (`questionSessionSpec` in `decisions/questionSession.ts`, opened on the binding's backend's `SessionFactory`): Pi's is the in-process session with its 64-token cap (`pi/session.ts`); Claude's (`claude/session.ts`) is ONE query to the machine's own client on its default login - the instruction as the only system prompt the app supplies (the client adds its own identity line, and a date reminder to the user message), no tools, no MCP servers and none of the person's settings or Claude notes (`tools: []`, `strictMcpConfig`, `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), one agent turn (`maxTurns: 1`) at low effort, no transcript (`persistSession: false`), and at most a word: thinking disabled and the client's output capped at the same 64 tokens (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, from the question's own bound) - holding the account's shared store lease for its life.
`effort` alone does not bound it: the pinned client drops effort for Haiku, the low slot the walk binds first, and serves it a 31,999-token thinking budget; with thinking off and the cap set, Haiku, Sonnet and Opus are all served `max_tokens` 64 with no thinking.
An answer the cap cuts short is still the answer, read as Pi reads it (the one option word in the text): `maxTurns` does not stop the client's own output-limit recovery, which re-asks within milliseconds up to three times, so the classifier reads the cut-short text off the first request (its typed `max_tokens` stop rides the streamed `message_delta`) and stops the client; the one re-ask already sent is dropped unanswered.
Claude competes in the same low-first walk as every other provider (the owner's Q3 a); a Claude model binds only through its account, never the base runtime, and a backend with no factory is passed over.
A typed cut-off the call sees is recorded on the account (`noteCutOff`, `docs/quota.md`), which takes the account's models out of the pool until a fact changes; the answer is the abstention with `provider` as its reason, like any failed turn.

The question is one of the session contract's three presets (the seat's and the crewmate's are the others, `docs/architecture.md` §2): the adapter takes the same `SessionFactories` pair the agent and the supervisor open on (`services.ts`), and binds a candidate's account through a `SessionBinder` (`session/binding.ts`), the account-to-binding step the flagship and the supervisor use too.
Its walk, rendering, parsing, ledger and wall clock stay the adapter's; the factory sees only the spec.
The native model is not a session and not a third backend: it sits beside the adapter under `DecisionModels`, one layer above the session contract, and makes one typed call with no turn to run.

The wall clock (`DECIDE_TIMEOUT_MS`, 15 s) bounds the WHOLE call - creating the session as well as its turn - because a Claude session spawns the client and waits out a sign-in in progress first; a session that arrives after the bound is disposed unasked, and one whose abort never settles its turn is not waited for.

**The native model** (`JevDecisionModel`) serves the typed question as its API.
TypeSafe's Jev is the direct-key catalog row.
Both direct TypeSafe and OpenRouter choice models delegate serialization, reply parsing and cost multiplication to Pi through `src/core/pi/decisionModels.ts`.
The direct path supplies its private key only to the existing bounded transport; Pi receives an availability marker and no ambient environment.
TypeSafe requires Pi's complete choice replies (type, choice, probabilities and confidence); one malformed answer rejects the whole batch and uses the existing fallback.
Unsupported categorical-score questions fail explicitly rather than translating to Pi's numeric-score contract.
The approved TypeSafe input rate remains $0.042 per million as model configuration because Pi's bundled entry lists zero.
A shared bounded metadata observer retains served-model attribution and reported cost/count presence without parsing answers itself.
Missing usage remains missing, not measured zero.
OpenRouter choice models are offered separately through Pi (below).
Four rules the client keeps:

- one bounded request (15 s, the caller's own cancel, a 64 KB body cap checked before anything is parsed, transport failures named in our own vocabulary - the quota sensor's proven posture, reused verbatim).
  A cancel stops the request itself and is recorded `aborted`; a caller's deadline is `timeout`; a reply past 64 KB is `oversized`, never read to the end;
- an unrecognised body is `schema`, never an answer (the Grok meter's rule);
- certainty stays inside, as above;
- the abstention is **withheld from the model**, so its distribution is over the real options, and the implementation returns the abstention itself below the catalog row's floor (0.6).

## Egress and opt-in

Six rules, from design section 6.

1. **Listed.**
   The endpoint is a bullet in `docs/architecture.md` §1.
2. **Off by default, twice.**
   The default record names no native model and no egress.
   `DecisionModels` constructs no client unless the row names it, its egress is on, the consent covers the current `DECISION_STATE_VERSION` AND a key is stored - all five checked in one place.
   A fresh install makes zero requests, which `tests/e2e/decision-models.spec.ts` asserts.
3. **The user's own key, nowhere else.**
   Entered only in Settings, stored 0600 under `userData/decisions/<id>/` (`DecisionKeyStore`), never in the `settings` table, a log, argv, a feed line or a card; never read from `TYPESAFE_API_KEY` or any ambient config - the same rule that keeps the app out of `~/.pi`.
   Infinitary does read it to place it in a header, which is the quota sensor's existing posture for API keys, and this document says so rather than pretending otherwise.
   The D-13 purge does not touch it; "Remove Jev" does.
4. **Consent says what leaves.**
   `decisionConsent()` in `src/shared/decisions.ts` is the copy, and it sits beside `DECISION_STATE_VERSION` because the two must move together: the list IS the fact set.
   Widening it re-shows the consent and drops the egress to off until re-accepted (`consentedVersion`); narrowing it does not.
5. **Bounded and fail-soft, never silent.**
   A native failure is one reason line on the routing decision (`decision model jev failed: 429; answered by adapted:openai-codex/gpt-5.6-luna`, carried as `WorkShape.kind_detail`) and the ADAPTED model answers in its place, so a vendor outage costs one call on the user's own subscription.
   Only the vendor's own 401 flips the row to `key rejected`, with one feed line, once per key; a rate limit, an outage or an unreadable body are transient and the row keeps saying `ready`.
   No card: the agent-down cards are the host's only cards and this is not one.
6. **Attributable and measured.**
   Every native answer lands in `usage_events` (provider `typesafe`, the served model id, input tokens, cost from the published price pinned in the catalog row) under the caller's task, and its `kind_source` reads `classifier:jev/jev-1.13.0`.
   S5's metrics count it as classified with no change, because `kindSourceClass` folds by prefix.

What this does NOT do: no proxy, no Infinitary-held key, no decision catalog fetch from the vendor (the alias is pinned in code and the response's own `model` field is what gets recorded), no telemetry about decisions, and no decision ever made on a captain's private note or a card body.

`INFINITARY_JEV_URL` redirects the endpoint in dev/e2e only, exactly like `INFINITARY_CLAUDE_USAGE_URL`; a packaged build ignores it.

## The surface

Settings → **Intelligence** (retitled from "Subscriptions" on the captain's Q1 note: the tab holds accounts, the model board and this group, and only some of that is a subscription) → Models → **Decisions**, hint "Efficient decision making" (his words).

One row, by state: `auto · your cheapest slotted model` by default; a named offering when the captain pinned one ("Use a specific model" - naming a model is its own placement, so a premium offering, or one that is not in use, is allowed here as it is everywhere a user names one); `Jev · TypeSafe · on` with `last answer fix · 412 tokens` when the native option is ready; `key rejected · using one of your own models` after a vendor 401.
The picker lists the listed models, and a pick binds from the whole signed-in pool, slot or no slot, so every model it offers can answer.
The row names a pick only while it is the model answering: the view's `pinned` state comes from the same checks the call makes before it picks an account (`AdaptedDecisionModel.pinState`).
A pick no signed-in account serves reads `chosen model unavailable · using your cheapest slotted model`, and the walk answers in its place; a named custom connection that cannot answer reads `chosen model unavailable · decisions go unanswered`, because it never moves to another account.
"Use Jev (TypeSafe)" opens the one inline form: the consent copy, a write-only key field, one "Turn on".

The board's header line grows one token: `· decisions auto` or `· decisions Jev` (or the selected OpenRouter decision model, or the pinned model's name).
A pick that cannot answer reads `· decisions auto` while the walk answers for it, and `· decisions unanswered` while nothing does.

Four IPC channels, all `surface: "core"`, and the split between them is the point - the ROW travels on the first pair and carries no secret, the KEY has its own write-only call, and no call returns one:

- `inf:settings:decisions` / `inf:settings:decisions:set`
- `inf:decisions:key:set` / `inf:decisions:key:remove`

They hang off the frozen `window.infinitary.models` namespace; the top-level key set is unchanged.

## The first consumer

`DecisionKindClassifier` (`src/core/routing/decisionKindClassifier.ts`).
`KindClassifier`, `KIND_SOURCE`, `resolveKind`, `CrewSupervisor.classifyShape` and the tier table are all unchanged - see `docs/kind-classifier.md`.
The module holds the question, the facts, and the mapping back to a `KindVerdict`, and owns no model, no transport and no setting.
Adding a second consumer is adding a question.

## Scoring it

`pnpm score:kinds --decision-model jev --models <models.json> --provider <p> --model <m>` scores the native model over the same 31 hand labels as the adapter, with `--provider`/`--model` as the fallback the service uses when it cannot answer.
The key is read from `TYPESAFE_API_KEY` for that offline run only and is never written anywhere; the app itself reads only the user's own stored key.
The scorer sits behind Observe's development gate like the other offline tools.

## The decision ledger

A decision model answers a question; the ledger records what the host decided.
Every decision about a task - which model and tier a spawn is routed to, which account serves it, and whose turn a report or an idle crewmate is - is one row of `decisions` (migration 50, the primitives review's P6) with its `kind`: `routing`, `account` or `sort`.
`DecisionStore` (`src/core/storage/decisionStore.ts`) is its one writer: `Router`, `AccountSelector` and the supervisor's `recordSort` seam write through it, and a sort row commits in one transaction with the wake it records.

One shape: the task, the time, the `rule` that decided (a routing policy row R0-R9, or the whose-turn or idle rule of a sort; none for an account pick or a retired triage verdict, whose judging model sits in `model`), the reasons for a routing or account pick, and each kind's own columns - routing's provider, model, asked and served slot; the account; a sort's wake, verdict, summary, provenance stamps and the write-once missed-escalation label.
A sort row that recorded a typed wake carries its facts (`facts_json`; `docs/inbox.md`, "The wake envelope") beside the text it was served as.

### Candidate facts

A routing row and an account row save every candidate they weighed in `facts_json` too (`CandidateFacts`, `decisionStore.ts`; no migration).
Each candidate carries the allowance reading behind it (`percentRemaining`, `pace`), its `spendPriority` score and what became of it (`status`: picked, eligible, or why it was skipped).
The skipped ones are there: a model at 0%, one in no slot, one that cannot serve the turn; an account that is disabled, signed out, withheld, exhausted or reserved for the first mate.
A pinned choice scores nothing, so its row saves none.
They live in the record only: no screen reads them and nothing ranks by them, so an investigation reads them with a query over `decisions` (the old views do not carry the column).

The three old table names are read-only views over the ledger, each kind's rows in its old columns (`LEDGER_VIEWS`, `src/core/storage/views.ts`): `routing_decisions`, `account_decisions` and `supervision_outcomes`, where a rule's sort reads `model` as its `rule:<id>` stamp and gains `facts_json`.
So the published views, Observe, the exporters, the miss deriver and the replay scorer read the same rows from an old database and a new one, and nothing writes through them.
No plugin's query reaches them.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- **Decision models** (S7, captain-approved design `fm3000-decision-models-s7-design-s1/report.md`, "ok let's ship"; `docs/decision-models.md`).
  A decision model answers ONE typed, bounded question and returns one value from the closed set the question declared - no text, no tool call, no session - so it is a fifth GROUP on the Models board, never a fifth `Slot`, never a `PROVIDER_CATALOG` row, and `route()` cannot see it.
  `DecisionModels` (`src/core/decisions/decisionModel.ts`) is the CORE-WIDE seam any module may ask (the captain's annotation): it owns the `decisions` settings row, the native model's construction and that row's state, never a question.
  The interface carries NO `confidence` and no distribution - the adapter path cannot supply one honestly - so a question DECLARES its abstention and an answer carries `outcome` (answered/abstained/failed) plus a short `reason`; a native model's certainty stays inside its implementation, decides when it answers the abstention, and reaches the record only as prose (`WorkShape.kind_detail`, one reason line on `routing_decisions`).
  S7b removed the dead confidence fields with it - `KindVerdict.confidence`, `WorkShape.kind_confidence`, `RoutingPolicy.confidenceFloor` are gone and a pre-S7b row simply parses without them.
  Two implementations: `AdaptedDecisionModel` is S3's walk and session generalised, and a consumer PINS its served bytes (`adapterInstruction`, `adapterText`) so its fingerprint cannot drift - which is what made S7a a no-op by construction; `JevDecisionModel` (`decisions/jev/`, Biome-fenced so only `src/core/decisions/` and the composition root reach it) is TypeSafe's Jev, OFF by default behind the user's own 0600 key (`userData/decisions/<id>/`, never the settings row, never an env var), listed as an egress in `docs/architecture.md` §1, `INFINITARY_JEV_URL` dev-only.
  A native failure is answered by the adapter with one reason line; only the vendor's own 401 flips the row to `key rejected`, once per key, one feed line, no card.
  The surface is Settings → **Intelligence** (the tab's new label; the id, the `open subscriptions` effect and the e2e ids are unchanged) → Models → Decisions, hint "Efficient decision making", four `surface: "core"` channels off the frozen `models` namespace.
  `tests/e2e/decision-models.spec.ts` is the binding test and `pnpm score:kinds --decision-model jev` scores it.
  S7c asked whether a decision model should pre-sort supervision; the captain answered no (C7 A) - it shipped as the whose-turn rule, with no `decide()` in the report path at all.

## OpenRouter decision models (FI3-505)

Settings → Intelligence → Models → Decisions offers **Use an OpenRouter decision model** only while an enabled OpenRouter account is signed in (by browser sign-in or API key).
The picker lists choice-capable models from Pi's classifier catalog with maker and dollars per million input tokens; output is free.
These classifiers never appear in the chat model board or "Use a specific model".
TypeSafe Jev and its separate key form remain.

The accepted direction A uses `ModelRuntime.classify()` behind `src/core/pi/decisionModels.ts`, with the account selected by the same `AccountSelector` as work.
Pi owns and resolves that account's credential; the app neither reads it nor adds a second transport.
The address is `https://openrouter.ai/api/v1/systemone`, OpenRouter's System One equivalent of its alpha Decisions API.
GPT-6 Luna Decisions arrives with Pi 1.1.0, so the Pi packages are pinned to 1.1.0.

The current Pi 1.1.0 catalog offers seven decision models: Jev 1.13, Jev latest, Kev 4B, Solar Decide, Mercury Decide (free), Tev1 4B Experimental and OpenAI's GPT-6 Luna Decisions.
GPT-6 Luna Decisions uses the same setup, consent, account, usage and fallback as the others, with no key field.
Span's three yes/no-only models and unknown choice capabilities are excluded.
The catalog's classifier type alone does not say which question types a model accepts, so the seam keeps the established choice-capable IDs, intersected with Pi's catalog.
Liquid D1 is not currently in that catalog.

The first selection shows a note naming OpenRouter and the maker, the same bounded facts, the paying account and fail-soft fallback.
**Turn on** persists `{ kind: "openrouter", model }` and `egress.openrouter` consent for `DECISION_STATE_VERSION` 1.
Later model changes reuse that consent.
Returning to auto preserves consent and the pick may be restored without a second note.
Signing out hides the choice and uses the adapter; signing in restores it.
A fresh installation has neither pick nor consent and sends no decision call.

`OpenRouterDecisionModel` withholds the abstention and requires a recognized choice plus a finite confidence in [0, 1].
Below 0.6 it returns the consumer's abstention; missing confidence, malformed answers, errors, no credit and rate limits use the existing adapter fallback, with the reason in the task record, never a card.
Runtime construction and the request together are bounded to 15 seconds and honor caller cancellation.
A reply past 64 KB, an answer or a refusal, is `oversized` and the adapter answers, as for Jev.
The app reads the reply in Pi's request callback with the bounded reader Jev's transport uses: it is never read to the end, and Pi never parses it.
An oversized reply is never a verdict on the credential, even with a 401 status.
Retries are disabled.
Only a 401 asks the vault's existing credential owner to renew; 402/403/429 do not.
The account's normal health surface remains the sign-in authority.

Usage is recorded against the selected account and task under `openrouter`, with Pi's input and output counts, named by the model the reply says answered (`model_source = 'served'`) and priced at the cost the reply states (`cost_source = 'reported'`).
An alias answers as a dated model: `~typesafe/jev-latest` is recorded as, for example, `typesafe/jev-1.13-20260917`.
Pi's classify result keeps the requested model ID and prices the tokens from its catalog, so `classifyOpenRouter` reads the reply's `model` and `usage.cost` from the same bounded bytes its request callback hands Pi.
It never reads the request or its credential and sends nothing more: no second transport and no Pi change.
A reply that names no model is recorded under the pick (`requested`), and one that states no cost at Pi's catalog estimate (`listed-prices`).
The answer's source on the task names the served model as well (`classifier:openrouter/typesafe/jev-1.13-20260917`), while the row's last answer stays with the pick.
Certainty remains free prose, not a new field on `DecisionAnswer`.
The kind-of-work question remains the only consumer.

`INFINITARY_OPENROUTER_DECISIONS_BASE_URL` redirects only this classifier's request address inside Pi's request callback in unpackaged dev/e2e runs; packaged builds ignore it.
Hermetic tests use a stand-in System One server and fake account credentials, never a real OpenRouter login.
Live paid-model accuracy and optional-confidence compatibility remain unscored.
