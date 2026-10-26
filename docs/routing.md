# Routing

How a crewmate's model is chosen: the capability, premium and slot boundaries around the ladder, the computed tier, escalation, and same-tier order.
Model lists are `docs/model-lists.md`; decision models are `docs/decision-models.md`; the kind is `docs/kind-classifier.md`.

## Starting with Dynamic routing off

Every fresh crewmate still needs an eligible model and the account that serves it.
When Dynamic routing is off, `CrewSupervisor.routeTask` uses `Router.initialChoice` to evaluate the same pool, work shape, capability checks, allowance and premium boundaries before selecting an account through the existing account selector.
A model named for that task remains a one-off pin; saved Always use pins apply only with Dynamic routing on.
The initial choice is recorded through the same decision ledger and bound through the same session binder; credentials never move into the base store.
If no model or account can serve a local start, startup explains that before opening a session, rather than asking the account-less engine for a default model.
Dynamic routing off still disables automatic computer comparison and previews for moving running work.

## Bounded fact retrieval

R10 maps classifier-owned `retrieval` to low: the whole task must ask for a fact, or how or why something is so, read from what this app can already read - the code and its history, the task record, the docs, and the current state of the computers, checks and GitHub runs it connects to (`docs/kind-classifier.md`).
An answer that needs a cause traced across past runs, a computer the app does not reach, a reproduction, a measurement, the web or an outside report, an audit or a design excludes that route; ambiguous work still reaches R8 high.
A retrieval crewmate stops at that boundary rather than climbing on its own: its card says what is and is not established, names the source still needed, and makes Look deeper the default, which the first mate answers with a read-only research step built on that answer (INF-1430).
R0 named models, R1a premium asks and R1b escalation remain above it, and pins, capability and availability keep their existing precedence and fallback.
Low is the requested slot, not a promise of the served model: both slots remain in the routing ledger.
The task record and crew summary say “Looking up or explaining from what is here” when R10 serves as requested, or retain the existing named-model, pin or fallback reason when one applies.
Settings → Usage calls the saved kind “Lookups and explanations”, past lookups included; older saved research and reproduction remain as they were.

## Teaching

R2 maps `teach`, established by the classifier or a packaged teach line, to high, the captain's choice on FI3-1466: the slowest and most careful model plans each round and keeps the learner's records.
The task record and crew summary say "teaching".
Settings → Usage calls the saved kind "Lessons".
Named models, premium asks and escalation stay above it (`docs/lessons.md`).

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The routing redesign (captain decisions A/B/C, 2026-09-01; Three boundaries now sit around the ladder in `routingEngine.route()`, and each has a single home:
 - **Capability** (`src/core/routing/capability.ts`): a candidate's def is resolved BEFORE it is chosen (`src/core/pi/modelCapability.ts` reads it out of the same runtimes the session will use, so it is the `withHonestReasoning`-corrected def) and skipped with a recorded reason when it cannot carry the turn - images or context.
   High-slot placement is trusted fully (no reasoning skip).
   A def no runtime knows is UNKNOWN, not incapable.
   There is deliberately NO failure/incident ledger; the captain cut it.
 - **Premium** (`PREMIUM_SLOT` / `AUTO_ROUTABLE_SLOTS` in `src/shared/modelSlots.ts`): a fourth slot above high that crewmate automatic selection NEVER picks - not in `route()` or the cheap-first candidate walk (`src/core/routing/candidates.ts`, including its uncatalogued tail).
   The first mate's Auto instead tries high → medium → premium → low across Pi and Claude in one pool; premium is its automatic fallback before low.
   A premium starter row (`claude-fable-5-1` on Claude, `gpt-6-astra` on Codex) is pinnable without a settings trip; crew never auto-picks it.
   GPT-6 Sol is the high and medium default and GPT-6 Luna is low on Codex (`STARTER_SLOTS`; migration 39 moves a saved GPT-5.6 pick onto the Sol and Luna rows).
 - **Slots** (`src/core/routing/modelSlots.ts` + `src/shared/modelSlots.ts`): a per-OFFERING record (decision C - the same id can sit in two slots on two providers; never dedupe ids across providers).
   Seeded from `STARTER_SLOTS` on first activation only; a LISTED newcomer from a successful read arrives off unless the map names them, and is announced once, and a listed or kept model a later successful read no longer serves is announced once as gone (`ModelSlots.departures`).
   Off = in no slot.
   The fallback ladder is slotted → starter map virtually → every listed model at medium → the whole signed-in pool: a shortlist is a preference, never a way to brick routing.
   Pins bypass it - naming a model is its own placement.
   Per-account control is the account's pause, not a second toggle.
   Every skip and every rung lands in `routing_decisions` / `account_decisions`; never quiet it.
 - **The tier itself** is COMPUTED from the work's SHAPE, never judged (captain-approved 2026-09-18, `fm3000-intelligence-bucket-routing-s1/report.md`).
   Its two homes: `src/shared/routingPolicy.ts` is the shape (kind, basis, premium_ask, override_model_id, escalate_from, escalation) and the policy as DATA, so a later user override reads the same definition the way `model-slots` overrides `STARTER_SLOTS`; `src/core/routing/policy.ts` is `tierFor` - pure, reads no task text, and hands an `override_model_id` back as a pin because it knows no slot record (`Router.decide` resolves that pin's own slot as the tier).
   The kind comes from `KindClassifier` (`kindClassifier.ts`; the `none` implementation abstains, and `unclear` routes HIGH by the captain's call), never from the engine and never from the first mate.
   Premium stays unreachable automatically: only a captain ask or the bounded escalation rung.
   The spawn carries the facts (contract v2.8) and `CrewSupervisor.commission` builds the shape: it checks the basis against the record (done, or carrying an outcome - an unverified basis routes high; a verified basis routes `implement` work at medium under R4, with medium reasoning when served at medium; planning stays high under R2, and a grounded `fix` (R6) also routes medium) and stores the shape on `tasks.shape_json`, so a queued row dispatches from what it was commissioned with (a filed row takes a model the captain names later through `update_task override_model_id`, contract v4.46, into the same field); the rule lands on `routing_decisions.rule` beside the shape's reason lines, and the C5 join carries `shape`/`tier`/`rule` as the classification's label.
   A named model routes only when it can serve and otherwise falls back with no feed line, so whenever the first mate hears that work the captain named a model for has started, it hears the model that took it, saying so when the named one was not available and never confirming it when no model is recorded (FI3-444, `src/core/orchestrator/namedModel.ts`, matched the way `Router.decide` matches the pin): `spawn_crewmate`'s answer, `update_task start_now`'s answer, and the queued-started wake of work whose wait ended.
   `tasks.difficulty` still holds the tier, computed now - an older row (or a recorded spawn in replay) is translated by `legacyShapeFromDifficulty`.
   The kind comes from a model (`docs/kind-classifier.md`; the implementation is `DecisionKindClassifier` over the decision-model class, and the default answerer is the question's one-shot on the session contract (`decisions/questionSession.ts`), served by `pi/session.ts` or by its Claude twin `claude/session.ts` when the walk binds a Claude model): one bounded call on the cheapest slotted model, the cheap-first binding walk, a byte-stable versioned instruction, and fail-soft - every failure and the model's own abstention are `unclear`, which R8 still routes high, each naming itself in `kind_source` (`KIND_SOURCE`).
   It is skipped, with a `skipped:` source, exactly where the table decides above the kind (R0/R1a/R1b), runs at most once per row (`kindEstablished`), costs one row in `usage_events` under the task, and reaches no user surface.
   `pnpm score:kinds` scores the labelled fixtures and the hand labels in `tests/fixtures/kind-classifier/`; bump `KIND_CLASSIFIER_INSTRUCTION_VERSION` when the instruction text changes and re-run it.
   The routing numbers - tier distribution, classifier-source share, downgrade rate, escalations per lineage - have ONE home, `scoreRouting` in `scripts/interaction-metrics.ts`, fed by `ObservedDispatch` rows so the replay gate and the offline corpus export (`manifest.routing`) cannot disagree; a distribution has no good direction, so those metric rows are `direction: "either"` - written to the baseline, never graded by the gate - while the downgrade rate and the escalation depth still are.
   Migration 35's `routing_decisions.served` is what makes a downgrade a join instead of a regex over the reasons prose, and Observe's crewmate header renders rule/tier/served/kind-stamp (`docs/dev-observe.md`) - the only surface in the app that shows them as recorded.
   The crewmate summary's reason line (below) says the same decision in the captain's words.
 - **Escalation** is that ladder's one automatic rung and the CAPTAIN opens it : `spawn_crewmate` carries `escalate_from` - no new tool, the count stays 24 - and the field is refused as text at the tool boundary on any turn that is not a captain turn (`CrewDelegate.isCaptainTurn`, the wake stamp `remember` reads), so a crewmate's own "I am blocked" never climbs; that report earns one decision card with a non-default premium way when it can serve, otherwise the stronger-model fallback when a rung remains, and only the captain's click is the say-so (O2).
   `CrewSupervisor.resolveEscalation` refuses before anything exists - an unknown task, one that never ran ("never on first dispatch"), a lineage past `maxEscalations` (2), or nothing above premium - then `applyEscalation` links the pair `discovered-from`, writes the two `escalated` timeline rows (the rejected attempt's is the move's ONE feed line; the supersede's own close is `feed: false`) and `supersedeAttempt` interrupts the attempt and closes it `dropped`/`superseded` with `escalated_to`, its worktree and branch retired like any close but ALWAYS saved first on its kept ref, which the brief names (O1).
   Discard, rework, cancel and a failed turn share a best-effort close of the abandoned attempt’s open pull request; success or a failure is recorded on its timeline, and a host failure never prevents local cleanup.
   Existing closed tasks are not revisited.
   The fresh row inherits kind, basis, repo and parent; a clicked premium way also carries `premium_ask` and stamps premium as the floor (R1a outranks R1b), while a stronger-model click takes the next rung.
   It is briefed by `renderEscalationBrief` (Q4 B: a fresh crewmate, never a resume).
   `neverDowngrades` is the never-downward gate: an escalation queues on its tier's quota reset rather than starting at the tier that already failed, at commission and at dispatch alike.
   A premium ask that cannot be served waits the same way, on a `bucket:<tier>` gate that `quotaGateCleared` (`src/core/routing/quotaGate.ts`) clears once an available model placed at that tier has headroom or unknown headroom.
   When no available model sits at that tier at all, the route says so (`emptyBucket`): no reset ends that wait, and the first mate's `reasoning-wait` wake says it ends once a model is placed there.
   An Automatic task is held the same way, with the same gate and one wake, when no computer serves its tier (`floorHold`; `docs/helper.md`, "Automatic starts").
   The task's record says why it waits and what ends the wait (`docs/task-record.md`, "A held task says why").
- Reasoning effort: a fresh crewmate with a routed model inherits the served slot's table level (`src/shared/routingPolicy.ts`: premium/high xhigh, medium/low medium).
  Pi clamps to the nearest offered level at or below it (or the lowest offered); Claude sends the level explicitly on its opening query for supported models and omits it for legacy Haiku.
  Haiku 5.5 receives medium for ordinary low-slot work and low for Quick; saved slot choices remain untouched.
  Settings → Intelligence → Models offers a reasoning menu beside each model in each used level.
  An explicit provider/model/served-level choice overrides that default, after routing, and keeps its chosen level under Quick care, bounded by the executing backend's capabilities.
  A reasoning effort the captain named for the task (`override_reasoning` on its shape) outranks that choice for this task alone and is treated the same way; the Settings choice is unchanged.
  An inherited choice whose derived rigor is Quick moves one offered rung below that clamped level, if possible.
  Standard and reviewed rigor, answers, reviewers and the personal workspace do not step down.
  A named model or premium ask with inherited reasoning still takes the adjustment; an escalation raises the slot first.
  A resumed conversation retains its opening level.
  The session says what it opened at (`ModelSession.reasoning()`, FI3-439: the level after the cap and the Quick step, why it is lower - `quick` or `capped` - `off` for a model the runtime marks as not reasoning, `default` where Claude sends none), the supervisor records it on the `dispatched` timeline row beside the model, and `TaskDetail.reasoning` carries the newest one while the record still names that model; the crewmate summary shows it.
- Same-tier routing order: spend priority first (quota-axi ranking semantics - the scope whose paid allowance is most on track to expire unused; a known signal, even negative, outranks an unmeasurable one, and unknown is NEVER zero), then a newer id within the same model line (dotted/dashed version tokens; the line is the id's prefix AND suffix around the version, so gpt-5.6-luna never outranks gpt-5.3-codex-spark) still overrides; unmeasurable candidates keep runway order (`newerId` + the ranked pool in `src/core/routing/routingEngine.ts`; the account pick in `accountPolicy.ts` ranks the same way).
  Spend priority ranks inside three groups (INF-898, `compareSpendRank` in `src/shared/quotaSignals.ts`): a fresh, known score whose scope is projected to last through every reset (`lastsThroughReset`, the scope's runway at its observed burn), then a known score projected to run out first, then an unmeasurable one.
  So a tight session outranks a weekly surplus: a model whose session runs out before its reset yields to one at the same level that lasts, whatever their scores.
  Recency overrides only inside the leader's group, and the reasons name a higher-scored model passed over because it runs out.
  Nothing becomes ineligible for it: pins, slots, capability, the reviewer's provider, the 0% exclusion and the fallback ladder are unchanged, and a running crewmate keeps its model.
  The model catalog's best account per model, a computer's own pool and the account pick rank the same way.
- A task on a computer that runs work routes among that computer's own subscriptions, never this Mac's (`docs/helper.md`, "A task's model"): `Router.decide` takes a `pool` in place of this Mac's models and quota catalog, the slot record, pins and the ladder read it as they read this Mac's own, and its reasons name it.
  No account of this Mac's is selected for such a task.
  A sign-in there with a typed cut-off standing on it, as its rows say, leaves that pool as a withheld account here leaves this Mac's; when nothing else there serves, the task waits for that sign-in rather than starting.
- Serveability (`docs/quota.md` "The cut-off on the account"): an account withheld by a fact beside its credential - no client to run it, or a standing `refused` / `signed_out` cut-off - leaves the routing pool (`AccountVault.availableModelsByAccount`), is never the flagship, and is skipped by account selection with `withheld (<reason>)` in the spawn's `account` row, which also names a withheld account of another provider that routing never reached.
  One predicate, `servesModels`, answers for every reader.
  A spent allowance is not withheld: its pushed `rejected` reading is a zero window until the reset, read like any other headroom.
  A task served from a weaker slot than it asked for says so in the feed (`downgradeLine` in `src/core/orchestrator/crewSupervisor.ts`), and the line names the cause from typed facts.
  `Router.preview` reruns the same ladder with the withheld accounts' models back in the pool (`AccountVault.withheldModels`); when that run serves the slot asked for from one of them, the route carries its provider and the account's reason (`RouteResult.withheld`, also a line in the routing reasons).
  The line then says that provider's models in the slot are paused until you sign in again, while it refuses your sign-in, or because it cannot run on this computer.
  Otherwise, including when the withheld model's own allowance is spent, the line says that slot's models have used up their allowance; a computer's own pool carries no withheld cause.
- **A move leaves a provider out** (INF-849): `withoutProvider` removes one provider from what may serve - the available models, a computer's unlisted ones and the pins - with no fallback to it, unlike R9's `avoidProvider`, and adds a reason line naming it.
  A started task moving off the provider that failed it routes this way on its own shape, and finds nothing when only that provider serves (`docs/task-record.md`, "Moving a started task to another provider").
- **Why this model** (FI3-427, captain's pick 2026-10-01): the crewmate summary on the home stage, and the task record's shared facts since FI3-565 piece 2, say under the model's name why it was chosen (`docs/crew-orbits.md` "The summary").
  `modelReasonOf` (`src/core/routing/modelReason.ts`) builds `TaskDetail.modelReason` from the TYPED columns of the task's newest routing decision that chose something - `rule`, `bucket`, `served` - beside the shape it was made from (the kind for R2, the basis key for R4/R6, the rejected attempt for R1b, the builder for a review, and whether another provider than the builder's served an R9 review, read off the builder's own decision at that time).
  It never reads the reasons prose.
  Two facts are derived at the read because the row has no column for them: `named` (R0, and the served model is the one the shape named) and `pinned` (the served model is a current Settings pin, which outranks every slot).
  It is absent when the task never routed, when the row predates the rule column, or when the record's model is not the one the decision chose, so the line never explains a model the crewmate is not on.
  The record's model follows the model that answers: when Claude Code moves a crewmate to another model, the record names it and the routing ledger keeps the router's decision as it was made (`docs/claude-client.md`, "The model that answers").
  `modelReasonLine` (`src/shared/modelReason.ts`) is the one wording: the captain's own choice first ("You asked for this model", "You pinned this model in Settings"), then a slot that could not serve ("No high model could take it"), then the rule's reason ("Building from the plan in FI3-419").
  Since FI3-439 the line never leads with the level: the summary shows the served level and the reasoning as their own labeled values, and `modelFootnote` adds why the reasoning is lower ("Reasoning one step lower for Quick care.").
  Why one model won over another inside a slot (spend priority, recency) is still prose only and is not shown.

## Read-only computer evaluation

`Router.preview` evaluates a computer's own pool with the same policy, pins, slots, capability checks, quota facts and premium boundary as `decide`, without writing a routing decision.
`decide` calls that path; Automatic placement records only its chosen preview through `Router.commit` inside the task commitment transaction.
Previews themselves neither write decisions, bind an account nor reserve allowance.
The preview carries the result, reasons, a preference rank and the existing premium/escalation waiting rule (`requiresReasoningWait`), which the supervisor also reads.
A named model ranks first, then saved pins in order, then the existing slot ladder's order (`fallbackRank`); the rank reads typed choices, never the reasons prose.
A preview made while dynamic routing is off is absent, not a claim that a computer can serve a model.

`evaluatePlacement` (`src/core/routing/placementEngine.ts`) is the pure computer-policy seam beside that model owner.
It consumes declared requirements, receiver-owned observations, per-computer model previews and pending reservations and returns a choice or a wait with typed candidate reasons.
Each computer comes with the core's one reach value (`reachFrom`), which its evaluation carries as it came: a connecting computer is still refused as out of reach, and its wait and saved explanation read connecting.
It performs no sampling, preparation, account access, database writes or task starts.
`AutomaticPlacement` calls it inside `TaskService.commitPlacement` before a new Automatic task starts; explicit selections keep their existing start path.

### Requirements and defaults

`placementRequirementsSchema` (`src/shared/placement.ts`) describes optional OS, execution architecture, required tools and workload profile for a project or task.
Only the existing Mac and Linux work platforms qualify; the architecture is what the process executes, not inferred hardware capability or emulation support.
Task platform declarations intersect project declarations, required tools are united, and a task cannot lower a declared project resource profile.
Without a platform declaration, the home platform is the conservative default: a Mac task is not presumed portable to Linux, nor an Arm task to Intel.
The resolver says which platform fields it filled from the home's own (`inherited`), so an added computer that default leaves out is told rather than silent (`docs/helper.md`, "Automatic starts").
An unknown home platform or an empty intersection admits nothing.
A working copy requires git; every other tool must be declared by identity, never discovered by parsing task text.
The caller supplies typed access to the particular project and the tools on each computer; missing or unknown facts exclude that computer.
Project configuration and task tools persist declarations through their existing owners; `AutomaticPlacement` collects fresh compatibility facts before using this seam.

The profile is independent of model-routing kind: a research task may use a browser, and a build may launch large tools.
The default is `standard`; an explicit `conversation` profile requests 0.25 logical CPU and 512 MiB, `standard` requests 0.5 logical CPU and 2 GiB, and `heavy` requests 2 logical CPUs and 4 GiB.
These are initial admission allowances, not measured peaks, process-enforced limits or a guarantee about later work.
CPU capacity is 80% of the observed idle logical CPUs.
Memory room starts from installed memory minus the one memory-used figure, then keeps the larger of 512 MiB and 10% of installed RAM untouched, then subtracts pending demand.
The home's receiver works that figure out once for each fresh reading (`memoryUsedBytes` in `src/core/placed/memoryUsed.ts`).
A reading with no figure is refused, as a missing Linux estimate is.
Linux is a reading that carries its available-memory estimate: the figure counts installed memory minus that estimate as used.
A Mac is a reading that carries purgeable or file-backed bytes.
At normal pressure the figure counts free, speculative and inactive memory as free, and also free, purgeable and file-backed bytes, and keeps the larger free part, capped at installed memory.
At warning or critical pressure nothing counts as free, so the figure reads all installed memory as used and the Mac has no memory room.
A waiting task still says it is short of spare memory.
A Mac reading without pressure, or without inactive and speculative bytes, counts free, purgeable and file-backed bytes as free, as a reading from an older computer or a failed read does.
Anything else has no figure.
A Mac in ordinary use keeps almost no page free, so free bytes alone would read a Mac with room as full.
The observation still carries every raw count, and the figure is the only number a reader uses.
`tests/e2e/automatic-placement.spec.ts` starts an Automatic project task on the computer that runs the suite, once on a model routing names and once on that computer's own default when routing names none: the Mac mini on a pull request and in the full suite's Mac lane, and the hosted Linux virtual machines in the full suite.
Memory, macOS page and pressure reads, computer identity, program and project access remain that computer's own.
The journey replays captured CPU counters only inside its isolated Electron process (`tests/e2e/placementCpu.ts`); production sampling and admission are unchanged.
It first observes a fresh busy sample, asks for a task, checks that the task waits unstarted for CPU room, then releases available counters and checks that the next placement sweep starts it on its own branch.
The sampler still measures counter deltas over its real window, and the journey checks its resulting CPU observation.
A wait for anything other than CPU room or an outstanding comparison fails in the task's own words.
The shared Mac's other work cannot hold the replay busy: release follows the observed wait, not elapsed time or the real processor becoming idle.
The journey's ordinary load-clock deadlines still bound a missing comparison or start.
It also holds a premium ask that computer cannot serve on the premium reset, and checks that the first mate hears once.

### Filtering, sharing and order

Only in-reach, work-enabled computers with matching platform, known tools, project access, a model choice and fresh valid resources qualify.
A preview with no choice still qualifies a computer whose caller declares a runtime default (`runtimeDefault`); `AutomaticPlacement` declares it for the home only, which starts such a task as a This computer task starts.
No model choice without a runtime default, an absent preview, a premium/escalation downgrade, stale or missing resources, and an unreadable computer identity each carry a typed rejection.
A wait in which some computer was refused for the downgrade alone (`model-floor`) and none waits only for room is a wait for the task's own tier (`placementFloorHold`).
`floorHold` returns the route that wait holds on: a computer with a model placed at that tier first, then one whose routing names a model, then the strongest preference.
The caller may supply a binding resolved by the existing placement owner: explicit task or parent, review with its builder, local-only project or personal workspace.
A binding filters out every other computer; the evaluator never substitutes another when the bound computer cannot qualify.
It does not replace the existing manual or recovery paths.

The caller supplies a known computer group, the system identity its readings measure (`docs/helper.md`, "Automatic starts"), not a name, address or OS guess.
Several users in one group share the smallest fresh CPU and memory allowance observed for that group; allowances are never added.
Every pending reservation in that group subtracts once by order identity, including reservations for another user there.
An identical repeated order counts once; conflicting identities or malformed demand make the whole evaluation wait.
Already observed running work is not reserved again.
The dispatch owner must retain pending reservations across uncertain replies, and release or reconcile them only with evidence that preparation ended or a later observation includes their running demand.
The evaluator alone cannot make two concurrent starts atomic.

Among compatible computers with fresh facts, the best model preference is selected before checking room for a new task.
If that preference has no capacity, the result waits rather than quietly choosing a weaker model on an idle computer.
If no compatible fresh computer offers it, the existing fallback order ranks the available choices.
A runtime default names no model, so it ranks after every computer whose preview names one.
At equal model preference, the largest minimum of CPU headroom/demand and memory headroom/demand wins.
A computer id breaks an exact tie deterministically, independently of input order; the home participates in the same comparison, with no fallback penalty or capacity bonus.
The result includes the candidate readings and their ages, capacity, reserved demand, remaining room, missing tools, model preview and typed rejection reasons.
Automatic placement saves at most 64 candidate explanations, including the chosen computer, in one task-owned commitment snapshot.
That snapshot is historical, never a fresh observation after restart; `docs/helper.md`, "Automatic starts", owns the commitment and recovery rules.

## Placed work in the ranking

`PlacedWorkScores` (`src/core/routing/placedWork.ts`, INF-443 piece 3) adjusts the spend-priority score for work already placed, without changing the allowance reading.
The router uses it for the home and each computer's pool, and account selection uses it too.
The settings meters, 0% eligibility check, flagship reserve, pins, requested tier and reset waits still read the unadjusted meter.
An unpriced allowance takes no charge, as the captain selected in question 7; there is no one-task restriction or shipped starting price.

Task size is the average of at least five finished tasks from the last fourteen days: the same model and served level first, then that model at any level, then that provider.
A task already beyond that average uses the average of finished tasks costing at least as much as its logged usage, or its own logged spend when it exceeds every sample.
Missing costs do not become zero-cost samples.
Each allowance window learns points per listed-price dollar from its cycle's drop and the same sign-in's usage between those readings, once the pooled drop reaches three points.
Grok and Codex sign-ins pool by provider, while Claude pools by provider-reported login, falling back to the individual sign-in when it names no login.
Drops and usage are summed across those sign-ins, including the first mate's calls in usage; this deliberately counts shared Grok/Codex meters twice when two sign-ins report the same drop, as accepted in question 6.
Each window has its own price, and a model-specific window counts only matching model usage.
A reset or top-up begins a new observation interval; the last learned price remains available across resets and restarts.
Duplicate, older, stale and failed readings do not advance learning.
Only learned prices persist; local and other computers' observation intervals stay in memory.

A charge is the expected task cost minus its usage logged through the reading's measurement time, converted to points by that window's price.
It includes open tasks with a committed routing choice, including an Automatic placement still preparing, and closed tasks until the first reading strictly after closure.
The newest route's saved account identity attributes pre-attachment work to the login behind that score; an attached task's recorded account takes precedence.
Older decisions without that identity fall back to the first observed sign-in for that provider on the task's computer.
The first mate's own calls are not placed-task charges.
The router recomputes spend priority and the runway over charged windows, so placed work can make a window run out before its reset, but retains the raw headroom for all eligibility checks, so a negative projection never invents an exhaustion hold.
Automatic placement commits its chosen route in the existing transaction, so the next start sees that choice without an additional allowance reservation.

## Program-selected intelligence

A program's `task()` call may choose `intelligence` for that part (INF-974, `docs/programs.md`).
The runner validates the slot, journals it as part of the call identity, and the supervisor persists it on `shape.program_part.intelligence`.
`tierFor` reads that typed declaration before kind rules and after a named model, premium ask or escalation.
Without a declaration the existing table is unchanged.
The supervisor refuses premium without the program's captain-origin `premium_ask`; an authorized premium part carries that ask into the existing availability wait.
R11 records low, medium or high program choices in the routing ledger, with the requested and served slots as usual.
R11 is ledger-only: the published model-reason vocabulary stays unchanged, and no kind-based explanation is shown for it.
Model selection, pins, allowance fallback and reasoning remain the router's, not the script's.
