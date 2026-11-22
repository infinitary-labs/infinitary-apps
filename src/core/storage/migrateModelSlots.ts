import type { Slot } from "@shared/modelSlots";
import { EMPTY_MODEL_SLOTS, offeringKey, parseOfferingKey } from "@shared/modelSlots";
import type { AppDatabase } from "./db";

/**
 * Snapshot of the editorial table + heuristic that used to stamp
 * catalog.intelligence (src/core/quota/catalog.ts before slots). The live
 * classifier is deleted; a migration must not depend on it. Keys match on a
 * normalized id (dots and dashes are one separator), the same way the old
 * table did, so an upgrade rearranges nothing.
 */
const FROZEN_BUCKETS: Record<string, Slot> = {
  "claude-fable-5": "premium",
  "claude-opus-4-5": "high",
  "claude-opus-4-5-20251101": "high",
  "claude-opus-4-6": "high",
  "claude-opus-4-7": "high",
  "claude-opus-4-8": "high",
  "claude-opus-5": "high",
  "claude-sonnet-4-5": "medium",
  "claude-sonnet-4-5-20250929": "medium",
  "claude-sonnet-4-6": "medium",
  "claude-sonnet-5": "medium",
  "claude-haiku-4-5": "low",
  "claude-haiku-4-5-20251001": "low",
  "gpt-5.5": "high",
  "gpt-5.6-sol": "high",
  "gpt-5.4": "high",
  "gpt-5.6-terra": "medium",
  "gpt-5.4-mini": "low",
  "gpt-5.6-luna": "low",
  "gpt-5.3-codex-spark": "low",
  "grok-4.5": "high",
  "grok-4.6": "high",
  "grok-4.3": "high",
  "grok-build-0.1": "medium",
  auto: "medium",
  "composer-2.5": "medium",
  "gpt-5.3-codex": "high",
  k3: "high",
  "kimi-for-coding": "high",
  "k3-256k": "medium",
  "kimi-for-coding-highspeed": "low",
  "kimi-k3": "high",
  "gpt-5.2": "high",
  "gpt-5.2-codex": "high",
  "claude-sonnet-4": "medium",
  "gemini-3.1-pro-preview": "medium",
  "gpt-4.1": "low",
  "claude-sonnet-5-thinking-high": "medium",
  "cursor-grok-4.6-high": "high",
};

function normalizeId(id: string): string {
  return id.toLowerCase().replace(/\./g, "-");
}

const NORMALIZED: Record<string, Slot> = Object.fromEntries(
  Object.entries(FROZEN_BUCKETS).map(([id, slot]) => [normalizeId(id), slot]),
);

export function frozenClassify(id: string, name = ""): Slot {
  const explicit = NORMALIZED[normalizeId(id)];
  if (explicit) return explicit;
  const haystack = `${id} ${name}`.toLowerCase();
  if (/\b(haiku|mini|spark|luna|nano|fast|flash|highspeed)\b/.test(haystack)) return "low";
  if (/\bfable\b/.test(haystack)) return "premium";
  if (/\b(opus|gpt-5\.[5-9]|grok-4\.[3-9])\b/.test(haystack)) return "high";
  return "medium";
}

type LegacyActivation = {
  accounts?: Record<string, { active?: unknown; known?: unknown }>;
};

/**
 * Migration 21: convert settings.model-activation into settings.model-slots
 * so the routable pool after the upgrade equals the pool before it. Leaves
 * the model-activation row in place, unread, for one release.
 */
export function migrateModelSlots(db: AppDatabase): void {
  const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get("model-slots") as
    | { value: string }
    | undefined;
  if (existing) return;

  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("model-activation") as
    | { value: string }
    | undefined;
  if (!row) return;

  let parsed: LegacyActivation;
  try {
    parsed = JSON.parse(row.value) as LegacyActivation;
  } catch {
    return;
  }
  const accounts = parsed.accounts;
  if (!accounts || typeof accounts !== "object") return;

  const assignments: Record<string, Slot> = {};
  const seen = new Set<string>();

  for (const record of Object.values(accounts)) {
    const known = Array.isArray(record.known)
      ? record.known.filter((k) => typeof k === "string")
      : [];
    const active = Array.isArray(record.active)
      ? record.active.filter((k) => typeof k === "string")
      : [];
    for (const key of known) seen.add(key);
    for (const key of active) {
      const { id } = parseOfferingKey(key);
      if (!id) continue;
      // First active write wins; a later account with the same offering
      // already classified the same way (the frozen table is provider-blind).
      assignments[key] ??= frozenClassify(id);
    }
  }

  const state = {
    version: 1 as const,
    assignments,
    seen: [...seen],
  };
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("model-slots", JSON.stringify(state));
}

const GPT6_SLOT_MOVES: Record<string, string> = {
  "gpt-5.6-sol": "gpt-6-sol",
  "gpt-5.6-terra": "gpt-6-luna",
  "gpt-5.6-luna": "gpt-6-luna",
};

const SLOT_ORDER: readonly Slot[] = ["premium", "high", "medium", "low"];

function asSlots(value: unknown): Slot[] {
  const raw = Array.isArray(value) ? value : [value];
  return SLOT_ORDER.filter((slot) => raw.includes(slot));
}

/**
 * Migration 39: move saved GPT-5.6 slot picks onto the GPT-6 rows the
 * starter map names. A pick keeps the slots the user chose; terra and luna
 * that both land on gpt-6-luna keep every slot between them. The old
 * offering stays in `seen` so it is not announced as a newcomer, and the
 * new id is marked seen too - including when the old pick was off - so the
 * starter seed does not turn a turned-off row back on. Astra is untouched.
 * No-op when the row names none of the three ids.
 */
export function migrateGpt6Slots(db: AppDatabase): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("model-slots") as
    | { value: string }
    | undefined;
  if (!row) return;

  let parsed: { version?: number; assignments?: Record<string, unknown>; seen?: unknown };
  try {
    parsed = JSON.parse(row.value) as typeof parsed;
  } catch {
    return;
  }
  if (!parsed.assignments || typeof parsed.assignments !== "object") return;

  const seen = Array.isArray(parsed.seen)
    ? parsed.seen.filter((key): key is string => typeof key === "string")
    : [];
  const movedId = (key: string) => GPT6_SLOT_MOVES[parseOfferingKey(key).id];
  if (!Object.keys(parsed.assignments).some(movedId) && !seen.some(movedId)) return;

  const assignments: Record<string, unknown> = { ...parsed.assignments };
  for (const [key, value] of Object.entries(parsed.assignments)) {
    const { provider, id } = parseOfferingKey(key);
    const nextId = GPT6_SLOT_MOVES[id];
    if (!nextId || !provider) continue;
    const target = offeringKey({ provider, id: nextId });
    delete assignments[key];
    assignments[target] = asSlots([...asSlots(assignments[target]), ...asSlots(value)]);
  }

  const seenSet = new Set(seen);
  const markSeen = (key: string) => {
    const { provider, id } = parseOfferingKey(key);
    const nextId = GPT6_SLOT_MOVES[id];
    if (!nextId || !provider) return;
    seenSet.add(offeringKey({ provider, id: nextId }));
  };
  for (const key of seen) markSeen(key);
  for (const key of Object.keys(parsed.assignments)) markSeen(key);

  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
    JSON.stringify({
      version: parsed.version ?? 1,
      assignments,
      seen: [...seenSet],
    }),
    "model-slots",
  );
}

export function emptyMigratedSlots(): typeof EMPTY_MODEL_SLOTS {
  return { ...EMPTY_MODEL_SLOTS, assignments: {}, seen: [] };
}

export { offeringKey };
