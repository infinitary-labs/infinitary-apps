/**
 * A task's registered stops (INF-3447's approved plan, piece 1, done
 * criterion 1; docs/leftover-programs.md, "Registering a stop"): a task
 * command adds, lists and drops them; they are saved readable only by the
 * user and read back after a restart; the close takes them newest first,
 * once; and a carried-on task hands them to its successor.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { handOverStops, readStops, stopsFile, takeStops, taskStopsCommand } from "./taskStops";

const TART_STOP = {
  label: "scratch macOS machine",
  command: "tart stop inf-scratch && tart delete inf-scratch",
};
const SIM_STOP = {
  label: "booted iPhone simulator",
  command: "xcrun simctl shutdown 5A1C2E9F-7B42-4D0E-9C11-2F3B6A8D4E10",
};

describe("task stops", () => {
  it("adds, lists and drops stops, saved readable only by the user across a restart", () => {
    const folder = join(scratchDir("infinitary-stops-"), "task");
    const command = taskStopsCommand(folder, () => 1_700_000_000_000);
    const first = command.add({ ...TART_STOP, cwd: "/Users/someone/work/copy" });
    expect(first.added).toMatchObject({ id: "s1", ...TART_STOP, cwd: "/Users/someone/work/copy" });
    command.add(SIM_STOP);
    expect(statSync(stopsFile(folder)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);

    // A restart reads the same file: a fresh command sees both.
    const again = taskStopsCommand(folder, () => 0);
    expect(again.list().stops?.map((stop) => stop.id)).toEqual(["s1", "s2"]);

    expect(again.drop("s1")).toMatchObject({ dropped: "s1" });
    expect(again.drop("s1")).toMatchObject({ refused: "refused" });
    // An id is never reused after a drop.
    expect(again.add(TART_STOP).added?.id).toBe("s3");
    expect(readStops(folder).stops.map((stop) => stop.label)).toEqual([
      SIM_STOP.label,
      TART_STOP.label,
    ]);
  });

  it("refuses a stop with no label or no command", () => {
    const command = taskStopsCommand(join(scratchDir("infinitary-stops-"), "task"), () => 0);
    expect(command.add({ label: "", command: "tart stop x" })).toMatchObject({
      refused: "invalid",
    });
    expect(command.add({ label: "machine", command: "" })).toMatchObject({ refused: "invalid" });
    expect(command.list().stops).toEqual([]);
  });

  it("is taken newest first, once", () => {
    const folder = join(scratchDir("infinitary-stops-"), "task");
    const command = taskStopsCommand(folder, () => 0);
    command.add(TART_STOP);
    command.add(SIM_STOP);
    expect(takeStops(folder).map((stop) => stop.label)).toEqual([SIM_STOP.label, TART_STOP.label]);
    expect(takeStops(folder)).toEqual([]);
  });

  it("hands its stops to the task that carries the work on, after that task's own", () => {
    const root = scratchDir("infinitary-stops-");
    const from = join(root, "first");
    const to = join(root, "successor");
    taskStopsCommand(from, () => 0).add(TART_STOP);
    taskStopsCommand(to, () => 0).add(SIM_STOP);
    expect(handOverStops(from, to)).toBe(1);
    expect(readStops(from).stops).toEqual([]);
    expect(readStops(to).stops.map((stop) => [stop.id, stop.label])).toEqual([
      ["s1", SIM_STOP.label],
      ["s2", TART_STOP.label],
    ]);
    expect(handOverStops(from, to)).toBe(0);
  });
});
