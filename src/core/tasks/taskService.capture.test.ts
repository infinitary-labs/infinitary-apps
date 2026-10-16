import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * The capture side of the one writer (task-system P1, design sections 4.5
 * and 6): asks and their attachments, the three filed kinds, and the card
 * and answer records that ride a task's timeline.
 */

function setup() {
  const db = openInMemoryDatabase();
  let now = 1_000;
  const tasks = new TaskService({ db, strict: true, now: () => now });
  return { db, tasks, tick: () => (now += 1) };
}

describe("TaskService capture", () => {
  it("opens an ask, attaches it once per task with an ask event, and closes it", () => {
    const { tasks, tick } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "running" });
    const ask = tasks.openAsk({
      id: "ask1",
      text: "how is it going?",
      images: [{ mimeType: "image/png" }],
      hintTaskId: "t1",
    });
    expect(ask.turnState).toBe("open");
    expect(tasks.listOpenAsks().map((row) => row.id)).toEqual(["ask1"]);
    tick();
    expect(tasks.attachAsk("ask1", "t1", "tool:emit_card")).toBe(true);
    expect(tasks.attachAsk("ask1", "t1", "tool:steer_crewmate")).toBe(false);
    const stored = tasks.getAsk("ask1");
    expect(stored?.taskId).toBe("t1");
    expect(stored?.attachedVia).toBe("tool:emit_card");
    expect(stored?.attachedAt).toBe(1_001);
    expect(stored?.images).toEqual([{ mimeType: "image/png" }]);
    const events = tasks.timeline("t1").filter((event) => event.kind === "ask");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("captain");
    expect(events[0]?.data).toMatchObject({ askId: "ask1", via: "tool:emit_card", first: true });
    expect(events[0]?.feed).toBe(false);
    expect(tasks.asksFor("t1").map((row) => row.id)).toEqual(["ask1"]);
    expect(tasks.closeAsk("ask1", "closed")?.turnState).toBe("closed");
    expect(tasks.listOpenAsks()).toEqual([]);
    expect(() => tasks.attachAsk("missing", "t1", "host:fallback")).toThrow(/Unknown ask/);
    expect(() => tasks.attachAsk("ask1", "missing", "host:fallback")).toThrow(/Unknown task/);
  });

  it("keeps a message's picture copies on its ask, and a task's pictures are those of every message attached to it", () => {
    const { db, tasks } = setup();
    seedTask(tasks, { id: "t1", title: "Fix the dialog", status: "queued" });
    seedTask(tasks, { id: "t2", title: "Fix the footer", status: "queued" });
    const ref = (n: number) => ({
      id: `ref-${n}`,
      kind: "image" as const,
      name: `shot-${n}.png`,
      mimeType: "image/png" as const,
      bytes: 10 + n,
      sha256: String(n).repeat(64),
      file: `message-${n}/1-abc.png`,
    });
    tasks.openAsk({
      id: "ask1",
      text: "this dialog and this footer",
      images: [{ mimeType: "image/png" }, { mimeType: "image/png" }],
      attachments: [ref(1), ref(2)],
    });
    tasks.openAsk({ id: "ask2", text: "and this", attachments: [ref(3)] });
    tasks.openAsk({ id: "ask3", text: "no picture here" });
    // The copies survive the row: read back as they were written.
    expect(tasks.getAsk("ask1")?.attachments).toEqual([ref(1), ref(2)]);
    expect(tasks.getAsk("ask1")?.images).toEqual([
      { mimeType: "image/png" },
      { mimeType: "image/png" },
    ]);
    // One message about two tasks lands its pictures on both; a later one adds its own.
    tasks.attachAsk("ask1", "t1", "tool:create_task");
    tasks.attachAsk("ask1", "t2", "tool:create_task");
    tasks.attachAsk("ask2", "t1", "tool:update_task");
    tasks.attachAsk("ask3", "t1", "tool:update_task");
    expect(tasks.pictures("t1")).toEqual([ref(1), ref(2), ref(3)]);
    expect(tasks.pictures("t2")).toEqual([ref(1), ref(2)]);
    // A row an older build saved holds the shapes alone: it has no copies.
    db.prepare(
      "INSERT INTO captain_asks (id, at, text, images_json, turn_state) VALUES ('old', 1, 'before', ?, 'closed')",
    ).run(JSON.stringify([{ mimeType: "image/jpeg" }]));
    expect(tasks.getAsk("old")).toMatchObject({
      images: [{ mimeType: "image/jpeg" }],
      attachments: [],
    });
  });

  it("files a question task born closed, with its card and answer on record", () => {
    const { tasks } = setup();
    const question = tasks.fileQuestion({
      id: "q1",
      title: "The port flag",
      outcome: "<p>It picks the port.</p>",
      cardId: "card-fm-1",
    });
    expect(question).toMatchObject({
      kind: "question",
      status: "done",
      closedReason: "answered",
      projectId: "scratch",
      outcome: "<p>It picks the port.</p>",
      // The first sentence, as the feed summarizes a report (HTML and all).
      outcomeSummary: "<p>It picks the port.</p>",
      workspaceState: "none",
    });
    expect(question.key).toBe("SCR-1");
    expect(question.closedAt).toBe(1_000);
    expect(tasks.timeline("q1").map((event) => event.kind)).toEqual([
      "created",
      "card_raised",
      "status",
    ]);
    expect(tasks.taskForCard("card-fm-1")?.id).toBe("q1");
    expect(tasks.taskForCard("card-fm-none")).toBeUndefined();
    // A host fallback carries its provenance and may have no answer text.
    const fallback = tasks.fileQuestion({
      id: "q2",
      title: "hello",
      outcome: null,
      actor: "host",
      fallback: "question",
    });
    expect(fallback.outcome).toBeNull();
    const status = tasks.timeline("q2").find((event) => event.kind === "status");
    expect(status?.text).toBe("noted (nothing attached this turn)");
    expect(status?.data).toMatchObject({ fallback: "question" });
    expect(status?.actor).toBe("host");
  });

  it("files an operation task done/settled with the tool result as its outcome", () => {
    const { db, tasks } = setup();
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES ('r1', '/fleet/api', 'api', 1, 'adopt', NULL, 'local-only', 0)",
    ).run();
    tasks.projects.ensureForRepo({ id: "r1", name: "api" });
    const operation = tasks.fileOperation({
      id: "o1",
      title: "Configured repository api",
      outcome: "api now ships direct-pr with autonomy on.",
      tool: "configure_repo",
      repoId: "r1",
    });
    expect(operation).toMatchObject({
      kind: "operation",
      status: "done",
      closedReason: "settled",
      repoId: "r1",
      outcome: "api now ships direct-pr with autonomy on.",
    });
    expect(operation.projectId).toBe(tasks.projects.forRepo("r1")?.id);
    expect(operation.key).toMatch(/^API-1$/);
    const status = tasks.timeline("o1").find((event) => event.kind === "status");
    expect(status?.text).toBe("settled by configure_repo");
    // No repo: Scratch.
    expect(
      tasks.fileOperation({ id: "o2", title: "Noted x", outcome: "Noted.", tool: "remember" })
        .projectId,
    ).toBe("scratch");
  });

  it("files a decision task open on a captain gate keyed by its card, found by that card", () => {
    const { tasks } = setup();
    const decision = tasks.fileDecision({
      id: "d1",
      title: "Ship now or wait",
      cardId: "card-fm-9",
    });
    expect(decision).toMatchObject({
      kind: "decision",
      status: "open",
      gate: { kind: "captain", ref: "card-fm-9" },
      projectId: "scratch",
    });
    expect(tasks.openDecisionFor("card-fm-9")?.id).toBe("d1");
    expect(tasks.openDecisionFor("card-fm-other")).toBeUndefined();
    const raised = tasks.timeline("d1").find((event) => event.kind === "card_raised");
    expect(raised?.ref).toBe("card-fm-9");
    expect(raised?.data).toMatchObject({ cardId: "card-fm-9", kind: "decision" });
    tasks.close("d1", { status: "done", reason: "answered", actor: "captain", text: 'chose "A"' });
    expect(tasks.openDecisionFor("card-fm-9")).toBeUndefined();
  });

  it("records answers and card raise/resolve on an existing task's timeline", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "t1", title: "Add pagination", status: "idle" });
    tasks.recordAnswer("t1", { cardId: "card-fm-2", title: "Under way", body: "<p>Step 2.</p>" });
    tasks.recordCardRaised("t1", { cardId: "card-fm-3", kind: "decision", title: "Settle it?" });
    tasks.recordCardResolved("t1", { cardId: "card-fm-3", title: "Settle it?", action: "keep" });
    const kinds = tasks.timeline("t1").map((event) => `${event.kind}:${event.ref ?? ""}`);
    expect(kinds).toEqual([
      "created:",
      "dispatched:",
      "answered:card-fm-2",
      "card_raised:card-fm-3",
      "card_resolved:card-fm-3",
    ]);
    const answered = tasks.timeline("t1").find((event) => event.kind === "answered");
    expect(answered?.data).toEqual({ cardId: "card-fm-2", body: "<p>Step 2.</p>" });
    expect(tasks.get("t1")?.outcome).toBeNull();
    // A revised standalone answer also becomes the record's outcome.
    tasks.recordAnswer("t1", {
      cardId: "card-fm-2",
      title: "Under way",
      body: "<p>Step 3.</p>",
      asOutcome: true,
    });
    expect(tasks.get("t1")?.outcome).toBe("<p>Step 3.</p>");
    // Records on a task that is gone are dropped, never thrown.
    expect(() =>
      tasks.recordCardResolved("nope", { cardId: "c", title: "t", action: "a" }),
    ).not.toThrow();
  });

  it("the purge clears asks with everything else", () => {
    const { tasks } = setup();
    tasks.openAsk({ id: "ask1", text: "hi" });
    tasks.fileQuestion({ id: "q1", title: "hi", outcome: "hello" });
    tasks.attachAsk("ask1", "q1", "host:fallback");
    expect(tasks.purge()).toBe(1);
    expect(tasks.listAsks()).toEqual([]);
    expect(tasks.list()).toEqual([]);
  });
});
