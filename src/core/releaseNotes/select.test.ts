import { describe, expect, it } from "vitest";
import { verifyCatalog } from "./catalog";
import {
  listedEntries,
  type Selection,
  selectEntries,
  UNAVAILABLE_REASON,
  UNKNOWN_BOUNDARY_REASON,
} from "./select";
import { catalogFor, ENTRIES, entry, RELEASES } from "./testCatalog";

const upgrade = (
  from: string,
  to: string,
  extra: Partial<Parameters<typeof selectEntries>[0]> = {},
) =>
  selectEntries({
    catalog: "catalog" in extra ? (extra.catalog ?? null) : catalogFor(to),
    from,
    to,
    delivered: new Set(),
    unresolved: [],
    mode: "upgrade",
    ...extra,
  });

const groups = (selection: Selection) =>
  selection.releases.map((group) => [group.version, group.entries.map((entry) => entry.id)]);
const ids = (selection: Selection) => listedEntries(selection).map((entry) => entry.id);

describe("what an upgrade lists", () => {
  it("lists every change since the version last opened once, by the release that brought it, newest first", () => {
    const selection = upgrade("0.1.25", "0.1.27");
    // The lower version is excluded, the skipped 0.1.26 and the current 0.1.27 included.
    expect(groups(selection)).toEqual([
      ["0.1.27", ["change-d", "change-c"]],
      ["0.1.26", ["change-b"]],
    ]);
    expect(selection).toMatchObject({
      coverage: "complete",
      unresolved: [],
      diverged: false,
      boundaryUnknown: false,
      previousIncomplete: false,
    });
  });

  it("repeats nothing an alpha had when that alpha is promoted to stable", () => {
    const selection = upgrade("0.1.27-alpha.20", "0.1.27");
    expect(ids(selection)).toEqual([]);
    expect(selection.coverage).toBe("complete");
  });

  it("groups an alpha's changes by alpha, ordering alpha numbers as numbers", () => {
    expect(groups(upgrade("0.1.28-alpha.2", "0.1.28-alpha.10"))).toEqual([
      ["0.1.28-alpha.10", ["change-f"]],
    ]);
    expect(groups(upgrade("0.1.27", "0.1.28-alpha.10"))).toEqual([
      ["0.1.28-alpha.10", ["change-f"]],
      ["0.1.28-alpha.2", ["change-e"]],
    ]);
  });

  it("leaves out a side branch's change and says the move left that line", () => {
    const selection = upgrade("0.1.27-alpha.16", "0.1.27");
    expect(ids(selection)).toEqual(["change-d"]);
    expect(selection.diverged).toBe(true);
    // A side branch between the two ends lends nothing to a later upgrade.
    expect(ids(upgrade("0.1.26", "0.1.27"))).not.toContain("change-x");
  });

  it("never lists again what an earlier note listed", () => {
    expect(ids(upgrade("0.1.25", "0.1.27", { delivered: new Set(["change-c"]) }))).toEqual([
      "change-d",
      "change-b",
    ]);
  });

  it("lists a removal its authors wrote, after the features, fixes and improvements", () => {
    const [group] = upgrade("0.1.27", "0.1.28-alpha.10").releases.slice(-1);
    expect(group?.entries.map((entry) => entry.kind)).toEqual(["removal"]);
    const all = selectEntries({
      catalog: catalogFor("0.1.28-alpha.10"),
      from: null,
      to: "0.1.28-alpha.10",
      delivered: new Set(),
      unresolved: [],
      mode: "overview",
    });
    expect(listedEntries(all).map((entry) => entry.kind)).toEqual(["maintenance"]);
  });

  it("marks the list partial when the previous version's own history is incomplete", () => {
    const selection = upgrade("0.1.0", "0.1.25");
    expect(ids(selection)).toEqual(["change-a"]);
    expect(selection).toMatchObject({ previousIncomplete: true, coverage: "partial" });
  });
});

describe("what cannot be verified", () => {
  it("is unavailable, keeping the range, when the build carries no catalog or no manifest for itself", () => {
    const none = upgrade("0.1.25", "0.1.27", { catalog: null });
    expect(none).toMatchObject({
      coverage: "unavailable",
      releases: [],
      unresolved: [{ from: "0.1.25", to: "0.1.27", reason: UNAVAILABLE_REASON }],
    });
    const stranger = upgrade("0.1.25", "0.1.29", { catalog: catalogFor("0.1.27") });
    expect(stranger.coverage).toBe("unavailable");
  });

  it("lists only this release's own changes for a previous version the catalog lacks, and keeps the gap", () => {
    const selection = upgrade("0.1.26-alpha.99", "0.1.27");
    expect(groups(selection)).toEqual([["0.1.27", ["change-d", "change-c"]]]);
    expect(selection).toMatchObject({
      boundaryUnknown: true,
      coverage: "partial",
      unresolved: [{ from: "0.1.26-alpha.99", to: "0.1.27", reason: UNKNOWN_BOUNDARY_REASON }],
    });
  });

  it("recovers an earlier gap once both ends are known, under its own range, and keeps one still unknown", () => {
    const selection = upgrade("0.1.26", "0.1.27", {
      unresolved: [
        { from: "0.1.25", to: "0.1.26", reason: UNAVAILABLE_REASON },
        { from: "0.1.24-alpha.1", to: "0.1.25", reason: UNKNOWN_BOUNDARY_REASON },
      ],
    });
    expect(groups(selection)).toEqual([["0.1.27", ["change-d", "change-c"]]]);
    expect(selection.recovered).toEqual([
      { from: "0.1.25", to: "0.1.26", entries: [expect.objectContaining({ id: "change-b" })] },
    ]);
    expect(selection.unresolved).toEqual([
      { from: "0.1.24-alpha.1", to: "0.1.25", reason: UNKNOWN_BOUNDARY_REASON },
    ]);
    // The gap still unknown was named on its own note; this interval is whole.
    expect(selection.coverage).toBe("complete");
  });

  it("does not repeat a recovered change the new interval or an earlier note already lists", () => {
    const selection = upgrade("0.1.25", "0.1.27", {
      delivered: new Set(["change-a"]),
      unresolved: [{ from: "0.1.0", to: "0.1.26", reason: UNAVAILABLE_REASON }],
    });
    expect(ids(selection)).toEqual(["change-d", "change-c", "change-b"]);
    expect(selection.recovered).toEqual([]);
    expect(selection.coverage).toBe("complete");
  });
});

describe("backfilled history", () => {
  // The changelog's own commit wording, recorded beside change-b in 0.1.26.
  const backfilled = entry("backfilled-b", {
    kind: "fix",
    title: "Quote dry-run fixture check path",
    provenance: { origin: "changelog-backfill" },
  });
  const releases = RELEASES.map((release) =>
    release.entryIds.includes("change-b")
      ? { ...release, entryIds: [...release.entryIds, backfilled.id].sort() }
      : release,
  );
  const catalog = (to: string) => catalogFor(to, releases, [...ENTRIES, backfilled]);

  it("stays in the catalog the packaging check accepts", () => {
    const target = releases.find((release) => release.version === "0.1.27");
    expect(
      verifyCatalog(catalog("0.1.27"), {
        version: "0.1.27",
        sourceCommit: target?.sourceCommit ?? "",
      }),
    ).toEqual([]);
  });

  it("is never listed, across its release or for a profile whose earlier version kept no record", () => {
    const across = upgrade("0.1.25", "0.1.27", { catalog: catalog("0.1.27") });
    expect(ids(across)).toEqual(["change-d", "change-c", "change-b"]);
    expect(across).toMatchObject({ coverage: "complete", diverged: false });
    const history = selectEntries({
      catalog: catalog("0.1.27"),
      from: null,
      to: "0.1.27",
      delivered: new Set(),
      unresolved: [],
      mode: "history",
    });
    expect(ids(history)).toEqual(["change-d", "change-c", "change-b", "change-a"]);
  });

  it("is never listed when an earlier gap is recovered", () => {
    const selection = upgrade("0.1.26", "0.1.27", {
      catalog: catalog("0.1.27"),
      unresolved: [{ from: "0.1.25", to: "0.1.26", reason: UNAVAILABLE_REASON }],
    });
    expect(selection.recovered).toEqual([
      { from: "0.1.25", to: "0.1.26", entries: [expect.objectContaining({ id: "change-b" })] },
    ]);
  });
});
