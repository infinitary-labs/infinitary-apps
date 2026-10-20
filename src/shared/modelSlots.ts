import { z } from "zod";
import { crewSpeedSchema } from "./crewSpeed";
import { catalogEntry } from "./providers";
import { reasoningSchema } from "./reasoning";

/**
 * User-assigned intelligence slots. The catalog no longer stamps a
 * per-model tier; the user places each offering in any of these four (zero
 * or more), and off means in no slot (settled 2026-09-10, reopened
 * 2026-09-15 to allow more than one). The names ARE the contract: the tier
 * the work-shape policy computes, bucket: gate refs and supervision
 * grains, and routing_decisions.bucket all speak them.
 */
export const slotSchema = z.enum(["premium", "high", "medium", "low"]);
export type Slot = z.infer<typeof slotSchema>;
export const SLOTS: ReadonlyArray<Slot> = ["premium", "high", "medium", "low"];

/** The slot automatic crewmate routing may never reach for. */
export const PREMIUM_SLOT = "premium" as const;

/**
 * The slots automatic crewmate routing operates over, strongest first.
 * Firstmate Auto has a separate high → medium → premium → low ladder.
 */
export const AUTO_ROUTABLE_SLOTS: ReadonlyArray<Slot> = ["high", "medium", "low"];

/** True when a crewmate slot may be chosen without the user naming the model. */
export function isAutoRoutableSlot(slot: Slot): boolean {
  return slot !== PREMIUM_SLOT;
}

/**
 * An offering: one model as one provider serves it. Decision C stands -
 * the same model id on two providers is two offerings, keyed provider/id.
 */
export function offeringKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function parseOfferingKey(key: string): { provider: string; id: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return { provider: "", id: key };
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

/**
 * A single legacy scalar coerces to its one-element array on read; every
 * write after that always persists an array, so this only ever fires
 * against data written before multi-slot shipped.
 */
const slotMembershipSchema = z
  .union([slotSchema, z.array(slotSchema)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

export const reasoningChoiceSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningChoice = z.infer<typeof reasoningChoiceSchema>;
export const reasoningCapabilitiesSchema = z.object({
  levels: z.array(reasoningChoiceSchema),
  fixed: z.enum(["off", "default"]).optional(),
});
export type ReasoningCapabilities = z.infer<typeof reasoningCapabilitiesSchema>;
const reasoningOverridesSchema = z.record(
  z.string(),
  z.partialRecord(slotSchema, reasoningChoiceSchema),
);

export const modelSlotsStateSchema = z.object({
  version: z.literal(1),
  /** offering → slots. An absent key or an empty array is OFF: never auto-picked, still pinnable. */
  assignments: z.record(z.string(), slotMembershipSchema),
  /** every offering this install has ever been offered. Seeding only touches keys absent here. */
  seen: z.array(z.string()),
  /** Choices survive membership changes; absent means inherit. */
  reasoning: reasoningOverridesSchema.optional(),
  /** Per offering, shared by every account; absent means Standard. */
  speed: z.record(z.string(), crewSpeedSchema).optional(),
  /**
   * offering → when it arrived as announced news (epoch ms), for the board's
   * "new" mark. Saved, so a later catalog read or a restart keeps the mark
   * until the person changes the model's levels or it has had a week.
   */
  arrived: z.record(z.string(), z.number()).optional(),
});
export type ModelSlotsState = z.infer<typeof modelSlotsStateSchema>;

export const EMPTY_MODEL_SLOTS: ModelSlotsState = {
  version: 1,
  assignments: {},
  seen: [],
};

/**
 * Per account, the model ids its last SUCCESSFUL catalog read served
 * (docs/model-lists.md). The one baseline a departure is measured against:
 * a model leaves only when one successful read no longer lists what the
 * previous one did, never because a read failed.
 */
export const servedBaselinesSchema = z.record(z.string(), z.array(z.string()));
export type ServedBaselines = z.infer<typeof servedBaselinesSchema>;

/**
 * The settled starter map (captain, 2026-09-10). Today's default-approved
 * entries with their slot attached, plus the captain's anchors. A row for
 * an id the provider never ships is inert: seeding only runs over offerings
 * in the pool, which is why an id has to be the one its provider actually
 * serves. Fable sat here under guessed spellings before anything checked
 * them (FI3-74), so each Fable row below is the id its provider's own
 * catalog answers with, and the Claude one moves when the model probe
 * (docs/claude-model-probe.md) says the installed client's answer moved.
 */
export const STARTER_SLOTS: Readonly<Record<string, Readonly<Record<string, readonly Slot[]>>>> = {
  // GPT-6.1 Sol takes high and medium (2026-09-29). GPT-6 Astra stays
  // premium and GPT-6 Luna stays low. Existing saved picks remain the
  // person's choices; migration 39 only moved earlier GPT-5.6 picks.
  "openai-codex": {
    "gpt-6-astra": ["premium"],
    "gpt-6.1-sol": ["high", "medium"],
    "gpt-6-luna": ["low"],
  },
  // Grok 4.7 is medium on every provider that serves it (captain, 2026-09-23).
  xai: { "grok-4.7": ["medium"] },
  "anthropic-claude": {
    // The id Claude's own client serves Fable under, which is what the model
    // probe checks CLAUDE_MODELS against (docs/claude-model-probe.md):
    // Fable 5.1 on Claude Code 2.1.278 (2026-09-20), where 2.1.234 had
    // served "claude-fable-5" - a row the client no longer answers is inert
    // rather than premium (FI3-74's shape).
    "claude-fable-5-1": ["premium"],
    "claude-opus-5-5": ["high"],
    "claude-sonnet-5-5": ["medium"],
    "claude-haiku-5-5": ["low"],
  },
  // Kimi Code starts with these two only (captain, 2026-10-19): "k3 high,
  // kimi-for-coding medium only".
  "kimi-coding": {
    k3: ["high"],
    "kimi-for-coding": ["medium"],
  },
};

/**
 * How much of each provider's catalog gets a row (lean model lists, captain
 * 2026-09-23, docs/model-lists.md). `every` lists the newest generation of
 * every family the provider serves - Claude, Codex and Grok serve a handful,
 * and a new family there is news. An `ids` table names exact rows.
 * Everything else a provider serves stays reachable by name only: it is
 * never listed, announced or picked on its own. Starter rows and anything
 * the user kept (slotted, pinned, or chosen as the Firstmate model) are
 * always listed besides.
 */
export const TRACKED_FAMILIES: Readonly<
  Record<string, "every" | { readonly ids: readonly string[] }>
> = {
  "anthropic-claude": "every",
  "openai-codex": "every",
  xai: "every",
  // Kimi Code lists only its two starter rows; k3-256k and the highspeed
  // row stay reachable by name.
  "kimi-coding": { ids: ["k3", "kimi-for-coding"] },
  // OpenRouter lists 388 ids from 47 vendors. Its own `~…-latest` aliases
  // already follow each family's newest generation, so the rows are those
  // aliases for the families Infinitary itself serves.
  openrouter: {
    ids: [
      "~anthropic/claude-fable-latest",
      "~anthropic/claude-opus-latest",
      "~anthropic/claude-sonnet-latest",
      "~anthropic/claude-haiku-latest",
      "~openai/gpt-astra-latest",
      "~openai/gpt-sol-latest",
      "~openai/gpt-luna-latest",
      "~x-ai/grok-latest",
    ],
  },
};

/**
 * Starter rows deliberately left a generation behind, each with the reason.
 * The live catalog checks fail when a starter's family has a newer served
 * generation (docs/model-lists.md); an entry here is how a person answers
 * that failure without moving the default. Keyed provider, then starter id.
 */
export const HELD_BACK: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

/** The starter slots for one offering. Empty when the map leaves it off. */
export function starterSlots(providerId: string, id: string): readonly Slot[] {
  return STARTER_SLOTS[providerId]?.[id] ?? [];
}

/** The starter-map keys for one provider, as offering keys. */
export function starterKeys(providerId: string): string[] {
  return Object.keys(STARTER_SLOTS[providerId] ?? {}).map((id) => `${providerId}/${id}`);
}

/** Every starter-map key across providers. */
export function allStarterKeys(): string[] {
  return Object.keys(STARTER_SLOTS).flatMap((providerId) => starterKeys(providerId));
}

/**
 * An id's ordering shape: the family stem (everything before the first
 * version number), the version as a number list, and any variant suffix
 * after it - "claude-opus-4-8" is family "claude-opus", [4,8]; "gpt-6-sol"
 * is family "gpt", [6], "-sol". An id with no version keeps the whole id
 * as its family so it still groups and orders deterministically.
 */
function modelIdShape(id: string): { family: string; version: number[]; suffix: string } {
  const norm = id.toLowerCase().replace(/_/g, "-");
  const match = norm.match(/^(.*?)[.-](\d+(?:[.-]\d+)*)(.*)$/);
  if (!match?.[2]) return { family: norm, version: [], suffix: "" };
  return {
    family: match[1] || norm,
    version: match[2].split(/[.-]/).map(Number),
    suffix: match[3] ?? "",
  };
}

/** Descending version compare: negative when `a` is the newer version. */
function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * The order every model list in Settings -> Intelligence -> Models reads
 * (the slot cards, the Off group, the add-model and decisions pickers - all
 * render this one sequence):
 *
 * 1. provider label A-Z, so a vendor's models sit together;
 * 2. model family, ranked by that family's newest generation first -
 *    families with no version number rank last, by name;
 * 3. generation newest-first inside the family;
 * 4. same-generation variants by the starter map's tier (premium, high,
 *    medium, low); variants the map does not name follow, by suffix;
 * 5. the id itself, so nothing ever compares equal.
 *
 * Nothing is tabled per provider: the rule reads any catalog the same way,
 * so a provider that ships a new family or generation lands in place on
 * its own.
 */
export function sortModelRows<T extends { provider: string; providerLabel: string; id: string }>(
  rows: readonly T[],
): T[] {
  const shapeOf = new Map<T, { family: string; version: number[]; suffix: string }>();
  const familyBest = new Map<string, number[]>();
  for (const row of rows) {
    const shape = modelIdShape(row.id);
    shapeOf.set(row, shape);
    const key = `${row.provider}|${shape.family}`;
    const best = familyBest.get(key);
    if (!best || compareVersionsDesc(shape.version, best) < 0) familyBest.set(key, shape.version);
  }
  const starterRank = (row: T): number => {
    const slots = starterSlots(row.provider, row.id);
    return slots.length === 0
      ? SLOTS.length
      : Math.min(...slots.map((slot) => SLOTS.indexOf(slot)));
  };
  return [...rows].sort((a, b) => {
    const provider = a.providerLabel.localeCompare(b.providerLabel);
    if (provider !== 0) return provider;
    const A = shapeOf.get(a) as { family: string; version: number[]; suffix: string };
    const B = shapeOf.get(b) as { family: string; version: number[]; suffix: string };
    if (A.family !== B.family) {
      const bestA = familyBest.get(`${a.provider}|${A.family}`) as number[];
      const bestB = familyBest.get(`${b.provider}|${B.family}`) as number[];
      if ((bestA.length === 0) !== (bestB.length === 0)) return bestA.length === 0 ? 1 : -1;
      return compareVersionsDesc(bestA, bestB) || A.family.localeCompare(B.family);
    }
    return (
      compareVersionsDesc(A.version, B.version) ||
      starterRank(a) - starterRank(b) ||
      A.suffix.localeCompare(B.suffix) ||
      a.id.localeCompare(b.id)
    );
  });
}

/** One model row on the slot-first Settings board. */
export const slotModelViewSchema = z.object({
  /** Pi provider id serving this model (never the quota id). */
  provider: z.string(),
  providerLabel: z.string(),
  id: z.string(),
  label: z.string(),
  /** empty = off (in no slot); may carry more than one. */
  slots: z.array(slotSchema),
  reasoningCapabilities: reasoningCapabilitiesSchema.optional(),
  speed: crewSpeedSchema.optional(),
  /** Union of fresh account capabilities, not a promise about a routed account. */
  speeds: z.array(crewSpeedSchema).optional(),
  reasoning: z
    .partialRecord(
      slotSchema,
      z.object({
        chosen: reasoningChoiceSchema.optional(),
        effective: reasoningSchema.optional(),
      }),
    )
    .optional(),
  /**
   * Arrived as announced news after this install had already seen the
   * provider's catalog, within the last week and with its levels untouched since.
   */
  isNew: z.boolean().optional(),
  /** The computer the model runs on, when it is not this Mac's. */
  place: z.string().min(1).max(64).optional(),
});
export type SlotModelView = z.infer<typeof slotModelViewSchema>;

export const modelSlotsViewSchema = z.object({
  /** The listed rows (docs/model-lists.md): what the board shows. */
  models: z.array(slotModelViewSchema),
  /**
   * Everything else the signed-in accounts serve, for the "use a model by
   * name" controls. Never rows on the board; choosing one keeps it, which
   * lists it from then on.
   */
  byName: z.array(slotModelViewSchema).default([]),
  /**
   * True when nothing currently available is assigned, so routing is running
   * off the starter map (or the whole signed-in pool). The surface says so.
   */
  usingDefaults: z.boolean(),
});
export type ModelSlotsView = z.infer<typeof modelSlotsViewSchema>;

export function providerLabel(providerId: string): string {
  return catalogEntry(providerId)?.name ?? providerId;
}

/**
 * Routing still records `bucket` on routing_decisions; the values were slot
 * names already. The computed tier on a task record, quota-gate refs, and
 * supervision grains keep speaking these four words.
 */
export type IntelligenceBucket = Slot;
export const intelligenceBucketSchema = slotSchema;
export const PREMIUM_BUCKET = PREMIUM_SLOT;
export const AUTO_ROUTABLE_BUCKETS = AUTO_ROUTABLE_SLOTS;
export const isAutoRoutableBucket = isAutoRoutableSlot;
