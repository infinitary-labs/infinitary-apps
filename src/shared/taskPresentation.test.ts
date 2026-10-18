import { describe, expect, it } from "vitest";
import { type TaskStatusInput, taskStatusLabel, taskStatusOf } from "./taskPresentation";

const base: TaskStatusInput = {
  status: "open",
  activity: null,
  closedReason: null,
  startPolicy: "on-request",
  flags: { blocked: false, held: false, needsYou: false, ready: true },
  waitingCardId: null,
  children: { total: 0, closed: 0 },
};
const read = (changes: Partial<TaskStatusInput>) => taskStatusOf({ ...base, ...changes });
describe("one task status", () => {
  it.each([
    [{}, "backlog", "Backlog"],
    [{ startPolicy: "when-ready" }, "queued", "Queued"],
    [{ status: "active", activity: "running" }, "working", "Working"],
    [{ status: "active", activity: "idle" }, "idle", "Idle"],
    [{ status: "active", activity: "interrupted" }, "interrupted", "Interrupted"],
    [{ waitingCardId: "card" }, "waiting", "Waiting on you"],
    [{ status: "done", activity: "running" }, "done", "Done"],
    [{ status: "dropped", closedReason: "failed" }, "dropped", "Dropped"],
  ] as const)("reads %j as %s", (input, mark, word) => {
    expect(read(input)).toMatchObject({ mark, word });
  });
  it("preserves honest reasons without expanding the status vocabulary", () => {
    for (const [state, reason] of [
      ["idle", "checks"],
      ["paused", "access"],
      ["unknown", "unobserved"],
    ] as const) {
      expect(read({ status: "active", workPosture: { state, reason } }).mark).toBe("idle");
      expect(read({ status: "active", workPosture: { state, reason } }).reason).not.toBe("");
    }
    expect(
      taskStatusLabel(read({ status: "active", workPosture: { state: "idle", reason: "checks" } })),
    ).toBe("Idle · Waiting for checks");
  });
  it("puts closure then ready decisions then continuing work ahead of stale interruption", () => {
    expect(read({ status: "done", waitingCardId: "old", activity: "interrupted" }).mark).toBe(
      "done",
    );
    expect(read({ status: "active", captainWait: true, activity: "running" }).mark).toBe("working");
    expect(read({ status: "active", waitingCardId: "ready", activity: "running" }).mark).toBe(
      "waiting",
    );
    expect(
      read({
        status: "active",
        activity: "interrupted",
        workPosture: { state: "active", reason: "job" },
      }),
    ).toEqual({ mark: "working", word: "Working", reason: "Background work continues" });
    expect(
      read({
        status: "active",
        activity: "interrupted",
        workPosture: { state: "unknown", reason: "unobserved" },
      }).mark,
    ).toBe("interrupted");
  });
  it("a declared wait is not a decision and cannot hide continuing checks", () => {
    expect(
      read({
        status: "active",
        captainWait: true,
        workPosture: { state: "active", reason: "checks" },
      }),
    ).toEqual({ mark: "working", word: "Working", reason: "Waiting for checks" });
    expect(
      read({
        status: "active",
        captainWait: true,
        activity: "idle",
        workPosture: { state: "idle", reason: "captain" },
      }),
    ).toEqual({ mark: "idle", word: "Idle", reason: "Work is paused" });
  });
  it("reads open work by its start policy, with a blocker or hold as the reason", () => {
    expect(
      read({ startPolicy: "when-ready", flags: { ...base.flags, blocked: true } }),
    ).toMatchObject({ mark: "queued", word: "Queued", reason: "Blocked by another task" });
    expect(read({ startPolicy: "when-ready", flags: { ...base.flags, held: true } })).toMatchObject(
      { mark: "queued", word: "Queued", reason: "Held" },
    );
    expect(read({ flags: { ...base.flags, blocked: true } })).toMatchObject({
      mark: "backlog",
      word: "Backlog",
      reason: "Blocked by another task",
    });
    expect(read({})).toMatchObject({ reason: "Starts when you press Start" });
    expect(read({ startPolicy: "when-ready" })).toMatchObject({
      reason: "Starts by itself when ready",
    });
  });
  it("says a parent's parts do the work, after a blocker or hold", () => {
    expect(taskStatusLabel(read({ children: { total: 3, closed: 1 } }))).toBe(
      "Backlog · Its 3 parts do the work",
    );
    expect(
      taskStatusLabel(read({ startPolicy: "when-ready", children: { total: 1, closed: 0 } })),
    ).toBe("Queued · Its 1 part does the work");
    expect(
      read({ children: { total: 2, closed: 0 }, flags: { ...base.flags, held: true } }).reason,
    ).toBe("Held");
    // Started work reads by its activity, parts or not.
    expect(
      read({ status: "active", activity: "running", children: { total: 2, closed: 0 } }).reason,
    ).toBe("");
  });

  it("says a task on a computer whose connection is being made is connecting, with no warn mark", () => {
    const place = { name: "Mac mini", where: "on Mac mini" };
    const away = read({
      status: "active",
      activity: "running",
      place: { ...place, reach: "out-of-reach" },
    });
    expect(away).toMatchObject({
      mark: "working",
      reason: "Mac mini is out of reach",
      outOfReach: true,
    });
    const connecting = read({
      status: "active",
      activity: "running",
      place: { ...place, reach: "connecting" },
    });
    expect(connecting).toMatchObject({ mark: "working", reason: "Mac mini is connecting" });
    expect(connecting.outOfReach).toBeUndefined();
    // As sent on the wire: `outOfReach` beside `connecting`, for a paired view on protocol 8.5.
    const sent = read({
      status: "active",
      activity: "running",
      place: { ...place, reach: "connecting" },
    });
    expect(sent).toMatchObject({ mark: "working", reason: "Mac mini is connecting" });
    expect(sent.outOfReach).toBeUndefined();
    expect(read({ place: { ...place, reach: "connecting" } }).reason).toBe(
      "Mac mini is connecting",
    );
  });
});
