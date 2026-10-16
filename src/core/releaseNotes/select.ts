import type { UnresolvedRange } from "@shared/releaseTracking";
import { compareSemver } from "../update/semver";
import { type Catalog, ENTRY_KINDS, type NoteEntry, type ReleaseManifest } from "./catalog";

/**
 * Which entries a person is told about on reaching a release
 * (docs/release-notes.md "The startup note"): the exact set difference of the
 * bundled releases' memberships, once per entry id. Skipped releases are
 * included because the target's membership holds them, an unrelated branch's
 * entries are not because the target's membership lacks them, and an alpha's
 * changes do not repeat on its promoted stable because both share ids. The
 * releases in between only group the list; they never decide what is in it.
 * A range that cannot be verified is returned as unresolved, never as an
 * empty success.
 */

/** One release's share of what is new: the entries it was the first in the interval to carry. */
export type ReleaseGroup = { version: string; entries: NoteEntry[] };

/** An earlier stretch a previous launch could not verify, verified now, under its own range. */
export type RecoveredGroup = { from: string | null; to: string; entries: NoteEntry[] };

export type Selection = {
  /** The interval's new entries by release, newest release first. */
  releases: ReleaseGroup[];
  recovered: RecoveredGroup[];
  /**
   * This interval's own: partial when part of it, or the previous version's
   * history, cannot be verified. A gap an earlier note already named and
   * that stays unverifiable does not make a later interval partial.
   */
  coverage: "complete" | "partial" | "unavailable";
  /** Every range still unverifiable, to keep until a later catalog covers it. */
  unresolved: UnresolvedRange[];
  /** The previous version's own history is marked incomplete. */
  previousIncomplete: boolean;
  /** The previous version had entries this release lacks: a move off its line. */
  diverged: boolean;
  /** The previous version is not in the catalog, so only this release's own entries are listed. */
  boundaryUnknown: boolean;
};

export type SelectInput = {
  /** Null when the build carries no usable catalog. */
  catalog: Catalog | null;
  /** The previous successfully reconciled version; null for a first installation. */
  from: string | null;
  to: string;
  /** Entry ids an earlier delivery already listed. */
  delivered: ReadonlySet<string>;
  /** Ranges earlier deliveries could not verify. */
  unresolved: readonly UnresolvedRange[];
  /**
   * `overview`: a first installation's notes for this release alone.
   * `history`: every entry this release carries, for a profile whose earlier
   * version kept no record of what it had seen.
   */
  mode: "upgrade" | "overview" | "history";
};

export const UNAVAILABLE_REASON = "this version carries no readable notes";
export const UNKNOWN_BOUNDARY_REASON = "the notes this version carries do not include it";

const bySemver = (a: ReleaseManifest, b: ReleaseManifest) =>
  compareSemver(a.version, b.version) ?? a.version.localeCompare(b.version);

const below = (version: string, than: string) => (compareSemver(version, than) ?? 0) < 0;

function contains(outer: ReleaseManifest, inner: ReleaseManifest): boolean {
  const ids = new Set(outer.entryIds);
  return inner.entryIds.every((id) => ids.has(id));
}

/**
 * Where "this release" begins: the newest earlier release on the target's
 * own channel that the target contains. A promoted stable's own alpha is
 * never it, so the stable's notes are not empty.
 */
function channelPredecessor(
  releases: ReleaseManifest[],
  target: ReleaseManifest,
): ReleaseManifest | undefined {
  return releases
    .filter(
      (release) =>
        release.channel === target.channel &&
        below(release.version, target.version) &&
        contains(target, release),
    )
    .sort(bySemver)
    .at(-1);
}

const kindRank = (entry: NoteEntry) => ENTRY_KINDS.indexOf(entry.kind);

/** Features first, maintenance last; the catalog's own order within a kind. */
function inKindOrder(entries: NoteEntry[]): NoteEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => kindRank(a.entry) - kindRank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * Each entry under the first release after `floor`, on the target's channel
 * and inside the target, that carried it; the target itself carries them all.
 */
function groupByRelease(
  entries: NoteEntry[],
  releases: ReleaseManifest[],
  target: ReleaseManifest,
  floor: string | null,
): ReleaseGroup[] {
  const steps = releases
    .filter(
      (release) =>
        release.channel === target.channel &&
        (floor === null || below(floor, release.version)) &&
        !below(target.version, release.version) &&
        contains(target, release),
    )
    .sort(bySemver);
  const groups = new Map<string, NoteEntry[]>();
  for (const entry of entries) {
    const home = steps.find((step) => step.entryIds.includes(entry.id)) ?? target;
    groups.set(home.version, [...(groups.get(home.version) ?? []), entry]);
  }
  return [...steps, ...(steps.includes(target) ? [] : [target])].reverse().flatMap((step) => {
    const found = groups.get(step.version);
    return found ? [{ version: step.version, entries: inKindOrder(found) }] : [];
  });
}

export function selectEntries(input: SelectInput): Selection {
  const { catalog, from, to, delivered } = input;
  const unavailable = (): Selection => ({
    releases: [],
    recovered: [],
    coverage: "unavailable",
    unresolved: [...input.unresolved, { from, to, reason: UNAVAILABLE_REASON }],
    previousIncomplete: false,
    diverged: false,
    boundaryUnknown: false,
  });
  if (!catalog) return unavailable();
  const byVersion = new Map(catalog.releases.map((release) => [release.version, release]));
  const target = byVersion.get(to);
  if (!target) return unavailable();
  // Backfilled history keeps the changelog's commit wording, never written
  // for a person (the captain's FI3-783 answer): the catalog keeps it so
  // every release's membership checks out, and no note lists it.
  const entryById = new Map(
    catalog.entries
      .filter((entry) => entry.provenance.origin !== "changelog-backfill")
      .map((entry) => [entry.id, entry]),
  );
  const known = (ids: Iterable<string>) =>
    [...ids].flatMap((id) => {
      const entry = entryById.get(id);
      return entry ? [entry] : [];
    });

  const gaps: UnresolvedRange[] = [];
  const carried: UnresolvedRange[] = [];
  let base: ReleaseManifest | undefined;
  let boundaryUnknown = false;
  if (input.mode === "upgrade" && from !== null) {
    base = byVersion.get(from);
    if (!base) {
      boundaryUnknown = true;
      gaps.push({ from, to, reason: UNKNOWN_BOUNDARY_REASON });
    }
  }
  // `history` keeps no base: everything the target carries is listed.
  if (input.mode !== "history") base ??= channelPredecessor(catalog.releases, target);
  const previousIncomplete =
    input.mode === "upgrade" && !boundaryUnknown && base?.incomplete !== undefined;
  const baseIds = new Set(base?.entryIds ?? []);
  const targetIds = new Set(target.entryIds);
  const fresh = target.entryIds.filter((id) => !baseIds.has(id) && !delivered.has(id));
  const listed = new Set(fresh);
  const diverged =
    input.mode === "upgrade" && !boundaryUnknown && [...baseIds].some((id) => !targetIds.has(id));
  const floor = input.mode === "upgrade" && !boundaryUnknown ? from : (base?.version ?? null);

  // Gaps an earlier launch could not verify, recovered once both ends are
  // known. Only entries this release still carries can be described.
  const recovered: RecoveredGroup[] = [];
  for (const gap of input.unresolved) {
    const gapFrom = gap.from === null ? undefined : byVersion.get(gap.from);
    const gapTo = byVersion.get(gap.to);
    if (!gapFrom || !gapTo) {
      carried.push(gap);
      continue;
    }
    const fromIds = new Set(gapFrom.entryIds);
    const wanted = known(
      gapTo.entryIds.filter((id) => !fromIds.has(id) && !delivered.has(id) && !listed.has(id)),
    );
    for (const entry of wanted) listed.add(entry.id);
    if (wanted.length > 0)
      recovered.push({ from: gap.from, to: gap.to, entries: inKindOrder(wanted) });
  }

  return {
    releases: groupByRelease(known(fresh), catalog.releases, target, floor),
    recovered,
    coverage: gaps.length > 0 || previousIncomplete ? "partial" : "complete",
    unresolved: [...carried, ...gaps],
    previousIncomplete,
    diverged,
    boundaryUnknown,
  };
}

/** Every entry a selection lists, in the order the card lists them. */
export function listedEntries(selection: Selection): NoteEntry[] {
  return [
    ...selection.releases.flatMap((group) => group.entries),
    ...selection.recovered.flatMap((group) => group.entries),
  ];
}
