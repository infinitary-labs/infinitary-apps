import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { WorkDevices } from "../placed/workDevices";
import { KeptJobs } from "./keptJobs";
import { KeptRunning, runKeptJobHere } from "./keptRunning";

// Measured on the Mac mini: each case runs a few shell commands, well under
// a second; a 10 s budget covers a slow runner several times over.
vi.setConfig({ testTimeout: 10_000 });

/**
 * Kept running (docs/leftover-programs.md, "Kept running"), the captain's
 * approved plan on INF-4381, piece 2: "Check runs the check; Remove asks
 * once, then runs the remove on that computer and keeps a failure." Each
 * case records a job the way a merged close does (`KeptJobs.record`), with
 * a kept folder holding the job's own file, and runs the job's real check
 * and remove commands through `KeptRunning`.
 */

const LABEL = "Nightly backup of the notes folder";

/** A kept folder with the job's file in it, and its record as a merged close leaves it. */
function keptJob(options: { remove?: string; computer?: string | null; root?: string } = {}) {
  const home = scratchDir("infinitary-kept-running-");
  const root = options.root ?? join(home, "kept");
  const folder = join(root, "task-1-s1");
  mkdirSync(folder, { recursive: true });
  const marker = join(folder, "backup.timer");
  writeFileSync(marker, "[Timer]\nOnCalendar=daily\n");
  const jobs = new KeptJobs(join(home, "kept", "jobs.json"), () => 1_000);
  jobs.record(
    [
      {
        id: "s1",
        label: LABEL,
        check: `test -f "${marker}"`,
        remove: options.remove ?? `rm "${marker}"`,
        folder,
        account: "captain",
      },
    ],
    { computer: options.computer ?? null, task: "task-1", key: "INF-7" },
  );
  return { jobs, folder, marker };
}

const here = (jobs: KeptJobs, work?: KeptRunningWork) =>
  new KeptRunning({
    jobs,
    work: work ?? unreachable,
    computerName: (id) => (id === "mini" ? "Mac mini" : undefined),
    homeName: () => "MacBook Pro",
    now: () => 2_000,
  });

type KeptRunningWork = Pick<WorkDevices, "ask" | "inReach" | "takesCurrentWork" | "version">;
const unreachable: KeptRunningWork = {
  ask: () => Promise.reject(new Error("out of reach")),
  inReach: () => false,
  takesCurrentWork: () => false,
  version: () => undefined,
};

/** A computer that runs work with the change, which answers the order from its own kept folder. */
function workThere(root: string, changes: string[] = ["kept-job-orders"]): KeptRunningWork {
  return {
    ask: (_device, _channel, args) => runKeptJobHere(root, args),
    inReach: () => true,
    takesCurrentWork: () => true,
    version: () => ({ changes }) as unknown as ReturnType<WorkDevices["version"]>,
  };
}

describe("kept running", () => {
  it("lists a kept job by label, computer, account and task", () => {
    const { jobs } = keptJob();
    expect(here(jobs).list().jobs).toEqual([
      {
        id: "task-1-s1",
        label: LABEL,
        computer: null,
        computerName: "MacBook Pro",
        account: "captain",
        task: "task-1",
        key: "INF-7",
        at: 1_000,
      },
    ]);
  });

  it("checks the job here, and keeps how the check went on its record", async () => {
    const { jobs, marker } = keptJob();
    const running = here(jobs);
    expect((await running.check("task-1-s1")).checked).toEqual({ at: 2_000, outcome: "running" });
    // The job's file gone, its check exits non-zero: not running.
    rmSync(marker);
    expect((await running.check("task-1-s1")).checked?.outcome).toBe("not-running");
    expect(jobs.list()[0]?.checked).toEqual({ at: 2_000, outcome: "not-running" });
  });

  it("removes the job here: its remove runs, its kept folder goes and it leaves the record", async () => {
    const { jobs, folder, marker } = keptJob();
    const said: string[] = [];
    const result = await here(jobs).remove("task-1-s1", { say: (text) => said.push(text) });
    expect(result).toEqual({ id: "task-1-s1", removed: true });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(jobs.list()).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(LABEL);
  });

  it("keeps a job whose remove fails, with how it went, and its kept folder", async () => {
    const { jobs, folder } = keptJob({ remove: "exit 3" });
    const said: string[] = [];
    const result = await here(jobs).remove("task-1-s1", { say: (text) => said.push(text) });
    expect(result.removed).toBe(false);
    expect(result.job?.removeFailed).toEqual({ at: 2_000, outcome: "failed", exitCode: 3 });
    expect(jobs.list()).toHaveLength(1);
    expect(existsSync(folder)).toBe(true);
    expect(said[0]).toContain("stays under Kept running");
  });

  it("forgets a job whose remove did not finish without running anything, keeping its folder", async () => {
    // The captain's choice on the review: Forget beside a remove that did not finish.
    const { jobs, folder, marker } = keptJob({ remove: "exit 3" });
    const running = here(jobs);
    await running.remove("task-1-s1");
    const said: string[] = [];
    expect(running.forget("task-1-s1", { say: (text) => said.push(text) })).toEqual({
      id: "task-1-s1",
    });
    expect(jobs.list()).toEqual([]);
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(said[0]).toContain("may still run on MacBook Pro");
  });

  it("runs a job kept on a computer that runs work there, which takes the folder with its remove", async () => {
    const there = join(scratchDir("infinitary-kept-there-"), "kept");
    const { jobs, folder } = keptJob({ computer: "mini", root: there });
    const running = here(jobs, workThere(there));
    expect(running.list().jobs[0]?.computerName).toBe("Mac mini");
    expect((await running.check("task-1-s1@mini")).checked?.outcome).toBe("running");
    expect((await running.remove("task-1-s1@mini")).removed).toBe(true);
    expect(existsSync(folder)).toBe(false);
    expect(jobs.list()).toEqual([]);
  });

  it("keeps a job whose computer is out of reach or lacks the change, and runs nothing", async () => {
    const there = join(scratchDir("infinitary-kept-there-"), "kept");
    const { jobs, marker } = keptJob({ computer: "mini", root: there });
    expect((await here(jobs).check("task-1-s1@mini")).checked?.outcome).toBe("unreachable");
    const older = here(jobs, workThere(there, []));
    const result = await older.remove("task-1-s1@mini");
    expect(result.job?.removeFailed?.outcome).toBe("unreachable");
    expect(existsSync(marker)).toBe(true);
  });

  it("tells apart a job kept here and one kept there under the same folder name", async () => {
    // A task that moved computers counts its keeps from 1 again there.
    const there = join(scratchDir("infinitary-kept-there-"), "kept");
    const { jobs, marker } = keptJob();
    const away = join(there, "task-1-s1");
    mkdirSync(away, { recursive: true });
    jobs.record(
      [
        {
          id: "s1",
          label: "Weekly photo sync",
          check: "true",
          remove: "true",
          folder: away,
          account: "captain",
        },
      ],
      { computer: "mini", task: "task-1", key: "INF-7" },
    );
    const running = here(jobs, workThere(there));
    expect(running.list().jobs.map((job) => job.id)).toEqual(["task-1-s1", "task-1-s1@mini"]);
    expect((await running.remove("task-1-s1@mini")).removed).toBe(true);
    // The job kept here, with its file, is untouched.
    expect(existsSync(marker)).toBe(true);
    expect(jobs.list().map((job) => job.label)).toEqual([LABEL]);
  });

  it("runs a job whose kept folder is gone in that folder made again, never among other jobs'", async () => {
    const { jobs, folder } = keptJob({ remove: "touch left-behind" });
    const root = join(folder, "..");
    rmSync(folder, { recursive: true });
    const running = here(jobs);
    expect((await running.check("task-1-s1")).checked?.outcome).toBe("not-running");
    expect(existsSync(folder)).toBe(true);
    expect((await running.remove("task-1-s1")).removed).toBe(true);
    expect(existsSync(join(root, "left-behind"))).toBe(false);
  });

  it("refuses an order naming a folder outside that computer's kept folder", async () => {
    const root = join(scratchDir("infinitary-kept-there-"), "kept");
    mkdirSync(root, { recursive: true });
    const outside = scratchDir("infinitary-not-kept-");
    for (const folder of [outside, join(root, "..", "elsewhere"), join(root, "a", "b"), root])
      await expect(
        runKeptJobHere(root, [{ action: "remove", label: LABEL, command: "true", folder }]),
      ).rejects.toThrow(/not a kept job's folder/);
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses an id that names no kept job", async () => {
    const { jobs } = keptJob();
    await expect(here(jobs).remove("task-2-s4")).rejects.toThrow(/No kept job task-2-s4/);
  });
});
