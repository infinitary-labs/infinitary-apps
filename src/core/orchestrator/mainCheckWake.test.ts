import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { declareCheckAction, observeCheckRepair } from "./checkRepair";
import { CHECK_WATCH_SLOW_MS } from "./checkWatch";
import { type MainBranchReading, MainCheckWatcher } from "./mainCheckWake";
import { renderWake, type TypedWake } from "./wakes";

/**
 * Captain F5: each default-branch commit's final checks are relayed once;
 * the crew decides whether those facts clear its baseline wait.
 * Empty, incomplete and running readings are not final observations.
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
    seedDelivery(tasks, task.id, {
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
  const host = {
    tasks,
    inbox,
    read: async (repoId: string) => {
      reads.push(repoId);
      return reading;
    },
    steer: async (taskId: string, wake: TypedWake) => {
      steers.push({ taskId, wake });
      if (wake.once) inbox.enqueueSteerOnce(taskId, { ...wake, once: wake.once });
    },
  };
  let watcher = new MainCheckWatcher(host);
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
    restart: () => {
      watcher = new MainCheckWatcher(host);
    },
  };
}

describe("a main failure's wake (INF-833 Fix 4)", () => {
  // INF-2149: on a spent hourly allowance the read waits for GitHub's reset, not the usual pause.
  it("reads the default branch again only at the reset GitHub named for a spent allowance", async () => {
    const { db, answer, poll, reads } = setup();
    try {
      const at = 1_700_000_060_000;
      const resetAt = at + 20 * 60_000;
      answer({
        kind: "failed",
        problem:
          "GitHub answered 403 to GET /repos/o/r/commits/main/check-runs (the hourly allowance is spent)",
        retryAt: resetAt,
      });
      await poll(at);
      await poll(at + CHECK_WATCH_SLOW_MS);
      await poll(resetAt - 1);
      expect(reads).toHaveLength(1);
      await poll(resetAt);
      expect(reads).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  // INF-1555 F14 and captain F5: explain a refused list on each task, never invent a final wake.
  it.each(["read", "failed"] as const)(
    "records a %s refusal reason once per waiting task without a non-final wake",
    async (kind) => {
      const { db, tasks, waiters, answer, poll, steers, restart } = setup();
      try {
        const problem =
          "GitHub could not provide all check runs: Resource not accessible by integration";
        answer(
          kind === "read"
            ? {
                kind,
                sha: MAIN,
                complete: false,
                problem,
                items: [{ name: CHECK, state: "success" }],
              }
            : { kind, problem },
        );
        await poll();
        restart();
        await poll();
        expect(steers).toEqual([]);
        for (const task of waiters) {
          const notes = tasks.timeline(task.id).filter((event) => event.data?.mainCheckReadProblem);
          expect(notes).toHaveLength(1);
          expect(notes[0]).toMatchObject({
            text: `The default branch's checks cannot be read: ${problem}`,
            data: { news: true },
          });
          // F14 retains only the identity actually read; a failed lookup has no main commit.
          expect(notes[0]?.data?.mainCheckReadProblem).toEqual(
            kind === "read" ? { sha: MAIN, problem } : { problem },
          );
        }
        answer({
          kind: "read",
          sha: MAIN,
          complete: true,
          items: [{ name: CHECK, state: "success" }],
        });
        await poll(1_700_000_060_000 + CHECK_WATCH_SLOW_MS);
        expect(steers).toHaveLength(waiters.length);
      } finally {
        db.close();
      }
    },
  );

  // Captain F5: one final-state wake per main commit, not each check transition.
  it("relays final checks once per commit across transitions and restart", async () => {
    const { db, tasks, waiters, reads, steers, answer, poll, restart } = setup();
    try {
      for (const items of [
        [],
        [{ name: CHECK, state: "pending" }],
        [
          { name: CHECK, state: "success" },
          { name: "phone", state: "pending" },
        ],
      ] as const) {
        answer({ kind: "read", sha: MAIN, items: [...items] });
        await poll();
        expect(steers).toEqual([]);
      }
      answer({
        kind: "read",
        sha: MAIN,
        items: [{ name: CHECK, state: "failure" }],
        complete: false,
      });
      await poll();
      expect(steers).toEqual([]);
      const final = [
        { name: CHECK, state: "failure" },
        { name: "phone", state: "skipped" },
      ] as const;
      answer({ kind: "read", sha: MAIN, items: [...final], complete: true });
      await poll();
      expect(steers.map((entry) => entry.taskId).sort()).toEqual(
        waiters.map((task) => task.id).sort(),
      );
      expect(steers.at(-1)?.wake.facts).toEqual({
        kind: "main-check-observed",
        sha: MAIN,
        checks: [...final],
      });
      expect(renderWake(steers.at(-1)!.wake)).toContain(
        "Judge whether this clears your declared wait",
      );
      await poll();
      restart();
      answer({ kind: "read", sha: MAIN, items: [{ name: CHECK, state: "success" }] });
      await poll();
      expect(steers).toHaveLength(waiters.length);
      expect(reads.every((repo) => repo === "infinitary")).toBe(true);
      seedDelivery(tasks, waiters[1]!.id, { ci: "green", headSha: LATER });
      answer({ kind: "read", sha: LATER, items: [{ name: CHECK, state: "success" }] });
      await poll();
      expect(steers.slice(waiters.length).map((entry) => entry.taskId)).toEqual([waiters[0]!.id]);
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
