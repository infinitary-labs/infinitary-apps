/**
 * The captain's card actions as `CardActions` dispatches them
 * (docs/card-threads.md): a merge click queued mid-turn and run at the idle
 * boundary, a revised action checked at dispatch, settle refusals and the
 * wakes they raise, and the replies typed under a card.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import { CARD_ANSWERS_TOO_LONG, type Card, REPLY_SETTINGS_HEAD } from "@shared/cards";
import { PLAIN_PROBLEM_FALLBACK } from "@shared/plainProblem";
import { describe, expect, it, vi } from "vitest";
import {
  answersPastBound,
  askedOn,
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  reboot,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  served,
  settleLines,
  settleWakes,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { pngImage } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { attachmentPath } from "../attachments";
import { initOverflowDir } from "../overflow";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { THREAD_STEER_PREAMBLE } from "./captainWakes";
import { cannotMergeText, discardedText } from "./settleWords";
import { renderWake, type WakeFacts } from "./wakes";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("durably queues a mid-turn merge click and runs it at the idle boundary without another click", async () => {
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #42 is in on GitHub." }));
    const { supervisor, tasks, specs, cards, events } = setup(crewmate, { mergePullRequest });
    const { taskId } = await supervisor.intake.commission({
      title: "Ship while reporting",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    // INF-2744: autonomy off, so the merge card waits for the captain's click.
    vi.spyOn(supervisor.facts, "taskAutonomy").mockReturnValue(false);
    specs[0]?.onCard?.({
      requiredActions: [],
      title: "Ready before the turn ends",
      body: completionBody("<p>The PR is ready.</p><p>CI is green on the tested head commit.</p>"),
      actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
    });
    await tick();
    const settle = cards().find((card) => card.title === "Ready before the turn ends") as Card;

    specs[0]?.onReport?.("The decision is ready.");
    supervisor.cardActions.act(settle.id, "merge");
    await tick();

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(tasks.get(taskId)?.pendingSettle).toMatchObject({
      mode: "merge-pr",
      actor: "captain",
    });
    expect(settleLines(tasks, taskId)).toEqual([
      "Merging once its crewmate finishes what it is doing",
    ]);

    crewmate.finishPrompt();
    await vi.waitFor(() => expect(mergePullRequest).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(tasks.get(taskId)).toMatchObject({
        status: "done",
        closedReason: "merged",
        pendingSettle: null,
      }),
    );
  });

  /** A merge click parked mid-turn, waiting for the turn's end. */
  async function mergeWaitingForTurn() {
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #42 is in on GitHub." }));
    const h = setup(crewmate, { mergePullRequest });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Ship while reporting",
      intent: intentOf("finish the PR"),
      shape: { rigor_ask: "quick" },
    });
    await tick();
    vi.spyOn(h.supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    vi.spyOn(h.supervisor.facts, "taskAutonomy").mockReturnValue(false);
    const click = h.supervisor.settling.settle.reportCardSettle(taskId, "merge-pr");
    await tick();
    expect(h.tasks.get(taskId)?.pendingSettle).toMatchObject({ mode: "merge-pr" });
    return { ...h, crewmate, mergePullRequest, taskId, click };
  }

  it("refuses another settle of a task while its merge click waits for the turn's end", async () => {
    const h = await mergeWaitingForTurn();
    const second = await h.supervisor.settling.settle.settleTaskGuarded(
      h.taskId,
      "merge-pr",
      undefined,
      "captain",
    );
    expect(second).toMatchObject({ ok: false, contention: true });
    const done = await h.supervisor.settling.done.close(h.taskId, {
      why: "finished",
      evidence: "the PR merged",
    });
    expect(done.text).toContain("another settle of it is already in progress");
    h.crewmate.finishPrompt();
    await expect(h.click).resolves.toMatchObject({ ok: true });
    expect(h.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  // INF-3307's audit, row 3: turning autonomy off cleared the parked intent,
  // the turn's end then skipped the wake, and the settle claim stuck until a
  // restart, refusing every later merge, drop or done close of the task.
  it("ends a merge click waiting for the turn's end when a policy change cancels it, and frees the task for the next settle", async () => {
    const h = await mergeWaitingForTurn();
    const record = h.tasks.get(h.taskId);
    const before = record ? h.tasks.policiesOf(record) : null;
    h.tasks.updateFields(h.taskId, { policies: { autonomy: false } }, "firstmate");
    h.supervisor.policiesChanged(h.taskId, { autonomy: false }, before);
    await expect(h.click).resolves.toMatchObject({ ok: false });
    expect(h.tasks.get(h.taskId)?.pendingSettle).toBeNull();
    // The captain's Activity line says why in plain words, never the task or a mode token.
    expect(settleLines(h.tasks, h.taskId).at(-1)).toBe(
      cannotMergeText("how it merges changed while its crewmate was working"),
    );
    h.crewmate.finishPrompt();
    await tick();
    expect(h.mergePullRequest).not.toHaveBeenCalled();
    await expect(
      h.supervisor.settling.settle.settleTaskGuarded(h.taskId, "merge-pr", undefined, "captain"),
    ).resolves.toMatchObject({ ok: true });
    expect(h.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("recovers a committed policy edit after a quit without resuming waiting work, and later serves it with the next turn", async () => {
    const original = fakeCrewmate();
    const { db, paths, workspace, tasks, supervisor } = setup(original);
    const { taskId } = await supervisor.intake.commission({
      title: "Waiting work",
      intent: intentOf("Keep working"),
    });
    await tick();
    original.finishPrompt();
    await tick();
    const task = tasks.get(taskId);
    if (!task) throw new Error("The commissioned task is missing");
    tasks.updateFields(task.id, { policies: { rigor: "quick" } }, "firstmate");
    // Quit before the edit's notice was queued.
    supervisor.disposeAll();
    const resumed = fakeCrewmate();
    const openSession = vi.fn(async () => resumed);
    const inbox = new InboxStore(db);
    const restartedTasks = new TaskService({ db, strict: true });
    const restarted = reboot({ paths, db, workspace }, openSession, {
      tasks: restartedTasks,
      inbox,
    });
    restarted.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
    await tick();
    await restarted.watch.sweepInbox(Date.now());
    expect(openSession).not.toHaveBeenCalled();
    expect(restartedTasks.get(task.id)).toMatchObject({ status: "active", activity: "idle" });
    expect(inbox.allFor(task.id).map((row) => row.facts)).toEqual([
      expect.objectContaining({
        kind: "task-policies-changed",
        policies: expect.objectContaining({ revision: 1 }),
      }),
    ]);
    await restarted.steer.steerCrewmate(task.id, "Continue the requested fix");
    await tick();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(resumed.promptCalls.join("\n")).toContain('"revision":1');
    resumed.finishPrompt();
    await tick();
    restarted.disposeAll();
  });

  it("resumes a durable queued merge after a supervisor restart", async () => {
    const { db, paths, workspace, tasks } = setup(fakeCrewmate());
    await Promise.resolve(); // Let the original supervisor's boot scan finish before seeding.
    seedTask(tasks, {
      id: "restart-merge",
      title: "Merge after restart",
      status: "idle",
      worktreeDir: "/work/restart-merge",
    });
    tasks.delivery.setPendingSettle("restart-merge", {
      mode: "merge-pr",
      actor: "captain",
      requestedAt: Date.now(),
      proceedWithOpen: false,
    });
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #43 is in on GitHub." }));
    const restartedTasks = new TaskService({ db, strict: true });
    const restarted = reboot(
      { paths, db, workspace },
      vi.fn(async () => fakeCrewmate()),
      { tasks: restartedTasks, mergePullRequest },
    );
    vi.spyOn(restarted.facts, "taskDelivery").mockReturnValue("direct-pr");
    restarted.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });

    await vi.waitFor(() => expect(mergePullRequest).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(restartedTasks.get("restart-merge")).toMatchObject({
        status: "done",
        closedReason: "merged",
        pendingSettle: null,
      }),
    );
  });

  it("checks a revised action's effect at frame dispatch time", async () => {
    const { supervisor, tasks, workspace } = setup(fakeCrewmate());
    seedTask(tasks, {
      id: "revision",
      title: "Revised settle",
      status: "idle",
      worktreeDir: "/work",
    });
    const cardId = supervisor.addFirstmateCard({
      id: "revision-gate",
      taskId: "revision",
      title: "Ready",
      body: "<p>Choose.</p>",
      actions: [{ id: "land", label: "Ask the author", default: true }],
    });
    supervisor.addFirstmateCard({
      requiredActions: [],
      id: "revision-gate",
      taskId: "revision",
      title: "Ready",
      body: "<p>Choose.</p>",
      actions: [{ id: "land", label: "Land", default: true, effect: SETTLE_MERGE }],
    });

    expect(() => supervisor.cardActions.act(cardId, "land", "frame", { tiltDeg: 42 })).toThrow(
      "available only from the card controls",
    );
    expect(supervisor.cards.snapshot().some((card) => card.id === cardId)).toBe(true);
    expect(workspace.landTaskWork).not.toHaveBeenCalled();
    expect(tasks.get("revision")?.status).toBe("active");

    supervisor.cardActions.act(cardId, "land", "chrome");
    await vi.waitFor(() => expect(workspace.landTaskWork).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(tasks.get("revision")?.status).toBe("done"));
  });

  it("keeps what a choice was made on beside it: the offer shown and the task before it moved (docs/card-evidence.md)", async () => {
    const { supervisor, tasks, workspace, cardStore } = setup(fakeCrewmate());
    seedTask(tasks, { id: "ship", title: "Ship it", status: "idle", worktreeDir: "/work" });
    const cardId = supervisor.addFirstmateCard({
      requiredActions: [],
      id: "ship-gate",
      taskId: "ship",
      title: "Ready",
      body: "<p>Choose.</p>",
      actions: [{ id: "land", label: "Land", default: true, effect: SETTLE_MERGE }],
    });
    const shown = supervisor.cards.snapshot().find((card) => card.id === cardId) as Card;

    supervisor.cardActions.act(cardId, "land", "chrome", undefined, {
      id: "gesture-0100",
      lifecycleId: shown.lifecycleId,
      offerId: shown.offerId,
    });
    await vi.waitFor(() => expect(workspace.landTaskWork).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(tasks.get("ship")?.status).toBe("done"));

    const action = cardStore.observations(cardId).find((entry) => entry.kind === "action");
    expect(action).toMatchObject({
      actor: "captain",
      offerId: shown.offerId,
      interactionId: "gesture-0100",
      payload: {
        actionId: "land",
        recognized: true,
        effect: SETTLE_MERGE,
        display: { fidelity: "matched" },
        // The task as it stood when the choice was admitted, not as it ended.
        context: { taskId: "ship", status: "active", activity: "idle", blockers: [] },
      },
    });
  });

  it("records a body script's declared action and refuses an undeclared id", () => {
    const { supervisor, tasks, cardStore } = setup(fakeCrewmate());
    seedTask(tasks, { id: "look", title: "Tune it", status: "idle" });
    const scripted = supervisor.addFirstmateCard({
      id: "scripted",
      taskId: "look",
      title: "Tune",
      body: "<p>Tune it.</p>",
      actions: [{ id: "use", label: "Use this", default: true }],
    });
    supervisor.cardActions.act(scripted, "use", "frame", { tiltDeg: 42 });
    const stray = supervisor.addFirstmateCard({
      id: "stray",
      taskId: "look",
      title: "Pick",
      body: "<p>Pick.</p>",
      actions: [{ id: "go", label: "Go", default: true }],
    });
    const before = tasks.timeline("look");
    expect(() => supervisor.cardActions.act(stray, "not-offered", "chrome")).toThrow(
      "This choice is not offered on this card",
    );
    expect(supervisor.cards.snapshot().some((card) => card.id === stray)).toBe(true);
    expect(cardStore.chosenAction(stray)).toBeUndefined();
    expect(tasks.timeline("look")).toEqual(before);

    const actionOf = (id: string) =>
      cardStore.observations(id).find((entry) => entry.kind === "action");
    expect(actionOf(scripted)).toMatchObject({
      actor: "frame",
      source: "frame",
      payload: { actionId: "use", frameValue: '{"tiltDeg":42}', recognized: true },
    });
    expect(actionOf(stray)).toBeUndefined();
  });

  // INF-3169's piece 4, the captain's pick "Also fold the three into one
  // drop": the captain's own Discard click is the one drop, which passes the work holds
  // and keeps the unmerged work saved; the first mate alone still waits for
  // that choice.
  it("drops unmerged work on the captain's Discard click, keeping it saved, while the first mate's own discard waits for confirm", async () => {
    const { supervisor, tasks, workspace, ops } = setup(fakeCrewmate());
    for (const id of ["dirty", "alone"])
      seedTask(tasks, { id, title: "Unlanded", status: "idle", worktreeDir: `/${id}` });
    vi.mocked(workspace.taskWorkStatus).mockResolvedValue({ dirty: true, unlandedCommits: 2 });
    const refusal = await supervisor.settling.settle.settleTask("alone", "discard");
    expect(refusal).toContain("2 commits and uncommitted edits that were never merged");
    expect(tasks.get("alone")?.status).toBe("active");
    expect(await supervisor.settling.settle.settleTask("alone", "discard", true)).toBe(
      discardedText(),
    );

    const id = supervisor.addFirstmateCard({
      taskId: "dirty",
      title: "Settle",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "discard", label: "Discard", default: true, effect: SETTLE_DISCARD }],
    });
    supervisor.cardActions.act(id, "discard");
    await vi.waitFor(() => expect(settleWakes(ops)).toHaveLength(1));
    expect(settleWakes(ops)[0]).toContain(`the outcome was: ${discardedText()}`);
    expect(tasks.get("dirty")).toMatchObject({ status: "dropped", closedReason: "discarded" });
    // Its work is saved before its working copy goes, as every close saves it.
    expect(workspace.retireTaskWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "dirty", cwd: "/dirty" }),
      expect.anything(),
    );
  });

  it("stays quiet on contention, which settles nothing and has no outcome to report", async () => {
    const operation = deferred<{ dirty: boolean; unlandedCommits: number }>();
    const { supervisor, tasks, workspace, ops } = setup(fakeCrewmate());
    seedTask(tasks, { id: "busy", title: "Contended", status: "idle", worktreeDir: "/work" });
    vi.mocked(workspace.taskWorkStatus).mockReturnValue(operation.promise);
    const offer = () =>
      supervisor.addFirstmateCard({
        taskId: "busy",
        title: "Settle",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [{ id: "discard", label: "Discard", default: true, effect: SETTLE_DISCARD }],
      });
    const first = offer();
    const second = offer();

    supervisor.cardActions.act(first, "discard");
    supervisor.cardActions.act(second, "discard"); // Refused: the first settle owns the task.
    operation.resolve({ dirty: false, unlandedCommits: 0 });

    // One wake for the settle that ran, none for the one that was turned
    // away - announcing a settle that never happened is not an outcome.
    await vi.waitFor(() => expect(settleWakes(ops)).toHaveLength(1));
    expect(settleWakes(ops)[0]).toContain(`the outcome was: ${discardedText()}`);
    expect(settleWakes(ops).join("\n")).not.toContain("already in progress");
  });

  it("wakes on every settle refusal and failure, and on a discard, with no host-side sorting", async () => {
    const mergePullRequest = vi.fn(async () => ({
      ok: false,
      text: "PR merge blocked: CI is red.",
    }));
    const { supervisor, tasks, workspace, ops } = setup(fakeCrewmate(), { mergePullRequest });
    for (const id of ["clean", "land", "merge"]) {
      seedTask(tasks, { id, title: `Task ${id}`, status: "idle", worktreeDir: `/${id}` });
    }
    vi.mocked(workspace.landTaskWork).mockRejectedValue(new Error("The main worktree is dirty."));
    vi.spyOn(supervisor.facts, "taskDelivery").mockImplementation((taskId) =>
      taskId === "merge" ? "direct-pr" : "local-only",
    );
    const offer = (taskId: string, action: string) =>
      supervisor.addFirstmateCard({
        requiredActions: [],
        taskId,
        title: "Settle",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [
          {
            id: action,
            label: action,
            default: true,
            effect: action === "discard" ? SETTLE_DISCARD : SETTLE_MERGE,
          },
        ],
      });

    supervisor.cardActions.act(offer("clean", "discard"), "discard");
    supervisor.cardActions.act(offer("land", "land"), "land");
    supervisor.cardActions.act(offer("merge", "merge-pr"), "merge-pr");

    await vi.waitFor(() => expect(settleWakes(ops)).toHaveLength(3));
    const wake = (taskId: string) =>
      settleWakes(ops).find((line) => line.includes(`for task ${taskId} `)) ?? "";
    // A discard is an outcome too: the agent is told what its crew's work
    // became, and decides for itself whether that is worth a word.
    expect(wake("clean")).toContain(`the outcome was: ${discardedText()}`);
    expect(wake("land")).toContain("Cannot merge: The main worktree is dirty.");
    expect(wake("merge")).toContain("PR merge blocked: CI is red.");
  });

  // Friction 7 of the captain's Oct 22 audit (INF-834), his words: "The
  // merge-settled wake fires only when the merge failed or unblocked a
  // decision". 45 of 62 merge wakes were turns that said nothing.
  it.each(["land", "merge-pr"] as const)(
    "a %s that goes through is a feed line, and wakes only when it frees work only a start begins",
    async (mode) => {
      const { supervisor, tasks, events, ops } = setup(fakeCrewmate(), {
        mergePullRequest: async () => ({ ok: true, text: "Merged #9 on GitHub." }),
      });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue(
        mode === "merge-pr" ? "direct-pr" : "local-only",
      );
      const merge = (taskId: string) =>
        supervisor.cardActions.act(
          supervisor.addFirstmateCard({
            requiredActions: [],
            taskId,
            title: "Merge it",
            body: "<p>The change is ready.</p><p>Merging puts it on main.</p>",
            actions: [{ id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE }],
          }),
          "merge",
        );
      const closed = (taskId: string) =>
        vi.waitFor(() => expect(tasks.get(taskId)?.status).toBe("done"));
      // INF-1845: the merge's line is its task's close, which the click's line gives way to.
      const feed = (taskId: string) =>
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === (mode === "land" ? "landed" : "merged"));

      // Nothing waits on it: the feed line is the whole receipt.
      seedTask(tasks, { id: "plain", title: "Plain", status: "idle", worktreeDir: "/plain" });
      merge("plain");
      await closed("plain");
      await tick();
      expect(feed("plain").length).toBeGreaterThan(0);
      expect(settleWakes(ops)).toEqual([]);

      // Work that starts by itself once it merges is no decision: the queue owns it.
      seedTask(tasks, { id: "fix", title: "Fix", status: "idle", worktreeDir: "/fix" });
      seedTask(tasks, {
        id: "next",
        title: "Continue: the rest",
        status: "queued",
        startPolicy: "when-ready",
      });
      tasks.graph.link("fix", "next", "blocks", "firstmate");
      merge("fix");
      await closed("fix");
      await tick();
      expect(settleWakes(ops)).toEqual([]);

      // Work that waits on another task too is still held: no decision yet.
      seedTask(tasks, { id: "half", title: "Half", status: "idle", worktreeDir: "/half" });
      seedTask(tasks, { id: "other", title: "Other", status: "queued", startPolicy: "on-request" });
      seedTask(tasks, { id: "both", title: "Both", status: "queued", startPolicy: "on-request" });
      tasks.graph.link("half", "both", "blocks", "firstmate");
      tasks.graph.link("other", "both", "blocks", "firstmate");
      merge("half");
      await closed("half");
      await tick();
      expect(settleWakes(ops)).toEqual([]);

      // A task the first mate linked to wait on it - one the merged report
      // says it covers - now waits on a start alone: the merge wakes it once.
      seedTask(tasks, { id: "covers", title: "Covers", status: "idle", worktreeDir: "/covers" });
      seedTask(tasks, {
        id: "covered",
        title: "Covered",
        status: "queued",
        startPolicy: "on-request",
      });
      tasks.graph.link("covers", "covered", "blocks", "firstmate");
      merge("covers");
      await vi.waitFor(() => expect(settleWakes(ops)).toHaveLength(1));
      expect(settleWakes(ops)[0]).toContain(`the captain chose ${mode} for task covers "Covers"`);
      expect(tasks.get("covered")?.status).toBe("open");
    },
  );

  // INF-87 P1: the existing queue, not a first-mate continuation turn, owns later starts.
  it.each(
    (["card", "tool", "detailed"] as const).flatMap((via) =>
      (["land", "merge-pr", "discard", "refused"] as const).map((outcome) => ({ via, outcome })),
    ),
  )(
    "$via / $outcome starts ready pieces, whose crew asks at captain-only actions",
    async ({ via, outcome }) => {
      const { supervisor, tasks, workspace, sessions, specs, cardStore } = setup(fakeCrewmate(), {
        mergePullRequest: async () => ({ ok: true, text: "Change #9 is in on GitHub." }),
      });
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue(
        outcome === "merge-pr" ? "direct-pr" : "local-only",
      );
      const wakes: WakeFacts[] = [];
      supervisor.setFirstmateHooks({
        notifyOp: (wake) => {
          if (typeof wake === "object" && "facts" in wake && wake.facts) wakes.push(wake.facts);
        },
        retryConverse: vi.fn(),
      });
      // P3: an approved answer need not be classified as a plan.
      seedTask(tasks, {
        id: "P",
        title: "Approved work",
        status: "queued",
        startPolicy: "on-request",
      });
      seedTask(tasks, {
        id: "PLAN",
        title: "The plan",
        status: "idle",
        parentId: "P",
        shape: { kind: "research", deliverable: "answer" },
      });
      tasks.turns.recordReport("PLAN", {
        text: "Build the two approved repairs after the foundation merges; keep the other work held.",
      });
      tasks.close("PLAN", { status: "done", reason: "answered", actor: "captain" });
      seedTask(tasks, {
        id: "root",
        title: "Foundation",
        status: "idle",
        worktreeDir: "/root",
        shape: { kind: "implement", autonomy_ask: true },
      });
      for (const id of [
        "first",
        "second",
        "captain-action",
        "blocked",
        "other",
        "gated",
        "unrelated",
        "manual",
        "unapproved",
        "backlog",
      ]) {
        seedTask(tasks, {
          id,
          title: id,
          status: "queued",
          startPolicy: [
            "first",
            "second",
            "captain-action",
            "blocked",
            "gated",
            "backlog",
          ].includes(id)
            ? "when-ready"
            : "on-request",
          ...(id !== "manual"
            ? {
                parentId: "P",
                shape: {
                  kind: "implement" as const,
                  basis: "PLAN",
                },
              }
            : {}),
        });
        if (id !== "other" && id !== "unrelated") tasks.graph.link("root", id, "blocks", "host");
      }
      tasks.graph.link("other", "blocked", "blocks", "host");
      // INF-269 Q1: a plan-named action is not a host-set gate before dispatch.
      tasks.updateFields(
        "captain-action",
        {
          goal: "Prepare Infinitary for the App Store; ask the captain before signing or submission.",
        },
        "host",
      );
      // An already recorded captain decision remains a real hold, unlike words in a plan.
      tasks.placement.setGate(
        "gated",
        { kind: "captain", ref: "later-choice" },
        "An existing captain decision holds this task.",
      );
      tasks.starts.setQueued("backlog", "unqueue-task", { actor: "captain" });
      for (const status of ["idle", "cancelled"] as const) {
        seedTask(tasks, { id: status, title: status, status, startPolicy: "on-request" });
        tasks.graph.link("root", status, "blocks", "host");
      }
      if (outcome === "refused")
        vi.mocked(workspace.landTaskWork).mockRejectedValue(
          new Error("The main worktree is dirty."),
        );
      const card = supervisor.addFirstmateCard({
        requiredActions: [],
        taskId: "root",
        title: "Settle the foundation",
        body: "Choose what happens to this work.",
        actions: [
          {
            id: "settle",
            label: outcome,
            effect: outcome === "discard" ? SETTLE_DISCARD : SETTLE_MERGE,
          },
        ],
      });
      let text: string;
      let wake: Extract<WakeFacts, { kind: "settled" }> | undefined;
      if (via === "card") {
        supervisor.cardActions.act(card, "settle");
        await vi.waitFor(() => expect(wakes.some((wake) => wake.kind === "settled")).toBe(true));
        wake = wakes.find((wake) => wake.kind === "settled");
        text = renderWake({ facts: wake! });
      } else {
        const mode =
          outcome === "discard" ? "discard" : outcome === "merge-pr" ? "merge-pr" : "land";
        text =
          via === "tool"
            ? await supervisor.settling.settle.settleTask("root", mode)
            : (await supervisor.settling.settle.settleTaskDetailed("root", mode)).text;
        expect(wakes.filter((wake) => wake.kind === "settled")).toEqual([]);
      }
      const merged = outcome === "land" || outcome === "merge-pr";
      const opened = () => sessions.open.mock.calls.map(([spec]) => spec.owner);
      if (merged) {
        // No start_now, manual sweep or first-mate reply: settlement owns the recheck.
        await vi.waitFor(() =>
          expect(opened()).toEqual(expect.arrayContaining(["first", "second", "captain-action"])),
        );
        for (const id of ["first", "second", "captain-action"])
          expect(tasks.get(id)?.status).toBe("active");
        expect(tasks.get("captain-action")?.gate).toBeNull();
        const crew = specs.find((spec) => spec.taskId === "captain-action")!;
        const answer = await bindTool(EMIT_CARD_TOOL, crew).run({
          title: "Infinitary needs your signing decision",
          body: "<p>Infinitary needs your signing decision.</p><p>The approved plan reserves signing and submission for you; nothing has been signed or submitted.</p>",
          asking: true,
          actions: [
            { id: "review", label: "Review signing", default: true },
            { id: "wait", label: "Leave waiting" },
          ],
        });
        const decision = cardStore.listOpen().find((card) => card.taskId === "captain-action")!;
        expect(answer.text).toContain(decision.id);
        expect(decision.actions.map((action) => action.effect)).toEqual([undefined, undefined]);
        await vi.waitFor(() =>
          expect(tasks.get("captain-action")?.gate).toMatchObject({
            kind: "captain",
            ref: decision.id,
          }),
        );
      } else {
        for (const id of ["first", "second", "captain-action"]) {
          expect(tasks.get(id)?.status).toBe("open");
          expect(opened()).not.toContain(id);
        }
      }
      for (const id of ["manual", "unapproved", "backlog", "blocked", "gated", "unrelated"]) {
        expect(tasks.get(id)?.status).toBe("open");
        expect(opened()).not.toContain(id);
        expect(text).not.toContain(`"${id}"`);
      }
      expect(tasks.get("backlog")?.startPolicy).toBe("on-request");
      expect(tasks.get("gated")?.gate).toEqual({ kind: "captain", ref: "later-choice" });
    },
  );

  it("refs a shell settle wake after the close purge so it survives and anchors the turn", async () => {
    const { supervisor, tasks, inbox } = setup(fakeCrewmate());
    supervisor.setFirstmateHooks({
      notifyOp: (text, origin, ref) => {
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, text, origin, ref);
      },
      retryConverse: vi.fn(),
    });
    seedTask(tasks, { id: "shell", title: "Leftover", status: "idle", worktreeDir: "/work" });
    inbox.enqueue(FIRSTMATE_RECIPIENT, "stale wake", "shell");

    await supervisor.settling.settle.requestDiscard("shell");

    const rows = inbox.allFor(FIRSTMATE_RECIPIENT);
    expect(rows.map((row) => row.ref)).toEqual(["shell"]);
    expect(rows.map(renderWake)[0]).toContain(
      'the captain chose discard for task shell "Leftover"',
    );
  });

  it("never wakes for the Firstmate's own settle_task refusal", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, workspace, ops } = setup(crewmate);
    seedTask(tasks, { id: "done", title: "Half-done", status: "idle", worktreeDir: "/work" });
    vi.mocked(workspace.taskWorkStatus).mockResolvedValue({ dirty: true, unlandedCommits: 1 });

    // The agent's own tool call already receives this text as its result.
    expect(await supervisor.settling.settle.settleTask("done", "discard")).toContain(
      "uncommitted edits",
    );
    expect(settleWakes(ops)).toEqual([]);
  });

  it("catches a rejected merge, releases its guard, and permits an independent task while it waits", async () => {
    const operation = deferred<{ ok: boolean; text: string }>();
    const mergePullRequest = vi.fn(() => operation.promise);
    const { supervisor, tasks } = setup(fakeCrewmate(), { mergePullRequest });
    seedTask(tasks, { id: "merge", title: "PR", status: "idle", worktreeDir: "/pr" });
    seedTask(tasks, { id: "other", title: "Other", status: "idle", worktreeDir: "/other" });
    vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
    const id = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "merge",
      title: "Settle",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "merge-pr", label: "Merge PR", default: true, effect: SETTLE_MERGE }],
    });
    supervisor.cardActions.act(id, "merge-pr");
    expect(
      await supervisor.settling.settle.settleTask("merge", "land", undefined, "captain"),
    ).toContain("already in progress");
    expect(
      await supervisor.settling.settle.settleTask("merge", "merge-pr", undefined, "captain"),
    ).toContain("already in progress");
    expect(await supervisor.settling.settle.settleTask("other", "discard")).toBe(discardedText());
    operation.reject(new Error("GitHub is unreachable"));
    // The feed says what it means; the raw failure is kept on the record.
    await vi.waitFor(() =>
      expect(settleLines(tasks, "merge")).toContain(cannotMergeText(PLAIN_PROBLEM_FALLBACK)),
    );
    expect(tasks.timeline("merge").find((event) => event.data?.problem)).toMatchObject({
      kind: "note",
      feed: false,
      text: "Could not complete merge-pr for task merge: GitHub is unreachable",
    });
    mergePullRequest.mockResolvedValue({ ok: false, text: "PR merge blocked: CI is red." });
    expect(
      await supervisor.settling.settle.settleTask("merge", "merge-pr", undefined, "captain"),
    ).toBe("PR merge blocked: CI is red.");
    expect(mergePullRequest).toHaveBeenCalledTimes(2);
  });

  it("reports landing refusals and shell discard failures instead of dropping them", async () => {
    const { supervisor, tasks, workspace, events } = setup(fakeCrewmate());
    seedTask(tasks, { id: "land", title: "Branch", status: "idle", worktreeDir: "/work" });
    vi.mocked(workspace.landTaskWork).mockRejectedValue(new Error("The main worktree is dirty."));
    const id = supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "land",
      title: "Settle",
      body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
      actions: [{ id: "land", label: "Land", default: true, effect: SETTLE_MERGE }],
    });
    supervisor.cardActions.act(id, "land");
    await vi.waitFor(() =>
      expect(settleLines(tasks, "land")).toContain(cannotMergeText(PLAIN_PROBLEM_FALLBACK)),
    );
    expect(tasks.timeline("land").find((event) => event.data?.problem)).toMatchObject({
      kind: "note",
      text: "Cannot merge: The main worktree is dirty.",
      data: { problem: "The main worktree is dirty." },
    });
    vi.mocked(workspace.removeTaskWorktree).mockRejectedValue(new Error("Cleanup failed."));
    await supervisor.settling.settle.requestDiscard("land");
    expect(settleLines(tasks, "land")).toContain(`Could not discard: ${PLAIN_PROBLEM_FALLBACK}`);
    // The row closed but its worktree is still there, so a second discard
    // retries the cleanup instead of claiming there is nothing left (WI-7).
    expect(tasks.get("land")).toMatchObject({ status: "dropped", workspaceState: "present" });
    vi.mocked(workspace.removeTaskWorktree).mockResolvedValue(undefined);
    expect(await supervisor.settling.settle.settleTask("land", "discard")).toBe(discardedText());
    expect(tasks.get("land")).toMatchObject({
      status: "dropped",
      closedReason: "discarded",
      workspaceState: "removed",
    });
  });
});

/**
 * Cards as threads, phase 1 (captain-approved 2026-09-20, R4 of
 * `fm3000-card-close-decision-model-s1`). A card is the head of a
 * conversation with its author, and what the captain types under a
 * crewmate's card is a captain steer to that crewmate - never a Firstmate
 * turn, and never a close.
 */
describe("CrewSupervisor: the card thread", () => {
  function withRequiredAction() {
    const h = setup(fakeCrewmate());
    seedTask(h.tasks, {
      id: "required-source",
      title: "Update the setup files",
      status: "completed",
    });
    h.tasks.delivery.declareRequiredActions(
      "required-source",
      {
        cardId: "card-source",
        offerId: "offer-source",
        actions: [
          {
            id: "rebuild",
            target: "the computer",
            title: "Rebuild the setup",
            consequence: "The new setup is not running yet.",
            instructions: ["Rebuild using the updated files."],
            criterion: "The rebuild succeeds.",
            prerequisites: [],
            completion: { kind: "manual", label: "The rebuild succeeded" },
          },
        ],
      },
      true,
    );
    const row = h.tasks.listOpen().find((task) => task.delivery?.captainAction);
    expect(row).toBeDefined();
    const taskId = row?.id ?? "missing";
    h.supervisor.cards.presentRequiredAction(taskId);
    const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId) as Card;
    return { h, taskId, card };
  }

  it("INF-1137 friction 2 keeps failure output and repair replies on a required-action card without confirming it", async () => {
    const { h, taskId, card } = withRequiredAction();
    const converse = vi.fn();
    h.supervisor.setFirstmateHooks({
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      converseAboutCard: converse,
    });
    const output = "It failed. Output: error: Cannot build fm-placer-0.1.0.drv";
    h.supervisor.cardActions.replyToCard(card.id, output);
    expect(converse).toHaveBeenCalledWith(card.id, output, undefined);
    expect(() => h.supervisor.cardActions.act(card.id, "confirm")).toThrow();
    // Reopening and repeating a refused confirmation must not erase the pending reply.
    h.supervisor.cards.presentRequiredAction(taskId);
    expect(() => h.supervisor.cardActions.act(card.id, "confirm")).toThrow();
    expect(h.tasks.get(taskId)?.status).toBe("open");
    expect(h.supervisor.cards.thread(card.id).messages).toMatchObject([
      { who: "captain", text: output },
    ]);
    const answer =
      "I have asked the crew to repair the setup files. Keep the rebuild unconfirmed until it succeeds.";
    expect(
      h.supervisor.addFirstmateCard({
        id: card.id,
        title: "Ignored replacement",
        body: "<p>Ignored instructions</p>",
        actions: [],
        reply: answer,
        answersMessage: askedOn(h.supervisor, card.id),
      }),
    ).toBe(card.id);
    const current = h.supervisor.cards.snapshot().find((entry) => entry.id === card.id);
    expect(current).toMatchObject({
      body: card.body,
      title: card.title,
      actions: card.actions,
      offerId: card.offerId,
    });
    expect(h.supervisor.cards.thread(card.id).messages.at(-1)).toMatchObject({
      who: "firstmate",
      text: answer,
    });
    expect(h.tasks.get(taskId)?.status).toBe("open");
    // Only the captain's explicit success confirmation completes the operation.
    h.supervisor.cardActions.act(card.id, "confirm");
    expect(h.tasks.get(taskId)?.delivery?.captainAction?.state).toBe("confirmed");
    await tick();
  });
  it("INF-1160 sends a normal required-action failure choice and its output, then reoffers the outstanding action", async () => {
    const { h, taskId, card } = withRequiredAction();
    const converse = vi.fn();
    h.supervisor.setFirstmateHooks({
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      converseAboutCard: converse,
    });
    const output = "error: Cannot build fm-placer-0.1.0.drv";
    const answers = [{ name: "anything_else", values: [], changed: true, written: output }];
    expect(card.actions.find((action) => action.id === "failed")).toMatchObject({
      label: "It failed",
    });
    h.supervisor.cardActions.act(card.id, "failed", "chrome", { answers });
    const reopened = h.supervisor.cards.snapshot().find((entry) => entry.id === card.id) as Card;
    expect(reopened.offerId).not.toBe(card.offerId);
    expect(reopened).toMatchObject({
      title: card.title,
      body: card.body,
      actions: card.actions,
      awaiting: "answer",
    });
    expect(h.tasks.get(taskId)?.status).toBe("open");
    expect(h.supervisor.cards.thread(card.id).messages.at(-1)).toMatchObject({
      who: "captain",
      text: `It failed\n\n${output}`,
    });
    expect(converse).toHaveBeenCalledWith(card.id, `It failed\n\n${output}`, undefined);
    expect(() => h.supervisor.cardActions.act(card.id, "confirm")).toThrow();
    await tick();
  });
  // INF-2225, carrying out INF-2214's approved shared cards: the DOP-217
  // required action named a remover the captain could not find. Another
  // task's crewmate reads the card, corrects the words in place and answers
  // the captain's message by name, with no grant and no second card. Nothing
  // here touches a PC or runs the remover.
  it("INF-2225 corrects a required action's remover path and answers the captain on the same card", async () => {
    const { h, taskId, card } = withRequiredAction();
    const converse = vi.fn();
    h.supervisor.setFirstmateHooks({
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      converseAboutCard: converse,
    });
    const remover = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";
    h.supervisor.cardActions.replyToCard(
      card.id,
      "Where is the remover? I cannot find it on the PC.",
    );
    expect(converse).toHaveBeenCalledTimes(1);
    const { taskId: helper } = await h.supervisor.intake.commission({
      title: "Find the remover",
      intent: intentOf("find the remover path"),
    });
    await tick();
    const spec = h.specs[0];
    const read = JSON.parse((await spec?.onReadCard?.(card.id)) as string);
    const asked = read.thread.at(-1).id as number;
    expect(read).toMatchObject({
      id: card.id,
      waitingOn: { messageId: asked },
      requiredAction: { generation: 1, state: "ready" },
    });
    const source = read.requiredAction.requirements[0].source as string;

    const corrected = await spec?.onReviseRequiredAction?.({
      action: card.id,
      source,
      actionId: "rebuild",
      expectedGeneration: 1,
      patch: { instructions: [`Run ${remover} as an administrator.`] },
      reason: "The instructions named no remover path",
      operationId: "op-remover-path",
      sameAction: true,
    });
    const key = h.tasks.get(helper)?.key;
    expect(corrected).toContain(
      `Revised card "Rebuild the setup" (${card.id}) as the crewmate on ${key}.`,
    );
    expect(corrected).toContain("Its required action is at generation 2.");
    expect(
      spec?.onReply?.({ cardId: card.id, text: `It is at ${remover}.`, answersMessage: asked }),
    ).toContain(`it answers the captain's message ${asked} and ends that question`);

    // One card, under its own task, now naming the path at generation 2.
    const cards = h.supervisor.cards.snapshot();
    expect(cards.filter((entry) => entry.taskId === taskId)).toHaveLength(1);
    expect(cards.filter((entry) => entry.taskId === helper)).toEqual([]);
    const now = cards.find((entry) => entry.id === card.id) as Card;
    expect(now.body).toContain("FleetCheckSetup");
    expect(h.tasks.get(taskId)?.delivery?.captainAction).toMatchObject({
      generation: 2,
      state: "ready",
    });
    expect(
      h.supervisor.cards
        .thread(card.id)
        .messages.map((message) => [
          message.who,
          message.contributor?.taskId,
          message.answersMessage,
        ]),
    ).toEqual([
      ["captain", undefined, undefined],
      ["host", helper, undefined],
      ["crewmate", helper, asked],
    ]);
    // The first mate was asked once, and nothing asked the captain again.
    expect(converse).toHaveBeenCalledTimes(1);
    // The confirmation offered at generation 1 cannot complete generation 2.
    expect(h.tasks.delivery.completeCaptainAction(taskId, 1, "confirmed")).toBe(false);
    expect(h.tasks.get(taskId)?.status).toBe("open");
    await tick();
  });

  /** Commission a task and give it one crewmate card; returns that card. */
  async function withCard(
    harness: ReturnType<typeof setup>,
    input: { title: string; body?: string; actions?: Card["actions"] } = { title: "Owner note" },
  ) {
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Owner",
      intent: intentOf("emit a card"),
    });
    await tick();
    harness.specs[0]?.onCard?.({
      title: input.title,
      body: input.body ?? "<p>The body.</p>",
      actions: input.actions ?? [],
    });
    await tick();
    const card = harness.cards().find((entry) => entry.title === input.title) as Card;
    return { taskId, card };
  }

  it("sends the captain's reply to the crewmate as a steer, verbatim under the host preamble", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, card } = await withCard(harness);

    const thread = harness.supervisor.cardActions.replyToCard(
      card.id,
      "  the checks failed on windows  ",
    );
    await tick();

    // On the record the moment it was typed, trimmed but not reworded.
    expect(thread).toMatchObject({
      cardId: card.id,
      messages: [{ who: "captain", text: "the checks failed on windows" }],
    });
    expect(harness.threads.at(-1)).toMatchObject({ cardId: card.id });

    // Delivered to the crewmate's own session, not to Firstmate.
    const steer = vi.mocked(crewmate.steer).mock.calls.at(-1)?.[0] ?? "";
    expect(steer).toContain(THREAD_STEER_PREAMBLE);
    expect(steer).toContain("the checks failed on windows");
    expect(steer).toContain(card.id);
    expect(harness.ops).toEqual([]);

    // And recorded as the gesture it was: a captain steer via the thread.
    const steered = harness.tasks.timeline(taskId).find((event) => event.kind === "steered");
    expect(steered?.data).toMatchObject({ via: "thread", cardId: card.id });
  });

  it("carries reply settings as context and records them without resolving or merging", async () => {
    const crew = fakeCrewmate();
    const harness = setup(crew);
    const { taskId, card } = await withCard(harness);
    const answers = [
      { name: "look", values: ['{"tiltDeg":57}'], changed: true, json: true as const },
    ];
    const thread = harness.supervisor.cardActions.replyToCard(
      card.id,
      "revise this",
      undefined,
      undefined,
      answers,
    );
    await tick();
    // The thread keeps his words and the settings apart (FI3-617); the
    // author still reads them together, permission wording included.
    expect(thread.messages.at(-1)).toMatchObject({ who: "captain", text: "revise this", answers });
    expect(vi.mocked(crew.steer).mock.calls.at(-1)?.[0]).toContain(
      `revise this\n${REPLY_SETTINGS_HEAD}\n- look: {"tiltDeg":57} (JSON), changed`,
    );
    expect(
      harness.tasks.timeline(taskId).find((event) => event.kind === "steered")?.data,
    ).toMatchObject({ via: "thread" });
    expect(harness.cards().some((entry) => entry.id === card.id)).toBe(true);
    expect(
      harness.cardStore.observations(card.id).find((event) => event.kind === "message_ref")
        ?.payload,
    ).toMatchObject({ answers });
    expect(harness.tasks.get(taskId)?.status).toBe("active");
    expect(harness.workspace.landTaskWork).not.toHaveBeenCalled();
    expect(() =>
      harness.supervisor.cardActions.replyToCard(
        card.id,
        "build it",
        undefined,
        undefined,
        answersPastBound(),
      ),
    ).toThrow(CARD_ANSWERS_TOO_LONG);
  });

  it("hands a builder each reply under its basis card with the settings it was sent with", async () => {
    const crew = fakeCrewmate();
    const harness = setup(crew);
    const { taskId, card } = await withCard(harness, { title: "Two dials" });
    const answers = [
      { name: "look", values: ['{"tiltDeg":57}'], changed: true, json: true as const },
    ];
    harness.supervisor.cardActions.replyToCard(
      card.id,
      "tilt it more",
      undefined,
      undefined,
      answers,
    );
    await tick();
    harness.specs[0]?.onReport?.("Two dials, the second tilted.");
    crew.emit({ type: "turn_end", taskId });
    crew.finishPrompt();
    await tick();
    await harness.supervisor.intake.commission({
      title: "Build the dial",
      intent: intentOf("build it"),
      shape: { basis: harness.tasks.get(taskId)?.key ?? taskId },
    });
    await tick();
    // The thread shows his words alone; the builder reads the reply as its
    // author did, settings included (FI3-617).
    expect(crew.promptCalls.at(-1)).toContain(
      `What was said under its card, newest last:\n- captain: tilt it more\n${REPLY_SETTINGS_HEAD}\n- look: {"tiltDeg":57} (JSON), changed`,
    );
  });

  it("resolves nothing: the card and its buttons stay exactly where they were", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card } = await withCard(harness, {
      title: "Pick one",
      body: "<p>Await the queue.</p><p>Mocking the clock leaves write order uncertain.</p>",
      actions: [
        { id: "go", label: "Go", default: true },
        { id: "wait", label: "Wait" },
      ],
    });

    harness.supervisor.cardActions.replyToCard(card.id, "what about the other one?");
    await tick();

    const still = harness.cards().find((entry) => entry.id === card.id);
    expect(still).toMatchObject({ id: card.id, status: "ready" });
    expect(still?.actions).toEqual(card.actions);
    expect(harness.cardStore.chosenAction(card.id)).toBeUndefined();
  });

  it("refuses a reply to a card with no author to reach, and to a closed one", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card, taskId } = await withCard(harness);

    // The host's own agent-down cards answer to nobody.
    harness.supervisor.cards.hostCards.addSystemNoteCard(
      "card-host-1",
      "Host note",
      "nothing to reply to",
    );
    await tick();
    expect(() => harness.supervisor.cardActions.replyToCard("card-host-1", "hello")).toThrow(
      /no author to reply to/,
    );
    expect(() => harness.supervisor.cardActions.replyToCard("ghost", "hello")).toThrow(
      /Unknown card/,
    );
    expect(() => harness.supervisor.cardActions.replyToCard(card.id, "   ")).toThrow(
      /needs some words/,
    );

    // Read a completed ordinary note, not one still awaiting its author's turn (INF-1879).
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    harness.supervisor.pressNote(card.id);
    await tick();
    expect(() => harness.supervisor.cardActions.replyToCard(card.id, "too late")).toThrow(
      /is closed/,
    );
  });

  it("puts the revised line and then the author's answer in the thread when it revises with a reply", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card } = await withCard(harness, { title: "Pick one" });
    harness.supervisor.cardActions.replyToCard(card.id, "the second option is wrong");
    await tick();

    const id = card.id.replace(/^card-[^-]+-/, "");
    const revision = { id, title: "Pick one", body: "the body, corrected", actions: [] };

    // An update alone does not answer him: refused, card and thread unchanged.
    expect(() => harness.specs[0]?.onCard?.(revision)).toThrow(/waits on your answer/);
    expect(harness.supervisor.cards.thread(card.id).messages.map((m) => m.who)).toEqual([
      "captain",
    ]);

    harness.specs[0]?.onCard?.({
      ...revision,
      reply: "You are right; I corrected the second option.",
      answersMessage: askedOn(harness.supervisor, card.id),
    });
    await tick();

    const messages = harness.supervisor.cards.thread(card.id).messages;
    expect(messages.map((message) => message.who)).toEqual(["captain", "host", "crewmate"]);
    expect(messages[1]?.text).toBe("revised: Pick one");
    expect(messages[2]?.text).toBe("You are right; I corrected the second option.");
  });

  it("lets the crewmate answer in its own card's thread and refuses another task's", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card } = await withCard(harness);

    const spec = harness.specs[0];
    expect(spec?.onReply?.({ cardId: card.id, text: "rebased; the checks pass again" })).toContain(
      "Replied in the thread",
    );
    expect(harness.supervisor.cards.thread(card.id).messages).toMatchObject([
      { who: "crewmate", text: "rebased; the checks pass again" },
    ]);
    // Refusals are tool text, never throws - a conversational miss is guidance.
    expect(spec?.onReply?.({ cardId: "ghost", text: "hello" })).toContain("Unknown card");
    expect(spec?.onReply?.({ cardId: card.id, text: "  " })).toContain("needs some words");
  });

  it("makes an unanswered captain message the crewmate's turn, so a report wakes nobody", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, card } = await withCard(harness, { title: "Owner note" });

    harness.supervisor.cardActions.replyToCard(card.id, "and the flaky retry - keep it?");
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "Unrelated progress landed." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();

    expect(harness.sorts.at(-1)).toMatchObject({
      taskId,
      verdict: "routine",
      rule: "thread-unanswered",
    });
    expect(harness.ops.filter((line) => line.includes("Unrelated progress"))).toEqual([]);
  });

  it("stops holding the turn once the crewmate has answered in the thread", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, card } = await withCard(harness, { title: "Owner note" });

    harness.supervisor.cardActions.replyToCard(card.id, "and the flaky retry - keep it?");
    await tick();
    harness.specs[0]?.onReply?.({
      cardId: card.id,
      text: "kept it; the checks still pass",
      answersMessage: askedOn(harness.supervisor, card.id),
    });
    crewmate.emit({ type: "assistant_delta", taskId, text: "Kept the retry as asked." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();

    expect(harness.sorts.at(-1)?.rule).not.toBe("thread-unanswered");
    expect(harness.ops.at(-1)).toContain("Kept the retry as asked.");
  });

  // INF-990 friction 3: a reply asking for a code change went 41 minutes
  // with no sign of work. The crewmate's one interim line shows at once,
  // and the captain's reply still waits for its real answer.
  it("keeps the captain's reply waiting after the crewmate's interim line, until its answer", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, card } = await withCard(harness, { title: "Owner note" });
    const awaiting = () =>
      harness.supervisor.cards.snapshot().find((shown) => shown.id === card.id)?.awaiting;

    harness.supervisor.cardActions.replyToCard(
      card.id,
      "rename review to audit and rerun the evaluations",
    );
    await tick();
    const interim = "Renaming review to audit now; the evaluations take about twenty minutes.";
    expect(
      harness.specs[0]?.onReply?.({ cardId: card.id, text: interim, interim: true }),
    ).toContain("still waits for your answer");
    expect(harness.supervisor.cards.thread(card.id).messages.map((m) => m.text)).toEqual([
      "rename review to audit and rerun the evaluations",
      interim,
    ]);
    expect(awaiting()).toBe("answer");
    // A turn that ends after the interim line alone still owes the answer.
    crewmate.emit({ type: "assistant_delta", taskId, text: "Renamed half of it." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(harness.sorts.at(-1)?.rule).toBe("thread-unanswered");
    expect(awaiting()).toBe("answer");

    harness.specs[0]?.onReply?.({
      cardId: card.id,
      text: "Renamed; the evaluations pass.",
      answersMessage: askedOn(harness.supervisor, card.id),
    });
    expect(awaiting()).not.toBe("answer");
  });

  it("reads an interim line under a card nobody waits on as an ordinary reply", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card } = await withCard(harness);
    expect(
      harness.specs[0]?.onReply?.({ cardId: card.id, text: "Still on it.", interim: true }),
    ).toContain("Replied in the thread");
  });

  it("carries the thread's state onto the crew line and the context section", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId, card } = await withCard(harness);
    expect(harness.supervisor.facts.crewStatus(taskId)[0]?.thread).toBeUndefined();

    harness.supervisor.cardActions.replyToCard(card.id, "what about X?");
    await tick();
    expect(harness.supervisor.facts.crewStatus(taskId)[0]?.thread).toBe(
      "thread: 1 message, last from captain",
    );
    expect(harness.supervisor.cards.threadActivitySince(0)).toMatchObject([
      {
        card: { id: card.id },
        count: 1,
        last: { who: "captain", text: "what about X?" },
        owed: "author",
      },
    ]);
    // Everything before the window is already behind the Firstmate.
    expect(harness.supervisor.cards.threadActivitySince(Date.now() + 1000)).toEqual([]);
  });

  it("keeps a crewmate's note when its task closes done, and sends a reply on it to the Firstmate", async () => {
    const crewmate = fakeCrewmate();
    const converseAboutCard = vi.fn();
    const harness = setup(crewmate);
    harness.supervisor.setFirstmateHooks({
      notifyOp: (wake) => harness.ops.push(served(wake)),
      retryConverse: vi.fn(),
      converseAboutCard,
    });
    const { taskId, card: note } = await withCard(harness, { title: "Release is out" });
    harness.specs[0]?.onReport?.("The release is published.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(harness.cards().map((entry) => entry.id)).toContain(note.id);

    const closed = await harness.supervisor.settling.done.close(taskId, {
      why: "released",
      evidence: "v1.2.3 published",
    });
    await tick();
    expect(closed.text).toContain("v1.2.3 published");
    expect(harness.tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "released" });

    // The note outlives the close.
    expect(harness.cards().map((entry) => entry.id)).toContain(note.id);

    // Its author is gone, so the Firstmate takes the captain's reply.
    harness.supervisor.cardActions.replyToCard(note.id, "which build is it?");
    expect(converseAboutCard).toHaveBeenCalledWith(note.id, "which build is it?", undefined);
    expect(crewmate.promptCalls.some((call) => call.includes("which build is it?"))).toBe(false);
  });

  it("routes a captain reply on a Firstmate card as a captain turn, not a crewmate steer", async () => {
    const crewmate = fakeCrewmate();
    const converseAboutCard = vi.fn();
    const harness = setup(crewmate);
    harness.supervisor.setFirstmateHooks({
      notifyOp: (wake) => harness.ops.push(served(wake)),
      retryConverse: vi.fn(),
      converseAboutCard,
    });
    const cardId = harness.supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    await tick();
    const thread = harness.supervisor.cardActions.replyToCard(cardId, "the second option is wrong");
    expect(thread.messages).toMatchObject([{ who: "captain", text: "the second option is wrong" }]);
    expect(converseAboutCard).toHaveBeenCalledWith(cardId, "the second option is wrong", undefined);
    const answers = [
      { name: "look", values: ['{"tiltDeg":57}'], changed: true, json: true as const },
    ];
    harness.supervisor.cardActions.replyToCard(
      cardId,
      "revise this",
      undefined,
      undefined,
      answers,
    );
    expect(converseAboutCard).toHaveBeenLastCalledWith(
      cardId,
      expect.stringContaining('"tiltDeg":57'),
      undefined,
    );
    expect(
      harness.cardStore
        .observations(cardId)
        .filter((event) => event.kind === "message_ref")
        .at(-1)?.payload,
    ).toMatchObject({ answers });
    expect(crewmate.steer).not.toHaveBeenCalled();
  });

  // INF-1623: the crew includes the first mate on its own cards.
  it("shows the answer the Firstmate's revision carries after its closing words answered, and refuses one without it in that turn", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    harness.supervisor.setFirstmateHooks({
      notifyOp: (wake) => harness.ops.push(served(wake)),
      retryConverse: vi.fn(),
      converseAboutCard: vi.fn(),
    });
    const body = "<h2>Options</h2><p>A or B.</p>";
    const cardId = harness.supervisor.addFirstmateCard({
      id: "pick",
      title: "Pick one",
      body,
      actions: [{ id: "a", label: "A", default: true }],
    });
    await tick();
    harness.supervisor.cardActions.replyToCard(cardId, "the second option is wrong");
    expect(
      harness.supervisor.cards.recordFirstmateThreadAnswer(cardId, "You are right; B is wrong."),
    ).toBe(true);
    const revision = {
      id: "pick",
      title: "Pick one",
      body: "<h2>Options</h2><p>A or C.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    };
    expect(() => harness.supervisor.addFirstmateCard(revision)).toThrow(/under which heading/);
    harness.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    harness.supervisor.addFirstmateCard({
      ...revision,
      reply: "I replaced B with C under Options.",
    });
    await tick();
    expect(
      harness.supervisor.cards
        .thread(cardId)
        .messages.map((message) => [message.who, message.text]),
    ).toEqual([
      ["captain", "the second option is wrong"],
      ["firstmate", "You are right; B is wrong."],
      ["host", "revised: Pick one"],
      ["firstmate", "I replaced B with C under Options."],
    ]);
  });

  it("rides an image on a crewmate thread steer", async () => {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card } = await withCard(harness);
    const image = pngImage;
    harness.supervisor.cardActions.replyToCard(card.id, "see this", [image]);
    await tick();
    expect(crewmate.steer).toHaveBeenCalledWith(
      expect.stringContaining("see this"),
      [image],
      expect.stringMatching(/^rows:\d+:/),
    );
  });

  it("names a dropped text file in the thread and the steer, beside its preview and pointer", async () => {
    initOverflowDir(scratchDir("infinitary-overflow-"));
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { card } = await withCard(harness);
    const text = "a\r\nb\r\n".repeat(900);
    const thread = harness.supervisor.cardActions.replyToCard(
      card.id,
      "see",
      undefined,
      undefined,
      undefined,
      [{ text, name: "log.txt" }],
    );
    await tick();
    const shown = thread.messages.at(-1)?.text ?? "";
    expect(shown).toContain("see\n\n[attached file: log.txt]\n");
    const pointer = /full text: (\S+\.txt)\]/.exec(shown)?.[1] ?? "";
    expect(readFileSync(pointer, "utf8")).toBe(text);
    expect(crewmate.steer).toHaveBeenCalledWith(
      expect.stringContaining("[attached file: log.txt]"),
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );
    rmSync(pointer);
  });

  it("keeps a queued reply's picture as a message-owned copy: served from it later, and held when the copy is gone", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const harness = setup(crewmate);
    const { taskId, card } = await withCard(harness);
    // This backend takes guidance between turns: the reply waits on the lane.
    const thread = harness.supervisor.cardActions.replyToCard(card.id, "see this", [
      { ...pngImage, name: "shot.png" },
    ]);
    await tick();
    expect(thread.messages.at(-1)?.text).toBe("see this\n[attached 1 picture: shot.png]");
    const [row] = harness.inbox.allFor(taskId);
    expect(row?.facts).toMatchObject({ kind: "attachments-kept" });
    const kept = row?.facts as unknown as { attachments: AttachmentRef[] };
    const refs = kept.attachments;
    expect(refs).toHaveLength(1);
    const file = attachmentPath(refs[0] as AttachmentRef);
    const bytes = readFileSync(file);
    rmSync(file);
    crewmate.finishPrompt();
    await tick();
    // Blocked: nothing was sent as words alone, the row stays, the feed says so.
    expect(crewmate.promptCalls.some((text) => text.includes("see this"))).toBe(false);
    expect(harness.inbox.allFor(taskId)).toHaveLength(1);
    expect(
      harness.events.filter(
        (event) => event.type === "firstmate_note" && event.text.includes("is not available"),
      ),
    ).toHaveLength(1);
    // The copy back, the same message is delivered with its picture.
    writeFileSync(file, bytes);
    await harness.supervisor.watch.sweepInbox(Date.now() + 60_000);
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain("see this\n\n[attached: 1 picture: shot.png]");
    expect(crewmate.promptImageCalls.at(-1)).toEqual([expect.objectContaining(pngImage)]);
  });
});
