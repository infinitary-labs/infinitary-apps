/**
 * What a close keeps and how a computer lists it (INF-2574's approved plan
 * under direction C, piece 2, done criteria 1, 2 and 6;
 * docs/leftover-programs.md, "What a close leaves"): a stop that failed or
 * did not finish keeps its command, readable only by the user; a survivor
 * keeps its start time; the list names finished tasks' items without any
 * command; and a kept stop runs again through the app.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LoadRun } from "@shared/load";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { ProcessReading } from "../placed/processResources";
import {
  KEPT_INDEX_DIR,
  KEPT_LEFTOVERS_FILE,
  keepLeftovers,
  LeftBehindHere,
  readKept,
} from "./leftBehind";

const FINISHED = "c0ffee01";
const OPEN = "beef0002";

// INF-2570's Nov 3 leftovers: a scratch machine whose stop timed out and a
// simulator whose shutdown failed; a VM process that survived its close.
const MACHINE = {
  id: "s1",
  label: "scratch macOS machine",
  command: "tart stop inf-scratch && tart delete inf-scratch",
  cwd: "/tmp/inf-scratch",
  at: 1_793_750_000_000,
};
const SIMULATOR = {
  id: "s2",
  label: "booted iPhone simulator",
  command: "xcrun simctl shutdown 5A1C2E9F-7B42-4D0E-9C11-2F3B6A8D4E10",
  at: 1_793_750_100_000,
};
const DISK = { id: "s3", label: "scratch disk", command: "rm -f disk.img", at: 1_793_750_200_000 };
const STARTED = "Tue Nov  3 21:25:01 2026";

const row = (pid: number, started: string, exited = false): ProcessReading => ({
  pid,
  parent: 1,
  group: pid,
  started,
  residentBytes: 1,
  ...(exited ? { exited } : {}),
});

function closeOf(tasksDir: string): void {
  keepLeftovers(
    join(tasksDir, FINISHED),
    [
      { stop: MACHINE, outcome: { label: MACHINE.label, outcome: "timed-out" } },
      { stop: SIMULATOR, outcome: { label: SIMULATOR.label, outcome: "failed", exitCode: 149 } },
      { stop: DISK, outcome: { label: DISK.label, outcome: "ran" } },
    ],
    [
      { pid: 4242, name: "qemu-system-aarch64", outcome: "survived", started: STARTED },
      { pid: 4343, name: "sleep", outcome: "ended", started: STARTED },
    ],
  );
}

describe("what a close keeps", () => {
  it("keeps each unfinished stop's command and each survivor's start time, readable only by the user", () => {
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    const file = join(tasksDir, FINISHED, KEPT_LEFTOVERS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readKept(join(tasksDir, FINISHED))).toEqual({
      stops: [
        { ...MACHINE, outcome: "timed-out" },
        { ...SIMULATOR, outcome: "failed", exitCode: 149 },
      ],
      programs: [{ pid: 4242, name: "qemu-system-aarch64", started: STARTED }],
    });
  });

  it("writes nothing when every stop ran and every program ended", () => {
    const folder = join(scratchDir("infinitary-left-"), FINISHED);
    keepLeftovers(
      folder,
      [{ stop: DISK, outcome: { label: DISK.label, outcome: "ran" } }],
      [{ pid: 4343, name: "sleep", outcome: "killed", started: STARTED }],
    );
    expect(existsSync(join(folder, KEPT_LEFTOVERS_FILE))).toBe(false);
  });
});

describe("what a computer lists", () => {
  const runs: LoadRun[] = [
    {
      id: "6f1c2b7e-1f0a-4c55-9d3e-2b8a4f6c9e10",
      taskId: FINISHED,
      demand: { cpu: 4, memoryBytes: 8 * 1024 ** 3 },
      state: "running",
      ahead: 0,
    },
    {
      id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      taskId: OPEN,
      demand: { cpu: 2, memoryBytes: 4 * 1024 ** 3 },
      state: "waiting",
      ahead: 0,
    },
  ];

  const here = (tasksDir: string, rows: ProcessReading[] | null, ran: string[] = []) =>
    new LeftBehindHere({
      tasksDir,
      closed: (task) => task === FINISHED,
      runs: () => runs,
      processes: async () => rows,
      runStop: async (stop) => {
        ran.push(stop.command);
        return stop.id === "s1"
          ? { label: stop.label, outcome: "ran" }
          : { label: stop.label, outcome: "failed", exitCode: 1 };
      },
    });

  it("names finished tasks' kept stops without commands, live survivors and runs in the line", async () => {
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    // An open task's kept file is its own crewmate's business.
    keepLeftovers(
      join(tasksDir, OPEN),
      [{ stop: DISK, outcome: { label: DISK.label, outcome: "failed" } }],
      [],
    );
    const list = await here(tasksDir, [row(4242, STARTED)]).list();
    expect(list).toEqual({
      stops: [
        { task: FINISHED, id: "s1", label: MACHINE.label, outcome: "timed-out" },
        { task: FINISHED, id: "s2", label: SIMULATOR.label, outcome: "failed", exitCode: 149 },
      ],
      programs: [{ task: FINISHED, pid: 4242, name: "qemu-system-aarch64", started: STARTED }],
      runs: [{ task: FINISHED, id: runs[0]?.id, state: "running", demand: runs[0]?.demand }],
      kept: [OPEN, FINISHED].sort(),
    });
    expect(JSON.stringify(list)).not.toContain("tart stop");
  });

  it("gives a look on this computer each kept stop's command and folder, and the order none", async () => {
    // INF-3592's review, the captain's choice "A plain line saying the step
    // deletes something, and what, without showing the command": the look
    // reads the command to say so.
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    const computer = here(tasksDir, []);
    expect((await computer.list({ commands: true })).stops).toEqual([
      expect.objectContaining({ id: "s1", command: MACHINE.command, cwd: MACHINE.cwd }),
      expect.objectContaining({ id: "s2", command: SIMULATOR.command }),
    ]);
    expect(JSON.stringify(await computer.list())).not.toContain("simctl");
  });

  it("leaves out a task while its close still cleans up, and acts on nothing of it", async () => {
    // INF-3592's review, the captain's choice "Only after its close has
    // finished its own cleanup".
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    const ran: string[] = [];
    const computer = here(tasksDir, [row(4242, STARTED)], ran);
    let release: () => void = () => {};
    const sweep = computer.sweep(FINISHED, () => new Promise<void>((done) => (release = done)));
    const during = await computer.list();
    expect({ ...during, kept: [] }).toEqual({ stops: [], programs: [], runs: [], kept: [] });
    expect(await computer.rerun(FINISHED, "s1")).toMatchObject({ refused: "refused" });
    expect(await computer.drop(FINISHED, "s1")).toMatchObject({ refused: "refused" });
    release();
    await sweep;
    expect((await computer.list()).stops).toHaveLength(2);
    expect(ran).toEqual([]);
  });

  it("drops a kept stop whose target is gone without running it", async () => {
    // INF-3592's review, the captain's choice "Add a drop command, and drop a
    // step on its own once its target is gone".
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    const ran: string[] = [];
    const computer = here(tasksDir, [], ran);
    expect(await computer.drop(FINISHED, "s2")).toEqual({ label: SIMULATOR.label });
    expect(readKept(join(tasksDir, FINISHED)).stops.map((stop) => stop.id)).toEqual(["s1"]);
    expect(await computer.drop(FINISHED, "s2")).toMatchObject({ refused: "refused" });
    expect(ran).toEqual([]);
  });

  it("leaves out a survivor whose number now belongs to another program, or that ended", async () => {
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    expect((await here(tasksDir, [row(4242, "Wed Nov  4 08:00:00 2026")]).list()).programs).toEqual(
      [],
    );
    expect((await here(tasksDir, [row(4242, STARTED, true)]).list()).programs).toEqual([]);
    // An unreadable table proves nothing alive.
    expect((await here(tasksDir, null).list()).programs).toEqual([]);
  });

  it("runs a kept stop again: one that runs leaves the record, one that fails keeps its new outcome", async () => {
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    const ran: string[] = [];
    const computer = here(tasksDir, [], ran);
    expect(await computer.rerun(FINISHED, "s1")).toEqual({ label: MACHINE.label, outcome: "ran" });
    expect(await computer.rerun(FINISHED, "s2")).toEqual({
      label: SIMULATOR.label,
      outcome: "failed",
      exitCode: 1,
    });
    expect(ran).toEqual([MACHINE.command, SIMULATOR.command]);
    expect(readKept(join(tasksDir, FINISHED)).stops).toEqual([
      { ...SIMULATOR, outcome: "failed", exitCode: 1 },
    ]);
    expect(await computer.rerun(FINISHED, "s1")).toMatchObject({ refused: "refused" });
    expect(JSON.parse(readFileSync(join(tasksDir, FINISHED, KEPT_LEFTOVERS_FILE), "utf8"))).toEqual(
      readKept(join(tasksDir, FINISHED)),
    );
  });

  it("reads only the tasks that kept something, and forgets one whose folder retention removed", async () => {
    // The independent review found the list walked every task folder the
    // computer ever held; it reads the index of tasks that kept something.
    const tasksDir = scratchDir("infinitary-left-");
    closeOf(tasksDir);
    expect(readdirSync(join(tasksDir, KEPT_INDEX_DIR))).toEqual([FINISHED]);
    rmSync(join(tasksDir, FINISHED), { recursive: true });
    expect(await here(tasksDir, [row(4242, STARTED)]).list()).toMatchObject({
      stops: [],
      programs: [],
    });
    expect(readdirSync(join(tasksDir, KEPT_INDEX_DIR))).toEqual([]);
  });

  it("refuses to act for a task that is not finished here", async () => {
    const tasksDir = scratchDir("infinitary-left-");
    keepLeftovers(
      join(tasksDir, OPEN),
      [{ stop: DISK, outcome: { label: DISK.label, outcome: "failed" } }],
      [{ pid: 4242, name: "qemu", outcome: "survived", started: STARTED }],
    );
    const ran: string[] = [];
    const computer = here(tasksDir, [row(4242, STARTED)], ran);
    expect(await computer.rerun(OPEN, "s3")).toMatchObject({ refused: "refused" });
    expect(await computer.end(OPEN, 4242)).toMatchObject({ refused: "refused" });
    expect(await computer.drop(OPEN, "s3")).toMatchObject({ refused: "refused" });
    expect(ran).toEqual([]);
  });
});
