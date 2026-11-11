import { describe, expect, it } from "vitest";
import { rowWrites } from "../../../tests/helpers/rowWrites";
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

/**
 * INF-2220: every run-watch read rewrote the task's whole delivery three
 * times - its checks, its failures and its watch, each its own write - and
 * each write saved the evidence again together with every permission
 * column, the history row and the turn's declarations, then moved the
 * board. A captain's 380 ms freeze sat in that write. An ordinary read now
 * commits once and saves only the evidence that moved: the read's own time
 * and when the next read is due.
 */
describe("RunWatcher's ordinary read (INF-2220)", () => {
  it("saves each read's time and next read once, leaving permissions, history and declarations unwritten", async () => {
    const start = Date.parse("2026-11-06T21:17:00Z");
    let now = start;
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => now });
    seedTask(tasks, { id: "t1", title: "Fix the phone check", status: "running" });
    const watch = {
      runId: 41_478_071_255,
      name: "journeys",
      attempt: 1,
      since: start - 10 * 60_000,
      nextAt: start,
      failureSeen: false,
    };
    const refusal = {
      at: start - 60_000,
      title: "Phone check fixed",
      reason: "checks" as const,
      why: "The checks had not finished.",
    };
    const checkBack = { at: start - 60_000, until: start + 30 * 60_000, waitingFor: "journeys" };
    seedDelivery(tasks, "t1", { runWatches: [watch], checkBack });
    tasks.delivery.recordPermissionRecords("t1", { cardRefusal: refusal });
    const writes = rowWrites(db);
    const changes: number[] = [];
    tasks.onChange((change) => changes.push(change.seq));
    const running: RunReading = {
      run: {
        id: watch.runId,
        name: "journeys",
        headSha: "c4d0a220c089e1d83092fead988848b4fed1e80a",
        branch: "fm/task-t1",
        attempt: 1,
        status: "in_progress",
        conclusion: null,
        url: "https://github.com/octo/app/actions/runs/41478071255",
      },
      list: { jobs: [], total: 0, complete: true },
    };
    const watcher = new RunWatcher({
      tasks,
      inbox: { woken: () => false },
      read: async () => running,
      steer: async () => undefined,
    });

    for (const at of [start, start + RUN_WATCH_TICK_MS]) {
      now = at;
      await watcher.poll(at);
      const delivery = tasks.get("t1")?.delivery;
      // The read's own time and the next read move on every read, the run unchanged.
      expect(delivery?.runChecks).toMatchObject({ runId: watch.runId, state: "running", at });
      expect(delivery?.runWatches).toEqual([
        {
          ...watch,
          nextAt: at + RUN_WATCH_TICK_MS,
          // No job has a machine yet: the run reads as queued since the first read.
          reading: {
            head: running.run.headSha,
            url: running.run.url,
            state: "queued",
            since: start,
            at,
          },
        },
      ]);
      expect(delivery?.cardRefusal).toEqual(refusal);
      expect(delivery?.checkBack).toEqual(checkBack);
      expect(writes.take()).toEqual([
        "task_delivery_evidence UPDATE",
        "tasks UPDATE",
        "task_board UPDATE",
      ]);
    }
    expect(changes).toHaveLength(2);
  });
});
