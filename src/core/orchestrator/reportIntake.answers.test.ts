/**
 * What a crewmate reports as `ReportIntake` takes it in
 * (docs/report-sort.md): who owns an answer, the truthful report channel,
 * and the answers the captain requested.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  served,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import type { CrewmateSpec } from "./crewSession";
import { QUIET_CARD_MS } from "./crewWatch";
import { PENDING_RESPONSES_END, PENDING_RESPONSES_OPENING } from "./reportWakes";

fakeCrewTimersEachTest();

describe("crew report answer ownership", () => {
  /** Drive one crewmate turn to completion so the report wake is emitted. */
  async function reportOnce(crewmate: FakeCrewmate, taskId: string, text: string): Promise<void> {
    crewmate.emit({ type: "assistant_delta", taskId, text });
    crewmate.emit({ type: "turn_end", taskId, usage: { input: 10, output: 2 } });
    crewmate.finishPrompt();
    await tick();
  }

  it("tells Firstmate in the report wake that the crewmate already carded the answer", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, ops, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Check if PR 58 merged",
      intent: intentOf("check if pr 58 merged"),
    });
    await tick();
    specs[0]?.onCard?.({
      title: "PR 58 is merged",
      body: "<p>merged</p>",
      actions: [],
    });
    await tick();
    await reportOnce(crewmate, taskId, "PR 58 is merged.");
    const report = ops.find((text) => text.includes(`reported on task ${taskId}`));
    // WI-12: the wake names the crewmate's card by id - the fact; the
    // steer-not-answer rule stays in the Firstmate's prompt (v2.0).
    expect(report).toMatch(
      /Its card on the captain's screen: card-[\w-]+ \(note\) "PR 58 is merged"\.$/,
    );
    expect(report).not.toContain("steer the crewmate");
  });

  it("refs the report wake to its task so the consuming turn can place it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    const refs: Array<{ text: string; origin: string; ref?: string }> = [];
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => {
        refs.push({ text: served(wake), origin, ...(ref ? { ref } : {}) });
      },
      retryConverse: vi.fn(),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Check if PR 58 merged",
      intent: intentOf("check if pr 58 merged"),
    });
    await tick();
    await reportOnce(crewmate, taskId, "PR 58 is merged.");
    // The report is stamped a crewmate report on its task: that stamp, not the
    // wording, is what the consuming turn is classified by.
    expect(refs).toContainEqual(
      expect.objectContaining({ ref: taskId, origin: "crewmate-report" }),
    );
  });

  it("refs distinct Firstmate card wakes to their natural task without deduping either", () => {
    const { supervisor, tasks, inbox } = setup(fakeCrewmate());
    seedTask(tasks, { id: "work", title: "Work", status: "idle" });
    supervisor.setFirstmateHooks({
      notifyOp: (text, origin, ref) => {
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, text, origin, ref);
      },
      retryConverse: vi.fn(),
    });
    const choice = supervisor.addFirstmateCard({
      taskId: "work",
      title: "Choose",
      body: "<p>Choose the course.</p><p>This keeps the work moving.</p>",
      actions: [{ id: "choose", label: "Choose it", default: true }],
    });
    const review = supervisor.addFirstmateCard({
      taskId: "work",
      title: "Review",
      body: "<p>Review the detail.</p><p>This settles the review.</p>",
      actions: [{ id: "review", label: "Review it", default: true }],
    });

    supervisor.cardActions.act(choice, "choose");
    supervisor.cardActions.act(review, "review");

    expect(inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.ref)).toEqual(["work", "work"]);
  });

  it("refs a standalone Firstmate card wake to its open decision task", () => {
    const { supervisor, tasks, inbox } = setup(fakeCrewmate());
    supervisor.setFirstmateHooks({
      notifyOp: (text, origin, ref) => {
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, text, origin, ref);
      },
      retryConverse: vi.fn(),
    });
    const cardId = supervisor.addFirstmateCard({
      title: "Choose",
      body: "<p>Choose the course.</p><p>This keeps the work moving.</p>",
      actions: [{ id: "choose", label: "Choose it", default: true }],
    });
    tasks.capture.fileDecision({ id: "decision-task", title: "Choose", cardId });

    supervisor.cardActions.act(cardId, "choose");

    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([
      expect.objectContaining({ ref: "decision-task" }),
    ]);
  });
});

describe("the truthful report channel (interaction P0, WI-1)", () => {
  /** Every wake this task earned the Firstmate, in order (S7c: there is one lane). */
  function withSupervision(crewmate: FakeCrewmate) {
    const harness = setup(crewmate);
    return {
      ...harness,
      wakes: (taskId: string) =>
        harness.ops.filter((line) => line.includes(taskId)).map((payload) => ({ payload })),
    };
  }

  it("an empty-text turn end emits no wake and never re-sends the previous report", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks, wakes } = withSupervision(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Find it",
      intent: intentOf("find"),
    });
    await tick();
    await endTurn(crewmate, taskId, "Found the cause: a stale cache key.");
    expect(wakes(taskId)).toHaveLength(1);

    // A background job result becomes a turn the crewmate ends silently.
    supervisor.watch.deliverJobResult(taskId, '[job] background job j1 finished: "make" exited 0');
    await tick();
    await endTurn(crewmate, taskId);

    expect(wakes(taskId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "task_report")).toHaveLength(1);
    expect(tasks.get(taskId)?.outcome).toBe("Found the cause: a stale cache key.");
    expect(supervisor.facts.crewStatus(taskId)[0]?.lastReport).toBe(
      "Found the cause: a stale cache key.",
    );
  });

  it("text streamed ahead of the turn's tool calls is not its report", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, wakes } = withSupervision(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Plan",
      intent: intentOf("plan"),
    });
    await tick();
    // Pi ends one turn per assistant message: a self-brief with a tool call,
    // then an empty final message.
    crewmate.emit({ type: "assistant_delta", taskId, text: "Self-brief: goal, acceptance." });
    crewmate.emit({ type: "turn_end", taskId });
    await endTurn(crewmate, taskId);

    expect(wakes(taskId)).toHaveLength(0);
    expect(events.some((event) => event.type === "task_report")).toBe(false);
    expect(supervisor.facts.crewStatus(taskId)[0]?.lastReport).toBeUndefined();
  });

  it("an explicit report wakes exactly once and wins over the turn's final text", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, tasks, wakes, events } = withSupervision(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Ship",
      intent: intentOf("ship"),
    });
    await tick();
    const spec = specs[0] as CrewmateSpec;
    // The receipt promises only what the sort will do (FI3-710): here the
    // Pi crewmate stops, so the report wakes; elsewhere it may not.
    expect(spec.onReport?.("Opened PR 97; every check is green.")).toBe(
      "Reported. It goes on your task's record when this turn ends; whether the first mate is woken for it depends on your task's state. If the first mate must act on it, report again with needs_firstmate.",
    );
    expect(wakes(taskId)).toHaveLength(0);
    await endTurn(crewmate, taskId, "Watching nothing else.");

    const [wake] = wakes(taskId);
    expect(wakes(taskId)).toHaveLength(1);
    expect(wake?.payload).toContain("Opened PR 97; every check is green.");
    expect(wake?.payload).not.toContain("Watching nothing else.");
    expect(tasks.get(taskId)?.outcome).toBe("Opened PR 97; every check is green.");

    // The headline is the report's own summary when it gave one, on the
    // record and on the feed's report line alike; a final text standing in
    // for a report never borrows one.
    expect(tasks.get(taskId)?.outcomeSummary).toBe("Opened PR 97; every check is green.");
    crewmate.emit({ type: "continuation_started" });
    spec.onReport?.(
      "Intent: ship the search.\nWhat changed: the search reads keys.",
      "  The search reads keys now.  ",
    );
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.emit({ type: "continuation_ended" });
    await tick();
    expect(tasks.get(taskId)?.outcomeSummary).toBe("The search reads keys now.");
    expect(events.filter((event) => event.type === "task_report").at(-1)).toMatchObject({
      summary: "The search reads keys now.",
    });

    // A report that is not plausible prose is refused with the fix.
    expect(() => spec.onReport?.("Done.")).toThrow(/Report refused: it has fewer than 2 words/);
    expect(() => spec.onReport?.("  ")).toThrow(/text is required/);
  });

  it("an implausible report is a failed turn, never an outcome, and the crewmate stays steerable", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks, inbox, wakes } = withSupervision(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Meter",
      intent: intentOf("fix"),
    });
    await tick();
    await endTurn(crewmate, taskId, "RGCTXDataിക്ഷassistant to=functions.bash 新天天彩票?");

    expect(events.some((event) => event.type === "task_report")).toBe(false);
    expect(tasks.get(taskId)?.outcome ?? null).toBeNull();
    expect(
      tasks
        .timeline(taskId)
        .some((event) => event.kind === "failed" && event.text.includes("report was set aside")),
    ).toBe(true);
    const [wake] = wakes(taskId);
    expect(wake?.payload).toContain("failed: its report was set aside because");
    expect(wake?.payload).toContain("still steerable");
    expect(wake?.payload).not.toContain("to=functions");
    // The brief it consumed reached the transcript: acked, not retried.
    expect(inbox.allFor(taskId)).toHaveLength(0);

    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    await supervisor.steer.steerCrewmate(taskId, "say that again in plain words");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("say that again in plain words");
  });

  it("the quiet watchdog still fires for a crewmate that never reports", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, wakes } = withSupervision(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Quiet",
      intent: intentOf("go"),
    });
    await tick();
    await endTurn(crewmate, taskId);
    expect(wakes(taskId)).toHaveLength(0);

    await supervisor.steer.steerCrewmate(taskId, "keep going");
    await tick();
    supervisor.watch.checkQuietTasks(Date.now() + QUIET_CARD_MS);
    expect(supervisor.cards.snapshot()).toEqual([]);
    expect(wakes(taskId).map((row) => row.payload)).toEqual([
      expect.stringContaining("has produced no events"),
    ]);
  });
});

// INF-2214 accepted plan, piece 1: the recorded remover answer must be
// submitted before continuing work can replace the ordinary turn report.
describe("INF-2214 reliable requested answers", () => {
  it("queues the full path immediately while background work and the answering turn continue", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, { hasRunningJobs: () => true });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Find remover",
      intent: intentOf("Find the full path on SHELL-PC"),
    });
    await tick();
    const poke = vi.fn();
    h.supervisor.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn(), pokeInbox: poke });
    await h.supervisor.steer.steerCrewmate(
      taskId,
      "What is the full path to setup/shell-pc/shell-pc-job-host-remove.cmd?",
      "firstmate",
      {
        response: { mode: "expected", sourceSession: "firstmate-session" },
      },
    );
    const request = h.inbox.pendingResponses(taskId)[0]!;
    expect(request).toMatchObject({ state: "pending", sourceSession: "firstmate-session" });
    expect(crewmate.steer.mock.calls[0]?.[0]).toContain(request.id);
    const text = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";
    const declaration = {
      responses: [
        { requestId: request.id, responseId: "path-answer", status: "answered" as const },
      ],
    };
    const receipt = await h.specs[0]?.onReport?.(text, undefined, declaration);
    expect(receipt).toContain("queued immediately");
    expect(poke).toHaveBeenCalledOnce();
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.facts)).toEqual([
      expect.objectContaining({
        kind: "requested-response",
        excerpt: text,
        contributorTask: taskId,
      }),
    ]);
    await h.specs[0]?.onReport?.("The checks are still running.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(h.inbox.savedResponse("path-answer")?.text).toBe(text);
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    expect(h.inbox.pendingResponses(taskId)).toEqual([]);
    h.supervisor.disposeAll();
  });

  it("reports a consumed clean turn's missing answer but not guidance-only or unread tail steers", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Find remover",
      intent: intentOf("Find the full path"),
    });
    await tick();
    await h.supervisor.steer.steerCrewmate(taskId, "Please keep checking.", "firstmate", {
      response: { mode: "guidance-only" },
    });
    expect(h.inbox.pendingResponses(taskId)).toEqual([]);
    await h.supervisor.steer.steerCrewmate(taskId, "What is its full path?", "firstmate", {
      response: { mode: "expected" },
    });
    const consumed = h.inbox.pendingResponses(taskId)[0]!;
    crewmate.holdSteers();
    await h.supervisor.steer.steerCrewmate(taskId, "Did the tests finish?", "firstmate", {
      response: { mode: "expected" },
    });
    const unread = h.inbox.pendingResponses(taskId)[1]!;
    await h.specs[0]?.onReport?.("The checks are still running.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.facts)).toEqual([
      expect.objectContaining({ kind: "response-missing", requestId: consumed.id }),
    ]);
    const nextInput = crewmate.promptCalls[1]!;
    expect(nextInput).toContain(unread.id);
    // The Claude refusal recovery journey requires kept guidance once.
    // Serving its current request does not need another copy in context.
    expect(nextInput.split(unread.body).length - 1).toBe(1);
    const snapshot = nextInput.slice(nextInput.indexOf(PENDING_RESPONSES_OPENING));
    expect(snapshot).toContain(consumed.id);
    expect(snapshot).not.toContain(unread.id);
    expect(snapshot).toContain(PENDING_RESPONSES_END);
    expect(h.inbox.pendingResponses(taskId)).toHaveLength(2);
    h.supervisor.disposeAll();
  });

  it("keeps card references factual, refuses stale lifecycles, and sends explicit cancellation without new expectations", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Find remover",
      intent: intentOf("Find the full path"),
    });
    await tick();
    const cardId = syncCardId(
      await h.specs[0]?.onCard?.({
        id: "path-question",
        title: "Find the remover",
        body: "<p>The target path is being checked.</p>",
        actions: [],
      }),
    );
    expect(cardId).toBeDefined();
    const thread = h.supervisor.cardActions.replyToCard(cardId!, "What is the full path?");
    const card = h.cardStore.get(cardId!)!;
    const reference = {
      id: cardId!,
      lifecycle: card.lifecycleId!,
      messageId: thread.messages.findLast((message) => message.who === "captain")!.id,
    };
    // INF-3718: a steer's wrong reference is refused with the card's current
    // lifecycle and captain messages, the facts nothing else shows the first mate.
    await expect(
      h.supervisor.steer.steerCrewmate(taskId, "Answer the path question.", "firstmate", {
        response: { mode: "expected", card: { ...reference, lifecycle: "resolved" } },
      }),
    ).rejects.toThrow(
      `Nothing changed. Card ${cardId}'s current lifecycle is ${reference.lifecycle}, with captain messages ${reference.messageId}. Name one of those messages in response_context, or leave response_context out.`,
    );
    // INF-4165 finding 6: the first mate names only the card and the
    // captain's message, never a lifecycle it is not shown. A message that
    // is not the captain's on the card is still refused.
    await expect(
      h.supervisor.steer.steerCrewmate(taskId, "Answer the path question.", "firstmate", {
        response: { mode: "expected", card: { id: cardId!, messageId: reference.messageId + 1 } },
      }),
    ).rejects.toThrow(`with captain messages ${reference.messageId}`);
    expect(h.inbox.pendingResponses(taskId)).toEqual([]);
    // The first try with the card and message is taken, and the request
    // records the card's current lifecycle the app filled in.
    await h.supervisor.steer.steerCrewmate(taskId, "Answer the path question.", "firstmate", {
      response: { mode: "expected", card: { id: cardId!, messageId: reference.messageId } },
    });
    const first = h.inbox.pendingResponses(taskId)[0]!;
    expect(first.card).toEqual(reference);
    const response = {
      requestId: first.id,
      responseId: "card-path-answer",
      status: "answered" as const,
    };
    await h.specs[0]?.onReport?.("The full path is verified.", undefined, {
      responses: [response],
    });
    await h.supervisor.steer.steerCrewmate(taskId, "Verify the result too.", "firstmate", {
      response: { mode: "expected", card: reference },
    });
    const pending = h.inbox.pendingResponses(taskId)[0]!;
    // The existing card writer records a new lifecycle; the old question
    // reference cannot silently answer a different reopened card.
    h.cardStore.upsert({ ...card, lifecycleId: "reopened-lifecycle" });
    await expect(
      Promise.resolve().then(() =>
        h.specs[0]?.onReport?.("A different result.", undefined, {
          responses: [{ requestId: pending.id, responseId: "stale-answer", status: "answered" }],
        }),
      ),
    ).rejects.toThrow("current lifecycle");
    expect(h.inbox.savedResponse("stale-answer")).toBeUndefined();
    // A retransmission of an already saved answer returns the prior result.
    await h.specs[0]?.onReport?.("The full path is verified.", undefined, {
      responses: [response],
    });
    expect(h.inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    await h.supervisor.steer.steerCrewmate(
      taskId,
      "That question no longer needs an answer.",
      "firstmate",
      { response: { mode: "guidance-only", cancel: [pending.id] } },
    );
    expect(h.inbox.pendingResponses(taskId)).toEqual([]);
    expect(crewmate.steer.mock.calls.at(-1)?.[0]).toContain(
      `cancelled response requests ${pending.id}`,
    );
    h.supervisor.disposeAll();
  });

  it.each(["provider", "interrupt"] as const)(
    "does not call a %s-cut turn a missing response",
    async (cut) => {
      const crewmate = fakeCrewmate();
      const h = setup(crewmate);
      const { taskId } = await h.supervisor.intake.commission({
        title: "Find remover",
        intent: intentOf("Find the full path"),
      });
      await tick();
      await h.supervisor.steer.steerCrewmate(taskId, "What is its full path?", "firstmate", {
        response: { mode: "expected" },
      });
      if (cut === "provider")
        crewmate.emit({ type: "turn_failed", taskId, error: "provider unavailable" });
      else await h.supervisor.sessions.interruptCrewmate(taskId, "interrupt");
      crewmate.finishPrompt();
      await tick();
      expect(
        h.inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => row.facts?.kind === "response-missing"),
      ).toEqual([]);
      expect(h.inbox.pendingResponses(taskId)).toHaveLength(1);
      h.supervisor.disposeAll();
    },
  );
});
