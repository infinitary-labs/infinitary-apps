import { isCustomApiProvider } from "@shared/customApi";
import { isOfferedProvider } from "@shared/providers";
import {
  type CatalogModelView,
  type IntelligenceBucket,
  isSensedProvider,
  type ModelPin,
  type Slot,
  servedModelKey,
  servedProviderOf,
} from "@shared/quota";
import {
  allowanceSpent,
  type BandRank,
  bandOf,
  compareBandRank,
  type SpendBand,
} from "@shared/quotaSignals";
import type { RoutingCandidateFact } from "../storage/decisionStore";
import { capabilityMiss, type ModelCapabilityLookup, type TurnNeeds } from "./capability";

/**
 * The routing engine (docs/architecture.md section 6): a pure function over
 * the task, the quota catalog, Pi availability, user slots, and user pins.
 *
 * 1. The reasoning class arrives as a judgment from the caller - Firstmate
 *    reads the task and says low, medium, high, or premium (see the
 *    routing rule in FIRSTMATE_PROMPT_CORE). No prompt heuristic lives
 *    here; absent a class the request is medium.
 * 2. Candidates = slot ∩ Pi-available models, minus exhausted scopes. A
 *    model with no allowance row - a checked custom connection's, an
 *    offered provider's whose allowance nobody reads (OpenRouter), or a
 *    computer's own - is admitted by slot membership alone. So is every
 *    offered model while the catalog is empty: no allowance has been read
 *    yet (before the first reading, or when none lands), which is unknown,
 *    never zero.
 * 3. Within a slot, serveable candidates rank band first (INF-1714): an
 *    unadjusted reading projected to last through every reset, then one
 *    projected to run out, then one at or below the near-floor, then an
 *    unknown one. Inside a band they rank by spend priority (quota-axi
 *    semantics, adjusted for placed work: highest first); unmeasurable
 *    signals keep runway order among themselves, and a newer id of the
 *    same model line in the same band still overrides (recency within slot).
 *    Models no allowance is read for, placed by a person, take turns: the
 *    one picked least recently goes (`turns`, INF-3782).
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
  /**
   * Quota catalog models in runway order; `band`, when present, is the band
   * of the unadjusted reading beside a placed-work-adjusted score.
   */
  catalog: (CatalogModelView & { band?: SpendBand })[];
  /**
   * Models Pi can actually serve right now (configured auth). Pins resolve
   * against THIS pool, not the slotted one: an explicit pin is the user
   * naming a model, which is its own placement.
   */
  available: PiModelRef[];
  /**
   * Models with no quota-catalog row that slot membership may still choose:
   * a computer's own list for a provider this Mac's catalog lacks.
   * Custom connections and an offered provider's models with no allowance
   * reader (`allowanceless`) are admitted from `available` and need not be
   * repeated.
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
  /**
   * Taking turns (INF-3782): set only when `slotted` is the person's own
   * placement, never the slot record's fallback. Each model with no
   * allowance row maps to the id of its newest chosen routing row; a model
   * absent from the map was never picked. When the leader of a slot is such
   * a model and two or more of them tie with it, the one picked least
   * recently is chosen, so they take turns. Previews write no row, so they
   * never advance the turn.
   */
  turns?: { lastPicked: ReadonlyMap<string, number> };
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
  /**
   * Every catalog model the router weighed, with the reading and score
   * behind it and what became of it (pinned choices score nothing, so a pin
   * leaves this empty). The record keeps them; nothing reads them to rank.
   */
  candidates: RoutingCandidateFact[];
  /**
   * What decided the choice, as a typed fact for the record (INF-1714):
   * a pin, the band (the runner-up sat in a lower one), spend priority
   * inside the band, same-line recency, runway order, or the only candidate.
   */
  decidedBy?: DecidedBy;
  /**
   * Set when models with no allowance reading took turns for this choice
   * (INF-3782); `decidedBy` stays `runway-order`, the closed set's word for
   * a choice no reading made.
   */
  turns?: true;
};

export type DecidedBy =
  | "pin"
  | "band"
  | "spend-priority"
  | "recency"
  | "runway-order"
  | "only-candidate";

/** How the reasons record says why a higher score sat in a lower band. */
const BAND_WORDS: Record<SpendBand, string> = {
  room: "lasts through its reset",
  conserve: "is projected to run out before its reset",
  near_floor: "is at or below the near-floor",
  unknown: "has no usable reading",
  credits: "spends credits past its allowance",
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
 * Whether an available model can have no quota-catalog row, so only its
 * slot admits it: a checked custom connection's, or an offered provider's
 * whose allowance nobody reads (OpenRouter, billed by the token). A model
 * the catalog would describe is never one, so it keeps its exhaustion and
 * band checks; a base-runtime provider the catalog does not offer (a
 * models.json provider) is still never a choice.
 */
export function allowanceless(ref: PiModelRef): boolean {
  return (
    isCustomApiProvider(ref.provider) ||
    (isOfferedProvider(ref.provider) && !isSensedProvider(ref.provider))
  );
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
  const toPiRef = (model: CatalogModelView): PiModelRef => ({
    provider: servedProviderOf(model.provider),
    id: model.id,
  });
  const slotsOf = (ref: PiModelRef): Slot[] | undefined => {
    if (!slots) return ["medium"];
    return slots.get(`${ref.provider}/${ref.id}`);
  };

  // Pins always win, if Pi can serve them and the provider is offered.
  for (const pin of input.pins) {
    const piProvider = servedProviderOf(pin.provider);
    if (!isOfferedProvider(piProvider) && !isCustomApiProvider(piProvider)) continue;
    if (availableKeys.has(servedModelKey(pin))) {
      reasons.push(`pinned ${pin.provider}/${pin.id}`);
      return {
        bucket,
        choice: { provider: piProvider, id: pin.id },
        reasons,
        candidates: [],
        decidedBy: "pin",
      };
    }
  }

  const skipped: string[] = [];
  // Each available catalog model's reading and what became of it; a model the
  // ladder never reached stays "other slot" (or "not reached").
  const facts = new Map<string, RoutingCandidateFact>();
  for (const model of input.catalog) {
    const ref = toPiRef(model);
    const key = `${ref.provider}/${ref.id}`;
    if (!availableKeys.has(servedModelKey(model)) || facts.has(key)) continue;
    facts.set(key, {
      provider: ref.provider,
      model: ref.id,
      ...(typeof model.effectivePercentRemaining === "number"
        ? { percentRemaining: model.effectivePercentRemaining }
        : {}),
      ...(model.paceStatus ? { pace: model.paceStatus } : {}),
      ...(typeof model.spendPriority === "number" ? { spendPriority: model.spendPriority } : {}),
      ...(typeof model.lastsThroughReset === "boolean"
        ? { lastsThroughReset: model.lastsThroughReset }
        : {}),
      band: bandOf(model),
      status: "not reached",
    });
  }
  const mark = (ref: PiModelRef, status: string) => {
    const fact = facts.get(`${ref.provider}/${ref.id}`);
    if (fact) fact.status = status;
  };
  const candidates = () => [...facts.values()];
  const catalogKeys = new Set<string>(input.catalog.map((model) => servedModelKey(model)));
  // No allowance read yet - an empty catalog, before the first reading lands
  // or when none does - leaves every sensed model's allowance unknown, never
  // zero: its slot alone admits it, in the unknown band, as its catalog row
  // would once a reading came back unknown. They come first among the
  // extras, where their rows would sit.
  const unread =
    input.catalog.length === 0
      ? input.available.filter(
          (ref) => isOfferedProvider(ref.provider) && isSensedProvider(ref.provider),
        )
      : [];
  const empty = [...input.available, ...(input.unowned ?? [])].some((ref) =>
    slotsOf(ref)?.includes(bucket),
  )
    ? {}
    : { emptyBucket: true as const };

  for (const candidateSlot of BUCKET_FALLBACK[bucket]) {
    const inSlot: {
      model: { provider: string; id: string } & BandRank;
      ref: PiModelRef;
      slot: Slot;
      /** A model no allowance is read for, which may take turns (INF-3782). */
      turnTaker?: true;
    }[] = input.catalog.flatMap((model) => {
      const ref = toPiRef(model);
      if (!availableKeys.has(servedModelKey(model))) return [];
      const memberSlots = slotsOf(ref);
      if (memberSlots === undefined) {
        skipped.push(`skipped ${ref.provider}/${ref.id}: not in a slot`);
        mark(ref, "skipped: not in a slot");
        return [];
      }
      if (!memberSlots.includes(candidateSlot)) return [];
      // A spent allowance stays out unless its account keeps going on
      // credits: then it routes in the last band (INF-4104 piece 2).
      if (allowanceSpent(model)) {
        mark(ref, `skipped: exhausted at ${candidateSlot}`);
        return [];
      }
      const miss = capabilityMiss({
        ref,
        ...(input.needs ? { needs: input.needs } : {}),
        ...(input.capabilityFor ? { capabilityFor: input.capabilityFor } : {}),
      });
      if (miss) {
        skipped.push(miss);
        mark(ref, "skipped: cannot serve this turn");
        return [];
      }
      mark(ref, `eligible at ${candidateSlot}`);
      return [{ model, ref, slot: candidateSlot }];
    });
    // Sensed models no allowance was read for yet, checked connection-owned
    // models, an offered provider's models whose allowance nobody reads, and
    // a computer's models the quota catalog does not list. Only slot
    // membership admits them.
    const unreadKeys = new Set(unread.map((ref) => `${ref.provider}/${ref.id}`));
    const extras = [...unread, ...input.available.filter(allowanceless), ...(input.unowned ?? [])];
    const seenExtra = new Set<string>();
    for (const ref of extras) {
      const key = `${ref.provider}/${ref.id}`;
      // A model the catalog describes was weighed above, with its reading.
      if (seenExtra.has(key) || catalogKeys.has(key)) continue;
      if (!slots?.get(key)?.includes(candidateSlot)) continue;
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
      inSlot.push({
        model: { provider: ref.provider, id: ref.id },
        ref,
        slot: candidateSlot,
        // A sensed model whose reading has not landed yet is not one: its
        // allowance will be read, so it never takes turns.
        ...(unreadKeys.has(key) ? {} : { turnTaker: true as const }),
      });
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
    for (const entry of inSlot) {
      if (!elsewhere.includes(entry) && elsewhere.length > 0) {
        mark(entry.ref, `eligible at ${candidateSlot}, avoided for the reviewer`);
      }
    }
    const pool = elsewhere.length > 0 ? elsewhere : inSlot;
    const ranked = [...pool].sort((a, b) => compareBandRank(a.model, b.model));
    let chosen = ranked[0] as (typeof ranked)[number];
    // Recency overrides only inside the leader's band, so a newer id never
    // brings back a model in a lower band.
    const band = bandOf(chosen.model);
    const highest = ranked.reduce(
      (best, entry) =>
        (entry.model.spendPriority ?? Number.NEGATIVE_INFINITY) >
        (best.model.spendPriority ?? Number.NEGATIVE_INFINITY)
          ? entry
          : best,
      chosen,
    );
    let recencyOverride = false;
    for (const entry of ranked) {
      if (bandOf(entry.model) !== band) continue;
      if (newerId(entry.model.id, chosen.model.id) === true) {
        chosen = entry;
        recencyOverride = true;
      }
    }
    // Taking turns (INF-3782): when the leader is a model no allowance is
    // read for, it and every other such model in the pool tie - nothing
    // ranks them - so the one picked least recently goes, never-picked
    // first in list order. A model with a newer id of its line among them
    // sits out, as same-line recency says.
    const turnLines: string[] = [];
    let turnTakers: typeof ranked = [];
    const turns = input.turns;
    if (turns && chosen.turnTaker) {
      const tied = ranked.filter((entry) => entry.turnTaker);
      const takers = tied.filter(
        (entry) => !tied.some((other) => newerId(other.model.id, entry.model.id) === true),
      );
      if (takers.length >= 2) {
        turnTakers = takers;
        const last = (entry: (typeof ranked)[number]) =>
          turns.lastPicked.get(`${entry.ref.provider}/${entry.ref.id}`) ?? Number.NEGATIVE_INFINITY;
        chosen = takers.reduce((best, entry) => (last(entry) < last(best) ? entry : best));
        recencyOverride = false;
        const previous = takers.reduce((best, entry) => (last(entry) > last(best) ? entry : best));
        const names = takers.map((entry) => `${entry.ref.provider}/${entry.ref.id}`).join(", ");
        turnLines.push(`no allowance is read for ${names}; they take turns`);
        if (previous !== chosen && last(previous) !== Number.NEGATIVE_INFINITY) {
          turnLines.push(`${previous.ref.provider}/${previous.ref.id} took the previous turn`);
        }
        for (const entry of takers) {
          facts.set(`${entry.ref.provider}/${entry.ref.id}`, {
            provider: entry.ref.provider,
            model: entry.ref.id,
            band: "unknown",
            status:
              entry === chosen
                ? `picked at ${candidateSlot}`
                : `eligible at ${candidateSlot}, took turns`,
          });
        }
      }
    }
    mark(chosen.ref, `picked at ${candidateSlot}`);
    reasons.push(...skipped);
    if (candidateSlot !== bucket) {
      reasons.push(`no serveable ${bucket} model; fell back to ${candidateSlot}`);
    }
    const runnerUp = ranked.find((entry) => entry !== chosen);
    const decidedBy: DecidedBy = recencyOverride
      ? "recency"
      : turnTakers.length > 0
        ? "runway-order"
        : !runnerUp
          ? "only-candidate"
          : bandOf(runnerUp.model) !== band
            ? "band"
            : typeof chosen.model.spendPriority === "number"
              ? "spend-priority"
              : "runway-order";
    const pickedBy = recencyOverride
      ? "same-line recency over spend priority"
      : turnTakers.length > 0
        ? "taking turns, the least recently picked"
        : typeof chosen.model.spendPriority === "number"
          ? `spend priority ${chosen.model.spendPriority.toFixed(2)}`
          : "runway order";
    if (highest !== ranked[0] && bandOf(highest.model) !== band) {
      reasons.push(
        `${highest.model.provider}/${highest.model.id} has a higher spend priority but ${BAND_WORDS[bandOf(highest.model)]}`,
      );
    }
    reasons.push(...turnLines);
    // Every included allowance at this level is spent: say the pick spends credits.
    if (bandOf(chosen.model) === "credits") {
      reasons.push(`${chosen.model.provider}/${chosen.model.id} ${BAND_WORDS.credits}`);
    }
    reasons.push(`picked ${chosen.model.provider}/${chosen.model.id} by ${pickedBy}`);
    return {
      bucket,
      ...(candidateSlot !== bucket ? { servedBucket: candidateSlot, ...empty } : {}),
      choice: chosen.ref,
      reasons,
      candidates: candidates(),
      decidedBy,
      ...(turnTakers.length > 0 ? { turns: true as const } : {}),
    };
  }

  reasons.push(...skipped);
  reasons.push("no serveable catalog model; deferring to the runtime default");
  return {
    bucket,
    ...(input.catalog.length > 0 ? { unserveable: true as const, ...empty } : {}),
    reasons,
    candidates: candidates(),
  };
}
