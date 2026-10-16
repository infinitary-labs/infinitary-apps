import { isCustomApiProvider } from "@shared/customApi";
import { isOfferedProvider } from "@shared/providers";
import {
  type CatalogModelView,
  type IntelligenceBucket,
  type ModelPin,
  QUOTA_TO_PI_PROVIDER,
  type Slot,
} from "@shared/quota";
import { capabilityMiss, type ModelCapabilityLookup, type TurnNeeds } from "./capability";

/**
 * The routing engine (docs/architecture.md section 6): a pure function over
 * the task, the quota catalog, Pi availability, user slots, and user pins.
 *
 * 1. The reasoning class arrives as a judgment from the caller - Firstmate
 *    reads the task and says low, medium, high, or premium (see the
 *    routing rule in FIRSTMATE_PROMPT_CORE). No prompt heuristic lives
 *    here; absent a class the request is medium.
 * 2. Candidates = slot ∩ Pi-available models, minus exhausted scopes.
 * 3. Within a slot, serveable candidates rank by spend priority
 *    (quota-axi semantics: highest first). Unmeasurable signals rank
 *    below any known one and keep runway order among themselves; a
 *    newer id of the same model line still overrides (recency within slot).
 * 4. Pins always win. Unoffered providers never become a choice.
 *
 * Two boundaries sit outside the ladder:
 *
 * - SLOTS (`slotted`): automatic selection never leaves the models the
 *   user placed in a slot. A pin still may - naming a model IS the user
 *   placing it for that request.
 * - PREMIUM: a premium-slot model is reached only by a premium REQUEST -
 *   which Firstmate may make only when the user asked for it - or by a
 *   pin. No other class can fall into it: `premium` appears on no other
 *   row of BUCKET_FALLBACK.
 *
 * Degradation is the caller's: no decision means Pi's default model.
 */

export type PiModelRef = { provider: string; id: string };

/** A routable model carrying the slot the user (or the starter map) placed it in. */
export type SlottedRef = PiModelRef & { slot: Slot };

export type RoutingInput = {
  /** Quota catalog models in runway order. */
  catalog: CatalogModelView[];
  /**
   * Models Pi can actually serve right now (configured auth). Pins resolve
   * against THIS pool, not the slotted one: an explicit pin is the user
   * naming a model, which is its own placement.
   */
  available: PiModelRef[];
  /**
   * Models with no quota-catalog row that slot membership may still choose:
   * a computer's own list for a provider this Mac's catalog lacks.
   * Custom connections are admitted from `available` and need not be repeated.
   */
  unowned?: PiModelRef[];
  /**
   * The slotted subset automatic selection may choose from, each carrying
   * its slot. Omitted means "no slot record" - every available model is
   * treated as medium, which is what a caller without slot state (and
   * tests that only exercise pins or capability) gets.
   */
  slotted?: SlottedRef[];
  /** How `slotted` was arrived at, for the audit record. */
  slotNote?: string;
  pins: ModelPin[];
  /**
   * The reasoning class for this task, as judged by the caller (Firstmate,
   * from the task itself). Absent means medium - the default class.
   */
  bucket?: IntelligenceBucket;
  /** Resolves a candidate's def so it can be checked before it is chosen. */
  capabilityFor?: ModelCapabilityLookup;
  /** What this turn will send, for that check. */
  needs?: TurnNeeds;
  /**
   * A Pi provider id to prefer AWAY from at the same tier (delivery rigor
   * phase 3, Q5): an independent reviewer is placed on a provider other
   * than the one that served its builder when any other signed-in provider
   * can serve the slot, and falls back to it - saying so - when none can.
   * Never descends a tier for it, and a pin still wins.
   */
  avoidProvider?: string;
};

export type RoutingDecision = {
  bucket: IntelligenceBucket;
  /**
   * Set when no model in the requested slot could serve and the choice
   * came from another slot - the structural fallback signal (P7), so the
   * caller can say so instead of leaving it buried in reasons_json.
   */
  servedBucket?: IntelligenceBucket;
  /**
   * Set when the catalog HAD models but none could serve (exhausted or not
   * signed in) - the structural nothing-serveable signal (P7). An empty
   * catalog (no quota data yet) does not set it: that is unknown, not
   * exhausted.
   */
  unserveable?: true;
  /**
   * Set beside either signal when no available model sits in the requested
   * slot at all: no allowance there can come back, so a wait for that slot
   * ends only when a model is placed in it.
   */
  emptyBucket?: true;
  /** Pi provider id + model id, ready for session creation. */
  choice?: PiModelRef;
  reasons: string[];
};

const BUCKET_RANK: Record<Slot, number> = {
  low: 0,
  medium: 1,
  high: 2,
  premium: 3,
};

/** True when the served slot has less reasoning than the requested one. */
export function isDowngrade(requested: IntelligenceBucket, served: IntelligenceBucket): boolean {
  return BUCKET_RANK[served] < BUCKET_RANK[requested];
}

/**
 * Within the same model line, a newer dotted/dashed version wins
 * (grok-4.6 > grok-4.3, sonnet-4-5 > sonnet-4-1). The line is everything
 * around the version - prefix AND suffix - so gpt-5.6-luna and
 * gpt-5.3-codex-spark are different lines, never compared. Incomparable
 * ids: undefined (the caller keeps runway order).
 */
function newerId(aId: string, bId: string): boolean | undefined {
  const parse = (id: string) => {
    const norm = id.toLowerCase().replace(/_/g, "-");
    const match = norm.match(/^(.*?)[.-](\d+(?:[.-]\d+)*)(.*)$/);
    if (!match || match[1] === undefined || !match[2]) return undefined;
    return {
      line: `${match[1]}|${match[3] ?? ""}`,
      version: match[2].split(/[.-]/).map(Number),
    };
  };
  const a = parse(aId);
  const b = parse(bId);
  if (!a || !b || a.line !== b.line) return undefined;
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const va = a.version[i] ?? 0;
    const vb = b.version[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return undefined;
}

/**
 * The ladder. `premium` appears on exactly one row - its own - so captain
 * decision A holds structurally: no request but a premium one can reach a
 * premium model, whatever the quota state.
 *
 * A premium REQUEST is served from the premium slot and falls to high
 * downward when nothing premium can serve, saying so. Firstmate may only
 * ask for it when the user did, which is what makes an automatic premium
 * choice impossible.
 */
const BUCKET_FALLBACK: Record<Slot, Slot[]> = {
  premium: ["premium", "high", "medium", "low"],
  high: ["high", "medium"],
  medium: ["medium", "high", "low"],
  low: ["low", "medium", "high"],
};

/** The existing ladder's order, shared by model and computer evaluation. */
export function fallbackRank(requested: Slot, served: Slot): number {
  const rank = BUCKET_FALLBACK[requested].indexOf(served);
  return rank < 0 ? Number.POSITIVE_INFINITY : rank;
}

/**
 * Collects `slotted` into the slots each offering sits in - more than one
 * row for the same key (an offering placed in more than one slot) adds to
 * the same list rather than overwriting it.
 */
function slotMap(slotted: SlottedRef[] | undefined): Map<string, Slot[]> | undefined {
  if (!slotted) return undefined;
  const map = new Map<string, Slot[]>();
  for (const model of slotted) {
    const key = `${model.provider}/${model.id}`;
    map.set(key, [...(map.get(key) ?? []), model.slot]);
  }
  return map;
}

export function route(input: RoutingInput): RoutingDecision {
  const bucket = input.bucket ?? "medium";
  const reasons: string[] = [
    input.bucket ? `bucket ${bucket} (the first mate's judgment)` : `bucket ${bucket} (default)`,
  ];

  const availableKeys = new Set(input.available.map((m) => `${m.provider}/${m.id}`));
  const slots = slotMap(input.slotted);
  // The slot record bounds automatic selection only; pins read availableKeys.
  if (input.slotNote) reasons.push(input.slotNote);
  const toPiRef = (model: CatalogModelView): PiModelRef | undefined => {
    const piProvider = QUOTA_TO_PI_PROVIDER[model.provider];
    if (!piProvider) return undefined;
    return { provider: piProvider, id: model.id };
  };
  const slotsOf = (ref: PiModelRef): Slot[] | undefined => {
    if (!slots) return ["medium"];
    return slots.get(`${ref.provider}/${ref.id}`);
  };

  // Pins always win, if Pi can serve them and the provider is offered.
  for (const pin of input.pins) {
    const piProvider = QUOTA_TO_PI_PROVIDER[pin.provider] ?? pin.provider;
    if (!isOfferedProvider(piProvider) && !isCustomApiProvider(piProvider)) continue;
    if (availableKeys.has(`${piProvider}/${pin.id}`)) {
      reasons.push(`pinned ${pin.provider}/${pin.id}`);
      return { bucket, choice: { provider: piProvider, id: pin.id }, reasons };
    }
  }

  const skipped: string[] = [];
  const empty = [...input.available, ...(input.unowned ?? [])].some((ref) =>
    slotsOf(ref)?.includes(bucket),
  )
    ? {}
    : { emptyBucket: true as const };

  for (const candidateSlot of BUCKET_FALLBACK[bucket]) {
    const inSlot: {
      model: { provider: string; id: string; spendPriority?: number };
      ref: PiModelRef;
      slot: Slot;
    }[] = input.catalog.flatMap((model) => {
      const ref = toPiRef(model);
      if (!ref || !availableKeys.has(`${ref.provider}/${ref.id}`)) return [];
      const memberSlots = slotsOf(ref);
      if (memberSlots === undefined) {
        skipped.push(`skipped ${ref.provider}/${ref.id}: not in a slot`);
        return [];
      }
      if (!memberSlots.includes(candidateSlot)) return [];
      if (
        typeof model.effectivePercentRemaining === "number" &&
        model.effectivePercentRemaining <= 0
      ) {
        return [];
      }
      const miss = capabilityMiss({
        ref,
        ...(input.needs ? { needs: input.needs } : {}),
        ...(input.capabilityFor ? { capabilityFor: input.capabilityFor } : {}),
      });
      if (miss) {
        skipped.push(miss);
        return [];
      }
      return [{ model, ref, slot: candidateSlot }];
    });
    // Checked connection-owned models, and a computer's models the quota
    // catalog does not list. Only slot membership admits them.
    const extras = [
      ...input.available.filter((ref) => isCustomApiProvider(ref.provider)),
      ...(input.unowned ?? []),
    ];
    const seenExtra = new Set<string>();
    for (const ref of extras) {
      const key = `${ref.provider}/${ref.id}`;
      if (seenExtra.has(key) || !slots?.get(key)?.includes(candidateSlot)) continue;
      seenExtra.add(key);
      const miss = capabilityMiss({
        ref,
        ...(input.needs ? { needs: input.needs } : {}),
        ...(input.capabilityFor ? { capabilityFor: input.capabilityFor } : {}),
      });
      if (miss) {
        skipped.push(miss);
        continue;
      }
      inSlot.push({ model: { provider: ref.provider, id: ref.id }, ref, slot: candidateSlot });
    }
    if (inSlot.length === 0) continue;
    // Reviewer placement (R9): another provider at this slot when one can
    // serve, else the avoided one with the fallback on the record.
    const elsewhere = input.avoidProvider
      ? inSlot.filter((entry) => entry.ref.provider !== input.avoidProvider)
      : inSlot;
    if (input.avoidProvider) {
      reasons.push(
        elsewhere.length > 0
          ? `rule R9: preferred a provider other than ${input.avoidProvider} (the builder's) at ${candidateSlot}`
          : `rule R9: no other signed-in provider could serve ${candidateSlot}; falling back to ${input.avoidProvider}`,
      );
    }
    const pool = elsewhere.length > 0 ? elsewhere : inSlot;
    const ranked = [...pool].sort((a, b) => {
      const aKnown = typeof a.model.spendPriority === "number";
      const bKnown = typeof b.model.spendPriority === "number";
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown) {
        return (b.model.spendPriority as number) - (a.model.spendPriority as number);
      }
      return 0;
    });
    let chosen = ranked[0] as (typeof ranked)[number];
    let recencyOverride = false;
    for (const entry of ranked) {
      if (newerId(entry.model.id, chosen.model.id) === true) {
        chosen = entry;
        recencyOverride = true;
      }
    }
    reasons.push(...skipped);
    if (candidateSlot !== bucket) {
      reasons.push(`no serveable ${bucket} model; fell back to ${candidateSlot}`);
    }
    const pickedBy = recencyOverride
      ? "same-line recency over spend priority"
      : typeof chosen.model.spendPriority === "number"
        ? `spend priority ${chosen.model.spendPriority.toFixed(2)}`
        : "runway order";
    reasons.push(`picked ${chosen.model.provider}/${chosen.model.id} by ${pickedBy}`);
    return {
      bucket,
      ...(candidateSlot !== bucket ? { servedBucket: candidateSlot, ...empty } : {}),
      choice: chosen.ref,
      reasons,
    };
  }

  reasons.push(...skipped);
  reasons.push("no serveable catalog model; deferring to the runtime default");
  return {
    bucket,
    ...(input.catalog.length > 0 ? { unserveable: true as const, ...empty } : {}),
    reasons,
  };
}
