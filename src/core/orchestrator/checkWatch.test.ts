import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import {
  armWatch,
  CHECK_REFRESH_MS,
  CHECK_WATCH_BOUND_MS,
  CheckWatcher,
  checkWatchOnce,
  type WatchedReading,
} from "./checkWatch";
import { renderWake, type TypedWake } from "./wakes";

/**
 * The check watch's own clock and outcomes (docs/forge.md, "The check
 * watch"), over the real task record and inbox with a scripted read. The
 * whole path - check_change, the supervisor's tick and steer, a restart -
 * is `crewWatch.git.test.ts` ("the host's check watch").
 */

const HEAD = "cafe0001feedbeef";
const minutes = (n: number) => n * 60_000;

function setup() {
  let now = 1_000_000;
  const clock = () => now;
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: clock });
  const inbox = new InboxStore(db, { now: clock });
  seedTask(tasks, { id: "t1", title: "Ship it", status: "completed", branch: "fm/task-t1" });
  const start = now;
  seedDelivery(tasks, "t1", { ciWatch: armWatch(undefined, HEAD, start) });
  /** What the next read answers; a function reads the moment it is asked. */
  let next: WatchedReading | (() => WatchedReading) = {
    kind: "pending",
    head: HEAD,
    change: "PR #7",
    pending: [{ name: "linux-checks", state: "pending" }],
  };
  const reads: number[] = [];
  const steers: TypedWake[] = [];
  const kept: string[] = [];
  const watcher = new CheckWatcher({
    tasks,
    inbox,
    runKept: (taskId) => kept.push(taskId),
    read: async () => {
      reads.push(now - start);
      return typeof next === "function" ? next() : next;
    },
    steer: async (taskId, wake) => {
      steers.push(wake);
      if (wake.once) inbox.enqueueSteerOnce(taskId, { ...wake, once: wake.once });
    },
  });
  return {
    tasks,
    inbox,
    reads,
    steers,
    kept,
    start,
    answer: (reading: WatchedReading | (() => WatchedReading)) => {
      next = reading;
    },
    /** The shared tick at `ms` past the watch's start. */
    at: async (ms: number) => {
      now = start + ms;
      await watcher.poll(now);
    },
    watch: () => tasks.get("t1")?.delivery?.ciWatch,
  };
}

describe("CheckWatcher", () => {
  // INF-1555 F21: a refused reading ends or reports through the existing unreadable path, never a running timeout.
  it.each([true, false])(
    "reports a refusal once without a running watch (already watched: %s)",
    async (watched) => {
      const { tasks, start, answer, at, steers, watch } = setup();
      const problem = "GitHub refused access to the remaining checks.";
      seedDelivery(tasks, "t1", {
        ci: "pending",
        ciAt: start,
        prNumber: 7,
        ciWatch: watched ? armWatch(undefined, HEAD, start) : undefined,
        ciObservation: { id: "refused-list", signature: "refused-list", forwarded: false },
      });
      answer({ kind: "failed", transient: false, problem, observationId: "refused-list" });
      await at(minutes(watched ? 1 : 5));
      expect(steers).toHaveLength(1);
      expect(steers[0]?.facts).toMatchObject({
        kind: "checks-settled",
        outcome: "unreadable",
        problem,
      });
      expect(renderWake(steers[0]!)).not.toContain("still running");
      expect(watch()).toBeUndefined();
      expect(tasks.get("t1")?.delivery?.ciObservation?.forwarded).toBe(true);
      await at(CHECK_WATCH_BOUND_MS + minutes(5));
      expect(steers).toHaveLength(1);
    },
  );

  it("forwards an unacknowledged observation once across restart, without deciding readiness (INF-1177 piece 0)", async () => {
    const { tasks, inbox, at, start, answer, steers } = setup();
    seedDelivery(tasks, "t1", {
      ciWatch: undefined,
      ci: "green",
      ciAt: start,
      prNumber: 7,
      ciObservation: { id: "observation-one", signature: "failed-check-reading", forwarded: false },
    });
    const reading: WatchedReading = {
      kind: "finished",
      observationId: "observation-one",
      head: HEAD,
      change: "PR #7",
      checks: [{ name: "linux-checks", state: "failure" }],
    };
    answer(reading);
    await at(minutes(5));
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({
      once: "check-observation:observation-one",
      facts: { kind: "checks-settled", outcome: "observed", checks: reading.checks },
    });
    expect(tasks.get("t1")?.delivery).toMatchObject({
      ci: "green",
      ciObservation: { forwarded: true },
    });
    // The inbox committed, but a crash preceded the delivery acknowledgement.
    seedDelivery(tasks, "t1", {
      ciObservation: { id: "observation-one", signature: "failed-check-reading", forwarded: false },
    });
    const restarted = new CheckWatcher({
      tasks,
      inbox,
      read: async () => reading,
      steer: async (_id, wake) => {
        steers.push(wake);
      },
    });
    await restarted.poll(start + minutes(10));
    expect(steers).toHaveLength(1);
    expect(tasks.get("t1")?.delivery?.ciObservation?.forwarded).toBe(true);
    await restarted.poll(start + minutes(15));
    expect(steers).toHaveLength(1);
  });

  it("does not repeat a watched finish as a quiet-refresh notice after a restart (INF-1177 piece 0)", async () => {
    const { tasks, inbox, at, start, answer, steers } = setup();
    seedDelivery(tasks, "t1", {
      ci: "pending",
      ciAt: start,
      prNumber: 7,
      ciObservation: { id: "watched-finish", signature: "finished-reading", forwarded: false },
    });
    const reading: WatchedReading = {
      kind: "finished",
      observationId: "watched-finish",
      head: HEAD,
      change: "PR #7",
      checks: [{ name: "linux-checks", state: "success" }],
    };
    answer(reading);
    await at(minutes(1));
    expect(steers).toHaveLength(1);
    const receipt = tasks.get("t1")!.delivery!.ciObservation!;
    expect(receipt.notice).toBe(steers[0]!.once);
    seedDelivery(tasks, "t1", { ciObservation: { ...receipt, forwarded: false } });
    const restarted = new CheckWatcher({
      tasks,
      inbox,
      read: async () => reading,
      steer: async (_id, wake) => {
        steers.push(wake);
      },
    });
    await restarted.poll(start + minutes(6));
    expect(steers).toHaveLength(1);
    expect(tasks.get("t1")!.delivery!.ciObservation!.forwarded).toBe(true);
    expect(tasks.get("t1")!.delivery!.ci).toBe("pending");
  });

  it("quietly refreshes finished checks, backs off refusals and stops on close", async () => {
    const { tasks, reads, steers, at, start, answer } = setup();
    seedDelivery(tasks, "t1", { ciWatch: undefined, ci: "green", ciAt: start, prNumber: 7 });
    answer({ kind: "failed", transient: false, problem: "sign in again", signIn: true });
    await at(minutes(4));
    expect(reads).toEqual([]);
    await at(minutes(5));
    await at(minutes(6));
    expect(reads).toEqual([minutes(5)]);
    await at(minutes(10));
    expect(reads).toEqual([minutes(5), minutes(10)]);
    expect(steers).toEqual([]);
    tasks.close("t1", { status: "dropped", reason: "discarded", actor: "captain", text: "gone" });
    await at(minutes(20));
    expect(reads).toHaveLength(2);
  });

  // The merge batch's check-refresh journey (tests/e2e/check-refresh.spec.ts)
  // aged a reading the turn-end read had just recorded, and the quiet refresh
  // waited five more minutes: that pass's own mark outlived the reading.
  it("counts the quiet refresh from a recorded reading's own time, whichever pass read it", async () => {
    const { tasks, reads, at, start, answer } = setup();
    seedDelivery(tasks, "t1", { ciWatch: undefined, ci: "green", ciAt: start, prNumber: 7 });
    // Each read records its time on the task, as `ChangeChecks.readWatched` does.
    answer(() => {
      seedDelivery(tasks, "t1", { ciAt: start + (reads.at(-1) ?? 0) });
      return {
        kind: "finished",
        head: HEAD,
        change: "PR #7",
        checks: [{ name: "linux-checks", state: "success" }],
      };
    });
    tasks.turns.markIdle("t1", { at: start + minutes(1) });
    await at(minutes(1) + 1_000);
    expect(reads).toEqual([minutes(1) + 1_000]);
    const readAt = tasks.get("t1")?.delivery?.ciAt ?? 0;
    expect(readAt).toBe(start + minutes(1) + 1_000);
    seedDelivery(tasks, "t1", { ciAt: readAt - CHECK_REFRESH_MS });
    await at(minutes(1) + 2_000);
    expect(reads).toEqual([minutes(1) + 1_000, minutes(1) + 2_000]);
  });

  it("reads every minute for 10 minutes, then every 2, writing nothing but its clock", async () => {
    const { reads, steers, at, watch } = setup();
    for (let minute = 1; minute <= 30; minute++) await at(minutes(minute));
    expect(reads).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30].map(minutes),
    );
    expect(steers).toEqual([]);
    expect(watch()).toMatchObject({ head: HEAD, tries: 20 });
  });

  it("wakes once when the checks are still running at its bound, naming them, and stops", async () => {
    const { reads, steers, at, watch } = setup();
    for (let minute = 1; minute <= 130; minute++) await at(minutes(minute));
    expect(steers).toHaveLength(1);
    expect(steers[0]?.once).toBe(`check-watch:${HEAD}:1000000:end`);
    expect(renderWake(steers[0] as TypedWake)).toBe(
      "The checks on PR #7 at cafe000 are still running after 2h: linux-checks (pending). The app stopped watching them: read them with check_change, and report a blocker if they never finish.",
    );
    expect(watch()).toBeUndefined();
    const readsAtEnd = reads.length;
    await at(minutes(200));
    expect(reads).toHaveLength(readsAtEnd);
    expect(reads.at(-1)).toBeGreaterThanOrEqual(CHECK_WATCH_BOUND_MS);
  });

  it("reads again after a host hiccup, and ends with one wake on a refusal", async () => {
    const { steers, answer, at, watch } = setup();
    answer({ kind: "failed", transient: true, problem: "could not reach GitHub" });
    await at(minutes(1));
    await at(minutes(2));
    expect(steers).toEqual([]);
    expect(watch()).toMatchObject({ tries: 2 });
    answer({ kind: "failed", transient: false, problem: "GitHub answered 404 to GET /repos/o/r" });
    await at(minutes(4));
    expect(steers.map((wake) => renderWake(wake))).toEqual([
      "The app could not read the checks on your pull request, so it stopped watching them: GitHub answered 404 to GET /repos/o/r. Read them with check_change; if that fails too, report it as a blocker.",
    ]);
    expect(watch()).toBeUndefined();
  });

  it("wakes once when the change is gone", async () => {
    const { steers, answer, at, watch } = setup();
    answer({ kind: "gone" });
    await at(minutes(1));
    await at(minutes(2));
    expect(steers.map((wake) => renderWake(wake))).toEqual([
      "Your pull request is no longer open where the project lives, so the app stopped watching its checks. Read it with check_change and carry on.",
    ]);
    expect(watch()).toBeUndefined();
  });

  it("leaves a watch a newer reading re-armed while its read was out to that reading", async () => {
    const { tasks, steers, answer, at, watch, start } = setup();
    const newer = armWatch(undefined, "beadbeef00000002", start + minutes(1));
    answer(() => {
      // The crewmate pushed and read the new head while the host was asking.
      seedDelivery(tasks, "t1", { ciWatch: newer });
      return {
        kind: "finished",
        head: HEAD,
        change: "PR #7",
        checks: [{ name: "linux-checks", state: "success" }],
      };
    });
    await at(minutes(1));
    expect(steers).toEqual([]);
    expect(watch()).toEqual(newer);
  });

  it("never wakes a task that closed while its read was out", async () => {
    const { tasks, steers, answer, at } = setup();
    answer(() => {
      tasks.close("t1", { status: "dropped", reason: "discarded", actor: "captain", text: "gone" });
      return {
        kind: "finished",
        head: HEAD,
        change: "PR #7",
        checks: [{ name: "linux-checks", state: "success" }],
      };
    });
    await at(minutes(1));
    expect(steers).toEqual([]);
  });

  it("clears a watch whose wake already went out without reading or waking again", async () => {
    const { inbox, reads, steers, at, watch } = setup();
    const standing = watch();
    if (!standing) throw new Error("no watch armed");
    inbox.enqueueSteerOnce("t1", {
      facts: {
        kind: "checks-settled",
        outcome: "finished",
        head: HEAD,
        checks: [{ name: "linux-checks", state: "success" }],
      },
      once: checkWatchOnce(standing),
    });
    await at(minutes(1));
    expect(reads).toEqual([]);
    expect(steers).toEqual([]);
    expect(watch()).toBeUndefined();
  });
});

/**
 * INF-4018: the batch check passed a version the captain had already
 * approved, and the watch's "offer its merge when ready" sent the crewmate
 * to raise a repeat card that ended the click. A version the standing
 * approval covers gets no such wake.
 */
describe("CheckWatcher at a version the captain's approval covers (INF-4018)", () => {
  /** The approval the captain's click keeps, at HEAD of PR #7. */
  function approve(tasks: TaskService) {
    seedDelivery(tasks, "t1", {
      prNumber: 7,
      headSha: HEAD,
      mergeAuthorization: {
        version: 1,
        id: "kept-1",
        generation: 1,
        issuer: "captain",
        at: 1,
        card: { id: "card-t1-merge", offerId: "offer-1", actionId: "merge" },
        target: {
          repoId: "meter",
          host: "github.com",
          owner: "octo",
          name: "meter",
          prNumber: 7,
          branch: "fm/task-t1",
          delivery: "direct-pr",
          method: "squash",
        },
        approvedHead: HEAD,
        lineage: [],
        proceedWithOpen: false,
        status: "standing",
        waiting: { on: "queue", head: HEAD, at: 1 },
      },
    });
  }

  // The reviewer's finding on PR #1673: that wake was the turn whose end ran
  // the kept merge, so the watch runs the approval in its place.
  it("sends no wake when every check passed there, and runs the approval instead", async () => {
    const { tasks, answer, at, steers, kept, watch } = setup();
    approve(tasks);
    answer({
      kind: "finished",
      head: HEAD,
      change: "PR #7",
      checks: [
        { name: "typecheck-lint-build", state: "success" },
        { name: "infinitary/queue", state: "success" },
      ],
    });
    await at(minutes(1));
    expect(steers).toEqual([]);
    expect(kept).toEqual(["t1"]);
    expect(watch()).toBeUndefined();
  });

  it("still wakes on a failure there, with the approval's line and no merge offer", async () => {
    const { tasks, answer, at, steers, kept } = setup();
    approve(tasks);
    answer({
      kind: "finished",
      head: HEAD,
      change: "PR #7",
      checks: [
        { name: "typecheck-lint-build", state: "failure" },
        { name: "infinitary/queue", state: "success" },
      ],
    });
    await at(minutes(1));
    expect(steers).toHaveLength(1);
    const words = renderWake(steers[0]!);
    expect(words).toContain(`The captain's merge approval is kept and covers ${HEAD}`);
    expect(words).toContain("Put up no merge card: the approval waits for these checks.");
    expect(words).toContain("Merge anyway case");
    expect(words).not.toContain("offer its merge when ready");
    expect(kept).toEqual([]);
  });

  // The reviewer's finding on PR #1673 (INF-3208): a failed batch check
  // wakes with the queue's route, which no checks override passes.
  it("wakes on a failed batch check there with the queue's route, never Merge anyway", async () => {
    const { tasks, answer, at, steers, kept } = setup();
    approve(tasks);
    answer({
      kind: "finished",
      head: HEAD,
      change: "PR #7",
      checks: [
        { name: "typecheck-lint-build", state: "success" },
        { name: "infinitary/queue", state: "failure" },
      ],
    });
    await at(minutes(1));
    expect(steers).toHaveLength(1);
    const words = renderWake(steers[0]!);
    expect(words).toContain("no checks override passes the queue");
    expect(words).toContain("check_change's answered verdict");
    expect(words).not.toContain("Merge anyway case");
    expect(kept).toEqual([]);
  });

  it("offers the merge as before at a version the approval does not cover", async () => {
    const { tasks, answer, at, steers } = setup();
    approve(tasks);
    const pushed = "cafe0002feedbeef";
    seedDelivery(tasks, "t1", { headSha: pushed, ciWatch: armWatch(undefined, pushed, 1_000_000) });
    answer({
      kind: "finished",
      head: pushed,
      change: "PR #7",
      checks: [{ name: "typecheck-lint-build", state: "success" }],
    });
    await at(minutes(1));
    expect(steers).toHaveLength(1);
    expect(renderWake(steers[0]!)).toContain("offer its merge when ready");
  });
});

describe("armWatch", () => {
  it("keeps the watch on the head it already reads, and starts over on a new one", () => {
    const first = armWatch(undefined, HEAD, 0);
    expect(first).toEqual({ head: HEAD, since: 0, nextAt: minutes(1), tries: 0 });
    const read = { ...first, tries: 3, nextAt: minutes(8) };
    expect(armWatch(read, HEAD, minutes(7))).toBe(read);
    expect(armWatch(read, "beadbeef", minutes(7))).toEqual({
      head: "beadbeef",
      since: minutes(7),
      nextAt: minutes(8),
      tries: 0,
    });
  });
});
