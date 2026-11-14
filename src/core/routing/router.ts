import { type Slot, slotSchema } from "@shared/modelSlots";
import {
  type CatalogModelView,
  type IntelligenceBucket,
  SLOTS,
  servedModelKey,
  servedProviderOf,
} from "@shared/quota";
import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import type { RuleId, WorkShape } from "@shared/routingPolicy";
import type { QuotaService } from "../quota/quotaService";
import type { DecisionStore, RoutingCandidateFact, SelectionFacts } from "../storage/decisionStore";
import type { SettingsStore } from "../storage/settingsStore";
import {
  estimateTokens,
  type ModelCapabilityLookup,
  PROMPT_CONTEXT_HEADROOM_TOKENS,
} from "./capability";
import type { ModelSlots } from "./modelSlots";
import type { PlacedWorkData, PlacedWorkScores, RankedModel } from "./placedWork";
import { tierFor } from "./policy";
import {
  allowanceless,
  fallbackRank,
  isDowngrade,
  type PiModelRef,
  type RoutingInput,
  route,
} from "./routingEngine";

/** What the supervisor consumes: the choice plus the fallback signals (P7). */
export type RouteResult = {
  choice?: PiModelRef;
  bucket: IntelligenceBucket;
  /** Set when the choice came from another slot than requested. */
  servedBucket?: IntelligenceBucket;
  /** Set when the catalog had models but none could serve at all. */
  unserveable?: true;
  /** Set beside either signal when no available model sits in the requested slot. */
  emptyBucket?: true;
  /**
   * Set beside a downgrade when the slot asked for would have served from a
   * model whose account is withheld (a standing sign-out or refusal, no
   * client to run it): that model's provider and the account's reason, so
   * the feed says what kept it out instead of blaming an allowance.
   */
  withheld?: { provider: string; reason: string };
  /** The policy row that asked for this tier (S2), for the record. */
  rule: RuleId;
};

/** A model a withheld account would serve, with why it is withheld (`AccountVault.withheldModels`). */
export type WithheldModel = PiModelRef & { reason: string };

/**
 * Models to route among other than this Mac's own: a task that runs on a
 * computer that runs work is routed among what that computer's own sign-ins
 * serve (`computerPool`), with the allowance as read there.
 */
export type RoutingPool = {
  available: PiModelRef[];
  /** The quota catalog of those models, with the allowance as read where they run. */
  catalog: CatalogModelView[];
  /** Whose sign-ins these are, for the record. */
  note: string;
  /** The computer these sign-ins are on, by name, for the record. */
  place?: string;
  readings?: import("@shared/quota").QuotaProviderView[];
  /** The computer's existing account-binding policy, before session attachment. */
  modelAccounts?: ReadonlyMap<string, string>;
  accounts?: ReadonlyMap<string, string>;
  /** Models the quota catalog does not list, admitted only by slot membership. */
  unowned?: PiModelRef[];
};

/** A read-only evaluation: smaller rank preserves the stronger requested preference. */
export type RoutePreview = {
  accountId?: string;
  result: RouteResult;
  reasons: string[];
  preferenceRank: number;
  requiresReasoningWait: boolean;
  /** Every candidate weighed, with its score and reading; saved with the decision. */
  candidates?: RoutingCandidateFact[];
  /** How the choice was made, saved with the decision (INF-1714). */
  selection?: SelectionFacts;
  /**
   * Providers whose spent allowance at the asked level made this work drop
   * a level or wait (this Mac's own sign-ins only): their run-out card may
   * offer Keep going on credits once the decision is committed.
   */
  spentAt?: string[];
};

export type RouteOptions = {
  /**
   * Reviewer placement (delivery rigor phase 3, Q5): the Pi provider
   * that served the builder, which the ladder prefers away from at the
   * same tier. Recorded as rule R9; the tier still comes from the
   * shape's own row.
   */
  avoidProvider?: string;
  /**
   * A provider left out entirely, with no fallback to it: a started task
   * moved off the provider that failed it (INF-849) routes only among the
   * others, and finds nothing when none can serve.
   */
  withoutProvider?: string;
  /**
   * The models to route among instead of this Mac's own: a task that
   * runs on a computer that runs work takes only what that computer's
   * own sign-ins serve (docs/helper.md, "Its own sign-ins").
   */
  pool?: RoutingPool;
};

export type PreparedRouteOptions = RouteOptions & { placed: PlacedWorkData };

/**
 * Binds the pure routing engine to live inputs (quota catalog, Pi
 * availability, persisted pins, user slots) and records every decision
 * with its reasons - the "why this model" surface.
 */
export class Router {
  private placement: Promise<unknown> = Promise.resolve();

  /** Preparation through commitment is one ordered operation across all placement callers. */
  inOrder<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.placement.then(operation);
    this.placement = next.catch(() => undefined);
    return next;
  }
  dynamicEnabled(): boolean {
    return this.options.settings.getRoutingSettings().dynamicRouting;
  }
  constructor(
    private readonly options: {
      quota: QuotaService;
      placedWork?: PlacedWorkScores;
      settings: SettingsStore;
      /** The decision ledger every routing decision is recorded in. */
      decisions: DecisionStore;
      availableModels: () => PiModelRef[];
      /** The slot record; omitted means every available model routes at medium. */
      slots?: ModelSlots;
      /** Resolves a candidate's def so it is checked before it is chosen. */
      capabilityFor?: ModelCapabilityLookup;
      /**
       * Models a withheld account would serve. They never route; a
       * downgrade reads them to tell a withheld account from a spent
       * allowance.
       */
      withheldModels?: () => WithheldModel[];
      /**
       * The account of this Mac a crewmate on that model would bind now
       * (`AccountSelector.crewAccount`): the model is ranked by its reading.
       */
      crewAccount?: (
        piProviderId: string,
        model: string,
        placed: PlacedWorkData,
      ) => string | undefined;
      /**
       * A committed decision dropped a level or waits because these
       * providers' allowance is spent at the asked level: the crew's
       * run-out card (docs/quota.md "Keep going on credits").
       */
      onSpentAt?: (piProviders: string[]) => void;
    },
  ) {}

  /** Read and score history apart from the window before the synchronous policy runs. */
  async prepare(options: RouteOptions = {}): Promise<PreparedRouteOptions> {
    const rows = options.pool
      ? (options.pool.readings ?? [])
      : (this.options.quota.latest()?.providers ?? []);
    const placed = await this.options.placedWork?.prepare(rows);
    return { ...options, placed: placed ?? { work: [], samples: [], charges: {}, readings: rows } };
  }

  reasoningChoice(ref: PiModelRef, slot: Slot) {
    return this.options.slots?.reasoningChoice(ref, slot);
  }

  /**
   * The tier comes from the work-shape policy (S2, `./policy.ts`), never
   * from a judgment: `shape` is what the host established about the work
   * and `tierFor` maps it to a slot through the captain's table. `prompt`
   * is only what the turn will send, for the context-window check.
   *
   * R0 is the one rule that names a model instead of a slot: the captain's
   * `override_model_id` becomes a one-off pin for this call only - matched
   * against what Pi can actually serve, tried before the persisted settings
   * pins and never written back to them - and the slot that model sits in
   * is recorded as the tier. It accepts either a bare model id or Pi's
   * provider-qualified `provider/model` key, which disambiguates models
   * offered by more than one provider.
   */
  decide(
    taskId: string,
    prompt: string,
    shape: WorkShape,
    options: PreparedRouteOptions,
  ): RouteResult | undefined {
    const evaluation = this.preview(prompt, shape, options);
    if (!evaluation) return undefined;
    return this.commit(taskId, evaluation);
  }

  /** Record the preview chosen by atomic placement, never another speculative candidate. */
  commit(taskId: string, evaluation: RoutePreview): RouteResult {
    const { result, reasons, candidates, accountId, selection, spentAt } = evaluation;
    if (spentAt && spentAt.length > 0) this.options.onSpentAt?.(spentAt);
    this.options.decisions.recordRouting({
      taskId,
      provider: result.choice?.provider ?? null,
      model: result.choice?.id ?? null,
      bucket: result.bucket,
      rule: result.rule,
      served: result.choice ? (result.servedBucket ?? result.bucket) : null,
      reasons,
      ...((candidates && candidates.length > 0) || accountId || selection
        ? {
            facts: {
              kind: "routing-candidates" as const,
              candidates: candidates ?? [],
              ...(accountId ? { accountId } : {}),
              ...(selection ? { selection } : {}),
            },
          }
        : {}),
    });
    return result;
  }

  /**
   * An initial session still needs a model when automatic routing is off.
   * Reuse the same eligibility, capability and premium boundaries, without
   * enabling previews for automatic placement or moves of running work.
   */
  initialChoice(
    taskId: string,
    prompt: string,
    shape: WorkShape,
    options: PreparedRouteOptions,
  ): RouteResult {
    return this.commit(taskId, this.evaluate(prompt, shape, options));
  }

  /**
   * Evaluate this computer's pool without recording a speculative routing row.
   * The ordinary decide path uses this same evaluation and remains the writer.
   * Call again at commitment: this preview is evidence, not a model reservation.
   */
  preview(
    prompt: string,
    shape: WorkShape,
    options: PreparedRouteOptions,
  ): RoutePreview | undefined {
    if (!this.dynamicEnabled()) return undefined;
    return this.evaluate(prompt, shape, options);
  }

  private evaluate(prompt: string, shape: WorkShape, options: PreparedRouteOptions): RoutePreview {
    const settings = this.options.settings.getRoutingSettings();
    // Saved Always use choices apply only while Dynamic routing is on.
    const pins = settings.dynamicRouting ? settings.pins : [];
    // What the router may pick: the catalog only describes, so leaving a
    // provider out of what serves leaves it out of the pick.
    const without = options.withoutProvider;
    const kept = <T extends { provider: string }>(models: T[]): T[] =>
      without ? models.filter((model) => model.provider !== without) : models;
    const rawCatalog = options.pool
      ? options.pool.catalog
      : (this.options.quota.latestModels()?.models ?? []);
    // Each model is ranked by the account that would serve it: a computer's
    // own binding there, or this Mac's crew account pick.
    const pool = options.pool;
    const crewAccount = this.options.crewAccount;
    const bound = pool
      ? (model: CatalogModelView) =>
          pool.modelAccounts?.get(servedModelKey(model)) ??
          pool.accounts?.get(servedProviderOf(model.provider))
      : crewAccount
        ? (model: CatalogModelView, placed: PlacedWorkData) =>
            crewAccount(servedProviderOf(model.provider), model.id, placed)
        : undefined;
    const catalog =
      this.options.placedWork?.catalog(
        rawCatalog,
        options.placed?.readings ??
          (pool ? (pool.readings ?? []) : (this.options.quota.latest()?.providers ?? [])),
        Date.now(),
        bound,
        options.placed,
      ) ?? rawCatalog;
    const available = kept(options.pool?.available ?? this.options.availableModels());
    const routable = this.options.slots?.routable(available);
    const tier = tierFor(shape);
    const modelId = tier.pin;
    const askPin = modelId
      ? available.find((model) =>
          modelId.includes("/")
            ? `${model.provider}/${model.id}` === modelId
            : model.id === modelId,
        )
      : undefined;
    // R0's tier is whichever slot the named model sits in; a model in no
    // slot (off, but still pinnable) leaves the engine's medium default.
    const bucket = tier.bucket ?? (askPin ? this.slotOf(askPin) : undefined);
    // Taking turns (INF-3782) reads, for each model a person placed that has
    // no allowance row, the newest routing row that chose it.
    const unowned = options.pool?.unowned ? kept(options.pool.unowned) : undefined;
    const catalogKeys = new Set(catalog.map((model) => servedModelKey(model)));
    const unownedKeys = new Set((unowned ?? []).map((ref) => `${ref.provider}/${ref.id}`));
    const turnTakers = routable?.placed
      ? routable.models.filter(
          (ref) =>
            !catalogKeys.has(`${ref.provider}/${ref.id}`) &&
            (allowanceless(ref) || unownedKeys.has(`${ref.provider}/${ref.id}`)),
        )
      : [];
    const input: RoutingInput = {
      catalog,
      available,
      ...(routable ? { slotted: routable.models, slotNote: routable.note } : {}),
      ...(unowned ? { unowned } : {}),
      pins: kept(askPin ? [askPin, ...pins] : pins),
      ...(bucket ? { bucket } : {}),
      ...(this.options.capabilityFor ? { capabilityFor: this.options.capabilityFor } : {}),
      ...(options.avoidProvider ? { avoidProvider: options.avoidProvider } : {}),
      ...(turnTakers.length >= 2
        ? { turns: { lastPicked: this.options.decisions.lastChosenIds(turnTakers) } }
        : {}),
      needs: { contextTokens: estimateTokens(prompt) + PROMPT_CONTEXT_HEADROOM_TOKENS },
    };
    const decision = route(input);
    // This Mac's own withheld accounts; a computer's pool says nothing of its own.
    const withheld =
      !options.pool && decision.servedBucket && isDowngrade(decision.bucket, decision.servedBucket)
        ? this.withheldCause(input)
        : undefined;
    if (withheld) {
      decision.reasons.push(
        `${withheld.provider}/${withheld.id} would serve ${decision.bucket} but its account is withheld (${withheld.reason})`,
      );
    }
    // An unavailable pin remains behaviorally silent: routing can still use
    // the normal ladder. Record it, though, so a fallback is diagnosable.
    if (modelId && !askPin) {
      decision.reasons.push(`requested pin ${modelId} is not available; ignoring it`);
    }
    // The shape and the rule lead the record (S2): what the work was taken
    // to be is why this slot was asked for, so a routing decision reads
    // top to bottom without a second table. Reviewer placement (R9) is
    // recorded as the rule and names the tier row it rode on.
    const rule: RuleId = options.avoidProvider ? "R9" : tier.rule;
    decision.reasons.unshift(
      ...shapeReasons(shape),
      options.avoidProvider
        ? `rule R9: reviewer placement away from ${options.avoidProvider}; tier from ${tier.reason}`
        : tier.reason,
      ...(options.pool ? [`routed among ${options.pool.note}`] : []),
      ...(without ? [`left out ${without}, the provider the task moved off`] : []),
    );
    const result: RouteResult = {
      bucket: decision.bucket,
      rule,
      ...(decision.servedBucket ? { servedBucket: decision.servedBucket } : {}),
      ...(decision.unserveable ? { unserveable: true as const } : {}),
      ...(decision.emptyBucket ? { emptyBucket: true as const } : {}),
      ...(withheld ? { withheld: { provider: withheld.provider, reason: withheld.reason } } : {}),
      ...(decision.choice ? { choice: decision.choice } : {}),
    };
    // A named model first, then saved pins in their order, then the existing
    // slot ladder. Do not infer quality by parsing the reasons or model name.
    const matches = (pin: { provider: string; id: string }) =>
      decision.choice !== undefined && servedModelKey(decision.choice) === servedModelKey(pin);
    const pinned = pins.findIndex(matches);
    const offset = modelId ? 1 : 0;
    const preferenceRank =
      askPin && matches(askPin)
        ? 0
        : pinned >= 0
          ? offset + pinned
          : offset +
            pins.length +
            fallbackRank(decision.bucket, decision.servedBucket ?? decision.bucket);
    return {
      result,
      accountId: decision.choice
        ? (options.pool?.modelAccounts?.get(servedModelKey(decision.choice)) ??
          options.pool?.accounts?.get(decision.choice.provider) ??
          (catalog as RankedModel[]).find(
            (model) => servedModelKey(model) === servedModelKey(decision.choice!),
          )?.charge?.accountId)
        : undefined,
      reasons: decision.reasons,
      preferenceRank,
      requiresReasoningWait: requiresReasoningWait(shape, result),
      ...spentAtLevel(decision, options.pool),
      candidates: decision.candidates.map((candidate) => {
        const ranked = (catalog as RankedModel[]).find(
          (model) => servedModelKey(model) === `${candidate.provider}/${candidate.model}`,
        );
        return {
          ...candidate,
          ...(ranked?.rawSpendPriority !== undefined
            ? { rawSpendPriority: ranked.rawSpendPriority }
            : {}),
          ...(ranked?.accountId ? { accountId: ranked.accountId } : {}),
          ...(ranked?.measuredAt !== undefined ? { measuredAt: ranked.measuredAt } : {}),
          ...(ranked?.resetsAtMs !== undefined ? { resetsAtMs: ranked.resetsAtMs } : {}),
          ...(ranked?.charge ? { charge: ranked.charge } : {}),
        };
      }),
      ...(decision.decidedBy
        ? {
            selection: {
              version: 1 as const,
              decidedBy:
                decision.decidedBy === "pin"
                  ? askPin && matches(askPin)
                    ? ("named" as const)
                    : ("pinned" as const)
                  : decision.decidedBy,
              floorPercent: CREW_NEAR_FLOOR_PERCENT,
              computer: pool?.place ?? "home",
              ...(decision.turns ? { turns: true as const } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * The Pi provider a task's newest routing decision chose, for reviewer
   * placement (R9): what its builder was served by, read off
   * the ledger's routing rows rather than guessed from the account.
   * Undefined when the task never routed or nothing was chosen.
   */
  servedProvider(taskId: string): string | undefined {
    return (
      this.options.decisions.routing({ taskIds: [taskId], chosen: true }).at(-1)?.provider ??
      undefined
    );
  }

  /**
   * The model and slot a task's newest routing decision chose - its start's
   * or its newest move's - for a reopen to ask for again, so a conversation
   * that starts over never opens on the client's own default. The slot is
   * the one served, as `servedSlots` reads it. Undefined when the task never
   * routed or the row's slot is not one.
   */
  servedChoice(taskId: string): { model: PiModelRef; slot: Slot } | undefined {
    const row = this.options.decisions.routing({ taskIds: [taskId], chosen: true }).at(-1);
    const slot = slotSchema.safeParse(row?.served ?? row?.bucket);
    if (!row?.provider || !row.model || !slot.success) return undefined;
    return { model: { provider: row.provider, id: row.model }, slot: slot.data };
  }

  /**
   * One offering named the way the captain knows it, through the one
   * model-name lookup (`ModelSlots.nameOf`): its Settings row's name
   * ("Fable 5"), the raw id otherwise. The settle card's model fact reads
   * the task record's model through this - the model the session reported
   * serving, kept current when the backend swapped it (FI3-967) - never the
   * newest routing choice, which can disagree with it (review F1).
   */
  modelLabel(ref: PiModelRef): string {
    return this.options.slots?.nameOf(ref) ?? ref.id;
  }

  /**
   * The withheld model that would have served a downgraded task at the slot
   * it asked for: the same ladder over the same catalog, pins and checks,
   * with the withheld accounts' models back in the pool and slotted as the
   * pool's own are. Undefined when that ladder still falls back, or picks a
   * model that was never withheld - then the withheld account is not why.
   */
  private withheldCause(input: RoutingInput): WithheldModel | undefined {
    const pooled = new Set(input.available.map((model) => `${model.provider}/${model.id}`));
    const held = (this.options.withheldModels?.() ?? []).filter(
      (model) => !pooled.has(`${model.provider}/${model.id}`),
    );
    if (held.length === 0) return undefined;
    const available = [...input.available, ...held.map(({ provider, id }) => ({ provider, id }))];
    const routable = this.options.slots?.routable(available);
    const unheld = route({
      ...input,
      available,
      ...(routable ? { slotted: routable.models, slotNote: routable.note } : {}),
    });
    const choice = unheld.choice;
    if (!choice || unheld.servedBucket) return undefined;
    return held.find((model) => model.provider === choice.provider && model.id === choice.id);
  }

  /**
   * The slot a pinned offering sits in. A model placed in several is read
   * at its strongest - pinning a premium-slotted model records premium,
   * not whatever weaker slot it also sits in.
   */
  private slotOf(ref: PiModelRef): IntelligenceBucket | undefined {
    const slots = this.options.slots?.slotsOf(ref) ?? [];
    return SLOTS.find((slot) => slots.includes(slot));
  }
}

/**
 * The providers whose spent allowance at the asked level made a decision on
 * this Mac's own sign-ins drop a level or find nothing.
 */
function spentAtLevel(
  decision: ReturnType<typeof route>,
  pool: RoutingPool | undefined,
): { spentAt?: string[] } {
  if (pool) return {};
  const dropped =
    !decision.choice ||
    (decision.servedBucket !== undefined && isDowngrade(decision.bucket, decision.servedBucket));
  if (!dropped) return {};
  const status = `skipped: exhausted at ${decision.bucket}`;
  const providers = [
    ...new Set(
      decision.candidates
        .filter((candidate) => candidate.status === status)
        .map((candidate) => candidate.provider),
    ),
  ];
  return providers.length > 0 ? { spentAt: providers } : {};
}

/** Premium asks and escalation keep the supervisor's existing never-downward gate. */
export function requiresReasoningWait(
  shape: WorkShape | null | undefined,
  routed: RouteResult,
): boolean {
  return Boolean(
    (shape?.premium_ask || shape?.escalation) &&
      (routed.unserveable ||
        (routed.servedBucket && isDowngrade(routed.bucket, routed.servedBucket))),
  );
}

/**
 * What the shape said about the work, for the record. The tier's own
 * reason line follows these, so `routing_decisions.reasons` carries the
 * input and the rule that read it - which is what the offline corpus
 * needs to score a classification (C5).
 */
function shapeReasons(shape: WorkShape): string[] {
  const kind = shape.kind_source ? `${shape.kind} (${shape.kind_source})` : shape.kind;
  const lines = [`shape kind=${kind}`];
  // How it was established, when there is anything to say: a native
  // decision model's certainty, or the note that one failed and the
  // adapter answered in its place.
  if (shape.kind_detail) lines.push(shape.kind_detail);
  if (shape.basis) {
    lines.push(`basis ${shape.basis} ${shape.basis_verified ? "verified" : "unverified"}`);
  }
  if (shape.escalation) {
    lines.push(`escalation attempt ${shape.escalation.attempt} from ${shape.escalation.from}`);
  }
  return lines;
}

/**
 * The slot each task's crewmate is served on, for the task board
 * (`TaskView.tier`) and so for the crewmate's solid on the crew orbit: the
 * newest routing decision that chose something, its `served` slot - the
 * weaker one when the ladder fell back (S5) - or, on a row written before
 * `served` existed, the slot it asked for. A task that never routed is
 * simply absent; a value that is not a slot is never guessed into one.
 */
export function servedSlots(
  decisions: DecisionStore,
  taskIds: readonly string[],
): Map<string, Slot> {
  const out = new Map<string, Slot>();
  for (const row of decisions.latestChosenSlots(taskIds)) {
    const slot = slotSchema.safeParse(row.served ?? row.bucket);
    if (slot.success) out.set(row.taskId, slot.data);
    else out.delete(row.taskId);
  }
  return out;
}
