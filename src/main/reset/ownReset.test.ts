import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { askedResetMark, writeResetMark } from "@core/reset/mark";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { resetWatch } from "./ownReset";
import { runReset } from "./running";

// The review of a reset asked of a first mate with no window (docs/reset.md,
// "A first mate with no window"): the window beside a run starts again once
// the run ended only for a reset another program took, never on a plain stop
// and never partway through its own reset, whose clearer ends the run.

function folder(): string {
  const dataDir = join(scratchDir("inf-reset-watch-"), "Infinitary");
  mkdirSync(dataDir);
  return dataDir;
}

describe("whether a reset waits for the window beside a run", () => {
  it("is none with no mark beside the folder, and one once a mark is there", () => {
    const dataDir = folder();
    const watch = resetWatch(dataDir);
    expect(watch.waiting()).toBe(false);
    writeResetMark(dataDir, askedResetMark([]));
    expect(watch.waiting()).toBe(true);
  });

  it("is none while this program's own reset runs, through the clearer that ends the run and every step after it", async () => {
    const dataDir = folder();
    const watch = resetWatch(dataDir);
    const seen: [string, boolean][] = [];
    const look = (step: string) => seen.push([step, watch.waiting()]);
    let restarts = 0;
    const reset = watch.own(() =>
      runReset({
        dataDir,
        atStart: [],
        confirm: async () => true,
        prepare: async () => look("prepare"),
        clear: {
          // Its first step lets the run go, which ends it: the window reads again at once.
          "start-entries": async () => {
            look("start entries");
            return true;
          },
          "phone-keys": async () => {
            look("phone keys");
            return true;
          },
        },
        stopFirstMate: async () => look("stop"),
        endLeftovers: async () => look("end leftovers"),
        restart: () => {
          restarts++;
          look("restart");
        },
        within: (work) => work,
      }),
    );
    expect(await reset()).toEqual({ outcome: "restarting" });
    expect(seen).toEqual([
      ["prepare", false],
      ["start entries", false],
      ["phone keys", false],
      ["stop", false],
      ["end leftovers", false],
      ["restart", false],
    ]);
    expect(restarts).toBe(1);
    // The app is quitting: the mark stays this program's own.
    expect(watch.waiting()).toBe(false);
  });

  it("reads a mark again once this program's reset changed nothing", async () => {
    const dataDir = folder();
    writeResetMark(dataDir, askedResetMark([]));
    const watch = resetWatch(dataDir);
    expect(await watch.own(async () => ({ outcome: "kept" as const }))()).toEqual({
      outcome: "kept",
    });
    expect(watch.waiting()).toBe(true);
  });
});
