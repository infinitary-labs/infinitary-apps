# The kind classifier

Intelligence-bucket routing S3 (captain-approved design 2026-09-18, `fm3000-intelligence-bucket-routing-s1/report.md` sections 3.4-3.5 and 6).
S1 gave the tier table a vocabulary, S2 gave it the facts the first mate can see, and both shipped with one stopgap: every kind was `unclear`, so R8 routed every unoverridden spawn high.
S3 is what fills that hole - one bounded call on the cheapest slotted model that answers a single question, *what kind of work is this*, and hands the answer to the table.

## Where it runs, and where it deliberately does not

`CrewSupervisor.classifyShape` is the only caller.
It runs in the spawn path before routing - at `commission` for an immediate spawn, at `dispatchQueuedTask` for a queued row when its gate opens - so a queued row is sorted against what it was commissioned with, as late as that can still change the outcome.
A queued row's verdict is written as the host's stamp fields onto the row as it stands when the call returns (`TaskService.recordShape`, `HOST_STAMP_FIELDS`).
A model, a basis or any other field a person owns (`CAPTAIN_OWNED_SHAPE_FIELDS`), named or cleared while the classifier ran, stays, and the tier is computed from that row (`CrewSupervisor.classifyQueued`, INF-83, INF-416 piece F).

Operations are never classified: their deliverable routes through R12 after the higher-priority choices, and their source is `skipped:operation`.
Three other shapes are never classified, because the captain's table decides them *above* the kind and a call could only cost quota:

| shape | rule that decides it | recorded `kind_source` |
|---|---|---|
| `override_model_id` (the captain named a model) | R0 | `skipped:override` |
| `premium_ask` | R1a | `skipped:premium-ask` |
| `escalation` (S4's rung) | R1b | `skipped:escalation` |

A row whose `kind_source` already carries one of the classifier prefixes is never classified again (`kindEstablished`): the classifier is consulted at most once per row, ever.
The first mate may declare the kind on spawn or create; the row records `firstmate:declared` and the classifier is not asked.
The host no longer reads the text of a relayed plan or lesson line to decide its kind.
A declared kind is an establishment just as a classifier answer is, so queued dispatch keeps it.
The one way back is a filed row whose named model is cleared with `update_task override_model_id` empty: its `skipped:override` becomes `none`, so it is classified when it starts.
A model cleared while a queued row's start is skipping the classifier leaves nothing to skip, so that row is classified as it now stands.

Since S7 the classifier is the first CONSUMER of the decision-model class (`docs/decision-models.md`): `DecisionKindClassifier` (`src/core/routing/decisionKindClassifier.ts`) owns the question, the facts and the mapping to a `KindVerdict`, and `DecisionModels` owns which model answers it.
The adapter over one of the user's own subscription models and the native question share the retrieval criterion and whole-task boundary from `piResources.ts`.

## Kinds nest under the deliverable

The kinds sit under what the work delivers (`KINDS_BY_DELIVERABLE`, INF-1430 piece 1): `retrieval`, `research`, `plan` and `reproduce` under an answer, `implement`, `fix` and `chore` under a change.
`classifyShape` passes the deliverable the first mate's `read-only` declaration makes (`deliverableFor`), never the kind it is about to give, and the classifier is offered only that branch's kinds and `unclear`.
The adapter's instruction stays one byte-stable text that teaches both branches; its user message names the deliverable and the kinds it may answer with, and the parse accepts only those, so a word from the other branch is `classifier-failed:unparsed`, which R8 routes high.
A native model is asked the branch's own question (`KIND_QUESTIONS`), with only that branch's options.
A crewmate's filed follow-up declares nothing: it is offered every kind, and its kind decides its deliverable.

## Bounded retrieval

`retrieval` means the whole task asks for a fact, or how or why something is so, read from what this app can already read: the code and its history, the task record, the docs, and the current state of what it connects to - the fleet's computers, and the project's checks, runs, logs and pull requests where it lives.
It may locate, quote, extract, list, summarize, compare records by a fixed rule, or trace how or why through them, within a bounded question and source or search scope.
Listing a disagreement, explaining why records here disagree, or reporting a saved test outcome without running the test can qualify (INF-1430 revised FI3-1237's line that a causal explanation is never retrieval).
An answer that needs a computer the app does not reach, a cause traced across past runs, a behavioral experiment or measurement, a bug reproduction, the web or an outside report, an audit, a recommendation, a design or a change excludes the whole task even when most effort is reading.
Reading that state now - which job is running or waiting its turn, whether a running job is stuck, what a setting or label says - can be retrieval; finding out why something got slow, failed or restarted across past runs is research.
The dominant-effort rule applies only after retrieval is excluded.
“Read-only,” “simple” and “quick” are not shortcuts to this verdict; uncertain boundaries answer `unclear` and request high.
A retrieval crewmate's brief tells it to stop at that boundary: its card says what is and is not established, names the source still needed, and makes Look deeper the default (`renderAnswerShapeSection`).
R10 requests low for retrieval; for work the first mate commissioned the kind never decides the deliverable, which only the typed `read-only` constraint makes an answer (`docs/delivery-rigor.md`, "The deliverable axis").
An older task's saved classification is not rewritten.

## The call

The session comes from the binding's backend (`docs/decision-models.md`): a Pi-served model gets the Pi factory below, a Claude-served one the Claude factory (W1 S10, `src/core/claude/claudeOneShotSession.ts`: one query to the machine's own client, no tools, one turn, low effort, no transcript), so a machine with only Claude signed in classifies too.
Claude classification keeps the client's model-specific output allowance rather than the Pi path's 64-token cap: Claude's output includes hidden thinking, which Sonnet 5.5 can use even when the session requests thinking disabled (INF-1451).
The question still asks for exactly one kind, and the adapter's 15-second deadline still covers the whole call.
No classification is re-asked to repair an empty reply; the original request has room to finish its thinking and return the word.

The question's session is a one-shot on the one session contract (`questionSessionSpec`, `src/core/decisions/questionSession.ts`).
On Pi, `createPiSessionFactory` (`src/core/pi/session.ts`) opens it in the removed consult factory's shape: `SessionManager.inMemory` so there is no session file and nothing to resume, compaction off, one retry, built-ins off, **no custom tools at all**, and the model's output clamped to 64 tokens.
The classifier cannot read or call anything, and its instruction asks for one word.
`classifierSession.realSession.test.ts` pins that call shape the way the other three personas' contract tests pin theirs.

The instruction is `buildKindClassifierInstruction` in `piResources.ts`, pinned by the kind question as its `adapterInstruction` (S7a) so the served bytes cannot drift when the class moves around it: byte-stable and interpolation-free, so the provider's prefix cache holds and a recorded verdict is attributable to an exact question.
It is versioned (`KIND_CLASSIFIER_INSTRUCTION_VERSION`) and fingerprinted (`kindClassifierInstructionSha`); a verdict's `version` is `kc<version>-<sha12>`.
**Changing the text means bumping the version.**
The instruction deliberately says nothing about tiers, models, quota or cost: a classifier that knows what its answer buys starts judging the tier, which is exactly what the redesign took away from the first mate.

The work itself rides one bounded user message (`buildClassifierPrompt`): title, goal, the captain's words verbatim, the typed constraints, the repository and its delivery posture, what the work delivers with the kinds it may be sorted into, and - only when a basis was named *and verified* - that task's key, title and outcome head.
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
pnpm score:kinds --cases tests/fixtures/kind-classifier/answer-lanes.jsonl --dry
pnpm score:kinds --models <models.json> --provider <p> --model <m> \
  --api-key-env OPENAI_API_KEY --out report.json
pnpm score:kinds --provider anthropic-claude --model <m> --out report.json
```

The Claude form runs the machine's own Claude client on its default login, exactly as the app does, and spends that login's allowance.
It loads no Pi runtime or session factory: the Claude binding needs neither a Pi catalog nor its auth/models stores.
Shared crewmate tool definitions also stay independent of Pi's tool generator (`pi/crewmateTools.ts`), so opening a Claude session does not initialize the Pi SDK through those definitions.
The boxed corpus integration exercises this same command against the hermetic client and local API, with Pi SDK imports refused.
Its test-only clock (`tests/helpers/classifierClock.ts`, preloaded in the scorer child) counts the existing load clock for both deadline forms during ordinary runs; performance runs keep their native 15 s wall deadline.
The runner's capped limit still ends a stuck integration, and `decisionKindClassifier.test.ts` independently checks the production deadline during session creation, a hung turn and a turn that ignores cancellation.
The app and a normal scorer invocation never load that test clock.
`INFINITARY_CLASSIFIER_EVIDENCE_DIR` on the integration optionally keeps the scored report, command output and served request for inspection, including a failed verdict.

`--cases <file>` scores a separate labelled boundary corpus rather than treating synthetic contrasts as recorded first mate spawns.
Each JSONL row carries its source provenance (`task-excerpt` or `synthetic`) and an expected kind beside the actual input words and constraints, and may carry a hand `lane`, `quick` or `deep`.
The scorer offers each row the branch its constraints declare, as the app does (`deliverableOf`), and reports each lane's tiers under `lanes`.
`answer-lanes.jsonl` holds the 155 delegated answers INF-1383 labelled from October 16 to 26, 44 quick and 111 deep, with names and private paths scrubbed and the step lines the first mate relayed under the old guidance left out, so a run measures what the words alone say.
The captain's line on where here ends (INF-1430) moved seven of those labels: the current state of what the app connects to is quick, and a cause traced across past runs, a run, a recommendation or a design is deep.
The fast lane's bar on a live run is at most 5 deep cases routed low and at least 30 quick ones (INF-1430).
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
