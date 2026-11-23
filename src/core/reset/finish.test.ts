import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { removeAll } from "../removeWhole";
import { acquireMoveLock, releaseMoveLock } from "../storage/moveLock";
import { finishReset, OUTSIDE_TRIES, type ResetFinishSeams } from "./finish";
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

  it("keeps a kind it could not clear on the mark for a few starts, then lets the mark go", async () => {
    const { dataDir } = place();
    writeResetMark(dataDir, askedResetMark(["password-store", "app-files"]));
    const locked = seams({ clearOutside: async (kind) => kind !== "password-store" });
    for (let start = 1; start < OUTSIDE_TRIES; start++) {
      expect(await finishReset(dataDir, locked)).toEqual({
        kind: "done",
        left: ["password-store"],
      });
      expect(readResetMark(dataDir)).toMatchObject({
        stage: "outside",
        outside: ["password-store"],
        outsideTries: start,
      });
    }
    expect(await finishReset(dataDir, locked)).toEqual({ kind: "done", left: ["password-store"] });
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
