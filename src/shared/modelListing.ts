import { HELD_BACK, STARTER_SLOTS, starterMap, TRACKED_FAMILIES } from "./modelSlots";

/**
 * The lean-list rule (captain, 2026-09-23; docs/model-lists.md): which of a
 * provider's served models get a row. Pure - the core's slot record and the
 * live catalog checks both read it, so the app and its checks cannot
 * disagree about what "the newest generation" is.
 *
 * Listed = the newest served generation of each tracked family
 *        ∪ the starter rows ∪ what the user kept (slotted, pinned, or
 *        chosen as the Firstmate model).
 * Everything else served stays reachable by name only.
 */

/** A model id split around its version: "gpt-6-sol" is gpt | [6] | -sol. */
export type ModelLine = { line: string; version: number[] };

/**
 * The same split `newerId` routes by (routingEngine.ts): the line is the
 * id's prefix AND suffix around the version, so gpt-6-sol and gpt-6-luna are
 * different lines and claude-opus-5-5 is newer than claude-opus-4-8. An id
 * with no version is a line of its own.
 */
export function modelLine(id: string): ModelLine {
  const norm = id.toLowerCase().replace(/_/g, "-");
  const match = norm.match(/^(.*?)[.-](\d+(?:[.-]\d+)*)(.*)$/);
  if (!match || match[1] === undefined || !match[2]) return { line: norm, version: [] };
  return {
    line: `${match[1]}|${match[3] ?? ""}`,
    version: match[2].split(/[.-]/).map(Number),
  };
}

/** Positive when `a` is the newer version. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** The newest served generation of one family, as the id that gets the row. */
export type FamilyHead = {
  /** The family's name - the line for `every`, or the id an `ids` table names. */
  family: string;
  /** The runnable id listed for it. */
  id: string;
  /** Every served id of the family, newest generation first. */
  members: string[];
};

type Generation = { key: string; version: number[]; ids: string[] };

function newestGeneration(generations: Map<string, Generation>): Generation | undefined {
  let newest: Generation | undefined;
  for (const generation of generations.values()) {
    if (!newest) {
      newest = generation;
      continue;
    }
    const delta = compareVersions(generation.version, newest.version);
    if (delta > 0 || (delta === 0 && generation.key < newest.key)) newest = generation;
  }
  return newest;
}

function sortedMembers(generations: Map<string, Generation>): string[] {
  return [...generations.values()]
    .sort((a, b) => compareVersions(b.version, a.version) || a.key.localeCompare(b.key))
    .flatMap((generation) => [...generation.ids].sort());
}

/** Every line's newest id: the `every` rule. */
function everyFamilyHeads(served: readonly string[]): FamilyHead[] {
  const lines = new Map<string, Map<string, Generation>>();
  for (const id of served) {
    const { line, version } = modelLine(id);
    const generations = lines.get(line) ?? new Map<string, Generation>();
    lines.set(line, generations);
    generations.set(id, { key: id, version, ids: [id] });
  }
  return [...lines.entries()].flatMap(([line, generations]) => {
    const newest = newestGeneration(generations);
    return newest ? [{ family: line, id: newest.key, members: sortedMembers(generations) }] : [];
  });
}

/**
 * The newest served generation of each family the provider tracks. A
 * provider outside the table (a models.json provider) has no families: all
 * of it is the user's own list, and `listedIds` lists every id.
 */
export function familyHeads(providerId: string, served: readonly string[]): FamilyHead[] {
  const rule = TRACKED_FAMILIES[providerId];
  if (rule === undefined) return [];
  if (rule === "every") return everyFamilyHeads(served);
  const present = new Set(served);
  return rule.ids.filter((id) => present.has(id)).map((id) => ({ family: id, id, members: [id] }));
}

/** Whether a provider's rows are drawn by the lean rule at all. */
export function isTrackedProvider(providerId: string): boolean {
  return TRACKED_FAMILIES[providerId] !== undefined;
}

/**
 * The ids of one provider that get a row: each tracked family's newest
 * generation, the starter rows, and whatever the user kept - each only
 * when served. A provider the table does not name lists everything.
 */
export function listedIds(
  providerId: string,
  served: readonly string[],
  kept: ReadonlySet<string> = new Set(),
): Set<string> {
  if (!isTrackedProvider(providerId)) return new Set(served);
  const present = new Set(served);
  const listed = new Set(familyHeads(providerId, served).map((head) => head.id));
  for (const id of Object.keys(starterMap()[providerId] ?? {})) {
    if (present.has(id)) listed.add(id);
  }
  for (const id of kept) {
    if (present.has(id)) listed.add(id);
  }
  return listed;
}

/** The tracked family a served id belongs to, if any. */
function headFor(id: string, heads: readonly FamilyHead[]): FamilyHead | undefined {
  return heads.find((head) => head.members.includes(id));
}

/** A starter row whose family has a newer served generation than it names. */
export type StaleDefault = { id: string; newer: string; heldBack?: string };

/**
 * Starter rows a generation behind their family (the Grok 4.7 case). A row
 * held back in HELD_BACK carries its reason and is not a failure.
 */
export function staleDefaults(providerId: string, served: readonly string[]): StaleDefault[] {
  const heads = familyHeads(providerId, served);
  const stale: StaleDefault[] = [];
  for (const id of Object.keys(STARTER_SLOTS[providerId] ?? {})) {
    const head = headFor(id, heads);
    if (!head || head.id === id) continue;
    if (compareVersions(modelLine(head.id).version, modelLine(id).version) <= 0) continue;
    const reason = HELD_BACK[providerId]?.[id];
    stale.push({ id, newer: head.id, ...(reason ? { heldBack: reason } : {}) });
  }
  return stale;
}

/** Ids an `ids` table names that the catalog no longer serves at all. */
export function vanishedFamilies(providerId: string, served: readonly string[]): string[] {
  const rule = TRACKED_FAMILIES[providerId];
  if (rule === undefined || rule === "every") return [];
  const present = new Set(served);
  return rule.ids.filter((id) => !present.has(id));
}

/** What a live catalog check prints and never fails on (docs/model-lists.md). */
export type CatalogDigest = {
  /** Each family's listed row, with how many served ids it stands for. */
  heads: { family: string; id: string; members: number }[];
  /** Served ids that are not a family's newest generation, nor a starter. */
  unlisted: number;
};

export function catalogDigest(providerId: string, served: readonly string[]): CatalogDigest {
  const heads = familyHeads(providerId, served);
  const listed = listedIds(providerId, served);
  return {
    heads: heads.map((head) => ({
      family: head.family,
      id: head.id,
      members: head.members.length,
    })),
    unlisted: served.filter((id) => !listed.has(id)).length,
  };
}

/** The digest as the lines a probe prints. */
export function describeDigest(providerId: string, digest: CatalogDigest): string {
  const lines = [
    `${providerId}: ${digest.heads.length} rows, ${digest.unlisted} more by name only`,
  ];
  for (const head of digest.heads) {
    lines.push(`  ${head.family}: ${head.id}${head.members > 1 ? ` (of ${head.members})` : ""}`);
  }
  return lines.join("\n");
}
