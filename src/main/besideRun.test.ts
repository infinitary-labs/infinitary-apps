import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  betweenStops,
  commandNotice,
  entryRestarts,
  entryWaitMs,
  noteStartedHere,
  runEnd,
  STARTED_HERE,
  startedHere,
  startsOverOnStop,
} from "./besideRun";
import { RUN_SETTINGS_EXIT, RUN_UPDATED_EXIT } from "./runCommand";
import type { RunStatus } from "./runStatus";

// INF-3660's plan, the captain's answer restart=wait-for-entry: "Wait for the start entry
// when one is in place, then offer it; offer it at once when none will restart the run"
// (docs/run.md, "When the command stops").
describe("what a window says once its command stops", () => {
  const JOINED = { pid: 41, startedAt: "2026-11-01T08:00:00.000Z" };
  type Records = Pick<RunStatus, "running" | "lastStop">;
  const recorded = (
    reason: "quit" | "signal" | "updated" | "start-failed",
    exitCode: number,
    of = JOINED,
  ): Records => ({
    running: false,
    lastStop: { ...of, stoppedAt: "2026-11-01T09:00:00.000Z", reason, exitCode, lines: [] },
  });
  const STOPPED_AT = Date.parse("2026-11-01T09:00:00.000Z");
  // The entry's own wait, then the time a window allows a command to welcome it.
  const waitMs = entryWaitMs();

  it("reads no end while a command runs, or while its records cannot be read", () => {
    expect(runEnd({ running: true, lastStop: null }, JOINED)).toBeNull();
    // Unreadable is never a stopped report.
    expect(runEnd({ running: null, lastStop: recorded("quit", 0).lastStop }, JOINED)).toBeNull();
    // No command ever ran here.
    expect(runEnd({ running: false, lastStop: null }, null)).toBeNull();
  });

  it("reads how the joined command ended from its own record", () => {
    expect(runEnd(recorded("updated", RUN_UPDATED_EXIT), JOINED)).toEqual({
      ending: "updated",
      exitCode: RUN_UPDATED_EXIT,
      of: JOINED,
      at: STOPPED_AT,
    });
    expect(runEnd(recorded("signal", 0), JOINED)).toMatchObject({ ending: "signal", exitCode: 0 });
  });

  // A kill writes no record, so the record in the folder is an earlier command's.
  it("reads a kill as stopped without saying why, whatever an earlier record says", () => {
    const earlier = recorded("quit", 0, { pid: 7, startedAt: "2026-10-30T08:00:00.000Z" });
    // The end is the joined command's, and names no time: the earlier record's is not its own.
    const crashed = { ending: "crashed", exitCode: null, of: JOINED, at: null };
    expect(runEnd(earlier, JOINED)).toEqual(crashed);
    expect(runEnd({ running: false, lastStop: null }, JOINED)).toEqual(crashed);
    const unrecorded: Records = {
      running: false,
      lastStop: { ...JOINED, stoppedAt: null, reason: "unrecorded", exitCode: null, lines: [] },
    };
    expect(runEnd(unrecorded, JOINED)).toEqual(crashed);
  });

  it("knows which ends each start entry starts the command again after", () => {
    const end = (exitCode: number | null) =>
      ({ ending: exitCode === null ? "crashed" : "quit", exitCode, of: JOINED, at: null }) as const;
    for (const entry of ["linux-unit", "mac-daemon"] as const) {
      expect(entryRestarts(entry, end(RUN_UPDATED_EXIT))).toBe(true);
      expect(entryRestarts(entry, end(null))).toBe(true);
      expect(entryRestarts(entry, end(0))).toBe(false);
    }
    // A settings file to fix: the Linux unit never retries it, the Mac's entry does.
    expect(entryRestarts("linux-unit", end(RUN_SETTINGS_EXIT))).toBe(false);
    expect(entryRestarts("mac-daemon", end(RUN_SETTINGS_EXIT))).toBe(true);
    expect(entryRestarts(null, end(RUN_UPDATED_EXIT))).toBe(false);
    // Windows' Task Scheduler starts the run at sign-in and when asked, never again after it ends
    // (INF-4243's plan, piece 5), so the window offers Start it here at once.
    expect(entryRestarts("windows-task", end(RUN_UPDATED_EXIT))).toBe(false);
    expect(entryRestarts("windows-task", end(null))).toBe(false);
  });

  it("offers Start it here at once when no entry will start the command again", () => {
    const end = runEnd(recorded("updated", RUN_UPDATED_EXIT), JOINED);
    expect(commandNotice({ end, entry: null, goneFor: 0, waitMs })).toEqual({
      state: "stopped",
      ending: "updated",
    });
    // An entry in place does not start a command the person stopped.
    const quit = runEnd(recorded("signal", 0), JOINED);
    expect(commandNotice({ end: quit, entry: "linux-unit", goneFor: 0, waitMs })).toEqual({
      state: "stopped",
      ending: "signal",
    });
  });

  it("waits for the entry after exit 75, and offers Start it here once it never came back", () => {
    const end = runEnd(recorded("updated", RUN_UPDATED_EXIT), JOINED);
    const at = (goneFor: number) => commandNotice({ end, entry: "linux-unit", goneFor, waitMs });
    expect(at(0)).toEqual({ state: "waiting", ending: "updated" });
    expect(at(waitMs - 1)).toEqual({ state: "waiting", ending: "updated" });
    expect(at(waitMs)).toEqual({ state: "stopped", ending: "updated" });
    // While a command runs there is nothing to say.
    expect(commandNotice({ end: null, entry: "linux-unit", goneFor: waitMs, waitMs })).toBeNull();
  });

  it("opens between two commands only where the entry starts the next one", () => {
    const soon = { now: STOPPED_AT + 1_000, waitMs, startedHere: null };
    expect(betweenStops(recorded("updated", RUN_UPDATED_EXIT), "linux-unit", soon)).toBe(true);
    expect(betweenStops(recorded("updated", RUN_UPDATED_EXIT), null, soon)).toBe(false);
    expect(betweenStops(recorded("quit", 0), "mac-daemon", soon)).toBe(false);
    expect(betweenStops({ running: true, lastStop: null }, "linux-unit", soon)).toBe(false);
    // Another program holds the folder: unreadable, never between two commands.
    expect(betweenStops({ running: null, lastStop: null }, "linux-unit", soon)).toBe(false);
    // No command ever ran here.
    expect(betweenStops({ running: false, lastStop: null }, "linux-unit", soon)).toBe(false);
  });

  // The same rule at a launch: an entry that had its time since the recorded
  // stop will not start the command, so the app opens as its own first mate.
  it("does not wait at a launch for an entry that already had its time", () => {
    const updated = recorded("updated", RUN_UPDATED_EXIT);
    const at = (now: number) => ({ now, waitMs, startedHere: null });
    expect(betweenStops(updated, "linux-unit", at(STOPPED_AT + waitMs - 1))).toBe(true);
    expect(betweenStops(updated, "linux-unit", at(STOPPED_AT + waitMs))).toBe(false);
    // A kill names no time: the window waits from when it opens.
    const killed: Records = {
      running: false,
      lastStop: { ...JOINED, stoppedAt: null, reason: "unrecorded", exitCode: null, lines: [] },
    };
    expect(betweenStops(killed, "linux-unit", at(STOPPED_AT + 10 * waitMs))).toBe(true);
  });

  // Start it here answers one end: no later launch waits under the notice for it again.
  it("remembers the end a person answered with Start it here, and waits for the next one", () => {
    const dataDir = scratchDir("infinitary-started-here-");
    const killed: Records = {
      running: false,
      lastStop: { ...JOINED, stoppedAt: null, reason: "unrecorded", exitCode: null, lines: [] },
    };
    const at = () => ({ now: STOPPED_AT, waitMs, startedHere: startedHere(dataDir) });
    expect(startedHere(dataDir)).toBeNull();
    expect(betweenStops(killed, "mac-daemon", at())).toBe(true);
    noteStartedHere(dataDir, killed);
    expect(startedHere(dataDir)).toEqual(JOINED);
    expect(betweenStops(killed, "mac-daemon", at())).toBe(false);
    // A later command's end is another end.
    const next: Records = {
      running: false,
      lastStop: {
        pid: 42,
        startedAt: "2026-11-02T08:00:00.000Z",
        stoppedAt: null,
        reason: "unrecorded",
        exitCode: null,
        lines: [],
      },
    };
    expect(betweenStops(next, "mac-daemon", at())).toBe(true);
    // While a command runs there is no end to answer, and a note that cannot be read is none.
    noteStartedHere(dataDir, { running: true, lastStop: null });
    expect(startedHere(dataDir)).toEqual(JOINED);
    writeFileSync(join(dataDir, STARTED_HERE), "not a note");
    expect(startedHere(dataDir)).toBeNull();
  });
});

describe("whether the window beside a command starts over once it ended", () => {
  const none = () => false;
  const waiting = () => true;

  it("never on a plain stop or crash: the first mate stays stopped and the window says so", () => {
    expect(startsOverOnStop({ running: false }, { moved: false, resetWaiting: none })).toBe(false);
  });

  it("once the first mate moved away, or a reset another program took waits for the next start", () => {
    expect(startsOverOnStop({ running: false }, { moved: true, resetWaiting: none })).toBe(true);
    expect(startsOverOnStop({ running: false }, { moved: false, resetWaiting: waiting })).toBe(
      true,
    );
  });

  it("never while a command runs or whether one runs is not known", () => {
    for (const running of [true, null] as const)
      expect(startsOverOnStop({ running }, { moved: true, resetWaiting: waiting })).toBe(false);
  });
});
