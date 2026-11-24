import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { removeAll } from "../removeWhole";
import { acquireMoveLock, releaseMoveLock } from "../storage/moveLock";
import { ASIDE_TRIES, finishReset, type ResetFinishSeams } from "./finish";
import {
  askedResetMark,
  type ResetMark,
  type ResetOutsideKind,
  readResetMark,
  resetLockPath,
  resetMarkPath,
  writeResetMark,
} from "./mark";

/**
 * Finishing a reset at the next start (docs/reset.md, "At the next start"):
 * the captain's ask that Reset Infinitary takes the app back to how it was
 * just installed "no matter what", so a start cut off at any step carries on
 * at the next and a fresh folder is never wiped by an old mark.
 */

function place() {
  const parent = scratchDir("inf-reset-finish-");
  const dataDir = join(parent, "Infinitary");
  mkdirSync(join(dataDir, "crewmates"), { recursive: true });
  writeFileSync(join(dataDir, "crewmates", "work.txt"), "saved\n");
  return { parent, dataDir };
}

function seams(overrides: Partial<ResetFinishSeams> = {}): ResetFinishSeams {
  return {
    rename: renameSync,
    remove: removeAll,
    olderCopies: () => [],
    wait: async () => {},
    ...overrides,
  };
}

describe("finishing a reset at the next start", () => {
  it("does nothing without a mark", async () => {
    const { dataDir } = place();
    expect(await finishReset(dataDir, seams())).toEqual({ kind: "none" });
    expect(existsSync(join(dataDir, "crewmates", "work.txt"))).toBe(true);
  });

  it("deletes the folder, its older copies and the mark, and clears each outside kind", async () => {
    const { parent, dataDir } = place();
    const older = join(parent, "Firstmate 3000");
    mkdirSync(older);
    writeResetMark(dataDir, askedResetMark(["password-store", "app-files"]));
    const cleared: ResetOutsideKind[] = [];
    const finish = await finishReset(
      dataDir,
      seams({
        olderCopies: () => [older],
        clearOutside: async (kind) => {
          cleared.push(kind);
          return true;
        },
      }),
    );
    expect(finish).toEqual({ kind: "done", left: [] });
    expect(cleared).toEqual(["password-store", "app-files"]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("wipes a folder with no outside reach alone when the run passes no clearer", async () => {
    const { parent, dataDir } = place();
    writeFileSync(join(parent, "beside.txt"), "not ours\n");
    writeResetMark(dataDir, askedResetMark(["password-store", "start-entries", "app-files"]));
    expect(await finishReset(dataDir, seams())).toEqual({ kind: "done", left: [] });
    expect(readdirSync(parent)).toEqual(["beside.txt"]);
  });

  it("carries on from the moved stage after a start cut off before deleting", async () => {
    const { parent, dataDir } = place();
    // An earlier start renamed the folder aside and stopped there.
    const aside = `${dataDir}.resetting-4242`;
    renameSync(dataDir, aside);
    const mark: ResetMark = { ...askedResetMark([]), stage: "moved" };
    writeResetMark(dataDir, mark);
    expect(await finishReset(dataDir, seams())).toEqual({ kind: "done", left: [] });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("never wipes the fresh folder of a start cut off after deleting", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, { ...askedResetMark(["app-files"]), stage: "outside" });
    expect(await finishReset(dataDir, seams({ clearOutside: async () => true }))).toEqual({
      kind: "done",
      left: [],
    });
    expect(existsSync(join(dataDir, "crewmates", "work.txt"))).toBe(true);
    expect(existsSync(resetMarkPath(dataDir))).toBe(false);
  });

  it("clears each outside kind once, at the start that wipes the folder", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark(["password-store", "app-files"]));
    const cleared: ResetOutsideKind[] = [];
    const locked = seams({
      clearOutside: async (kind) => {
        cleared.push(kind);
        return kind !== "password-store";
      },
    });
    expect(await finishReset(dataDir, locked)).toEqual({ kind: "done", left: ["password-store"] });
    expect(existsSync(resetMarkPath(dataDir))).toBe(false);
    // The fresh install's next start finds no mark, so nothing of its own is cleared.
    mkdirSync(dataDir);
    expect(await finishReset(dataDir, locked)).toEqual({ kind: "none" });
    expect(cleared).toEqual(["password-store", "app-files"]);
  });

  it("never clears an outside kind again at a start that only retries the renamed folder", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark(["start-entries"]));
    const cleared: ResetOutsideKind[] = [];
    const stuck = seams({
      remove: (path) => !path.includes(".resetting-") && removeAll(path),
      clearOutside: async (kind) => {
        cleared.push(kind);
        return true;
      },
    });
    await finishReset(dataDir, stuck);
    expect(readResetMark(dataDir)).toMatchObject({ stage: "moved", outside: [] });
    await finishReset(dataDir, stuck);
    expect(cleared).toEqual(["start-entries"]);
  });

  it("tries a folder renamed aside again at later starts while it cannot be deleted, never the fresh one", async () => {
    const { parent, dataDir } = place();
    writeResetMark(dataDir, askedResetMark([]));
    const stuck = (path: string) => !path.includes(".resetting-") && removeAll(path);
    expect(await finishReset(dataDir, seams({ remove: stuck }), { pid: 4242 })).toEqual({
      kind: "done",
      left: [],
    });
    expect(readResetMark(dataDir)).toMatchObject({ stage: "moved", asideTries: 1 });
    // The fresh install's folder, made after that start, is never touched.
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "fresh.txt"), "new\n");
    expect(await finishReset(dataDir, seams({ remove: stuck }))).toEqual({
      kind: "done",
      left: [],
    });
    expect(readResetMark(dataDir)).toMatchObject({ stage: "moved", asideTries: 2 });
    expect(await finishReset(dataDir, seams())).toEqual({ kind: "done", left: [] });
    expect(existsSync(resetMarkPath(dataDir))).toBe(false);
    expect(readdirSync(parent)).toEqual(["Infinitary"]);
    expect(existsSync(join(dataDir, "fresh.txt"))).toBe(true);
  });

  it("lets the mark go after a few starts that could not delete the renamed folder", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark([]));
    const stuck = seams({ remove: (path) => !path.includes(".resetting-") && removeAll(path) });
    for (let start = 1; start < ASIDE_TRIES; start++) await finishReset(dataDir, stuck);
    expect(readResetMark(dataDir)?.stage).toBe("moved");
    await finishReset(dataDir, stuck);
    expect(existsSync(resetMarkPath(dataDir))).toBe(false);
  });

  it("counts a clearer that throws as a kind left, never a failed start", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark(["start-entries"]));
    const finish = await finishReset(
      dataDir,
      seams({ clearOutside: () => Promise.reject(new Error("no service manager")) }),
    );
    expect(finish).toEqual({ kind: "done", left: ["start-entries"] });
    expect(existsSync(dataDir)).toBe(false);
  });

  it("tries a folder another program holds again, then answers held without opening it", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark([]));
    let tries = 0;
    const held = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    const finish = await finishReset(
      dataDir,
      seams({
        rename: () => {
          tries++;
          throw held;
        },
      }),
      { heldTries: 4 },
    );
    expect(finish).toEqual({ kind: "held" });
    expect(tries).toBe(4);
    expect(readResetMark(dataDir)?.stage).toBe("asked");
    expect(existsSync(join(dataDir, "crewmates", "work.txt"))).toBe(true);
    expect(existsSync(resetLockPath(dataDir))).toBe(false);
  });

  it("goes on once the program holding the folder lets it go", async () => {
    const { parent, dataDir } = place();
    writeResetMark(dataDir, askedResetMark([]));
    let tries = 0;
    const finish = await finishReset(
      dataDir,
      seams({
        rename: (from, to) => {
          if (++tries < 3) throw Object.assign(new Error("denied"), { code: "EPERM" });
          renameSync(from, to);
        },
      }),
    );
    expect(finish).toEqual({ kind: "done", left: [] });
    expect(readdirSync(parent)).toEqual([]);
  });

  it("quits quietly while another start finishes it", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark([]));
    const lock = resetLockPath(dataDir);
    // The parent of this test process is alive, so its lock is held.
    expect(acquireMoveLock(lock, process.ppid)).toBe(true);
    try {
      expect(await finishReset(dataDir, seams())).toEqual({ kind: "busy" });
      expect(existsSync(join(dataDir, "crewmates", "work.txt"))).toBe(true);
    } finally {
      releaseMoveLock(lock, process.ppid);
    }
  });

  it("wipes from its first step when the mark cannot be parsed", async () => {
    const { parent, dataDir } = place();
    writeFileSync(resetMarkPath(dataDir), "{ cut off");
    expect(await finishReset(dataDir, seams())).toEqual({ kind: "done", left: [] });
    expect(readdirSync(parent)).toEqual([]);
  });
});
