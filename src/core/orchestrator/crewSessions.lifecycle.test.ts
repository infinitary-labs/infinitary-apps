/**
 * A crewmate's session as `CrewSessions` runs it (docs/architecture.md
 * section 2): cancelling, interrupting and stopping it, the cancel purge, the
 * reasoning it opens at, a backend that mints its resume token only when the
 * first turn starts, and a file from outside saved in the task's hand-over
 * folder.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { crewmateTempDir } from "../paths";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { TaskProtocol } from "../tasks/taskProtocol";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it.each(["cancelled", "failed"] as const)(
    "retires every open card on a %s task without presenting deferred work",
    async (reason) => {
      const crewmate = fakeCrewmate();
      const { supervisor, cards, specs, tasks, cardStore, repos, workspace } = setup(crewmate);
      const { taskId } = await supervisor.intake.commission({
        title: "Retire the choices",
        intent: intentOf("do the work"),
      });
      await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
      const decision = {
        title: "Choose a course",
        body: "<p>Inspect the port hatch first.</p><p>It is closest; starboard takes longer.</p>",
        actions: [
          { id: "port", label: "Port", default: true },
          { id: "starboard", label: "Starboard" },
        ],
      };
      const emit = (id: string, extra = {}) => specs[0]?.onCard?.({ ...decision, id, ...extra });
      await emit("ready");
      await emit("answer");
      await emit("note", { actions: [] });
      specs[0]?.onReport?.("The choices are ready; the inspection continues.");
      await tick();
      const ids = ["ready", "answer", "note"].map((id) => `card-${taskId}-${id}`);
      await supervisor.cardActions.replyToCard(ids[1] as string, "Check the hinge first.");
      // An unreleased revision keeps the previous offer on the stage.
      await emit("ready", {
        body: "<p>Inspect the port hatch first.</p><p>Its hinge needs checking.</p>",
      });
      await emit("hidden");
      ids.push(`card-${taskId}-hidden`);
      ids.push(supervisor.addFirstmateCard({ ...decision, taskId }));
      supervisor.cards.hostCards.addAuthDecisionCard(
        "task-sign-in",
        "crewmate 1",
        "Sign in again.",
        {
          taskId,
        },
      );
      ids.push("task-sign-in");
      const other = supervisor.addFirstmateCard({ ...decision, title: "Another task's choice" });
      await tick();
      expect(supervisor.cards.snapshot().find((card) => card.id === ids[1])?.awaiting).toBe(
        "answer",
      );
      expect(supervisor.cards.snapshot().find((card) => card.id === ids[3])?.awaiting).toBe(
        "close-out",
      );
      expect(cardStore.history(ids[0] as string)).toHaveLength(1);
      const raisedBefore = tasks.timeline(taskId).filter((event) => event.kind === "card_raised");
      const protocol = new TaskProtocol({
        tasks,
        repos,
        cards: {
          listOpen: () => cardStore.listOpen(),
          snapshot: () => supervisor.cards.snapshot(),
        },
        broadcastEvent: () => {},
        emit: () => {},
      });
      try {
        expect(protocol.detail(taskId).waitingCardId).not.toBeNull();
        if (reason === "cancelled") await supervisor.sessions.interruptCrewmate(taskId, "cancel");
        crewmate.failPrompt(reason === "cancelled" ? "aborted" : "The client exited.");
        await tick();
        expect(tasks.get(taskId)).toMatchObject({
          status: "dropped",
          closedReason: reason,
          gate: null,
        });
        expect(protocol.detail(taskId)).toMatchObject({
          waitingCardId: null,
          flags: { needsYou: false },
        });
        expect(cards().map((card) => card.id)).toEqual([other]);
        expect(cardStore.listOpen().map((card) => card.id)).toEqual([other]);
        for (const id of ids) {
          expect(cardStore.get(id)).toBeDefined();
          expect(cardStore.chosenAction(id)).toBe(reason);
          expect(cardStore.observations(id).filter((entry) => entry.kind === "exit")).toMatchObject(
            [{ actor: "host", payload: { reason: "task-retired", note: reason } }],
          );
          expect(supervisor.cardActions.act(id, "port")).toEqual({});
        }
        expect(cardStore.history(ids[0] as string)).toHaveLength(1);
        expect(cardStore.messages(ids[1] as string).at(-1)?.text).toBe("Check the hinge first.");
        expect(tasks.timeline(taskId).filter((event) => event.kind === "card_raised")).toEqual(
          raisedBefore,
        );
        expect(workspace.removeTaskWorktree).toHaveBeenCalled();
      } finally {
        protocol.dispose();
      }
    },
  );

  it.each(["provider failure", "interruption"] as const)(
    "keeps cards on a resumable %s rather than treating it as terminal",
    async (boundary) => {
      const crewmate = fakeCrewmate();
      const { supervisor, specs, tasks, cardStore } = setup(crewmate);
      const { taskId } = await supervisor.intake.commission({
        title: "Inspect",
        intent: intentOf("inspect"),
      });
      await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
      await specs[0]?.onCard?.({
        id: "inspection",
        title: "Inspect port first",
        body: "<p>Inspect port first.</p><p>It is closest; starboard can wait.</p>",
        actions: [
          { id: "port", label: "Port", default: true },
          { id: "starboard", label: "Starboard" },
        ],
      });
      if (boundary === "interruption") {
        await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
        crewmate.failPrompt("aborted");
      } else {
        crewmate.emit({ type: "turn_failed", taskId, error: "Provider unavailable." });
        crewmate.finishPrompt();
      }
      await tick();
      expect(tasks.get(taskId)?.status).toBe("active");
      const id = `card-${taskId}-inspection`;
      expect(supervisor.cards.snapshot().map((card) => card.id)).toContain(id);
      expect(supervisor.cards.snapshot().find((card) => card.id === id)?.awaiting).toBeUndefined();
      expect(cardStore.chosenAction(id)).toBeUndefined();
      // Retire this test's now-idle runtime and pending retry through the real lifecycle.
      await supervisor.sessions.interruptCrewmate(taskId, "cancel");
      await tick();
    },
  );

  it("cancels through the lifecycle plane", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();
    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    crewmate.failPrompt("aborted");
    await tick();
    expect(events.filter((e) => e.type === "task_finished").at(-1)).toMatchObject({
      type: "task_finished",
      status: "cancelled",
      title: "long",
    });
    expect(cards()).toEqual([]);
  });

  // INF-3060's batch send-back: a spawn's start now runs behind the first
  // mate's answer, so the captain's cancel can arrive before the crewmate
  // exists; it was refused ("task still queued") and the task ran on.
  it("cancels a spawn whose start still runs behind the answer", async () => {
    let reached!: () => void;
    const classifying = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks } = setup(crewmate, {
      classifier: {
        classify: async () => {
          reached();
          await held;
          return { kind: "fix", source: "classifier:test", version: "kc1" };
        },
      },
    });
    const { taskId, crewmate: answer } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    expect(answer).toBe("starting");
    await classifying;
    const cancelling = supervisor.sessions.interruptCrewmate(taskId, "cancel");
    release();
    await cancelling;
    crewmate.failPrompt("aborted");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(events.filter((e) => e.type === "task_finished").at(-1)).toMatchObject({
      type: "task_finished",
      status: "cancelled",
      title: "long",
    });
  });

  // The captain's cancel bug (Nov 3, 2026): INF-2298 kept working after a
  // cancel that reported success, and FIRS-6, whose turn had started on its
  // own on another computer, stayed running after two. An abort asks the turn
  // to stop; the cancel itself ends the task, whether or not that turn ends.
  it.each([
    ["turn the host started", false],
    ["turn the crewmate started on its own", true],
  ])("ends a cancelled task when its %s never ends", async (_name, autonomous) => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();
    if (autonomous) {
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
      crewmate.emit({ type: "continuation_started" });
    }
    expect(legacyStateOf(tasks.get(taskId))).toBe("running");

    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();

    expect(crewmate.aborts).toHaveLength(1);
    expect(legacyStateOf(tasks.get(taskId))).toBe("cancelled");
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 0 });
    const finished = () => events.filter((event) => event.type === "task_finished");
    expect(finished()).toEqual([expect.objectContaining({ status: "cancelled", title: "long" })]);

    // The turn that ends late, if it ever does, changes nothing.
    if (autonomous) {
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.emit({ type: "continuation_ended" });
    } else {
      crewmate.failPrompt("aborted");
    }
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("cancelled");
    expect(finished()).toHaveLength(1);
  });

  // A merge batch failed crew-model-labels.spec.ts: the first mate's cancel
  // reached a crewmate whose working copy was still being made, so the
  // cancel only marked it, and the start then failed on that mark. The task
  // went back to waiting with no close and no closing note (INF-547). A
  // cancel that comes while a crewmate starts ends the task as that cancel,
  // with the first mate's sentence, whichever way the task was started.
  it.each([
    ["spawned", false],
    ["queued", true],
  ])("ends a %s task as the cancel that reached it while it started", async (_name, queued) => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks, workspace, paths } = setup(crewmate);
    const reached = deferred<string>();
    const made = deferred<void>();
    vi.mocked(workspace.createTaskWorktree).mockImplementationOnce(async (id: string) => {
      reached.resolve(id);
      await made.promise;
      return {
        taskId: id,
        cwd: join(paths.worktreesDir, id),
        branch: `fm/task-${id}`,
        repoDir: paths.defaultWorkspaceDir,
      };
    });
    const at = Date.now() + 60 * 60 * 1000;
    const commissioned = supervisor.intake.commission({
      title: "Second orbit example",
      intent: intentOf("draw the second orbit"),
      ...(queued ? { startAfter: { at } } : {}),
    });
    if (queued) {
      await commissioned;
      void supervisor.watch.sweepGates(at + 1000);
    }
    const taskId = await reached.promise;
    const sentence = "Dropped the second orbit example, as you asked.";
    await supervisor.sessions.interruptCrewmate(
      taskId,
      "cancel",
      { actor: "firstmate", via: "tool", decision: null },
      sentence,
    );
    made.resolve();
    await commissioned;
    await vi.waitFor(() =>
      expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "cancelled" }),
    );
    expect(
      tasks.timeline(taskId).find((event) => event.data?.reason === "cancelled")?.data,
    ).toMatchObject({ closingSentence: sentence });
    expect(events.filter((event) => event.type === "task_finished")).toEqual([
      expect.objectContaining({ taskId, status: "cancelled" }),
    ]);
    expect(crewmate.promptCalls).toEqual([]);
    await vi.waitFor(() => expect(workspace.removeTaskWorktree).toHaveBeenCalled());
  });

  it("cancels an idle reported task that stayed active until settled", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("open the pr"),
    });
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "PR opened." });
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");

    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    expect(legacyStateOf(tasks.get(taskId))).toBe("cancelled");
    expect(events.filter((e) => e.type === "task_finished").at(-1)).toMatchObject({
      type: "task_finished",
      status: "cancelled",
      title: "Ship it",
    });
  });

  it("does not relabel an already-closed task as cancelled", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks } = setup(crewmate);
    seedTask(tasks, {
      id: "t-done",
      title: "Already shipped",
      prompt: "done",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-done",
      sessionFile: null,
      accountId: null,
      status: "idle",
      createdAt: Date.now(),
    });
    await supervisor.settling.settle.settleTask("t-done", "land", undefined, "captain");
    await tick();
    expect(tasks.get("t-done")?.status).toBe("done");
    const finishedBefore = events.filter((e) => e.type === "task_finished").length;
    await supervisor.sessions.interruptCrewmate("t-done", "cancel");
    expect(tasks.get("t-done")).toMatchObject({ status: "done", closedReason: "landed" });
    expect(events.filter((e) => e.type === "task_finished").length).toBe(finishedBefore);
  });

  it("cancels a persist-only idle task that stayed active until settled", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks, cards, cardStore } = setup(crewmate);
    seedTask(tasks, {
      id: "t-idle",
      title: "Left idle",
      prompt: "work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-idle",
      sessionFile: null,
      accountId: null,
      status: "idle",
      createdAt: Date.now(),
    });
    const cardId = supervisor.addFirstmateCard({
      taskId: "t-idle",
      title: "Choose the next inspection",
      body: "<p>Inspect port first.</p><p>It is closest; starboard can wait.</p>",
      actions: [
        { id: "port", label: "Port", default: true },
        { id: "starboard", label: "Starboard" },
      ],
    });
    await tick();
    expect(cards().map((card) => card.id)).toEqual([cardId]);
    await supervisor.sessions.interruptCrewmate("t-idle", "cancel");
    await tick();
    expect(cards()).toEqual([]);
    expect(cardStore.chosenAction(cardId)).toBe("cancelled");
    expect(legacyStateOf(tasks.get("t-idle"))).toBe("cancelled");
    expect(events.filter((e) => e.type === "task_finished").at(-1)).toMatchObject({
      type: "task_finished",
      status: "cancelled",
      title: "Left idle",
    });
  });

  it("cancels a persist-only interrupted task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks } = setup(crewmate);
    seedTask(tasks, {
      id: "t-int",
      title: "Cut mid-turn",
      prompt: "work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-int",
      sessionFile: null,
      accountId: null,
      status: "interrupted",
      createdAt: Date.now(),
    });
    await supervisor.sessions.interruptCrewmate("t-int", "cancel");
    expect(legacyStateOf(tasks.get("t-int"))).toBe("cancelled");
    expect(events.filter((e) => e.type === "task_finished").at(-1)).toMatchObject({
      type: "task_finished",
      status: "cancelled",
      title: "Cut mid-turn",
    });
  });

  it("keeps the task steerable after an interrupt", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    crewmate.failPrompt("aborted");
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    // The interrupt is the Firstmate's own tool; its receipt is never a wake.
    expect(ops.some((line) => line.includes("interrupted"))).toBe(false);
    await supervisor.steer.steerCrewmate(taskId, "carry on");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("carry on");
  });

  it("records an abort request and only claims success after the transport confirms it", async () => {
    const crewmate = fakeCrewmate();
    crewmate.abort = vi.fn(async () => {});
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();

    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");

    expect(
      tasks
        .timeline(taskId)
        .filter((event) => event.kind === "interrupted")
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({ effect: "requested", error: null }),
      expect.objectContaining({ effect: "aborted-turn", error: null }),
    ]);
  });

  it("records a redacted abort failure without claiming the turn was aborted", async () => {
    const crewmate = fakeCrewmate();
    crewmate.abort = vi.fn(async () => {
      throw new Error("password=hunter2");
    });
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();

    await expect(supervisor.sessions.interruptCrewmate(taskId, "interrupt")).rejects.toThrow(
      "hunter2",
    );

    const events = tasks.timeline(taskId).filter((event) => event.kind === "interrupted");
    expect(events.map((event) => event.data?.effect)).toEqual(["requested", "abort-failed"]);
    expect(events.at(-1)?.data?.error).not.toContain("hunter2");
    expect(supervisor.facts.crewStatus(taskId)[0]?.status).toBe("running");
  });

  it("gives an interrupt the Firstmate asked for a feed-line receipt, never a wake", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();
    const opsBefore = ops.length;
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    crewmate.failPrompt("aborted");
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(ops.slice(opsBefore).filter((op) => op.includes("interrupted"))).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "firstmate_note",
        text: "Task long interrupted: it can still be told what to do",
      }),
    );
  });

  it("reads a turn its session settles quietly after an interrupt as the interrupt it asked for", async () => {
    // Pi and Claude alike settle the turn an interrupt cut short; neither throws.
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    crewmate.emit({ type: "assistant_delta", taskId, text: "Halfway through the rivet count." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    const receipts = () =>
      events.filter(
        (event) =>
          event.type === "firstmate_note" &&
          event.text === "Task long interrupted: it can still be told what to do",
      );
    expect(receipts()).toHaveLength(1);

    // The interrupt is spent: the next turn ends as an ordinary one.
    await supervisor.steer.steerCrewmate(taskId, "carry on");
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "Counted all forty rivets." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(receipts()).toHaveLength(1);
    expect(tasks.get(taskId)?.outcome).toBe("Counted all forty rivets.");
  });

  it("reads a continuation that ends after an interrupt as the interrupt it asked for", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "long",
      intent: intentOf("long running work"),
    });
    await tick();
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();

    // The backend resumed on its own; the Firstmate interrupts that work.
    crewmate.emit({ type: "continuation_started" });
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.emit({ type: "continuation_ended" });
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: "Task long interrupted: it can still be told what to do",
    });
  });

  it("announces an intelligence downgrade in the feed, never silently (P7)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "high",
        servedBucket: "medium",
        rule: "R8",
      },
    });
    await supervisor.intake.commission({
      title: "Big refactor",
      intent: intentOf("redesign the auth layer"),
    });
    await tick();
    const note = events.find((event) => event.type === "firstmate_note");
    expect(note && "text" in note ? note.text : "").toBe(
      '"Big refactor" is a hard task on a model for normal tasks. Your models for hard tasks have used up their allowance right now.',
    );
  });

  it("names a withheld account in the downgrade line, not a spent allowance (FI3-1375)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5-mini" },
        bucket: "high",
        servedBucket: "medium",
        withheld: { provider: CLAUDE_PROVIDER_ID, reason: "signed_out" },
        rule: "R8",
      },
    });
    await supervisor.intake.commission({
      title: "Big refactor",
      intent: intentOf("redesign the auth layer"),
    });
    await tick();
    const note = events.find((event) => event.type === "firstmate_note");
    expect(note && "text" in note ? note.text : "").toBe(
      '"Big refactor" is a hard task on a model for normal tasks. Claude\'s models for hard tasks are paused until you sign in again.',
    );
  });

  it("uses the actually served level's explicit choice exactly under Quick care", async () => {
    const choice = vi.fn(() => "high" as const);
    const { supervisor, sessionSpecs } = setup(fakeCrewmate(), {
      reasoningChoice: choice,
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-6.1-sol" },
        bucket: "high",
        servedBucket: "medium",
        rule: "R3",
      },
    });
    await supervisor.intake.commission({
      title: "Build the approved change",
      intent: intentOf("build from this plan"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    expect(choice).toHaveBeenCalledWith({ provider: "openai-codex", id: "gpt-6.1-sol" }, "medium");
    expect(sessionSpecs[0]?.thinking).toEqual({ level: "high" });
  });

  // FI3-1812: the captain names a reasoning effort for one task, the way he
  // names a model, without changing the model's choice in Settings.
  it("opens a task at the reasoning the captain named for it, over the model's saved choice and Quick care", async () => {
    const { supervisor, sessionSpecs } = setup(fakeCrewmate(), {
      reasoningChoice: () => "low",
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-6.1-sol" },
        bucket: "medium",
        servedBucket: "medium",
        rule: "R4",
      },
    });
    await supervisor.intake.commission({
      title: "Build the approved change",
      intent: intentOf("build from this plan at extra high reasoning"),
      shape: { rigor_ask: "quick", override_reasoning: "xhigh" },
    });
    await supervisor.intake.commission({
      title: "Build the next change",
      intent: intentOf("build the next part"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    expect(sessionSpecs.map((spec) => spec.thinking)).toEqual([
      { level: "xhigh" },
      { level: "low" },
    ]);
  });

  // FI3-1812 re-review W1: an effort named while the working copy is being
  // prepared is never recorded and then lost. The task is already active, so
  // the edit is refused in words, and the crewmate opens at what the record
  // holds when its session opens.
  it("never records a reasoning effort named while the working copy is being prepared without opening at it", async () => {
    const { supervisor, tasks, sessionSpecs, workspace, paths } = setup(fakeCrewmate(), {
      reasoningChoice: () => "low",
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-6.1-sol" },
        bucket: "medium",
        servedBucket: "medium",
        rule: "R4",
      },
    });
    const refusals: string[] = [];
    vi.mocked(workspace.createTaskWorktree).mockImplementation(async (id: string) => {
      try {
        tasks.updateFields(id, { reasoning: "xhigh" }, "firstmate");
      } catch (caught) {
        refusals.push(caught instanceof Error ? caught.message : String(caught));
      }
      return {
        taskId: id,
        cwd: join(paths.worktreesDir, id),
        branch: `fm/task-${id}`,
        repoDir: paths.defaultWorkspaceDir,
      };
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Build the approved change",
      intent: intentOf("build from this plan"),
    });
    await tick();
    expect(refusals).toEqual([
      "A reasoning effort can only be named on open work that no crewmate has taken.",
    ]);
    expect(tasks.get(taskId)?.shape).not.toHaveProperty("override_reasoning");
    expect(sessionSpecs[0]?.thinking).toEqual({ level: "low" });
  });

  it("records the reasoning the crewmate's session opened at beside its model", async () => {
    const crewmate = fakeCrewmate({ reasoning: { level: "high", lower: "quick" } });
    const { supervisor, tasks } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5" },
        bucket: "high",
        servedBucket: "high",
        rule: "R3",
      },
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Add a shortcut",
      intent: intentOf("add a shortcut that opens the Tasks panel"),
    });
    await tick();
    // INF-1288: a start records the actual serving model, not the route's choice.
    expect(tasks.archive.sessions(taskId)).toMatchObject([
      {
        conversation: crewmate.sessionId,
        provider: "fm-mock",
        model: "mock-1",
        began: "start",
        current: true,
      },
    ]);
    const dispatched = tasks.timeline(taskId).find((event) => event.kind === "dispatched");
    expect(dispatched?.data).toMatchObject({
      model: "fm-mock/mock-1",
      reasoning: { level: "high", lower: "quick" },
    });
  });

  it("stays quiet when the fallback went up a bucket, not down", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events } = setup(crewmate, {
      routeResult: {
        choice: { provider: "openai-codex", id: "gpt-5.5" },
        bucket: "low",
        servedBucket: "medium",
        rule: "R7",
      },
    });
    await supervisor.intake.commission({ title: "Tiny fix", intent: intentOf("fix a typo") });
    await tick();
    expect(events.find((event) => event.type === "firstmate_note")).toBeUndefined();
  });
});

describe("a backend that mints its resume token only when the first turn starts", () => {
  it("becomes resumable at the first turn end, not never", async () => {
    // A backend may mint its conversation id on the first turn rather than at
    // creation. Persisting only at creation would leave such a task
    // unresumable after a restart.
    const crewmate = fakeCrewmate();
    let token: string | undefined;
    const late: FakeCrewmate = {
      ...crewmate,
      resume: () => (token ? { backend: "claude", sessionId: token } : undefined),
      prompt: (text: string) => {
        token = "conversation-1";
        return crewmate.prompt(text);
      },
    };
    const { supervisor, tasks } = setup(late);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    expect(tasks.get(taskId)?.sessionFile).toBeNull();

    late.finishPrompt();
    await tick();
    expect(tasks.get(taskId)?.sessionFile).toBe("conversation-1");
  });
});

describe("the cancel purge (interaction P0, WI-2)", () => {
  it("cancelling a task with three pending rows leaves zero, and spares everyone else's", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const killJobs = vi.fn();
    const { supervisor, inbox, tasks } = setup(crewmate, { killJobs });
    const { taskId } = await supervisor.intake.commission({
      title: "Doomed",
      intent: intentOf("go"),
    });
    await tick();

    expect(await supervisor.steer.steerCrewmate(taskId, "one more thing")).toBe("queued-next-turn");
    inbox.enqueue("supervision", `[fm-op] crewmate 1 reported on task ${taskId}: stale`, taskId);
    inbox.enqueue("firstmate", `[fm-op] fleet event escalated to you (task ${taskId})`, taskId);
    inbox.enqueue("supervision", "[fm-op] another task's report", "other-task");
    inbox.enqueue("firstmate", "[fm-op] a notice about no task");
    const aboutTask = () => [
      ...inbox.allFor(taskId),
      ...inbox.allFor("supervision").filter((row) => row.ref === taskId),
      ...inbox.allFor("firstmate").filter((row) => row.ref === taskId),
    ];
    expect(aboutTask()).toHaveLength(3);

    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    crewmate.failPrompt("aborted");
    await tick();

    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(aboutTask()).toHaveLength(0);
    expect(killJobs).toHaveBeenCalledWith(taskId);
    expect(inbox.allFor("supervision").map((row) => row.ref)).toEqual(["other-task"]);
    expect(inbox.allFor("firstmate").map(renderWake)).toEqual(["[fm-op] a notice about no task"]);
  });

  it("an idle cancel purges a wake still queued about the task", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Idle",
      intent: intentOf("go"),
    });
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "Found it; the PR is open." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    inbox.enqueue("firstmate", `[fm-op] a wake about task ${taskId}`, taskId);
    expect(inbox.allFor("firstmate").filter((row) => row.ref === taskId)).toHaveLength(1);

    await supervisor.sessions.interruptCrewmate(taskId, "cancel");
    expect(inbox.allFor("firstmate").filter((row) => row.ref === taskId)).toHaveLength(0);
  });

  it("purges in the close's own transaction: a close that fails keeps every row", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Keep",
      intent: intentOf("go"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    inbox.enqueue("supervision", "[fm-op] a queued wake", taskId);

    vi.spyOn(tasks, "close").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(supervisor.settling.settle.settleTask(taskId, "discard")).rejects.toThrow(
      "disk full",
    );
    expect(inbox.allFor("supervision").filter((row) => row.ref === taskId)).toHaveLength(1);
    expect(tasks.get(taskId)?.status).toBe("active");
  });
});

// INF-2466, the captain's approved plan: a saved Gmail attachment lands "in
// the task's hand-over folder", which goes when the task closes.
describe("CrewSupervisor: a file from outside lands in the task's hand-over folder", () => {
  it("saves it byte for byte and 0600 for a running task here, and refuses a task that is not running", async () => {
    vi.useRealTimers();
    const h = setup(fakeCrewmate());
    const base = { repoId: null, sessionFile: null, accountId: null, createdAt: Date.now() };
    seedTask(h.tasks, { ...base, id: "t-save", title: "Check the invoice", status: "running" });
    seedTask(h.tasks, { ...base, id: "t-closed", title: "Dropped", status: "cancelled" });
    const pdf = randomBytes(48_211);

    const saved = await h.supervisor.sessions.saveOutsideFile("t-save", "invoice 2214.pdf", pdf);
    expect(saved.path).toBe(join(crewmateTempDir(h.paths, "t-save"), "handover", saved.file));
    expect(saved.file).toMatch(/^[0-9a-f]{16}-invoice_2214\.pdf$/);
    expect(readFileSync(saved.path).equals(pdf)).toBe(true);
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);

    expect(h.supervisor.sessions.outsideFileRefusal("t-closed")).toContain("not running");
    await expect(
      h.supervisor.sessions.saveOutsideFile("t-closed", "invoice.pdf", pdf),
    ).rejects.toThrow("not running");
  });
});
