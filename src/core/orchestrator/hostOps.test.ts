/**
 * The host's own operations as `HostOps` runs them (docs/task-board.md,
 * "Moves"; docs/cards.md for the app's own cards): each host card's
 * operation reaching the owner that answers it, and the task record's and
 * task board's lifecycle buttons with every refusal they answer before
 * anything is written. These cases pin the behaviour no other test reaches.
 * Each case drives a public door of the crew's owners - a click on a card,
 * or a button on a task - and reads its answer, the owner it reached and
 * the record.
 */

import type { CardAction, HostEffect } from "@shared/cards";
import { DROP_REVIEW_STALE, dropMissingRefusal } from "@shared/recordDrop";
import { queueMissingRefusal, queueStartedBacklogRefusal } from "@shared/taskQueue";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { backlogLeftLine } from "./hostOps";
import { describeStatus } from "./settleService";

fakeCrewTimersEachTest();

type Harness = ReturnType<typeof setup>;

function hostCard(h: Harness, id: string, effect: HostEffect): string {
  const action: CardAction = { id: "go", label: "Go", effect };
  h.supervisor.cards.hostCards.raiseHostCard({
    id,
    title: "A question the app asks",
    meta: "the app",
    body: "<p>Go ahead?</p>",
    actions: [action],
  });
  return id;
}

async function startedTask(h: Harness, crewmate: FakeCrewmate): Promise<string> {
  const { taskId } = await h.supervisor.intake.commission({
    title: "Count presses",
    intent: intentOf("make the meter count every press"),
  });
  await tick();
  await endTurn(crewmate, taskId, "The meter counts every press.");
  return taskId;
}

/** What the feed said about one task, in order. */
function notes(h: Harness, taskId: string): string[] {
  return h.events.flatMap((event) =>
    event.type === "firstmate_note" && event.taskId === taskId ? [event.text] : [],
  );
}

describe("the host's own operations, as HostOps runs them", () => {
  it("hands each host card's click to the owner that answers it, with what the card carried", () => {
    const h = setup(fakeCrewmate());
    const plugins = { add: vi.fn(), decline: vi.fn() };
    const change = { apply: vi.fn(), decline: vi.fn(), inspect: vi.fn(async () => {}) };
    const project = { add: vi.fn(), decline: vi.fn() };
    h.supervisor.hostOps.setPluginConsent(plugins as never);
    h.supervisor.hostOps.setProjectChange(change);
    h.supervisor.hostOps.setProjectSetup(project as never);
    const hooks = {
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      moveFlagship: vi.fn(),
      tryAgain: vi.fn(),
      askAgain: vi.fn(),
    };
    h.supervisor.setFirstmateHooks(hooks);
    const deferred = vi.spyOn(h.tasks.delivery, "deferCaptainAction");
    const click = (id: string, effect: HostEffect, value?: unknown) =>
      h.supervisor.cardActions.act(hostCard(h, id, effect), "go", "chrome", value);

    expect(click("c-plugin", { kind: "host", op: "add-plugin", arg: "weather" })).toEqual({});
    expect(click("c-plugin-no", { kind: "host", op: "decline-plugin", arg: "weather" })).toEqual(
      {},
    );
    expect(plugins.add).toHaveBeenCalledWith("weather");
    expect(plugins.decline).toHaveBeenCalledWith("weather");

    click("c-change", { kind: "host", op: "apply-project-change", arg: "meter" });
    click("c-change-no", { kind: "host", op: "decline-project-change", arg: "meter" });
    expect(change.apply).toHaveBeenCalledWith("meter");
    expect(change.decline).toHaveBeenCalledWith("meter");

    const answers = [{ name: "folder", values: ["~/code/meter"], changed: true }];
    click("c-project", { kind: "host", op: "add-project", arg: "meter" }, { answers });
    click("c-project-no", { kind: "host", op: "decline-project", arg: "meter" });
    expect(project.add).toHaveBeenCalledWith("meter", answers);
    expect(project.decline).toHaveBeenCalledWith("meter");

    click("c-flagship", { kind: "host", op: "move-flagship", arg: "xai" });
    click("c-try", { kind: "host", op: "try-again", arg: "acct-claude" });
    click("c-ask", { kind: "host", op: "ask-again", arg: "abc12345" });
    click("c-retry", { kind: "host", op: "retry-firstmate" });
    click("c-defer", { kind: "host", op: "defer-required-action", arg: "t-later" });
    expect(hooks.moveFlagship).toHaveBeenCalledWith("xai");
    expect(hooks.tryAgain).toHaveBeenCalledWith("acct-claude");
    expect(hooks.askAgain).toHaveBeenCalledWith("abc12345");
    expect(hooks.retryConverse).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveBeenCalledWith("t-later");

    expect(click("c-restore", { kind: "host", op: "restore-account", arg: "acct-codex" })).toEqual({
      effect: { kind: "open", target: "subscriptions", restoreAccountId: "acct-codex" },
    });
    expect(click("c-restore-any", { kind: "host", op: "restore-account" })).toEqual({
      effect: { kind: "open", target: "subscriptions" },
    });
  });

  it("does nothing for a host card's click that names nothing, and says so when a Move or Start is refused", async () => {
    const h = setup(fakeCrewmate());
    const hooks = {
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      moveFlagship: vi.fn(),
      tryAgain: vi.fn(),
      askAgain: vi.fn(),
    };
    h.supervisor.setFirstmateHooks(hooks);
    const deferred = vi.spyOn(h.tasks.delivery, "deferCaptainAction");
    for (const op of [
      "move-flagship",
      "try-again",
      "ask-again",
      "defer-required-action",
      "continue-task",
      "stop-task",
      "start-task",
    ] as const) {
      expect(
        h.supervisor.cardActions.act(hostCard(h, `c-${op}`, { kind: "host", op }), "go"),
        op,
      ).toEqual({});
    }
    // A Move that names no provider to move off is no move.
    expect(
      h.supervisor.cardActions.act(
        hostCard(h, "c-move-half", { kind: "host", op: "move-task", arg: "t1" }),
        "go",
      ),
    ).toEqual({});
    expect(hooks.moveFlagship).not.toHaveBeenCalled();
    expect(hooks.tryAgain).not.toHaveBeenCalled();
    expect(hooks.askAgain).not.toHaveBeenCalled();
    expect(deferred).not.toHaveBeenCalled();
    expect(h.events.filter((event) => event.type === "firstmate_note")).toEqual([]);

    // A sign-in card's Move on a task the record does not hold says why in the feed.
    const refusal = await h.supervisor.moves.requestMove("t-gone", {
      by: "captain",
      from: "openai-codex",
    });
    expect(refusal.ok).toBe(false);
    h.supervisor.cardActions.act(
      hostCard(h, "c-move", { kind: "host", op: "move-task", arg: "t-gone:openai-codex" }),
      "go",
    );
    await vi.waitFor(() => expect(notes(h, "t-gone")).toEqual([refusal.text]));

    // A stall card's Start on work that cannot start says why in the feed, and starts nothing.
    seedTask(h.tasks, { id: "t-dropped", title: "Old idea", status: "cancelled" });
    h.supervisor.cardActions.act(
      hostCard(h, "c-start", { kind: "host", op: "start-task", arg: "t-dropped" }),
      "go",
    );
    await tick();
    const dropped = h.tasks.get("t-dropped");
    expect(notes(h, "t-dropped")).toEqual([
      `Cannot start ${dropped?.key} "Old idea" now: it is ${describeStatus(dropped as TaskRecord)}, not queued work. Use Start again on its record to create a replacement.`,
    ]);
    expect(h.tasks.get("t-dropped")?.status).not.toBe("active");
  });

  it("answers the task record's buttons with a refusal in words when there is nothing to do", () => {
    const h = setup(fakeCrewmate());
    seedTask(h.tasks, { id: "t1", title: "Fix the meter", status: "queued" });

    expect(h.supervisor.hostOps.runTaskOp("t1", "answer-done")).toBe(
      "This task has no answer ready to mark Done.",
    );
    expect(h.supervisor.hostOps.runTaskOp("t1", "dismiss-question")).toBe(
      "This question is no longer waiting.",
    );
    expect(h.supervisor.hostOps.runTaskOp("t1", "show-card")).toBe(
      "This task has no card to show.",
    );
    expect(h.supervisor.hostOps.runTaskOp("t-gone", "start-again")).toBe(
      "This task could not be found.",
    );
    expect(
      h.supervisor.hostOps.runTaskOp("t-gone", "drop-task", {
        parts: [],
        waiting: [],
        underway: [],
      }),
    ).toBe(dropMissingRefusal("t-gone"));
    // A drop the captain did not review first writes nothing.
    expect(h.supervisor.hostOps.runTaskOp("t1", "drop-task")).toBe(DROP_REVIEW_STALE);
    expect(h.tasks.get("t1")?.status).toBe("open");
    expect(h.supervisor.hostOps.runTaskOp("t-gone", "queue-task")).toBe(
      queueMissingRefusal("t-gone"),
    );
    expect(h.events.filter((event) => event.type === "open_card_shown")).toEqual([]);
  });

  it("shows a task's open card on Show card, bringing it forward", () => {
    const h = setup(fakeCrewmate());
    seedTask(h.tasks, { id: "t1", title: "Fix the meter", status: "queued" });
    h.supervisor.cards.hostCards.raiseHostCard({
      id: "c-t1",
      taskId: "t1",
      title: "Pick a meter",
      meta: "the app",
      body: "<p>Which meter?</p>",
      actions: [{ id: "a", label: "The first one" }],
    });

    expect(h.supervisor.hostOps.runTaskOp("t1", "show-card")).toBeUndefined();
    expect(h.events).toContainEqual({ type: "open_card_shown", cardId: "c-t1" });
  });

  it("refuses to queue started work, and its Back to backlog says when it already waits there", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const taskId = await startedTask(h, crewmate);
    const key = h.tasks.get(taskId)?.key || taskId;

    expect(h.supervisor.hostOps.runTaskOp(taskId, "queue-task")).toBe(
      queueStartedBacklogRefusal(key),
    );
    expect(h.tasks.get(taskId)?.backlogSince).toBeNull();

    expect(
      h.supervisor.hostOps.moveToBacklog("t-gone", {
        actor: "captain",
        via: "task-card",
        decision: null,
      }),
    ).toEqual({
      ok: false,
      text: queueMissingRefusal("t-gone"),
    });
    const first = h.supervisor.hostOps.moveToBacklog(taskId, {
      actor: "captain",
      via: "task-card",
      decision: null,
    });
    expect(first.ok).toBe(true);
    await tick();
    const since = h.tasks.get(taskId)?.backlogSince;
    expect(since).not.toBeNull();
    expect(
      h.supervisor.hostOps.moveToBacklog(taskId, {
        actor: "captain",
        via: "task-card",
        decision: null,
      }),
    ).toEqual({ ok: true, text: expect.stringContaining("already waits in the backlog") });
    expect(h.supervisor.hostOps.runTaskOp(taskId, "unqueue-task")).toBeUndefined();
    expect(h.tasks.get(taskId)?.backlogSince).toBe(since);
  });

  it("starts a backlog task whose crewmate is gone by resuming its conversation, the backlog line first", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const taskId = await startedTask(h, crewmate);
    h.supervisor.hostOps.moveToBacklog(taskId, { actor: "firstmate", via: "tool", decision: null });
    await tick();
    // Its conversation is let go while it waits, as a quit or a release would.
    expect(await h.supervisor.sessions.releaseConversation(taskId)).toBe(true);
    expect(h.supervisor.sessions.conversationHeld(taskId)).toBe(false);
    const opened = h.sessions.open.mock.calls.length;

    const key = h.tasks.get(taskId)?.key || taskId;
    expect(await h.supervisor.starts.startQueuedNow(taskId)).toBe(
      `Started ${key} "Count presses" again from the backlog. Its crewmate carries on in the same conversation.`,
    );
    await tick();
    expect(h.sessions.open.mock.calls.length).toBe(opened + 1);
    expect(h.tasks.get(taskId)?.backlogSince).toBeNull();
    expect(crewmate.promptCalls.at(-1)).toContain(backlogLeftLine("firstmate"));
  });

  it("starts the captain's pending Start as it is when the first mate's turn ends without starting it", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    let row = 0;
    h.supervisor.setFirstmateHooks({
      notifyOp: () => {
        row += 1;
        return row;
      },
      retryConverse: vi.fn(),
      firstmateCannotAnswer: () => undefined,
    });
    seedTask(h.tasks, {
      id: "t1",
      title: "Count presses",
      status: "queued",
      startPolicy: "on-request",
      intent: intentOf("make the meter count every press"),
    });

    expect(h.supervisor.hostOps.runTaskOp("t1", "start-task")).toBeUndefined();
    await tick();
    // His Start waits for the first mate, which applies his standing directions first.
    expect(h.tasks.get("t1")?.status).toBe("open");
    expect(h.tasks.starts.startAttemptOf("t1")).toBeTruthy();
    expect(h.supervisor.hostOps.firstmateTurnEnded([row + 10], "clean")).toEqual([]);
    expect(h.tasks.get("t1")?.status).toBe("open");

    expect(h.supervisor.hostOps.firstmateTurnEnded([row], "failed")).toEqual([row]);
    await tick();
    expect(h.tasks.get("t1")?.status).toBe("active");
    expect(
      h.tasks
        .timeline("t1")
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).toContain("started without applying your standing directions: your first mate's turn failed");
    expect(h.supervisor.hostOps.firstmateTurnEnded([row], "clean")).toEqual([]);
  });

  it("names an open question's wait on its blockers in the crew status", () => {
    const h = setup(fakeCrewmate());
    seedTask(h.tasks, { id: "first", title: "Fix the meter", status: "queued" });
    // Work reads its start queue's wait; a question that waits reads its blockers.
    seedTask(h.tasks, {
      id: "second",
      kind: "question",
      title: "Is the meter right?",
      status: "queued",
    });
    h.tasks.graph.link("first", "second", "blocks", "firstmate");
    const firstKey = h.tasks.get("first")?.key;

    expect(h.supervisor.facts.crewStatus("second")[0]?.gate).toBe(
      `starts when ${firstKey} finishes`,
    );
    seedTask(h.tasks, { id: "third", kind: "question", title: "Which meter?", status: "queued" });
    expect(h.supervisor.facts.crewStatus("third")[0]?.gate).toBeUndefined();
  });
});
