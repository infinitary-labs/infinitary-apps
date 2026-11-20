/**
 * Steering a crewmate as `CrewSteer` does it (docs/inbox.md): a backend
 * that cannot take words mid-turn, a steer that lands after the run's last
 * look at its queue, the Crewmate tab's composer, and the spark when
 * something reaches a crewmate.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  queuedGuidanceLines,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedTask } from "../tasks/seedTask";
import { CARD_CLOSED_STEER_PREFIX } from "./captainWakes";

fakeCrewTimersEachTest();

describe("steering a crewmate whose backend cannot take it mid-turn", () => {
  it("queues the guidance for the next turn, says so, and delivers it", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Do the thing"),
    });
    await tick();

    // Mid-turn: the running turn cannot hear this.
    const delivery = await supervisor.steer.steerCrewmate(taskId, "use the other library");
    // The caller is told it was queued rather than applied - the captain's
    // phase-8 decision, and the whole difference between honest and not.
    expect(delivery).toBe("queued-next-turn");
    // Nothing was pushed at the running turn: this backend would have thrown.
    expect(crewmate.steer).not.toHaveBeenCalled();
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(crewmate.promptCalls[0]).toContain("Do the thing");

    crewmate.finishPrompt();
    await tick();

    // The turn ended, so the parked guidance became the next turn.
    expect(crewmate.promptCalls).toHaveLength(2);
    expect(crewmate.promptCalls[1]).toBe("use the other library");
    // Said in the feed as the task's own line, never as a Firstmate wake (WI-5).
    expect(queuedGuidanceLines(tasks, taskId)).toHaveLength(1);
    expect(ops).toEqual([]);
  });

  it("delivers everything that queued during one turn, in order", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    expect(await supervisor.steer.steerCrewmate(taskId, "first")).toBe("queued-next-turn");
    expect(await supervisor.steer.steerCrewmate(taskId, "second")).toBe("queued-next-turn");
    crewmate.finishPrompt();
    await tick();

    expect(crewmate.promptCalls[1]).toBe("first\n\nsecond");
  });

  it("delivers the queued guidance after an interrupt, not instead of it", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    await supervisor.steer.steerCrewmate(taskId, "stop and do this instead");
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    crewmate.failPrompt("The turn was interrupted.");
    await tick();

    // An interrupted turn is still a turn that ended, and the task stays
    // steerable - so the queued guidance is what comes next.
    expect(crewmate.promptCalls).toHaveLength(2);
    expect(crewmate.promptCalls[0]).toContain("Start");
    expect(crewmate.promptCalls[1]).toBe("stop and do this instead");
  });

  it("says so when a task ends before its queued guidance could be delivered", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, ops, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    await supervisor.steer.steerCrewmate(taskId, "one more thing");
    crewmate.failPrompt("the crewmate crashed");
    await tick();

    // Never silently dropped: the task's own timeline keeps the guidance and
    // says it was never delivered, as a feed line - not a Firstmate wake (WI-5).
    const note = tasks.timeline(taskId).find((event) => event.text.includes("never delivered"));
    expect(note).toMatchObject({ kind: "note", feed: true });
    expect(note?.text).toContain("one more thing");
    expect(ops.some((line) => line.includes("never delivered"))).toBe(false);
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(crewmate.promptCalls[0]).toContain("Start");
  });

  it("still steers a native backend into the running turn", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    // The fallback is for backends that need it, and for nobody else.
    expect(await supervisor.steer.steerCrewmate(taskId, "also make it blue")).toBe("mid-turn");
    expect(crewmate.steer).toHaveBeenCalledWith(
      "also make it blue",
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );
  });
});

describe("a steer that lands after the run's last look at its queue", () => {
  it("goes back on the lane, its attempt unspent, and is the crewmate's next turn", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    // The run has made its last check of the queue: the session accepts the
    // steer, and the turn ends without reading it.
    crewmate.holdSteers();
    expect(await supervisor.steer.steerCrewmate(taskId, "also make it blue")).toBe("mid-turn");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();

    // Taken back from the session, never acknowledged as handled: it is
    // the next turn, announced as queued guidance.
    expect(crewmate.promptCalls).toHaveLength(2);
    expect(crewmate.promptCalls[1]).toBe("also make it blue");
    expect(queuedGuidanceLines(tasks, taskId)).toHaveLength(1);
    // Its row rides that turn on its first attempt: the one no turn read was given back.
    expect(inbox.inFlight(taskId).map((row) => row.attempts)).toEqual([1]);
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(inbox.inFlight(taskId)).toEqual([]);
    expect(inbox.allFor(taskId)).toEqual([]);
    expect(crewmate.promptCalls).toHaveLength(2);
  });

  it("takes back only the steers the turn never read, the newest", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    // The first steer reaches the running turn; the second lands in its tail.
    await supervisor.steer.steerCrewmate(taskId, "first");
    crewmate.holdSteers();
    await supervisor.steer.steerCrewmate(taskId, "second");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();

    expect(crewmate.promptCalls.slice(1)).toEqual(["second"]);
    // The first was handled by the turn that read it; only the second rides on.
    expect(inbox.inFlight(taskId).map((row) => row.attempts)).toEqual([1]);
  });

  it("says a steer no turn read was never delivered when the task ends first", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();

    crewmate.holdSteers();
    await supervisor.steer.steerCrewmate(taskId, "one more thing");
    crewmate.failPrompt("the crewmate crashed");
    await tick();

    const note = tasks.timeline(taskId).find((event) => event.text.includes("never delivered"));
    expect(note).toMatchObject({ kind: "note", feed: true });
    expect(note?.text).toContain("one more thing");
    expect(ops.some((line) => line.includes("never delivered"))).toBe(false);
  });
});

describe("the Crewmate tab's composer (docs/task-card-tabs.md, Typing)", () => {
  it("steers the crewmate with the captain's words, recorded with its origin, and says so once in the feed", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Count the rivets",
      intent: intentOf("count the rivets"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(
      await supervisor.steer.steerFromCrewmateTab(taskId, "  count the starboard hatch too "),
    ).toEqual({
      ok: true,
    });
    // Into the running turn, as a reply under its card goes: Firstmate is not in the loop.
    expect(crewmate.steer).toHaveBeenCalledWith(
      expect.stringContaining("count the starboard hatch too"),
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );
    const steered = tasks.timeline(taskId).findLast((event) => event.kind === "steered");
    expect(steered?.actor).toBe("captain");
    expect(steered?.data).toMatchObject({ via: CREWMATE_TAB_VIA, outcome: "mid-turn" });
    const span = steered?.data?.words as { from: number; to: number };
    expect(steered?.text.slice(span.from, span.to)).toBe("count the starboard hatch too");
    const told = events.filter(
      (event) => event.type === "firstmate_note" && event.text.includes("Count the rivets"),
    );
    expect(told).toHaveLength(1);
    expect(told[0]).not.toHaveProperty("taskId");
    expect(supervisor.facts.turnStartedAt(taskId)).toEqual(expect.any(Number));
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();
  });

  it("refuses in words, and writes nothing, where no crewmate can be told anything", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    seedTask(tasks, { id: "queued", title: "Not started", status: "queued" });
    expect(await supervisor.steer.steerFromCrewmateTab("queued", "go")).toMatchObject({
      ok: false,
    });
    expect(await supervisor.steer.steerFromCrewmateTab("queued", "   ")).toMatchObject({
      ok: false,
    });
    seedTask(tasks, { id: "closed", title: "Closed", status: "idle" });
    tasks.close("closed", { status: "done", reason: "merged", actor: "host" });
    expect(await supervisor.steer.steerFromCrewmateTab("closed", "go")).toMatchObject({
      ok: false,
    });
    expect(
      [...tasks.timeline("queued"), ...tasks.timeline("closed")].some(
        (event) => event.kind === "steered",
      ),
    ).toBe(false);
  });

  it("interrupts the running turn as the captain and keeps the task steerable; with no turn running it refuses", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Count the hatches",
      intent: intentOf("count the hatches"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(await supervisor.steer.interruptFromCrewmateTab(taskId)).toEqual({ ok: true });
    expect(crewmate.aborts).toHaveLength(1);
    const interrupted = tasks.timeline(taskId).filter((event) => event.kind === "interrupted");
    expect(
      interrupted.map((event) => [event.actor, event.data?.via, event.data?.mode]),
    ).toContainEqual(["captain", CREWMATE_TAB_VIA, "interrupt"]);
    crewmate.failPrompt("aborted");
    await tick();
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(supervisor.facts.turnStartedAt(taskId)).toBeNull();
    expect(await supervisor.steer.interruptFromCrewmateTab(taskId)).toMatchObject({ ok: false });
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();
  });
});

/**
 * INF-759, the captain's plan: every action that reaches a crewmate is
 * announced as it reaches it, and the center draws one spark then. Its own
 * work - a job's result - is announced by nobody.
 */
describe("the spark when something reaches a crewmate (INF-759)", () => {
  const sparks = (events: readonly FmEvent[], taskId: string) =>
    events.filter(
      (event) => event.type === "task_event" && event.reached === true && event.taskId === taskId,
    ).length;

  async function idleCrewmate(crewmate = fakeCrewmate()) {
    const harness = setup(crewmate);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    return { ...harness, crewmate, taskId };
  }

  it("sparks a message steered into the running turn once, as it goes in", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    expect(sparks(events, taskId)).toBe(0);
    expect(await supervisor.steer.steerCrewmate(taskId, "also make it blue")).toBe("mid-turn");
    expect(crewmate.steer).toHaveBeenCalledTimes(1);
    expect(sparks(events, taskId)).toBe(1);
  });

  it("sparks a message queued behind the turn when the next turn takes it, not when it is sent", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    expect(await supervisor.steer.steerCrewmate(taskId, "use the other library")).toBe(
      "queued-next-turn",
    );
    expect(sparks(events, taskId)).toBe(0);
    crewmate.finishPrompt();
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("use the other library");
    expect(sparks(events, taskId)).toBe(1);
  });

  it("sparks a message to an idle crewmate as its turn starts", async () => {
    const { supervisor, events, crewmate, taskId } = await idleCrewmate();
    await supervisor.steer.steerCrewmate(taskId, "and the docs");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("and the docs");
    expect(sparks(events, taskId)).toBe(1);
  });

  it("draws nothing for the crewmate's own job result", async () => {
    const { supervisor, events, crewmate, taskId } = await idleCrewmate();
    supervisor.watch.deliverJobResult(taskId, {
      facts: {
        kind: "job-exit",
        to: "crewmate",
        jobId: "j1",
        command: "make",
        exitCode: 0,
        durationMs: 1000,
      },
    });
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain("make");
    expect(sparks(events, taskId)).toBe(0);
  });

  it("sparks the first mate's interrupt and the captain's Stop, each once", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    expect(sparks(events, taskId)).toBe(1);
    crewmate.failPrompt("The turn was interrupted.");
    await tick();
    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    const before = sparks(events, taskId);
    expect(await supervisor.steer.interruptFromCrewmateTab(taskId)).toEqual({ ok: true });
    expect(sparks(events, taskId)).toBe(before + 1);
  });

  it("sparks a cancel once, before the task closes", async () => {
    const { supervisor, events, tasks, taskId } = await idleCrewmate();
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();
    expect(tasks.get(taskId)?.status).toBe("dropped");
    expect(sparks(events, taskId)).toBe(1);
  });

  it("sparks a settle once, before the task closes", async () => {
    const { supervisor, events, tasks, taskId } = await idleCrewmate();
    await supervisor.settling.closing.closeTask(taskId, {
      status: "done",
      reason: "answered",
      actor: "captain",
    });
    expect(tasks.get(taskId)?.status).toBe("done");
    expect(sparks(events, taskId)).toBe(1);
  });

  it("tells the crewmate its card closed as a duplicate, with a spark", async () => {
    const { supervisor, events, crewmate, specs, cards, taskId } = await idleCrewmate();
    specs[0]?.onCard?.({ title: "First note", body: "<p>Version 1.2 is out.</p>", actions: [] });
    await tick();
    specs[0]?.onCard?.({ title: "Second note", body: "<p>Version 1.2 is out.</p>", actions: [] });
    await tick();
    const first = cards().find((card) => card.title === "First note") as Card;
    const second = cards().find((card) => card.title === "Second note") as Card;
    const before = sparks(events, taskId);
    expect(
      supervisor.flagDuplicate({ cardId: second.id, duplicateOf: first.id, note: "same news" }),
    ).toMatchObject({ status: "flagged" });
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe(
      `${CARD_CLOSED_STEER_PREFIX}"Second note" (${second.id}) as a duplicate of "First note" (${first.id}), without choosing.`,
    );
    expect(sparks(events, taskId)).toBe(before + 1);
  });

  it("sparks a new wait on a crewed task, which its crewmate never hears", async () => {
    const { supervisor, events, tasks, taskId } = await idleCrewmate();
    const planned = seedTask(tasks, { id: "t-later", title: "Later", status: "queued" });
    expect(supervisor.intake.linkTasks(planned.id, taskId, "blocks")).toMatch(/^Recorded/);
    expect(sparks(events, taskId)).toBe(1);
    // Only a crewmate on the ring has a place for a spark.
    expect(sparks(events, planned.id)).toBe(0);
  });
});
