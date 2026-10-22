import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { declareCheckAction, observeCheckRepair } from "./checkRepair";
import { CHECK_WATCH_SLOW_MS } from "./checkWatch";
import { type MainBranchReading, MainCheckWatcher } from "./mainCheckWake";
import { mainCheckPassedOnce, renderWake, type TypedWake } from "./wakes";

/**
 * INF-833 Fix 4, the captain's "wakes PRs waiting on a main failure once
 * main's own run of that check passes": a standing baseline wait is a steer
 * when the default branch's own run of that check is success, and not while
 * that run is still failing, waiting, skipped or absent. The named task
 * staying open is the case the close-only rule held (FI3-250).
 */

const HEAD = "c".repeat(40);
const MAIN = "a".repeat(40);
const LATER = "b".repeat(40);
const CHECK = "linux-checks";

function setup() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: () => 1_700_000_000_000 });
  const inbox = new InboxStore(db, { now: () => 1_700_000_000_000 });
  const owner = seedTask(tasks, {
    id: "owner",
    title: "Fix the phone failure",
    status: "running",
    repoId: "infinitary",
  });
  const waiters = ["pr-290", "pr-292"].map((id, index) => {
    const task = seedTask(tasks, {
      id,
      title: `Waiting pull request ${index + 1}`,
      status: "running",
      repoId: "infinitary",
    });
    tasks.recordDelivery(task.id, {
      headSha: HEAD,
      ci: "red",
      prNumber: 290 + index,
      ...observeCheckRepair(
        undefined,
        HEAD,
        [{ name: CHECK, state: "failure" }],
        1_700_000_000_000,
      ),
    });
    const declared = declareCheckAction(
      tasks,
      task.id,
      {
        diagnosis: {
          headSha: HEAD,
          check: CHECK,
          classification: "baseline-blocked",
          evidence: "The same assertion fails on untouched main, ci run 39702171971",
          dependencyTask: owner.id,
        },
      },
      1_700_000_000_000,
    );
    if (!declared.text.includes("Diagnosis recorded")) {
      throw new Error(declared.text);
    }
    return task;
  });
  let reading: MainBranchReading = {
    kind: "read",
    sha: MAIN,
    items: [{ name: CHECK, state: "failure" }],
  };
  const reads: string[] = [];
  const steers: { taskId: string; wake: TypedWake }[] = [];
  const watcher = new MainCheckWatcher({
    tasks,
    inbox,
    read: async (repoId) => {
      reads.push(repoId);
      return reading;
    },
    steer: async (taskId, wake) => {
      steers.push({ taskId, wake });
      if (wake.once) inbox.enqueueSteerOnce(taskId, { ...wake, once: wake.once });
    },
  });
  return {
    db,
    tasks,
    owner,
    waiters,
    reads,
    steers,
    answer: (next: MainBranchReading) => {
      reading = next;
    },
    poll: (at = 1_700_000_060_000) => watcher.poll(at),
  };
}

describe("a main failure's wake (INF-833 Fix 4)", () => {
  it("wakes each waiting pull request once the default branch's own run of that check passes, and not before", async () => {
    const { db, tasks, owner, waiters, reads, steers, answer, poll } = setup();
    try {
      await poll();
      expect(reads).toEqual(["infinitary"]);
      expect(steers).toEqual([]);
      expect(owner.status).toBe("active");

      answer({ kind: "read", sha: MAIN, items: [{ name: CHECK, state: "pending" }] });
      await poll();
      answer({ kind: "read", sha: MAIN, items: [{ name: CHECK, state: "skipped" }] });
      await poll();
      answer({ kind: "read", sha: MAIN, items: [{ name: "unit-tests", state: "success" }] });
      await poll();
      answer({
        kind: "read",
        sha: MAIN,
        items: [
          { name: CHECK, state: "success" },
          { name: CHECK, state: "pending" },
        ],
      });
      await poll();
      expect(steers).toEqual([]);

      answer({ kind: "read", sha: MAIN, items: [{ name: CHECK, state: "success" }] });
      await poll();
      expect(steers.map((steer) => steer.taskId).sort()).toEqual(
        waiters.map((task) => task.id).sort(),
      );
      for (const steer of steers) {
        expect(renderWake(steer.wake)).toBe(
          `The default branch's own run of ${CHECK} passed at ${MAIN.slice(0, 7)}. Bring your change up to date and read the checks again.`,
        );
        expect(steer.wake.once).toBe(mainCheckPassedOnce(CHECK, MAIN));
      }
      const woken = steers.length;
      await poll();
      expect(steers).toHaveLength(woken);

      const stillWaiting = waiters[0];
      const alreadyGreen = waiters[1];
      if (!stillWaiting || !alreadyGreen) {
        throw new Error("the two waiting pull requests were not seeded");
      }
      answer({ kind: "read", sha: LATER, items: [{ name: CHECK, state: "success" }] });
      tasks.recordDelivery(alreadyGreen.id, { ci: "green", headSha: LATER });
      await poll();
      expect(steers.slice(woken).map((steer) => steer.taskId)).toEqual([stillWaiting.id]);
      expect(steers.at(-1)?.wake.once).toBe(mainCheckPassedOnce(CHECK, LATER));
    } finally {
      db.close();
    }
  });

  it("a failed or unsupported read of the default branch wakes nobody", async () => {
    const { db, steers, reads, answer, poll } = setup();
    const at = 1_700_000_060_000;
    try {
      answer({ kind: "failed" });
      await poll(at);
      await poll(at + CHECK_WATCH_SLOW_MS - 1);
      expect(reads).toEqual(["infinitary"]);
      answer({ kind: "unsupported" });
      await poll(at + CHECK_WATCH_SLOW_MS);
      await poll(at + CHECK_WATCH_SLOW_MS + 60_000);
      expect(reads).toEqual(["infinitary", "infinitary"]);
      expect(steers).toEqual([]);
    } finally {
      db.close();
    }
  });
});
