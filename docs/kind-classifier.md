# The kind classifier

Intelligence-bucket routing S3 (captain-approved design 2026-09-18, `fm3000-intelligence-bucket-routing-s1/report.md` sections 3.4-3.5 and 6).
S1 gave the tier table a vocabulary, S2 gave it the facts the first mate can see, and both shipped with one stopgap: every kind was `unclear`, so R8 routed every unoverridden spawn high.
S3 is what fills that hole - one bounded call on the cheapest slotted model that answers a single question, *what kind of work is this*, and hands the answer to the table.

## Where it runs, and where it deliberately does not

`CrewSupervisor.classifyShape` is the only caller.
It runs in the spawn path before routing - at `commission` for an immediate spawn, at `dispatchQueuedTask` for a queued row when its gate opens - so a queued row is sorted against what it was commissioned with, as late as that can still change the outcome.

Three shapes are never classified, because the captain's table decides them *above* the kind and a call could only cost quota:

| shape | rule that decides it | recorded `kind_source` |
|---|---|---|
| `override_model_id` (the captain named a model) | R0 | `skipped:override` |
| `premium_ask` | R1a | `skipped:premium-ask` |
| `escalation` (S4's rung) | R1b | `skipped:escalation` |

A row whose `kind_source` already carries one of the classifier prefixes is never classified again (`kindEstablished`): the classifier is consulted at most once per row, ever.
Attaching a packaged plan-step line sets `kind` to `plan`, and a packaged teach line sets it to `teach`, even when one of those skips runs.
A named model still records `skipped:override`, and the kind is `plan` rather than `unclear`.
With no skip, these attachments record `host:plan-step` or `host:teach-step` and do not ask the classifier.
The one way back is a filed row whose named model is cleared with `update_task override_model_id` empty: its `skipped:override` becomes `none`, so it is classified when it starts.

Since S7 the classifier is the first CONSUMER of the decision-model class (`docs/decision-models.md`): `DecisionKindClassifier` (`src/core/routing/decisionKindClassifier.ts`) owns the question, the facts and the mapping to a `KindVerdict`, and `DecisionModels` owns which model answers it.
The adapter over one of the user's own subscription models and the native question share the retrieval criterion and whole-task boundary from `piResources.ts`.

## Bounded retrieval

`retrieval` means the whole task asks for facts and citations from existing evidence, within a bounded question and source or search scope, using lookup, extraction, factual summary or mechanical comparison.
Listing a disagreement without resolving it, or reporting a saved test outcome without running the test, can qualify.
Any required causal explanation, uncertainty resolution, investigation, diagnosis, experiment, bug reproduction, recommendation, design or change excludes the whole task even when most effort is lookup.
The dominant-effort rule applies only after retrieval is excluded.
“Read-only,” “simple” and “quick” are not shortcuts to this verdict; uncertain boundaries answer `unclear` and request high.
R10 requests low for retrieval and derives the existing answer deliverable, with no change to answer-card or closure behavior.
An older task's saved classification is not rewritten.

## Teaching

`teach` means the whole task is tutoring a learner through a subject or skill with lessons and practice (`docs/lessons.md`).
R2 requests high for it, below the same named-model, premium and escalation rules.
It is never an answer task: `deliverableFor` returns `change` for it even with a `read-only` constraint, so a choice on a lesson card never closes the subject (`SettleService.closeAnsweredTask`).
A teach task on the personal workspace has no gate to ship through, so its own turns are committed and never close it (`docs/lessons.md`, "The task").

## The call

The session comes from the binding's backend (`docs/decision-models.md`): a Pi-served model gets the Pi factory below, a Claude-served one the Claude factory (W1 S10, `src/core/claude/session.ts`: one query to the machine's own client, no tools, one turn, no thinking and the same 64-token output bound, no transcript), so a machine with only Claude signed in classifies too.

The question's session is a one-shot on the one session contract (`questionSessionSpec`, `src/core/decisions/questionSession.ts`).
On Pi, `createPiSessionFactory` (`src/core/pi/session.ts`) opens it in the removed consult factory's shape: `SessionManager.inMemory` so there is no session file and nothing to resume, compaction off, one retry, built-ins off, **no custom tools at all**, and the model's output clamped to 64 tokens.
The classifier cannot read, cannot call anything, and cannot say more than a word.
`classifierSession.realSession.test.ts` pins that call shape the way the other three personas' contract tests pin theirs.

The instruction is `buildKindClassifierInstruction` in `piResources.ts`, pinned by the kind question as its `adapterInstruction` (S7a) so the served bytes cannot drift when the class moves around it: byte-stable and interpolation-free, so the provider's prefix cache holds and a recorded verdict is attributable to an exact question.
It is versioned (`KIND_CLASSIFIER_INSTRUCTION_VERSION`) and fingerprinted (`kindClassifierInstructionSha`); a verdict's `version` is `kc<version>-<sha12>`.
**Changing the text means bumping the version.**
The instruction deliberately says nothing about tiers, models, quota or cost: a classifier that knows what its answer buys starts judging the tier, which is exactly what the redesign took away from the first mate.

The work itself rides one bounded user message (`buildClassifierPrompt`): title, goal, the captain's words verbatim, the typed constraints, the repository and its delivery posture, and - only when a basis was named *and verified* - that task's key, title and outcome head.
Nothing else: no transcript, no repo map, no fleet state.

The binding walk is the retired supervision session's, reused: `orderCandidates` low-first over the routable pool, premium never a candidate, a candidate whose def cannot carry the turn skipped, a dead account store tried past, and the flagship account held back until nothing else can bind.
Claude's models compete in the same walk as everyone's (the owner's Q3 a); an account a cut-off withholds has no models in the pool, and a cut-off the classifier itself sees is recorded on the account like a crewmate's.

## Fail-soft, and what the record says

Every failure wears the same coat - `unclear`, which R8 routes high, exactly as S2 behaved - and every one of them says which failure it was:

| `kind_source` | what happened |
|---|---|
| `classifier:<provider>/<model>` | a kind was read off the model |
| `classifier-abstained:<provider>/<model>` | the model itself answered `unclear` |
| `classifier-failed:no-model` | nothing signed in could serve the call |
| `classifier-failed:provider` | the turn came back a provider error (a typed cut-off among them, recorded on the account too) |
| `classifier-failed:timeout` | the 15s wall clock, which covers creating the session as well as its turn - the spawn path's own deadline (`AbortSignal.timeout`, which runs out first) or the adapter's |
| `classifier-failed:aborted` | the caller cancelled the call |
| `classifier-failed:unparsed` | the answer named no kind, or two |
| `classifier-failed:error` | the session could not be created |
| `classifier:jev/jev-1.13.0` | a native decision model answered (S7b, off by default) |

`classify` never throws and never blocks a dispatch past `CLASSIFY_TIMEOUT_MS`.
The stamp lands on `tasks.shape` - with `kind_detail` when there is anything to say about HOW the kind was established, which is a native decision model's own certainty or the note that one failed and the adapter answered in its place - and leads the `routing_decisions` reasons through `shapeReasons`; the classification's tokens land in `usage_events` under the task id and the serving account, so Observe shows what a classification cost.
There is no feed line and no card: a shape explains a routing decision, it is not one.
The stamp is also what the classifier-source share is counted from - folded to classified / abstained / failed / skipped by `kindSourceClass` (`docs/replay-harness.md`, `docs/corpus-export.md`) - and Observe's session header renders it beside the rule (`docs/dev-observe.md`).

## Measuring it

`pnpm score:kinds` (`scripts/score-kind-classifier.ts`) scores the labelled fixtures.
It reads every `spawn_crewmate` recorded in the `-real` replay fixtures - the captain's own hand-scrub-reviewed Sep 4 and Sep 14 evenings - runs the real classifier over them, and scores against `tests/fixtures/kind-classifier/labels.jsonl`, the hand-labelled sample keyed by a hash of each spawn's own words.
It sits behind Observe's development gate like the corpus export and the replay harness, and it is the one such script that can reach a provider, because scoring a classifier means running it.

```
pnpm score:kinds --dry                       # the historical corpus and labels, offline
pnpm score:kinds --cases tests/fixtures/kind-classifier/retrieval-boundary.jsonl --dry
pnpm score:kinds --models <models.json> --provider <p> --model <m> \
  --api-key-env OPENAI_API_KEY --out report.json
pnpm score:kinds --provider anthropic-claude --model <m> --out report.json
```

The Claude form runs the machine's own Claude client on its default login, exactly as the app does, and spends that login's allowance.
It loads no Pi runtime or session factory: the Claude binding needs neither a Pi catalog nor its auth/models stores.
Shared crewmate tool definitions also stay independent of Pi's tool generator (`pi/crewmateTools.ts`), so opening a Claude session does not initialize the Pi SDK through those definitions.
The boxed corpus integration exercises this same command against the hermetic client and local API, with Pi SDK imports refused, within its existing 15 s budget; `INFINITARY_CLASSIFIER_EVIDENCE_DIR` on that test optionally keeps the scored report, command output and served request for inspection.

`--cases <file>` scores a separate labelled boundary corpus rather than treating synthetic contrasts as recorded first mate spawns.
Each JSONL row carries its source provenance (`task-excerpt` or `synthetic`) and an expected kind beside the actual input words and constraints.
The report keeps that provenance and the exact adapter/native instruction and version.
The historical labels revise only two formerly-research factual asks: `42291b567612` (the “To land” definition in code) and `7fcb02d43484` (one task's recorded worktree chronology and current status).
The underlying replay transcripts and all other labels stay unchanged.
Dry runs and scripted model verdicts prove corpus loading and plumbing, not live semantic adherence.
A live run requires an authorized isolated provider binding: a Pi model file and a named key environment variable under scratch HOME, or a Claude client deliberately signed in under scratch HOME and its own configuration directory.
Never run that check against the captain's real login.

For Pi runs, `--api-key-env` sets the key on the runtime in memory: it never reaches `models.json`, argv, or a log.

The numbers it reports, and why each one is there:

- **tier distribution** - what the fleet would actually route at;
- **abstain rate / failure rate** - how often the classifier declines or breaks, both of which are R8 and therefore high;
- **agreement** - exact kind against the hand label;
- **tier agreement, `under_routed`, `over_routed`** - what a disagreement *costs*.
  The two directions are not symmetric: routing cheap work high wastes quota, while routing expensive work low is the failure the captain would feel.
  `under_routed` is the number to watch.

## The classifier's class

The classifier is an adapted decision model.
The question pins the instruction and the user message, so the stamp does not move when the walk and the session live in `AdaptedDecisionModel`.

Jev is a native answerer, off by default behind the user's own key.
`KindVerdict` carries no confidence: nothing fills one, and a floor at `resolveKind` could only re-judge a number that does not exist.
A stored shape may still carry a historical `kind_confidence`; the schema drops it.

Unchanged: the `KindClassifier` seam, `KIND_SOURCE`, `resolveKind`'s `unclear` path, `classifyShape`'s skips and stamp, the four slots, and the first mate tool schema.
The first mate still learns nothing about which model sorted its spawn.
