import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { TaskEventStore } from "../storage/taskEventStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AskEnding } from "./askEnding";
import { pendingMergeLine } from "./settleWords";

/**
 * How a captain's message ends (INF-1610 piece 2, the captain's approved
 * plan "each of your asks ends on a card you accept"; docs/task-capture.md
 * "How a message ends"): over a real task graph and a card stack, with one
 * clock so "shown since the message" is an order, never a wall-clock window.
 */
function fixture() {
  const clock = { t: 1_000 };
  const now = () => clock.t;
  const tasks = new TaskService({ db: freshDatabase(), strict: true, now });
  const open = new Map<string, Card>();
  const stored = new Map<string, Card>();
  const shown = new Map<string, number>();
  const ending = new AskEnding({
    tasks,
    openCards: () => open.values(),
    storedCard: (id) => stored.get(id),
    shownAt: (card) => shown.get(card.id) ?? 0,
  });
  const later = () => {
    clock.t += 1_000;
    return clock.t;
  };
  /** The captain sends a message; the first mate's tool attaches it to its work. */
  const message = (
    id: string,
    text: string,
    taskId?: string,
    via: `tool:${string}` = "tool:spawn_crewmate",
  ) => {
    later();
    tasks.openAsk({ id, text });
    if (taskId) tasks.attachAsk(id, taskId, via);
    tasks.closeAsk(id, "closed");
    return id;
  };
  const work = (id: string, title: string, status: "running" | "idle" | "queued" = "running") => {
    later();
    return seedTask(tasks, { id, title, status });
  };
  const show = (card: Partial<Card> & Pick<Card, "id" | "title">): Card => {
    const full: Card = {
      author: "firstmate",
      priority: 30,
      meta: "",
      body: `<p>${card.title}.</p>`,
      actions: [],
      status: "ready",
      createdAt: clock.t,
      ...card,
    };
    open.set(full.id, full);
    stored.set(full.id, full);
    shown.set(full.id, later());
    return full;
  };
  const closeCard = (id: string) => open.delete(id);
  const finish = (taskId: string) => {
    later();
    tasks.close(taskId, { status: "done", reason: "answered", actor: "host" });
  };
  const state = (askId: string) => {
    const chain = ending.chain(askId);
    if (!chain) throw new Error(`No chain for ${askId}`);
    return ending.state(chain);
  };
  return { tasks, ending, message, work, show, closeCard, finish, state, later };
}

const MERGE = {
  id: "merge",
  label: "Merge",
  default: true,
  effect: { kind: "settle", mode: "merge" },
};

describe("how a captain's message ends", () => {
  it("runs while its work runs, asks the last crewmate once, and ends on the note the captain closed", () => {
    const f = fixture();
    f.work("panels", "Build personal panels in isolation");
    f.message("m1", "build the personal panels in isolation", "panels");
    expect(f.state("m1")).toEqual({ kind: "working" });

    // Its crewmate reports finished with no answer up: asked once, never twice.
    expect(f.ending.crewmateStep("panels")?.ids).toEqual(["m1"]);
    expect(f.ending.crewmateStep("panels")).toBeUndefined();

    const answer = f.show({
      id: "card-panels-1",
      taskId: "panels",
      author: "crewmate",
      title: "Personal panels now build in isolation",
      answering: true,
    });
    f.finish("panels");
    expect(f.state("m1")).toEqual({ kind: "waiting", cardId: answer.id });

    // A closed note is accepted; the ending is final once nothing is left.
    f.ending.captainResponded(answer, "close");
    f.closeCard(answer.id);
    expect(f.state("m1")).toEqual({ kind: "accepted", cardId: answer.id });
    f.tasks.markAnswered(["m1"], answer.id);
    expect(f.state("m1")).toEqual({ kind: "answered", cardId: answer.id });
    expect(f.ending.openChains()).toEqual([]);
  });

  it("needs its answer now when it only pointed at work nobody acted on", () => {
    const f = fixture();
    f.work("t58", "Check if PR 58 merged", "idle");
    f.message("m1", "is PR 58 merged?", "t58", "host:fallback" as `tool:${string}`);
    expect(f.state("m1")).toEqual({ kind: "missing" });
  });

  it("takes a later message about the same open work into one chain that ends together", () => {
    const f = fixture();
    f.work("taps", "Keep taps on the phone");
    f.message("m1", "the taps on the phone get lost", "taps");
    f.message("m2", "also the long press", "taps", "tool:steer_crewmate");
    expect(f.tasks.getAsk("m2")?.continues).toBe("m1");
    expect(f.ending.openChains().map((chain) => chain.ids)).toEqual([["m1", "m2"]]);
    expect(f.ending.chain("m2")?.root.id).toBe("m1");
  });

  it("counts an answer only when it was shown since the newest message of the chain", () => {
    const f = fixture();
    f.work("taps", "Keep taps on the phone");
    f.message("m1", "the taps on the phone get lost", "taps");
    const early = f.show({
      id: "card-taps-1",
      taskId: "taps",
      title: "Taps kept",
      answering: true,
    });
    f.message("m2", "also the long press", "taps", "tool:steer_crewmate");
    f.finish("taps");
    // The card predates the second message: it cannot answer it.
    expect(f.state("m1")).toEqual({ kind: "missing" });
    f.ending.captainResponded(early, "close");
    expect(f.tasks.getAsk("m1")?.answerCardId).toBeNull();
  });

  it("is not answered by a decision closed without a choice, by a card awaiting its author's answer, or by a choice on a question", () => {
    const f = fixture();
    f.work("plan", "Plan the stack order");
    f.message("m1", "did something change about how we order the cards in the stack?", "plan");
    f.finish("plan");
    const decision = f.show({
      id: "card-plan-1",
      taskId: "plan",
      title: "Pick how the stack orders",
      answering: true,
      actions: [{ id: "a", label: "Keep it", default: true }],
    });
    f.ending.captainResponded(decision, "close");
    f.ending.captainResponded({ ...decision, awaiting: "answer" }, "choice");
    f.ending.captainResponded({ ...decision, asking: true }, "choice");
    expect(f.tasks.getAsk("m1")?.acceptedAt).toBeNull();
    // Their choice on the decision is the answer.
    f.ending.captainResponded(decision, "choice");
    expect(f.tasks.getAsk("m1")?.answerCardId).toBe(decision.id);
  });

  // INF-2242: the exception requires the actual terminal answer-task choice,
  // not merely the same project, a question or a button named Start.
  it.each([
    "ready plan",
    "unrelated ask",
    "older offer",
    "pending reply",
    "continues",
    "held write",
    "browser handoff",
    "build task",
    "unmarked",
    "firstmate card",
    "invalid action",
    "dismissed decision",
  ])("limits chosen-plan acceptance: %s", (scenario) => {
    const f = fixture();
    f.later();
    seedTask(f.tasks, {
      id: "reading",
      title: "Plan a reading-style feature",
      status: "running",
      shape: { kind: "plan", deliverable: scenario === "build task" ? "change" : "answer" },
    });
    f.work("other", "Investigate a separate failure");
    f.message("reading-ask", "How could a reading-style feature work?", "reading");
    f.message("other-ask", "Why did the build fail?", "other");
    const card = f.show({
      id: scenario === "firstmate card" ? "card-fm-reading" : "card-reading-plan",
      taskId: "reading",
      author: scenario === "firstmate card" ? "firstmate" : "crewmate",
      title: "A reading-style plan",
      answering: scenario === "unmarked" ? undefined : true,
      asking: true,
      actions: [{ id: "start", label: "Start", default: true }],
      ...(scenario === "pending reply" ? { awaiting: "answer" as const } : {}),
      ...(scenario === "continues" ? { continues: true as const } : {}),
      ...(scenario === "held write"
        ? {
            actions: [
              {
                id: "start",
                label: "Allow",
                default: true,
                effect: { kind: "request_write", ask: "held-write" },
              },
            ],
          }
        : {}),
    });
    if (scenario === "browser handoff") {
      card.attachment = {
        kind: "browser",
        label: "Sign in",
        taskId: "reading",
        session: "reading-browser",
        generation: 1,
        handoff: true,
      };
    }
    if (scenario === "older offer")
      f.message("clarification", "Also check rights before proposing the design", "reading");
    f.ending.captainResponded(
      card,
      scenario === "dismissed decision" ? "close" : "choice",
      scenario === "invalid action" ? "not-an-offer" : "start",
    );
    expect(f.tasks.getAsk("other-ask")?.answerCardId).toBeNull();
    expect(f.tasks.getAsk("reading-ask")?.answerCardId).toBe(
      scenario === "ready plan" || scenario === "unrelated ask" ? card.id : null,
    );
  });

  it("keeps the message open when the captain's choice started more of its work", () => {
    const f = fixture();
    f.work("plan", "Plan the panels");
    f.message("m1", "plan the personal panels", "plan");
    const plan = f.show({
      id: "card-plan-1",
      taskId: "plan",
      title: "The panels plan",
      answering: true,
      actions: [{ id: "build", label: "Approve and build", default: true }],
    });
    f.finish("plan");
    f.ending.captainResponded(plan, "choice");
    f.closeCard(plan.id);
    // The approval files and starts the build, which builds on the plan.
    f.later();
    seedTask(f.tasks, {
      id: "build",
      title: "Build the panels",
      status: "running",
      parentId: "plan",
    });
    expect(f.state("m1")).toEqual({ kind: "working" });
  });

  it("revises the accepted answer when its work closes later, and puts up no new card (INF-1533)", () => {
    const f = fixture();
    f.work("fix", "Fix the reply line");
    f.message("m1", "the reply line is wrong", "fix");
    const done = f.show({
      id: "card-fix-1",
      taskId: "fix",
      author: "crewmate",
      title: "The reply line is fixed",
      actions: [MERGE] as Card["actions"],
    });
    f.ending.captainResponded(done, "choice");
    f.closeCard(done.id);
    expect(f.ending.closingPlace("fix")).toEqual({ kind: "revise", card: done, open: false });
  });

  it("revises the task's own note shown before a later message asked to merge it, and puts up no second note (INF-1219)", () => {
    const f = fixture();
    f.work("meter", "Fix the meter timing");
    f.message("m1", "fix the meter timing", "meter");
    const story = f.show({
      id: "card-meter-1",
      taskId: "meter",
      author: "crewmate",
      title: "fix: the meter reads on time",
      body: `<p>The meter reads on time.</p>${pendingMergeLine("project")}`,
    });
    f.message("m2", "merge the meter fix", "meter", "tool:merge_pr");
    expect(f.ending.closingPlace("meter")).toEqual({ kind: "revise", card: story, open: true });
  });

  it("stays quiet while a handover carries the work on, and answers once when the last work closes (INF-1437)", () => {
    const f = fixture();
    f.work("first", "Rename the notice");
    f.message("m1", "rename the notice", "first");
    f.work("second", "Rename the notice in the app project");
    f.tasks.link("first", "second", "replaced-by", "firstmate");
    f.finish("first");
    expect(f.ending.closingPlace("first")).toEqual({ kind: "quiet" });
    expect(f.ending.crewmateStep("first")).toBeUndefined();
    f.finish("second");
    expect(f.ending.closingPlace("second")).toEqual({ kind: "note" });
  });

  it("leaves work no message of the captain's covers to the rule for work the fleet started", () => {
    const f = fixture();
    f.work("runner", "Rebuild the runner image");
    expect(f.ending.closingPlace("runner")).toEqual({ kind: "unasked" });
    expect(f.ending.crewmateStep("runner")).toBeUndefined();
  });

  // INF-2059 (the captain: "every several seconds it freezes for a few
  // seconds"): the context build read each message's tasks three times,
  // once for its work and twice more for what the first mate acted on.
  it("looks up each open message's tasks once while every chain's state and own work are read", () => {
    const f = fixture();
    f.work("panels", "Build personal panels");
    f.work("meter", "Fix the meter");
    f.message("m1", "build the personal panels", "panels");
    f.message("m2", "and give them a title", "panels", "tool:steer_crewmate");
    f.message("m3", "fix the meter", "meter");
    f.message("m4", "the meter is late again", "meter", "tool:steer_crewmate");
    f.message("m5", "check the meter on the phone too", "meter", "tool:steer_crewmate");
    const lookups = vi.spyOn(TaskEventStore.prototype, "taskIdsWithRef");
    try {
      const chains = f.ending.openChains();
      const read = chains.map((chain) => ({
        ids: chain.ids,
        state: f.ending.state(chain),
        own: f.ending.ownWork(chain).map((task) => task.id),
      }));
      expect(read).toEqual([
        { ids: ["m1", "m2"], state: { kind: "working" }, own: ["panels"] },
        { ids: ["m3", "m4", "m5"], state: { kind: "working" }, own: ["meter"] },
      ]);
      expect(lookups.mock.calls.map(([, askId]) => askId).sort()).toEqual([
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
      ]);
    } finally {
      lookups.mockRestore();
    }
  });
});
