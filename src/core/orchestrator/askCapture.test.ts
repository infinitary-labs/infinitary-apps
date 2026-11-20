import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AskCapture } from "./askCapture";

/**
 * The capture guarantee (task-system P1, design section 6): every captain
 * ask lands in a task - by the agent's own tool call when it found the
 * task, by the host at turn end when it did not. These tests drive the
 * policy over the real TaskService and SQLite.
 */

function setup() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: () => 1_000 });
  const capture = new AskCapture(tasks);
  return { db, tasks, capture };
}

describe("AskCapture", () => {
  it("keeps open an ask the turn never read, so the turn that serves it attaches and closes it", () => {
    const { tasks, capture } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "running" });
    const read = capture.open({ text: "how is pagination going?" });
    const parked = capture.open({ text: "and tell the crew to use cursors" });
    capture.beginTurn();
    capture.endTurn({ asks: [read.id], failed: false, closingText: "ok" });
    expect(tasks.capture.getAsk(read.id)?.turnState).toBe("closed");
    expect(tasks.capture.getAsk(parked.id)).toMatchObject({ turnState: "open", taskId: null });

    // The next turn adopts it, attaches it through a tool and closes it.
    capture.beginTurn();
    expect(capture.attach("t1", "steer_crewmate")).toBe(true);
    capture.endTurn({ asks: [parked.id], failed: false });
    expect(tasks.capture.getAsk(parked.id)).toMatchObject({
      turnState: "closed",
      taskId: "t1",
      attachedVia: "tool:steer_crewmate",
    });
  });

  it("opens the ask before the turn and attaches it through a tool", () => {
    const { tasks, capture } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "running" });
    const ask = capture.open({ text: "how is pagination going?" });
    expect(tasks.capture.getAsk(ask.id)?.turnState).toBe("open");
    expect(tasks.capture.getAsk(ask.id)?.taskId).toBeNull();

    capture.beginTurn();
    expect(capture.attach("t1", "emit_card")).toBe(true);
    const attached = tasks.capture.getAsk(ask.id);
    expect(attached?.taskId).toBe("t1");
    expect(attached?.attachedVia).toBe("tool:emit_card");
    const askEvents = tasks.timeline("t1").filter((event) => event.kind === "ask");
    expect(askEvents).toHaveLength(1);
    expect(askEvents[0]?.text).toBe("how is pagination going?");
    expect(askEvents[0]?.ref).toBe(ask.id);

    // The same ask on the same task twice is one event; a second task gets
    // its own event while the ask's first attachment stands.
    expect(capture.attach("t1", "steer_crewmate")).toBe(false);
    seedTask(tasks, { id: "t2", title: "Other work", status: "idle" });
    expect(capture.attach("t2", "steer_crewmate")).toBe(true);
    expect(tasks.capture.getAsk(ask.id)?.taskId).toBe("t1");
    expect(tasks.timeline("t2").some((event) => event.kind === "ask")).toBe(true);

    expect(capture.endTurn({ asks: [ask.id], failed: false, closingText: "done" })).toEqual([]);
    expect(tasks.capture.getAsk(ask.id)?.turnState).toBe("closed");
    expect(tasks.capture.listOpenAsks()).toEqual([]);
    // No question task was filed: the ask was about existing work (D1).
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("falls back to the hinted task when the agent attached nothing", () => {
    const { tasks, capture } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "idle" });
    const ask = capture.open({ text: "and then?", hintTaskId: "t1" });
    capture.beginTurn();
    const fallbacks = capture.endTurn({
      asks: [ask.id],
      failed: false,
      closingText: "Carrying on.",
    });
    expect(fallbacks).toEqual([{ askId: ask.id, via: "hint", taskId: "t1" }]);
    const closed = tasks.capture.getAsk(ask.id);
    expect(closed?.taskId).toBe("t1");
    expect(closed?.attachedVia).toBe("host:fallback");
    expect(closed?.hintTaskId).toBe("t1");
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("files a standalone question task when nothing attached and nothing was hinted", () => {
    const { tasks, capture } = setup();
    const ask = capture.open({ text: "What is the weather like on deck? Just curious." });
    capture.beginTurn();
    const [fallback] = capture.endTurn({
      asks: [ask.id],
      failed: false,
      closingText: "All quiet on deck.",
    });
    expect(fallback?.via).toBe("question");
    const question = tasks.get(fallback?.taskId ?? "");
    expect(question?.kind).toBe("question");
    expect(question?.title).toBe("What is the weather like on deck?");
    expect(question?.status).toBe("done");
    expect(question?.closedReason).toBe("answered");
    expect(question?.outcome).toBe("All quiet on deck.");
    expect(question?.projectId).toBe("scratch");
    expect(question?.key).toMatch(/^SCR-\d+$/);
    expect(tasks.capture.getAsk(ask.id)?.taskId).toBe(question?.id);
    expect(tasks.capture.getAsk(ask.id)?.attachedVia).toBe("host:fallback");
    const kinds = tasks.timeline(question?.id ?? "").map((event) => event.kind);
    expect(kinds).toEqual(["created", "status", "ask"]);
  });

  it("an unknown hint is dropped at open, so the fallback files a question", () => {
    const { tasks, capture } = setup();
    const ask = capture.open({ text: "hello", hintTaskId: "gone" });
    expect(tasks.capture.getAsk(ask.id)?.hintTaskId).toBeNull();
    capture.beginTurn();
    const [fallback] = capture.endTurn({ asks: [ask.id], failed: false });
    expect(fallback?.via).toBe("question");
    expect(tasks.get(fallback?.taskId ?? "")?.outcome).toBeNull();
  });

  it("a failed turn marks the ask failed and still files it", () => {
    const { tasks, capture } = setup();
    const ask = capture.open({ text: "ship it" });
    capture.beginTurn();
    const [fallback] = capture.endTurn({ asks: [ask.id], failed: true, error: "provider 500" });
    expect(tasks.capture.getAsk(ask.id)?.turnState).toBe("failed");
    expect(tasks.capture.getAsk(ask.id)?.taskId).toBe(fallback?.taskId);
    expect(tasks.get(fallback?.taskId ?? "")?.outcome).toBe("hit a problem: provider 500");
  });

  it("a steer mid-turn becomes the current ask; both close with the turn", () => {
    const { tasks, capture } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "running" });
    seedTask(tasks, { id: "t2", title: "Fix the flaky test", status: "running" });
    const first = capture.open({ text: "how is pagination?" });
    capture.beginTurn();
    capture.attach("t1", "emit_card");
    const second = capture.open({ text: "actually, stop the flaky-test work" });
    expect(capture.current()?.id).toBe(second.id);
    capture.attach("t2", "interrupt_crewmate");
    expect(capture.endTurn({ asks: [first.id, second.id], failed: false })).toEqual([]);
    expect(tasks.capture.getAsk(first.id)?.taskId).toBe("t1");
    expect(tasks.capture.getAsk(second.id)?.taskId).toBe("t2");
    expect(tasks.capture.listOpenAsks()).toEqual([]);
  });

  it("attaches nothing on an operational wake, and reconciles asks a dead process left open", () => {
    const { db, tasks, capture } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "running" });
    // A wake with no captain words: nothing to attach.
    capture.beginTurn();
    expect(capture.current()).toBeUndefined();
    expect(capture.attach("t1", "steer_crewmate")).toBe(false);
    expect(capture.endTurn({ asks: [], failed: false })).toEqual([]);

    // The captain asked, the app quit before the turn ended.
    const stranded = capture.open({ text: "what happened overnight?" });
    const rebooted = new AskCapture(new TaskService({ db, strict: true, now: () => 2_000 }));
    const [filed] = rebooted.reconcileStranded([]);
    expect(filed?.via).toBe("question");
    expect(tasks.capture.getAsk(stranded.id)?.turnState).toBe("failed");
    expect(tasks.capture.getAsk(stranded.id)?.taskId).toBe(filed?.taskId);
    expect(rebooted.reconcileStranded([])).toEqual([]);
  });

  it("files a message a quit cut mid-turn as closed by the app, not an unknown error (FI3-1691)", () => {
    const { db, tasks, capture } = setup();
    const stranded = capture.open({ text: "how is the crew doing?" });
    capture.beginTurn();
    capture.select(stranded.id);
    const rebooted = new AskCapture(new TaskService({ db, strict: true, now: () => 2_000 }));
    const [filed] = rebooted.reconcileStranded([]);
    expect(tasks.get(filed?.taskId ?? "")?.outcome).toBe(
      "hit a problem: the app closed before this turn ended",
    );
  });
});
