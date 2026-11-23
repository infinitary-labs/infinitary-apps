/**
 * The host's Start and task board buttons as `HostOps` runs them
 * (docs/task-board.md): a Start that goes through the first mate first, the
 * task board's queue, the record's Drop task and Continue run, and every
 * task card click written to the history as the captain's.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { closeDoneClosedRefusal, closeDoneNotStartedRefusal } from "@shared/recordCloseDone";
import { queueStartedBacklogRefusal } from "@shared/taskQueue";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { TaskService } from "../tasks/taskService";
import { CLOSE_AS_DONE_PRESS } from "./doneClose";
import { IDLE_NUDGE_TEXT } from "./idleWakes";

fakeCrewTimersEachTest();

describe("the task graph (R1)", () => {
  describe("a Start goes through the Firstmate first", () => {
    const hooked = (cannot?: string) => {
      const ctx = setup(fakeCrewmate());
      ctx.supervisor.setFirstmateHooks({
        notifyOp: (wake, origin, ref) =>
          ctx.inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref),
        firstmateCannotAnswer: () => cannot,
        retryConverse: vi.fn(),
      });
      const task = ctx.supervisor.intake.plan({
        title: "Fix the test",
        intent: intentOf("fix it"),
      });
      const notes = () => ctx.tasks.timeline(task.id).map((event) => event.text);
      return { ...ctx, task, notes };
    };

    it("holds Starting and sends one wake, then lets the Firstmate's start_now finish it", async () => {
      const { supervisor, tasks, inbox, task } = hooked();
      expect(supervisor.hostOps.runTaskOp(task.id, "start-task")).toBeUndefined();
      await tick();
      expect(tasks.starts.startAttemptOf(task.id)?.phase).toBe("preparing");
      expect(tasks.get(task.id)?.status).toBe("open");
      const rows = inbox.allFor(FIRSTMATE_RECIPIENT);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.facts).toMatchObject({ kind: "captain-start", move: "start" });
      await supervisor.watch.sweepGates(Date.now());
      expect(tasks.get(task.id)?.status).toBe("open");
      expect(supervisor.hostOps.runTaskOp(task.id, "start-task")).toContain("already starting");
      expect(await supervisor.starts.startQueuedNow(task.id)).toContain("is starting.");
      await tick();
      // Started, it stays on request as a started backlog task always did,
      // though its start queued it while it ran (INF-3060).
      expect(tasks.get(task.id)).toMatchObject({ status: "active", startPolicy: "on-request" });
      expect(tasks.starts.startAttemptOf(task.id)).toBeUndefined();
      expect(tasks.taskCardClicksSince(0).map(({ op }) => op)).toEqual(["start-task"]);
    });

    it("starts at once, and says why, when the Firstmate's seat cannot answer", async () => {
      const { supervisor, tasks, task, notes, inbox } = hooked("your first mate is paused");
      expect(supervisor.hostOps.runTaskOp(task.id, "start-task")).toBeUndefined();
      await tick();
      expect(tasks.get(task.id)?.status).toBe("active");
      expect(notes()).toContain(
        "started without applying your standing directions: your first mate is paused",
      );
      expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(0);
    });

    it("starts as it is when the turn that read the Start failed, and when its wake is gone", async () => {
      const { supervisor, tasks, inbox, task, notes } = hooked();
      supervisor.hostOps.runTaskOp(task.id, "start-task");
      const [row] = inbox.allFor(FIRSTMATE_RECIPIENT);
      expect(supervisor.hostOps.firstmateTurnEnded([row?.id ?? 0], "failed")).toEqual([row?.id]);
      await tick();
      expect(tasks.get(task.id)?.status).toBe("active");
      expect(notes()).toContain(
        "started without applying your standing directions: your first mate's turn failed",
      );

      const lost = supervisor.intake.plan({
        title: "Fix another test",
        intent: intentOf("fix it"),
      });
      supervisor.hostOps.runTaskOp(lost.id, "start-task");
      const pending = inbox.allFor(FIRSTMATE_RECIPIENT).find((entry) => entry.ref === lost.id);
      inbox.ack([pending?.id ?? 0]);
      supervisor.reconcileCutOffs();
      await tick();
      expect(tasks.get(lost.id)?.status).toBe("active");
    });

    // Intent: INF-3060's review (a quit is not a failed start). The first
    // mate's start_now on a backlog task, and the captain's Start it
    // finishes, return before the start; a quit during that start leaves the
    // task for the next launch, which starts it, and tells nobody it failed.
    // The quit stops the start either where it next reads, or by failing
    // what it waited on, as a computer that is stopping does.
    it.each([
      ["the first mate's start_now", "where it next reads", false, false],
      ["the first mate's start_now", "by failing its wait", false, true],
      ["the captain's Start the first mate finishes", "where it next reads", true, false],
      ["the captain's Start the first mate finishes", "by failing its wait", true, true],
    ])(
      "leaves %s on a backlog task that a quit stopped %s for the next launch",
      async (_name, _how, captain, fails) => {
        let reached!: () => void;
        const classifying = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ctx = setup(fakeCrewmate(), {
          classifier: {
            classify: async () => {
              reached();
              await held;
              if (fails) throw new Error("This computer is stopping.");
              return { kind: "fix", source: "classifier:test", version: "kc1" };
            },
          },
        });
        const wakes = () =>
          ctx.inbox
            .allFor(FIRSTMATE_RECIPIENT)
            .map((row) => (row.facts as { kind?: string })?.kind);
        ctx.supervisor.setFirstmateHooks({
          notifyOp: (wake, origin, ref) =>
            ctx.inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref),
          firstmateCannotAnswer: () => undefined,
          retryConverse: vi.fn(),
        });
        const task = ctx.supervisor.intake.plan({
          title: "Fix the test",
          intent: intentOf("fix it"),
        });
        expect(task.startPolicy).toBe("on-request");
        if (captain) {
          expect(ctx.supervisor.hostOps.runTaskOp(task.id, "start-task")).toBeUndefined();
          expect(wakes()).toEqual(["captain-start"]);
        }
        expect(await ctx.supervisor.starts.startQueuedNow(task.id)).toContain("is starting.");
        // The first mate's turn that read the Start ended: its wake is spent.
        ctx.inbox.ack(ctx.inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id));
        await classifying;
        const stopping = ctx.supervisor.disposeAll();
        release();
        await stopping;
        expect(ctx.tasks.get(task.id)).toMatchObject({ status: "open", startNotice: null });
        expect(wakes()).toEqual([]);

        const tasks = new TaskService({ db: ctx.db, strict: true });
        const restarted = reboot(ctx, async () => fakeCrewmate(), { tasks });
        try {
          await restarted.watch.sweepGates(Date.now());
          await tick();
          expect(tasks.get(task.id)?.status).toBe("active");
        } finally {
          await restarted.disposeAll();
        }
      },
    );

    // Intent: docs/task-board.md, "A confirmed failure returns it to Backlog
    // with Could not start" - also for the captain's Start on a backlog task,
    // which its start queues while it runs (INF-3060's review).
    it("returns the captain's Start on a backlog task that failed once its crewmate was set up to Backlog with Could not start", async () => {
      const { supervisor, tasks, task, sessions, workspace } = hooked();
      vi.mocked(sessions.open).mockRejectedValueOnce(new Error("Claude is not signed in here."));
      expect(task.startPolicy).toBe("on-request");
      expect(supervisor.hostOps.runTaskOp(task.id, "start-task")).toBeUndefined();
      expect(await supervisor.starts.startQueuedNow(task.id)).toContain("is starting.");
      await vi.waitFor(() => expect(sessions.open).toHaveBeenCalledTimes(1));
      await tick();
      expect(tasks.get(task.id)).toMatchObject({
        status: "open",
        gate: null,
        startPolicy: "on-request",
        startNotice: JSON.stringify({ reason: "Claude is not signed in here." }),
      });
      expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
      expect(tasks.graph.listReady().map((ready) => ready.id)).not.toContain(task.id);
    });

    it("shows a Start saved in the inbox as Starting again after a quit", async () => {
      const { supervisor, tasks, inbox, task } = hooked();
      const id = inbox.enqueueWake(
        FIRSTMATE_RECIPIENT,
        {
          facts: {
            kind: "captain-start",
            task: { id: task.id, key: task.key, title: task.title },
            move: "start",
            at: 1,
            from: "task-card",
          },
        },
        "agent",
        task.id,
      );
      supervisor.reconcileCutOffs();
      expect(tasks.starts.startAttemptOf(task.id)?.phase).toBe("preparing");
      expect(tasks.get(task.id)?.status).toBe("open");
      supervisor.hostOps.firstmateTurnEnded([id ?? 0], "clean");
      await tick();
      expect(tasks.get(task.id)?.status).toBe("active");
      expect(tasks.taskCardClicksSince(0).map(({ op }) => op)).toEqual(["start-task"]);
    });
  });

  it("a Start the host refuses at once comes back as text as well as the feed line", () => {
    const { supervisor, tasks, events } = setup(fakeCrewmate());
    const a = supervisor.intake.plan({ title: "A", intent: intentOf("a") });
    const b = supervisor.intake.plan({ title: "B", intent: intentOf("b"), blockedBy: [a.id] });
    const refusal = `Cannot start ${b.key} "B" now: it waits on ${a.key} "A".`;
    expect(supervisor.hostOps.runTaskOp(b.id, "start-task")).toBe(refusal);
    expect(events.findLast((event) => event.type === "firstmate_note")).toMatchObject({
      text: refusal,
    });
    expect(tasks.get(b.id)?.status).toBe("open");
  });

  it("the task board's queue starts never-started work that nothing holds, and unqueue puts it back", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions, ops } = setup(crewmate);
    const later = supervisor.intake.plan({ title: "Write the ADR", intent: intentOf("write it") });
    expect(later).toMatchObject({ status: "open", startPolicy: "on-request" });
    const blocker = supervisor.intake.plan({ title: "A", intent: intentOf("a") });
    const waits = supervisor.intake.plan({
      title: "B",
      intent: intentOf("b"),
      blockedBy: [blocker.id],
    });

    expect(supervisor.hostOps.runTaskOp(waits.id, "queue-task")).toBeUndefined();
    await tick();
    expect(tasks.get(waits.id)).toMatchObject({ status: "open", startPolicy: "when-ready" });
    expect(tasks.graph.blockers(waits.id).map((row) => row.id)).toEqual([blocker.id]);
    // Back to the backlog at once. Only the queue told the Firstmate, so his
    // standing directions apply to it before its wait ends.
    expect(supervisor.hostOps.runTaskOp(waits.id, "unqueue-task")).toBeUndefined();
    expect(tasks.get(waits.id)?.startPolicy).toBe("on-request");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toContain(`the captain queued task ${waits.id}`);

    expect(supervisor.hostOps.runTaskOp(later.id, "queue-task")).toBeUndefined();
    await tick();
    expect(tasks.get(later.id)?.status).toBe("active");
    expect(sessions.open).toHaveBeenCalledTimes(1);
    // Once started, Queue it is refused and writes nothing; Back to backlog
    // keeps it started with its work and parks it (INF-2062).
    expect(supervisor.hostOps.runTaskOp(later.id, "queue-task")).toBe(
      queueStartedBacklogRefusal(later.key),
    );
    expect(tasks.get(later.id)?.startPolicy).toBe("when-ready");
    expect(supervisor.hostOps.runTaskOp(later.id, "unqueue-task")).toBeUndefined();
    expect(tasks.get(later.id)).toMatchObject({
      status: "active",
      backlogSince: expect.any(Number),
    });
    // The clicks are the captain's on the history. Queueing work nothing
    // holds is a Start, so it records one and needs no ready-sweep note.
    expect(tasks.taskCardClicksSince(0).map(({ taskId, op }) => ({ taskId, op }))).toEqual([
      { taskId: later.id, op: "unqueue-task" },
      { taskId: later.id, op: "start-task" },
      { taskId: later.id, op: "queue-task" },
      { taskId: waits.id, op: "unqueue-task" },
      { taskId: waits.id, op: "queue-task" },
    ]);
    expect(ops).toHaveLength(1);
  });

  it("the record's started-work Drop task and Continue run the stall card's host ops on the task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const planned = supervisor.intake.plan({
      title: "Write the ADR",
      intent: intentOf("write it"),
    });
    supervisor.hostOps.runTaskOp(planned.id, "start-task");
    await tick();
    crewmate.emit({ type: "turn_end", taskId: planned.id });
    crewmate.finishPrompt();
    await tick();
    expect(tasks.get(planned.id)).toMatchObject({ status: "active", activity: "idle" });
    supervisor.hostOps.runTaskOp(planned.id, "continue-task");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
    expect(
      tasks
        .timeline(planned.id)
        .filter((event) => event.kind === "steered")
        .at(-1),
    ).toMatchObject({ actor: "captain" });

    // Drop task on started work, mid-turn: the turn is aborted and the task ends, cancelled.
    supervisor.hostOps.runTaskOp(planned.id, "stop-task");
    crewmate.failPrompt("aborted");
    await tick();
    expect(tasks.get(planned.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
  });

  // INF-3169's plan, piece 3: "a Close as done button on a started task's
  // record with one confirm" - the captain's own word that the work is done,
  // which meets only the real limits.
  it("closes started work as done on the captain's press from its record, and refuses work that has not started", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops } = setup(crewmate);
    const unstarted = supervisor.intake.plan({ title: "Never mind", intent: intentOf("nope") });
    const key = tasks.get(unstarted.id)?.key || unstarted.id;
    await expect(supervisor.hostOps.closeDoneFromRecord(unstarted.id)).resolves.toEqual({
      ok: false,
      text: closeDoneNotStartedRefusal(key),
    });
    expect(tasks.get(unstarted.id)?.status).toBe("open");

    const planned = supervisor.intake.plan({
      title: "Write the ADR",
      intent: intentOf("write it"),
    });
    supervisor.hostOps.runTaskOp(planned.id, "start-task");
    await tick();
    expect(tasks.get(planned.id)?.status).toBe("active");
    const key2 = tasks.get(planned.id)?.key || planned.id;
    // Pressed mid-turn, before its crewmate reported: the captain's word passes that hold.
    const closed = await supervisor.hostOps.closeDoneFromRecord(planned.id);
    expect(closed).toMatchObject({ ok: true });
    expect(tasks.get(planned.id)).toMatchObject({ status: "done", closedReason: "finished" });
    const close = tasks
      .timeline(planned.id)
      .find((event) => event.data?.status === "done" && event.data?.reason === "finished");
    expect(close).toMatchObject({
      actor: "captain",
      data: { via: "task-card", onWord: true, captainWords: CLOSE_AS_DONE_PRESS, why: "word" },
    });
    const again = await supervisor.hostOps.closeDoneFromRecord(planned.id);
    expect(again).toEqual({ ok: false, text: closeDoneClosedRefusal(key2) });
    // The press reads as itself, never as one of the record's other buttons, and woke nobody.
    expect(tasks.taskCardClicksSince(0).map(({ op }) => op)).toEqual(["close-done", "start-task"]);
    expect(ops).toEqual([]);
  });

  it("writes every task card click on the history as the captain's, once each, and wakes nobody (FI3-695)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops } = setup(crewmate);
    const planned = supervisor.intake.plan({
      title: "Write the ADR",
      intent: intentOf("write it"),
    });
    supervisor.hostOps.runTaskOp(planned.id, "start-task");
    await tick();
    expect(tasks.timeline(planned.id).find((event) => event.text === "starting")).toMatchObject({
      actor: "captain",
      data: { via: "task-card" },
    });
    crewmate.emit({ type: "turn_end", taskId: planned.id });
    crewmate.finishPrompt();
    await tick();
    // Continue names the task card, not the stall card it shares a nudge with.
    supervisor.hostOps.runTaskOp(planned.id, "continue-task");
    await tick();
    expect(
      tasks
        .timeline(planned.id)
        .filter((event) => event.kind === "steered")
        .at(-1),
    ).toMatchObject({ actor: "captain", data: { via: "task-card", cardId: null } });
    // Drop task mid-turn is the one drop (INF-3169's piece 4): it stops the
    // turn and closes the record as the captain's, from the task card.
    supervisor.hostOps.runTaskOp(planned.id, "stop-task");
    crewmate.failPrompt("aborted");
    await tick();
    expect(tasks.get(planned.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(
      tasks
        .timeline(planned.id)
        .filter((event) => event.kind === "status" && event.data?.status === "dropped"),
    ).toMatchObject([{ actor: "captain", data: { via: "task-card" } }]);
    const unstarted = supervisor.intake.plan({ title: "Never mind", intent: intentOf("nope") });
    expect(
      supervisor.hostOps.runTaskOp(unstarted.id, "drop-task", {
        parts: [],
        waiting: [],
        underway: [],
      }),
    ).toBeUndefined();
    expect(tasks.get(unstarted.id)?.status).toBe("dropped");

    expect(tasks.taskCardClicksSince(0).map(({ taskId, op }) => ({ taskId, op }))).toEqual([
      { taskId: unstarted.id, op: "drop-task" },
      { taskId: planned.id, op: "stop-task" },
      { taskId: planned.id, op: "continue-task" },
      { taskId: planned.id, op: "start-task" },
    ]);
    expect(ops).toEqual([]);
  });
});
