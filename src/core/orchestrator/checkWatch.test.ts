import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import {
  armWatch,
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
 * is `crewSupervisor.test.ts` ("the host's check watch").
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
  tasks.recordDelivery("t1", { ciWatch: armWatch(undefined, HEAD, start) });
  /** What the next read answers; a function reads the moment it is asked. */
  let next: WatchedReading | (() => WatchedReading) = {
    kind: "pending",
    head: HEAD,
    change: "PR #7",
    pending: [{ name: "linux-checks", state: "pending" }],
  };
  const reads: number[] = [];
  const steers: TypedWake[] = [];
  const watcher = new CheckWatcher({
    tasks,
    inbox,
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
  it("quietly refreshes finished checks, backs off refusals and stops on close", async () => {
    const { tasks, reads, steers, at, start, answer } = setup();
    tasks.recordDelivery("t1", { ciWatch: undefined, ci: "green", ciAt: start, prNumber: 7 });
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
      tasks.recordDelivery("t1", { ciWatch: newer });
      return {
        kind: "settled",
        overall: "green",
        head: HEAD,
        change: "PR #7",
        count: 1,
        failing: [],
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
        kind: "settled",
        overall: "green",
        head: HEAD,
        change: "PR #7",
        count: 1,
        failing: [],
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
      facts: { kind: "checks-settled", outcome: "passed", head: HEAD, count: 1 },
      once: checkWatchOnce(standing),
    });
    await at(minutes(1));
    expect(reads).toEqual([]);
    expect(steers).toEqual([]);
    expect(watch()).toBeUndefined();
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
