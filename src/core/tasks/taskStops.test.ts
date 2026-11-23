/**
 * A task's registered stops (INF-3447's approved plan, piece 1, done
 * criterion 1; docs/leftover-programs.md, "Registering a stop"): a task
 * command adds, lists and drops them; they are saved readable only by the
 * user and read back after a restart; the close takes them newest first,
 * once; and a carried-on task hands them to its successor.
 */

import { existsSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  handOverStops,
  KEEP_AS_ANOTHER_USER,
  KEEP_NOT_YET,
  keepsThere,
  keptRoot,
  readStops,
  stopsFile,
  takeKeeps,
  takeStops,
  taskStopsCommand,
} from "./taskStops";

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
    expect(handOverStops(from, to)).toEqual({ stops: 1, keeps: 0 });
    expect(readStops(from).stops).toEqual([]);
    expect(readStops(to).stops.map((stop) => [stop.id, stop.label])).toEqual([
      ["s1", SIM_STOP.label],
      ["s2", TART_STOP.label],
    ]);
    expect(handOverStops(from, to)).toEqual({ stops: 0, keeps: 0 });
  });
});

/**
 * A job the captain asked to keep running past the close (INF-4381's
 * approved plan, piece 1, done criteria 1, 2, 5 and 7;
 * docs/leftover-programs.md, "A job the captain asked to keep").
 */
const BACKUP = {
  label: "nightly photo backup",
  check: "systemctl --user is-active photo-backup.timer",
  remove:
    "systemctl --user disable --now photo-backup.timer && rm ~/.config/systemd/user/photo-backup.*",
};

describe("task keeps", () => {
  it("records a keep with a kept folder outside the task's folders, saved across a restart", () => {
    const tasksDir = join(scratchDir("infinitary-keeps-"), "crewmates");
    const folder = join(tasksDir, "task-7");
    const command = taskStopsCommand(folder, () => 1_700_000_000_000);
    command.add(TART_STOP);
    const answer = command.keep({ ...BACKUP, cwd: "/home/someone/copy" });
    const kept = answer.kept;
    expect(kept).toMatchObject({ id: "s2", ...BACKUP, account: userInfo().username });
    // Beside the task folders, never inside the task's own: no close removes it.
    expect(kept?.folder).toBe(join(keptRoot(tasksDir), "task-7-s2"));
    expect(dirname(kept?.folder ?? "")).toBe(join(dirname(tasksDir), "kept"));
    expect(statSync(kept?.folder ?? "").mode & 0o777).toBe(0o700);
    expect(statSync(stopsFile(folder)).mode & 0o777).toBe(0o600);

    // A restart reads the same file; stops and keeps share one count.
    const again = taskStopsCommand(folder, () => 0);
    expect(again.list().keeps?.map((keep) => keep.id)).toEqual(["s2"]);
    expect(again.add(SIM_STOP).added?.id).toBe("s3");

    // The close takes the stops alone first; the keeps stay for their own take.
    expect(takeStops(folder).map((stop) => stop.id)).toEqual(["s3", "s1"]);
    expect(readStops(folder).keeps?.map((keep) => keep.label)).toEqual([BACKUP.label]);
    expect(takeKeeps(folder).map((keep) => keep.label)).toEqual([BACKUP.label]);
    expect(takeKeeps(folder)).toEqual([]);
    expect(existsSync(stopsFile(folder))).toBe(false);
    expect(existsSync(kept?.folder ?? "")).toBe(true);
  });

  it("drops a keep without running its remove, and refuses one with a missing part", () => {
    const folder = join(scratchDir("infinitary-keeps-"), "crewmates", "task");
    const command = taskStopsCommand(folder, () => 0);
    expect(command.keep({ ...BACKUP, check: "" })).toMatchObject({ refused: "invalid" });
    expect(command.keep({ ...BACKUP, remove: " " })).toMatchObject({ refused: "invalid" });
    expect(command.keep({ ...BACKUP, label: "" })).toMatchObject({ refused: "invalid" });
    const id = command.keep(BACKUP).kept?.id ?? "";
    expect(command.drop(id)).toMatchObject({ dropped: id, keeps: [] });
    expect(command.drop(id)).toMatchObject({ refused: "refused" });
  });

  it("refuses a keep where the job would run as another user, or the home has no word on keeps", () => {
    const folder = join(scratchDir("infinitary-keeps-"), "tasks", "task");
    expect(taskStopsCommand(folder, () => 0, undefined, keepsThere(false)).keep(BACKUP)).toEqual({
      text: KEEP_AS_ANOTHER_USER,
      refused: "refused",
    });
    expect(
      taskStopsCommand(folder, () => 0, undefined, keepsThere(undefined)).keep(BACKUP),
    ).toEqual({ text: KEEP_NOT_YET, refused: "refused" });
    expect(readStops(folder).keeps).toBeUndefined();
    expect(
      taskStopsCommand(folder, () => 0, undefined, keepsThere(true)).keep(BACKUP).kept?.label,
    ).toBe(BACKUP.label);
  });

  it("hands its keeps to the task that carries the work on, its kept folder unmoved", () => {
    const tasksDir = join(scratchDir("infinitary-keeps-"), "crewmates");
    const from = join(tasksDir, "first");
    const to = join(tasksDir, "successor");
    taskStopsCommand(from, () => 0).add(TART_STOP);
    const folder = taskStopsCommand(from, () => 0).keep(BACKUP).kept?.folder;
    taskStopsCommand(to, () => 0).add(SIM_STOP);
    expect(handOverStops(from, to)).toEqual({ stops: 1, keeps: 1 });
    const moved = readStops(to);
    expect(moved.stops.map((stop) => stop.id)).toEqual(["s1", "s2"]);
    expect(moved.keeps?.map((keep) => [keep.id, keep.label, keep.folder])).toEqual([
      ["s3", BACKUP.label, folder],
    ]);
    expect(readStops(from).keeps).toBeUndefined();
  });
});
