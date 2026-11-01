import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { ForgeAllowanceSpent } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RUN_WATCH_TICK_MS, type RunReading, RunWatcher } from "./runWatch";
import type { TypedWake } from "./wakes";

/**
 * INF-2149: a spent hourly allowance ended every run watch as unreadable and
 * woke its crewmate, though the run was still going. The watch now keeps
 * standing and reads again at the reset GitHub named.
 */
describe("RunWatcher on a spent allowance (INF-2149)", () => {
  it("keeps the watch standing, wakes no one, and reads again at GitHub's reset", async () => {
    const start = Date.parse("2026-11-01T00:36:45Z");
    const resetAt = Date.parse("2026-11-01T00:42:42Z");
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => start });
    seedTask(tasks, { id: "t1", title: "Fix the phone check", status: "running" });
    const watch = {
      runId: 18_993_001_244,
      name: "phone",
      attempt: 1,
      since: start - 30 * 60_000,
      nextAt: start,
      failureSeen: false,
    };
    seedDelivery(tasks, "t1", { runWatches: [watch] });
    const reads: number[] = [];
    const steers: TypedWake[] = [];
    let answer: () => RunReading = () => {
      throw new ForgeAllowanceSpent(
        resetAt,
        "GitHub answered 403 to GET /repos/o/r/actions/runs/18993001244: API rate limit exceeded for user ID 3233006. (the hourly allowance is spent)",
      );
    };
    const watcher = new RunWatcher({
      tasks,
      inbox: { woken: () => false },
      read: async () => {
        reads.push(reads.length);
        return answer();
      },
      steer: async (_taskId, wake) => {
        steers.push(wake);
      },
    });
    await watcher.poll(start);
    expect(steers).toEqual([]);
    expect(tasks.get("t1")?.delivery?.runWatches).toEqual([{ ...watch, nextAt: resetAt }]);
    await watcher.poll(start + RUN_WATCH_TICK_MS);
    expect(reads).toHaveLength(1);
    answer = () => ({
      run: {
        id: watch.runId,
        name: "phone",
        headSha: "c342747a2d8f3e8b1c6e4f0a9b7d5e3c1a2b4d6f",
        branch: "fm/task-t1",
        attempt: 1,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/kunchenguid/infinitary/actions/runs/18993001244",
      },
      list: { jobs: [], total: 0, complete: true },
    });
    await watcher.poll(resetAt);
    expect(reads).toHaveLength(2);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ facts: { kind: "run-watch", outcome: "passed" } });
  });
});
