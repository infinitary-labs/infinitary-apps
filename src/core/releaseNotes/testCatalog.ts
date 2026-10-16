import type { Catalog, NoteEntry, ReleaseManifest } from "./catalog";

/**
 * Catalog fixtures for the startup note's tests, shaped like the published
 * history: alphas cut from one line, each stable promoted from its last
 * alpha with the same membership, and one side-branch alpha whose change
 * (`x`) never reached a later release.
 */

const sha = (n: number) => n.toString(16).padStart(40, "0");

export function entry(id: string, extra: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id,
    kind: "feature",
    title: `Change ${id}`,
    provenance: { origin: "change" },
    ...extra,
  };
}

export function release(
  version: string,
  ids: string[],
  extra: Partial<ReleaseManifest> = {},
): ReleaseManifest {
  return {
    version,
    channel: version.includes("-alpha.") ? "alpha" : "stable",
    sourceCommit: sha([...version].reduce((sum, c) => sum * 31 + c.charCodeAt(0), 7) % 2 ** 40),
    date: "2026-10-02",
    promotedFrom: null,
    entryIds: [...ids].sort(),
    ...extra,
  };
}

export const ENTRIES: NoteEntry[] = [
  entry("change-a"),
  entry("change-b", { kind: "improvement", body: "Body of b." }),
  entry("change-c", { kind: "fix", highlight: 2 }),
  entry("change-d", { highlight: 1, body: "Body of d." }),
  entry("change-e", { kind: "removal" }),
  entry("change-f", { kind: "maintenance" }),
  entry("change-x"),
];

const upTo = (last: string) => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  return ids.slice(0, ids.indexOf(last) + 1).map((id) => `change-${id}`);
};

export const RELEASES: ReleaseManifest[] = [
  release("0.1.0", [], { incomplete: "history before 0.1.0 is not recoverable" }),
  release("0.1.25", upTo("a")),
  release("0.1.26-alpha.14", upTo("b")),
  release("0.1.26", upTo("b"), { promotedFrom: "0.1.26-alpha.14" }),
  release("0.1.27-alpha.15", upTo("c")),
  release("0.1.27-alpha.16", [...upTo("c"), "change-x"]),
  release("0.1.27-alpha.20", upTo("d")),
  release("0.1.27", upTo("d"), { promotedFrom: "0.1.27-alpha.20" }),
  release("0.1.28-alpha.2", upTo("e")),
  release("0.1.28-alpha.10", upTo("f")),
];

/** The catalog release `to` packages: its own entries and every release's membership. */
export function catalogFor(
  to: string,
  releases: ReleaseManifest[] = RELEASES,
  entries: NoteEntry[] = ENTRIES,
): Catalog {
  const target = releases.find((r) => r.version === to);
  if (!target) throw new Error(`no release ${to} in the fixture`);
  const wanted = new Set(target.entryIds);
  return {
    schema: 1,
    release: { version: to, sourceCommit: target.sourceCommit },
    entries: entries.filter((e) => wanted.has(e.id)),
    releases,
  };
}
