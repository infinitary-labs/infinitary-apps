import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * The start and answer-delivery releases the crew supervisor and the answer
 * delivery check call, pinned before the task service splits into its
 * owners (INF-2625's plan, the task service row: "tests for three start and
 * delivery releases that no test calls"). Each case names the rule the
 * method's own documentation states.
 */
function setup() {
  const db = freshDatabase();
  let now = 1_000;
  const tasks = new TaskService({ db, now: () => now, strict: true });
  return { tasks, tick: (ms = 1) => (now += ms) };
}

describe("a start whose contact was lost", () => {
  it("moves a preparing attempt to checking and keeps when it began", () => {
    const { tasks, tick } = setup();
    seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
    expect(tasks.starts.beginStartAttempt("build")).toBe(true);
    tick(500);

    tasks.starts.markStartChecking("build");

    expect(tasks.starts.startAttemptOf("build")).toEqual({ phase: "checking", since: 1_000 });
    expect(tasks.starts.startAttemptIds()).toEqual(["build"]);
  });

  it("starts the checking clock now when no attempt was published", () => {
    const { tasks, tick } = setup();
    seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
    tick(250);

    tasks.starts.markStartChecking("build");

    expect(tasks.starts.startAttemptOf("build")).toEqual({ phase: "checking", since: 1_250 });
  });

  it("tells the board the task changed", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
    const changed: string[][] = [];
    tasks.onChange((change) => changed.push(change.taskIds));

    tasks.starts.markStartChecking("build");

    expect(changed).toEqual([["build"]]);
  });
});

describe("a start that came back unconfirmed", () => {
  it("returns claimed work to the queue with no failure notice", () => {
    const { tasks, tick } = setup();
    seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
    tasks.starts.beginStartAttempt("build");
    expect(tasks.starts.claimForDispatch("build")).toBe(true);
    tasks.starts.markStartChecking("build");
    tick(40);

    tasks.starts.releaseUnconfirmedStart("build");

    const record = tasks.get("build");
    expect(record).toMatchObject({
      status: "open",
      activity: null,
      assignee: null,
      model: null,
      startedAt: null,
      updatedAt: 1_040,
    });
    // An unknown outcome is not a confirmed failure.
    expect(record?.startNotice ?? null).toBeNull();
    expect(tasks.starts.startAttemptOf("build")).toBeUndefined();
    const last = tasks.timeline("build").at(-1);
    // This case owns the line's words (taskStarts.ts, UNCONFIRMED_START_RETURNED); other tests import it.
    expect(last).toMatchObject({
      actor: "host",
      kind: "status",
      text: "returned to the queue - the start was not confirmed",
      at: 1_040,
    });
  });

  it("keeps a start that recorded a working copy and only forgets the attempt", () => {
    const { tasks } = setup();
    seedTask(tasks, {
      id: "build",
      title: "Build the export",
      status: "running",
      worktreeDir: "/work/build",
    });
    tasks.starts.markStartChecking("build");
    const events = tasks.timeline("build").length;

    tasks.starts.releaseUnconfirmedStart("build");

    expect(tasks.get("build")).toMatchObject({ status: "active", worktreeDir: "/work/build" });
    expect(tasks.starts.startAttemptOf("build")).toBeUndefined();
    expect(tasks.timeline("build")).toHaveLength(events);
  });

  it("keeps a start that recorded its crewmate's conversation", () => {
    const { tasks } = setup();
    seedTask(tasks, {
      id: "build",
      title: "Build the export",
      status: "running",
      sessionFile: "/sessions/build.jsonl",
    });

    tasks.starts.releaseUnconfirmedStart("build");

    expect(tasks.get("build")).toMatchObject({
      status: "active",
      sessionFile: "/sessions/build.jsonl",
    });
  });

  it("leaves a closed task closed", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
    tasks.close("build", { status: "dropped", reason: "cancelled", actor: "captain" });
    const closed = tasks.get("build");
    const events = tasks.timeline("build").length;

    tasks.starts.releaseUnconfirmedStart("build");

    expect(tasks.get("build")).toEqual(closed);
    expect(tasks.timeline("build")).toHaveLength(events);
  });

  it("forgets the attempt of open work that was never claimed", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "build", title: "Build the export", status: "queued" });
    tasks.starts.beginStartAttempt("build");
    const open = tasks.get("build");

    tasks.starts.releaseUnconfirmedStart("build");

    expect(tasks.starts.startAttemptOf("build")).toBeUndefined();
    expect(tasks.get("build")?.status).toBe(open?.status);
  });
});

describe("a message the turn never read", () => {
  const entry = { outcome: "action", kind: "card", tool: "emit_card", at: 900 } as const;

  it("waits for the next turn with no facts of this one", () => {
    const { tasks } = setup();
    tasks.capture.openAsk({ id: "m1", text: "Is the export done?" });
    tasks.capture.noteDelivery(["m1"], entry);
    expect(tasks.capture.getAsk("m1")?.deliveryFacts.entries).toHaveLength(1);

    tasks.capture.releaseAskDelivery("m1");

    expect(tasks.capture.getAsk("m1")).toMatchObject({
      delivery: "pending",
      deliveryFacts: { entries: [] },
    });
  });

  it("returns a held message to pending", () => {
    const { tasks } = setup();
    tasks.capture.openAsk({ id: "m1", text: "Is the export done?" });
    tasks.capture.setAskDelivery("m1", "held", { entries: [entry] });

    tasks.capture.releaseAskDelivery("m1");

    expect(tasks.capture.getAsk("m1")).toMatchObject({
      delivery: "pending",
      deliveryFacts: { entries: [] },
    });
  });

  it("keeps a retry a retry, linked to the message it asks again", () => {
    const { tasks } = setup();
    tasks.capture.openAsk({ id: "m1", text: "Is the export done?" });
    tasks.capture.openAsk({ id: "m2", text: "Is the export done?", retryOf: "m1" });
    tasks.capture.setAskDelivery("m2", "retrying", { entries: [entry], retryOf: "m1" });

    tasks.capture.releaseAskDelivery("m2");

    expect(tasks.capture.getAsk("m2")).toMatchObject({
      delivery: "retrying",
      deliveryFacts: { entries: [], retryOf: "m1" },
    });
  });

  it.each(["covered", "unresolved", "legacy"] as const)(
    "leaves a %s message as it is",
    (delivery) => {
      const { tasks } = setup();
      tasks.capture.openAsk({ id: "m1", text: "Is the export done?" });
      tasks.capture.setAskDelivery("m1", delivery, { entries: [entry] });

      tasks.capture.releaseAskDelivery("m1");

      expect(tasks.capture.getAsk("m1")).toMatchObject({
        delivery,
        deliveryFacts: { entries: [entry] },
      });
    },
  );

  it("ignores a message it does not know", () => {
    const { tasks } = setup();
    expect(() => tasks.capture.releaseAskDelivery("missing")).not.toThrow();
    expect(tasks.capture.getAsk("missing")).toBeUndefined();
  });
});
