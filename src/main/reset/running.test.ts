import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readResetMark } from "@core/reset/mark";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type RunningResetSeams, runReset } from "./running";

/**
 * Reset Infinitary once confirmed (docs/reset.md, "Before it quits"): the
 * captain's ask that it goes back to how it was just installed "no matter
 * what", so no step that fails or hangs stops the mark that asks the next
 * start to wipe the folder.
 */

function seams(overrides: Partial<RunningResetSeams> = {}) {
  const dataDir = join(scratchDir("inf-reset-running-"), "Infinitary");
  mkdirSync(dataDir);
  const steps: string[] = [];
  const base: RunningResetSeams = {
    dataDir,
    atStart: [],
    confirm: async () => true,
    prepare: async () => steps.push("prepare"),
    stopFirstMate: async () => {
      steps.push(existsSync(`${dataDir}.reset`) ? "stop after mark" : "stop before mark");
    },
    endLeftovers: async () => steps.push("end leftovers"),
    restart: () => {
      steps.push("restart");
    },
    within: (work) => work,
  };
  return { steps, dataDir, seams: { ...base, ...overrides } };
}

describe("running a reset", () => {
  it("undoes the first mate's side, writes the mark, stops, ends leftovers, then restarts", async () => {
    const { steps, dataDir, seams: s } = seams();
    expect(await runReset(s)).toEqual({ outcome: "restarting" });
    expect(steps).toEqual(["prepare", "stop after mark", "end leftovers", "restart"]);
    expect(readResetMark(dataDir)).toMatchObject({ stage: "asked", outside: [] });
    // The folder itself stays for the next start, which this start still holds.
    expect(existsSync(dataDir)).toBe(true);
  });

  it("changes nothing when the system's own confirmation is not given", async () => {
    for (const confirm of [async () => false, () => Promise.reject(new Error("no prompt"))]) {
      const cleared: string[] = [];
      const {
        steps,
        dataDir,
        seams: s,
      } = seams({
        confirm,
        clear: {
          "password-store": async () => {
            cleared.push("password-store");
            return true;
          },
        },
      });
      expect(await runReset(s)).toEqual({ outcome: "kept" });
      expect(steps).toEqual([]);
      expect(cleared).toEqual([]);
      expect(existsSync(`${dataDir}.reset`)).toBe(false);
    }
  });

  it("changes nothing on this computer when the first mate it controls did not answer", async () => {
    const { steps, dataDir, seams: s } = seams({ askHome: async () => false });
    expect(await runReset(s)).toEqual({ outcome: "unreached" });
    expect(steps).toEqual([]);
    expect(existsSync(`${dataDir}.reset`)).toBe(false);
  });

  it("leaves each kind it could not clear now, and each start-only kind, on the mark", async () => {
    const cleared: string[] = [];
    const { dataDir, seams: s } = seams({
      atStart: ["app-files"],
      clear: {
        "password-store": async () => false,
        "start-entries": async () => {
          cleared.push("start-entries");
          return true;
        },
      },
    });
    await runReset(s);
    expect(cleared).toEqual(["start-entries"]);
    expect(readResetMark(dataDir)?.outside).toEqual(["password-store", "app-files"]);
  });

  it("has the mark naming every kind still to clear before a clearer runs, which may end this program", async () => {
    const marked: string[][] = [];
    const { dataDir, seams: s } = seams({
      atStart: ["app-files"],
      clear: {
        "start-entries": async () => {
          marked.push([...(readResetMark(dataDir)?.outside ?? [])].sort());
          return true;
        },
      },
    });
    await runReset(s);
    expect(marked).toEqual([["app-files", "start-entries"]]);
    expect(readResetMark(dataDir)?.outside).toEqual(["app-files"]);
  });

  it("goes on when the first mate's side fails, hangs or a clearer throws", async () => {
    const {
      steps,
      dataDir,
      seams: s,
    } = seams({
      prepare: () => Promise.reject(new Error("first mate gone")),
      clear: { "password-store": () => Promise.reject(new Error("store locked")) },
      // The cap answers at once, as one that ran out would.
      within: (work) => Promise.race([work, Promise.resolve("timed-out" as const)]),
    });
    await runReset(s);
    expect(readResetMark(dataDir)?.outside).toEqual(["password-store"]);
    expect(steps).toEqual(["stop after mark", "end leftovers", "restart"]);
  });
});
