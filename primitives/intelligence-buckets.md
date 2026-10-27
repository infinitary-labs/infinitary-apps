# Intelligence buckets

Intelligence buckets are the four ranked slots - `premium`, `high`, `medium` and `low` - into which the person places model offerings, and the routing that picks an offering for a piece of agent work from the tier its shape computes.

## Intended use

Use the buckets whenever agent work needs a model: a crewmate's spawn, an escalation, a review, a held task waiting for a tier.
The slot names are the contract (`slotSchema`, [`../src/shared/modelSlots.ts`](../src/shared/modelSlots.ts)): the tier the work-shape policy computes, `bucket:` gate refs, supervision grains and `routing_decisions.bucket` all speak them.
An offering is one model as one provider serves it (`offeringKey`, decision C): the same id on two providers is two offerings, and ids are never deduplicated across providers.
The person places each offering in zero or more slots; off means in no slot, never auto-picked and still pinnable.

## When to use it, and when not

Use the router for every model choice for crew work, and describe the work through its shape, not through a model name.
Do not write a per-feature model picker, a hard-coded model id, or a prompt that asks a model which tier the work deserves: the tier is computed unless a program explicitly chooses its part's level, and a captain-named model is a pin carried in the shape (`override_model_id`).
Do not add a fifth bucket for a bounded judgment: a typed one-value answer is a [Decision question](decision-questions.md), which holds exactly one model and no session ([`../docs/decision-models.md`](../docs/decision-models.md)).
Do not put account or allowance math here: which account serves a chosen model, headroom, spend ranking and withheld sign-ins belong to the accounts and allowance foundation ([`../docs/quota.md`](../docs/quota.md), [`../docs/architecture.md`](../docs/architecture.md) §16); routing reads those facts and never redefines them.
Do not use buckets to choose a computer: Automatic placement compares computers' previews of this routing ([`../docs/routing.md`](../docs/routing.md), "Read-only computer evaluation"; [`../docs/helper.md`](../docs/helper.md), "Automatic starts").

## Owner and entry points

- Owner: `Router` ([`../src/core/routing/router.ts`](../src/core/routing/router.ts)) with `decide`, `preview`, `initialChoice` and `commit`; it records every decision.
- An initial crew binding still uses `initialChoice` when Dynamic routing is off; it retains the same eligibility boundaries without enabling automatic computer previews or moves.
- The ladder: `route` ([`../src/core/routing/routingEngine.ts`](../src/core/routing/routingEngine.ts)), with the cheap-first candidate walk ([`../src/core/routing/candidates.ts`](../src/core/routing/candidates.ts)) and capability checks ([`../src/core/routing/capability.ts`](../src/core/routing/capability.ts)).
- The slots: `ModelSlots` ([`../src/core/routing/modelSlots.ts`](../src/core/routing/modelSlots.ts)) over the per-offering record, and `SLOTS`, `PREMIUM_SLOT`, `AUTO_ROUTABLE_SLOTS`, `isAutoRoutableSlot` and `STARTER_SLOTS` ([`../src/shared/modelSlots.ts`](../src/shared/modelSlots.ts)).
- The shape and the policy as data: `workShapeSchema`, `routingPolicySchema`, `DEFAULT_ROUTING_POLICY` and `levelDefaultReasoning` ([`../src/shared/routingPolicy.ts`](../src/shared/routingPolicy.ts)).
- The tier: `tierFor` and `escalationFloor` ([`../src/core/routing/policy.ts`](../src/core/routing/policy.ts)), pure and reading no task text.
- The kind: `KindClassifier` ([`../src/core/routing/kindClassifier.ts`](../src/core/routing/kindClassifier.ts)), never the engine and never the first mate.
- The ledger: `routing_decisions` and `account_decisions`, written through `DecisionStore` ([`../src/core/storage/decisionStore.ts`](../src/core/storage/decisionStore.ts)).

## Operations and lifecycle

- Routing is computed from the work's shape, never judged (captain-approved 2026-09-18): `CrewSupervisor.commission` builds the shape (kind, basis, `premium_ask`, `override_model_id`, `escalate_from`, escalation) and stores it on `tasks.shape_json`, so a queued row dispatches from what it was commissioned with.
- A program may declare `program_part.intelligence`; R11 reads low, medium or high before kind rules, after captain overrides and escalation; premium still needs `premium_ask`.
- An operation skips the classifier and requests medium through R12 after named models, premium, escalation and program intelligence.
- `tierFor` maps the shape to a rule and a requested tier; an `unclear` kind routes high.
- Requested versus served: the rule names the requested slot, and the ladder may serve a weaker one; both land on the routing row (`bucket`, `served`), and a downgrade says so in the feed (`downgradeLine`).
- Ladder: slotted offerings, then the starter map virtually, then every listed model at medium, then the whole signed-in pool; a shortlist is a preference, never a way to brick routing.
- Pins: a captain-named model routes first when it can serve and otherwise falls back without a feed line; saved Settings pins come next and bypass the slots, since naming a model is its own placement.
- Reasoning: a fresh crewmate inherits the served slot's level (premium and high Extra high, medium and low Medium), clamped to what the runtime offers; a Settings choice per offering and level, or a per-task `override_reasoning`, overrides it ([`../docs/model-lists.md`](../docs/model-lists.md), "Reasoning in each level").
- Escalation to a stronger model is the ladder's one automatic rung: `spawn_crewmate` carries `escalate_from`, `CrewSupervisor.resolveEscalation` refuses an unknown task, one that never ran, a lineage past `maxEscalations` (2) or nothing above premium, and the fresh crewmate is briefed anew, never resumed.
- An escalation or premium ask that cannot be served now waits on a `bucket:<tier>` gate (`quotaGateCleared`, [`../src/core/routing/quotaGate.ts`](../src/core/routing/quotaGate.ts)) rather than starting at a weaker tier.

## Authority

- The tier is computed from the work's shape, never judged; premium is never auto-picked; never quiet the `routing_decisions` / `account_decisions` observability.
- Crew premium restriction: crewmate automatic selection never picks `PREMIUM_SLOT` - not in `route()`, nor in the candidate walk including its uncatalogued tail; only a captain ask (`premium_ask`) or the escalation rung reaches it.
- The first mate's own Auto is a separate ladder (high, medium, premium, low) and does not change the crew rule.
- Escalation is the captain's: `escalate_from` is refused on any turn that is not a captain turn, so a crewmate's own "I am blocked" never climbs, and only the captain's click on the escalation card is the say-so.
- Every skip and every rung lands in the ledger; Observe's crewmate header and the task's "why this model" line read its typed columns (`modelReasonOf`, [`../src/core/routing/modelReason.ts`](../src/core/routing/modelReason.ts)), never the reasons prose.
- Per-account control is the account's pause, not a second toggle in the slot record.

## Compositions

- With [Tasks](tasks.md): the shape lives on the task row, and a held task says which tier it waits for ([`../docs/task-record.md`](../docs/task-record.md), "A held task says why").
- With [Decision questions](decision-questions.md): the kind classifier is one decision question on the cheapest slotted model; its answer feeds the shape, not the router directly.
- With accounts and allowance: same-tier order reads spend priority from the quota foundation, and the account pick ranks the same way; a withheld account leaves the pool ([`../docs/quota.md`](../docs/quota.md), "The cut-off on the account").
- With work devices: a task on a computer that runs work routes among that computer's own pool, never the home's ([`../docs/helper.md`](../docs/helper.md), "A task's model").
- With [Cards and consent](cards-and-consent.md): a crewmate's blocked report earns one decision card with a premium way or a stronger-model way.

## Failure and recovery

- A candidate that cannot carry the turn (images, context) is skipped with a recorded reason; a def no runtime knows is unknown, not incapable.
- An unavailable pin is ignored with a reason line and routing continues.
- When no available model sits at a tier, the route says so (`emptyBucket`), and the wait ends only once a model is placed there.
- A provider that failed a started task can be left out of the next route (`withoutProvider`), with no fallback to it.
- There is deliberately no failure or incident ledger; the captain cut it.

## Uses

- Every crewmate spawn, from a quick lookup (R10 to low) through implementation from a verified plan (R4 to medium) to teaching (R2 to high).
- Captain-requested escalation of a blocked crewmate to premium or the next rung.
- Automatic placement, which previews this routing on each computer and records only the chosen preview.
- Possible: a new kind of agent work routed by adding a kind or shape field to the policy data, never a new picker.

## Checks

- [`../src/core/routing/policy.test.ts`](../src/core/routing/policy.test.ts): the computed tier and its rules.
- [`../src/core/routing/candidates.test.ts`](../src/core/routing/candidates.test.ts): "never offers a premium model - including through the uncatalogued tail".
- [`../src/core/routing/router.test.ts`](../src/core/routing/router.test.ts) and [`../src/core/routing/routingEngine.test.ts`](../src/core/routing/routingEngine.test.ts): the ladder, pins, requested and served slots.
- [`../src/core/routing/modelSlots.test.ts`](../src/core/routing/modelSlots.test.ts): the per-offering record and its seeding.
- [`../src/core/routing/modelReason.test.ts`](../src/core/routing/modelReason.test.ts) and [`../src/core/orchestrator/crewSupervisor.test.ts`](../src/core/orchestrator/crewSupervisor.test.ts): the reason line, commission and escalation.
- `pnpm score:kinds` scores the kind classifier; `scoreRouting` in `scripts/interaction-metrics.ts` holds the routing numbers.

## Where the detail lives

- [`../docs/routing.md`](../docs/routing.md): the boundaries around the ladder, the computed tier, escalation, same-tier order, "Bounded fact retrieval", "Teaching", "Read-only computer evaluation" and "Placed work in the ranking".
- [`../docs/model-lists.md`](../docs/model-lists.md): which offerings are listed, "Reasoning in each level" and the live checks.
- [`../docs/kind-classifier.md`](../docs/kind-classifier.md) and [`../docs/decision-models.md`](../docs/decision-models.md).
- [`../docs/quota.md`](../docs/quota.md): accounts and allowance, which this page does not own.
