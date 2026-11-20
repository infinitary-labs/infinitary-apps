import { mkdirSync, type PathLike, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { clonesFrom, copyClones, copyTree } from "./copy";

// INF-1174: a Mac numbers each kind of disk as it registers at startup (xnu's
// `vfs_fsadd`, from 24 in that order), so APFS's statfs type is 26 on one boot
// and another number on the next. A virtual Mac that numbered it otherwise had
// every unit of the move reported written, not cloned, while its copier cloned
// them (move.test.ts, "refuses a cloned file that changed during the copy").
// Here every number from 24 on reads one higher, as on a boot where one more
// kind of disk registered before APFS.
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  const renumbered = (path: PathLike) => {
    const stats = actual.statfsSync(path);
    return Object.assign(stats, { type: stats.type >= 24 ? stats.type + 1 : stats.type });
  };
  return { ...actual, statfsSync: renumbered as typeof actual.statfsSync };
});

/** An older app's folder, a little of it: its database, a project's file and its update channel. */
function dataFolder(root: string): void {
  mkdirSync(join(root, "fleet", "inside"), { recursive: true });
  writeFileSync(join(root, "firstmate.db"), Buffer.alloc(64 * 1024, 7));
  writeFileSync(join(root, "fleet", "inside", "README.md"), "hello\n");
  writeFileSync(join(root, "update-channel.json"), '{"schemaVersion":1,"channel":"stable"}\n');
}

describe.runIf(process.platform === "darwin")("a Mac's copy of the data folder", () => {
  it("clones on a disk that clones, whatever number this boot gave its kind", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const base = realpathSync(scratchDir("fm-copy-clones-"));
    const root = join(base, "firstmate-3000");
    const staged = join(base, "infinitary.moving-1");
    dataFolder(root);
    mkdirSync(staged);
    expect(statfsSync(staged).type).toBe(actual.statfsSync(staged).type + 1);

    expect(copyClones(base, "darwin")).toBe(true);
    expect(clonesFrom(root, staged, "darwin")).toBe(true);
    const units: [string, boolean][] = [];
    await copyTree(root, staged, {
      platform: "darwin",
      done: (unit, cloned) => units.push([unit, cloned]),
    });
    expect(units.length).toBeGreaterThan(0);
    expect(units.filter(([, cloned]) => !cloned)).toEqual([]);
  });

  it("does not take a disk that cannot clone for one that does", () => {
    // devfs, on every Mac, is a disk that cannot clone.
    expect(copyClones("/dev", "darwin")).toBe(false);
  });
});
