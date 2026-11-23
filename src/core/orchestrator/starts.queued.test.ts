/**
 * Starting a queued task as `CrewStarts` does it (docs/task-graph.md):
 * gated rows dispatched when the sweep clears them, a goal, model or
 * reasoning the captain changes while classification runs, filed tasks
 * started on what the captain named, and dropped work started again with
 * its saved work.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { join } from "node:path";
import { noteDoneOf } from "@shared/cardLeave";
import { withAnythingElse } from "@shared/cards";
import { HOME } from "@shared/deviceNames";
import { placementNamedModelWait } from "@shared/placement";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { crewmateEvidenceDir } from "../paths";
import type { KindInput } from "../routing/kindClassifier";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { TaskEvent } from "../storage/taskEventStore";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { TaskProtocol } from "../tasks/taskProtocol";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

describe("the task graph (R1)", () => {
  it("queues work behind an at-time gate and dispatches it when the sweep clears it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events, tasks, sessions, cards } = setup(crewmate);
    const at = Date.now() + 60 * 60 * 1000;
    const { taskId, crewmate: name } = await supervisor.intake.commission({
      title: "Nightly sweep",
      intent: intentOf("run the sweep"),
      startAfter: { at },
    });
    expect(name).toBe("queued");
    // No worktree, no session, no card - a row and a feed line.
    expect(sessions.open).not.toHaveBeenCalled();
    expect(tasks.get(taskId)).toMatchObject({
      status: "open",
      key: "SCR-1",
      gate: { kind: "at-time", until: at },
    });
    const note = events.find((event) => event.type === "firstmate_note");
    expect(note && "text" in note ? note.text : "").toContain('Queued "Nightly sweep"');
    expect(events.find((e) => e.type === "crew_counts")).toMatchObject({ queued: 1 });
    // The strip and status see it.
    expect(supervisor.facts.crewStatus().find((entry) => entry.taskId === taskId)).toMatchObject({
      status: "queued",
    });

    // Before its time: nothing.
    await supervisor.watch.sweepGates(at - 1000);
    expect(sessions.open).not.toHaveBeenCalled();

    // Its time arrives: the sweep dispatches through the normal start path.
    await supervisor.watch.sweepGates(at + 1000);
    await tick();
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(legacyStateOf(tasks.get(taskId))).toBe("running");
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(crewmate.promptCalls[0]).toContain("run the sweep");
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 1, idle: 0 });
    expect(cards()).toEqual([]);
    expect(events.some((e) => e.type === "firstmate_note" && e.text.includes("Starting"))).toBe(
      true,
    );
  });

  it("overlapping dispatches of a queued task start it only once", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions, workspace, paths } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Queued",
      intent: intentOf("do the thing"),
      startAfter: { at: Date.now() - 1 },
    });
    const held = deferred<void>();
    vi.mocked(workspace.createTaskWorktree).mockImplementation(async (id: string) => {
      await held.promise;
      return {
        taskId: id,
        cwd: join(paths.worktreesDir, id),
        branch: `fm/task-${id}`,
        repoDir: paths.defaultWorkspaceDir,
      };
    });
    const first = supervisor.starts.dispatchQueuedTask(taskId);
    const second = supervisor.starts.dispatchQueuedTask(taskId);
    held.resolve();
    await Promise.all([first, second]);
    await tick();
    expect(workspace.createTaskWorktree).toHaveBeenCalledTimes(1);
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  it.each(["queue sweep", "direct Start", "Start behind the answer"] as const)(
    "keeps a saved answer done when %s finishes opening after Done",
    async (source) => {
      const taskId = "answer";
      const cardId = "card-answer-1";
      const words = "Thanks, use this for the next build.";
      const crewmate = fakeCrewmate();
      const { supervisor, tasks, sessions, events, ops } = setup(crewmate, {
        savedCards: [
          {
            id: cardId,
            taskId,
            author: "crewmate",
            title: "Recent changes and the next build",
            body: "<p>Two merged changes are not in the newest build.</p>",
            meta: "crew",
            status: "ready",
            priority: 10,
            createdAt: Date.now(),
            answering: true,
            actions: [],
          },
        ],
      });
      seedTask(tasks, {
        id: taskId,
        title: "Check what the next build holds",
        status: "queued",
        shape: { kind: "research", kind_source: "classifier:test", deliverable: "answer" },
      });
      const heard = vi.fn();
      supervisor.setFirstmateHooks({
        notifyOp: (wake) => ops.push(renderWake(wake)),
        retryConverse: vi.fn(),
        converseAboutCard: heard,
      });
      const opening = deferred<void>();
      const release = deferred<void>();
      sessions.open.mockImplementationOnce(async () => {
        opening.resolve();
        await release.promise;
        return crewmate;
      });
      const start = (() => {
        switch (source) {
          case "queue sweep":
            return supervisor.starts.dispatchQueuedTask(taskId);
          case "direct Start":
            return supervisor.starts.startQueuedNow(taskId, { audience: "captain", direct: true });
          case "Start behind the answer":
            return supervisor.starts.startBehind(taskId);
        }
      })();
      await opening.promise;
      try {
        expect(supervisor.cards.shown(cardId)?.noteDone).toEqual(
          noteDoneOf(tasks.get(taskId)?.key ?? "", true),
        );
        supervisor.pressNote(cardId, undefined, { answers: withAnythingElse([], words) });
        await tick();
        expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
        expect(heard.mock.calls).toEqual([[cardId, words, undefined]]);
      } finally {
        release.resolve();
        await start;
      }
      expect(tasks.get(taskId)).toMatchObject({ status: "done", closedReason: "answered" });
      expect(tasks.timeline(taskId).filter((event) => event.kind === "dispatched")).toEqual([]);
      expect(crewmate.dispose).toHaveBeenCalledTimes(1);
      expect(crewmate.promptCalls).toEqual([]);
      if (source === "direct Start") expect(await start).toBe("");
      expect(ops).toEqual([]);
      expect(
        events.some(
          (event) => event.type === "firstmate_note" && event.text.includes("could not start"),
        ),
      ).toBe(false);
    },
  );

  it("a failed queued start returns without leaving a runtime, and a retry can start", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions, workspace } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Queued",
      intent: intentOf("do the thing"),
      startAfter: { at: Date.now() - 1 },
    });
    vi.mocked(workspace.createTaskWorktree).mockRejectedValueOnce(
      new Error("a branch named 'fm/task-x' already exists"),
    );
    await supervisor.starts.dispatchQueuedTask(taskId);
    expect(tasks.get(taskId)).toMatchObject({ status: "open", startPolicy: "on-request" });
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 0 });
    expect(sessions.open).not.toHaveBeenCalled();

    await supervisor.starts.dispatchQueuedTask(taskId);
    await tick();
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(tasks.get(taskId)?.status).toBe("active");
  });

  // The captain's answer on INF-3075's review of INF-3060: a failed spawn
  // stays open, with its working copy kept for the retry.
  it("keeps a spawn whose start failed open for start_now, with the working copy its retry starts on", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions, workspace, ops } = setup(crewmate);
    vi.mocked(sessions.open).mockRejectedValueOnce(new Error("Claude is not signed in here."));
    const handle = await supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await handle.started;
    expect(tasks.get(handle.taskId)).toMatchObject({
      status: "open",
      gate: null,
      startPolicy: "on-request",
      startNotice: JSON.stringify({ reason: "Claude is not signed in here." }),
    });
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();
    expect(ops).toContain(
      renderWake({
        facts: {
          kind: "queued-start-failed",
          task: { id: handle.taskId, title: "Count presses" },
          error: "Claude is not signed in here.",
          asked: true,
          open: true,
        },
      }),
    );
    // Nothing starts it again on its own: its tile asks for the first mate's go.
    expect(tasks.graph.listReady().map((ready) => ready.id)).not.toContain(handle.taskId);

    const key = tasks.get(handle.taskId)?.key;
    expect(await supervisor.starts.startQueuedNow(handle.taskId)).toMatch(
      new RegExp(`^${key} "Count presses" is starting\\.`),
    );
    await vi.waitFor(() => expect(tasks.get(handle.taskId)?.status).toBe("active"));
    expect(vi.mocked(workspace.createTaskWorktree).mock.calls.map(([id]) => id)).toEqual([
      handle.taskId,
      handle.taskId,
    ]);
    expect(sessions.open).toHaveBeenCalledTimes(2);
  });

  it("refuses a start_after gate on a task that does not exist", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    await expect(
      supervisor.intake.commission({
        title: "x",
        intent: intentOf("y"),
        startAfter: { afterTask: "nope" },
      }),
    ).rejects.toThrow(/Unknown task/);
  });

  it("turns a dead gate into one deduped wake, no card and no hold (P0, WI-3)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, cards, sessions, inbox } = setup(crewmate);
    // The real agent's notifyOp is the inbox's deduped wake path.
    supervisor.setFirstmateHooks({
      notifyOp: (text, origin, ref) => {
        inbox.enqueueWake(FIRSTMATE_RECIPIENT, text, origin, ref);
      },
      retryConverse: vi.fn(),
    });
    const wakes = () =>
      inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => renderWake(row).includes("can never end"));
    const first = await supervisor.intake.commission({
      title: "Doomed",
      intent: intentOf("will fail"),
    });
    await tick();
    const second = await supervisor.intake.commission({
      title: "Dependent",
      intent: intentOf("needs doomed"),
      startAfter: { afterTask: first.taskId },
    });
    crewmate.failPrompt("crashed hard");
    await tick();

    expect(cards()).toEqual([]);
    expect(wakes()).toHaveLength(1);
    const row = wakes()[0];
    const wake = row ? renderWake(row) : "";
    expect(wake).toContain(`[fm-op] queued task ${second.taskId}`);
    expect(wake).toContain('"Doomed"');
    // The wake carries the fact - the dead edge - not the tool recipe (v2.0).
    expect(wake).toContain("the dead edge is blocks");
    expect(wake).not.toContain("update_task");
    expect(wakes()[0]?.ref).toBe(second.taskId);
    // No hold: the row stays plain queued work, and the tick does not nag.
    expect(tasks.get(second.taskId)).toMatchObject({ status: "open", gate: null });
    await supervisor.watch.sweepGates(Date.now());
    await supervisor.watch.sweepGates(Date.now());
    expect(wakes()).toHaveLength(1);
    expect(legacyStateOf(tasks.get(second.taskId))).toBe("queued");

    // start_now refuses while the dead edge stands: the wait is the edge,
    // and the refusal names the same edge the wake did.
    const dependent = tasks.get(second.taskId);
    const doomed = tasks.get(first.taskId)?.key;
    const refusal = await supervisor.starts.startQueuedNow(second.taskId);
    expect(refusal).toContain(
      `Cannot start ${dependent?.key} "Dependent" now: it waits on ${doomed} "Doomed"`,
    );
    expect(refusal).toContain(`remove the dead edge blocks ${doomed} -> ${dependent?.key}`);
    // Removing the edge is the way out the wake named; the sweep starts it.
    expect(supervisor.intake.unlinkTasks(first.taskId, second.taskId, "blocks")).toMatch(
      /^Removed/,
    );
    await tick();
    expect(legacyStateOf(tasks.get(second.taskId))).toBe("running");
    expect((sessions.open as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("standalone goal edits update saved intent and the actual served dispatch", async () => {
    const crew = fakeCrewmate();
    const { supervisor, tasks } = setup(crew);
    const planned = supervisor.intake.plan({
      title: "Transitions",
      intent: intentOf("Original scope"),
    });
    tasks.updateFields(
      planned.id,
      { goal: "Replacement-only shell-height interpolation" },
      "firstmate",
    );
    await supervisor.starts.startQueuedNow(planned.key);
    await tick();
    expect(crew.promptCalls[0]).toContain("Goal: Replacement-only shell-height interpolation");
    expect(crew.promptCalls[0]).toContain("Original scope"); // verbatim user words remain unchanged
    expect(tasks.get(planned.id)?.intent?.goal).toBe("Replacement-only shell-height interpolation");
    expect(tasks.get(planned.id)?.prompt).toContain(
      "Goal: Replacement-only shell-height interpolation",
    );
  });

  it("serves a goal amendment made while queued classification is in flight", async () => {
    const crew = fakeCrewmate();
    let release:
      | ((value: { kind: "implement"; source: string; version: string }) => void)
      | undefined;
    const classified = new Promise<{ kind: "implement"; source: string; version: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const { supervisor, tasks } = setup(crew, { classifier: { classify: async () => classified } });
    const planned = supervisor.intake.plan({
      title: "Transitions",
      intent: intentOf("Original scope"),
    });
    const starting = supervisor.starts.startQueuedNow(planned.key);
    tasks.updateFields(planned.id, { goal: "Responsive width and reduced motion" }, "firstmate");
    release?.({ kind: "implement", source: "classifier:test", version: "kc1" });
    await starting;
    await tick();
    expect(crew.promptCalls[0]).toContain("Goal: Responsive width and reduced motion");
  });

  it("opens at a reasoning effort the captain named while queued classification is in flight (FI3-1812)", async () => {
    let release:
      | ((value: { kind: "implement"; source: string; version: string }) => void)
      | undefined;
    const classified = new Promise<{ kind: "implement"; source: string; version: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const { supervisor, tasks, sessionSpecs } = setup(fakeCrewmate(), {
      classifier: { classify: async () => classified },
      reasoningChoice: () => "low",
      routeResult: {
        choice: { provider: "fm-mock", id: "mock-1" },
        bucket: "high",
        servedBucket: "high",
        rule: "R3",
      },
    });
    const planned = supervisor.intake.plan({
      title: "Transitions",
      intent: intentOf("Original scope"),
    });
    const starting = supervisor.starts.startQueuedNow(planned.key);
    tasks.updateFields(planned.id, { reasoning: "xhigh" }, "firstmate");
    release?.({ kind: "implement", source: "classifier:test", version: "kc1" });
    await starting;
    await tick();
    expect(sessionSpecs[0]?.thinking).toEqual({ level: "xhigh" });
    expect(tasks.get(planned.id)?.shape).toMatchObject({
      kind: "implement",
      override_reasoning: "xhigh",
    });
  });

  it("routes on a model the captain named while queued classification is in flight (INF-83)", async () => {
    let release:
      | ((value: { kind: "implement"; source: string; version: string }) => void)
      | undefined;
    const classified = new Promise<{ kind: "implement"; source: string; version: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const routed: WorkShape[] = [];
    const { supervisor, tasks } = setup(fakeCrewmate(), {
      classifier: { classify: async () => classified },
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      onRouteDecide: ({ shape }) => routed.push(shape),
    });
    const planned = supervisor.intake.plan({
      title: "Transitions",
      intent: intentOf("Original scope"),
    });
    const starting = supervisor.starts.startQueuedNow(planned.key);
    tasks.updateFields(planned.id, { model: "gpt-6-astra" }, "firstmate");
    release?.({ kind: "implement", source: "classifier:test", version: "kc1" });
    await starting;
    await tick();
    // The router is asked once, on the model the captain named (R0), and
    // the record keeps it with the tier it computes to: the pin's own slot.
    expect(routed.map((shape) => shape.override_model_id)).toEqual(["gpt-6-astra"]);
    expect(tasks.get(planned.id)?.shape?.override_model_id).toBe("gpt-6-astra");
    expect(tasks.get(planned.id)?.difficulty).toBeNull();
  });

  it("classifies a row whose named model the captain cleared as its start began (INF-83)", async () => {
    const asked: KindInput[] = [];
    const { supervisor, tasks } = setup(fakeCrewmate(), {
      classifier: {
        classify: async (input) => {
          asked.push(input);
          return { kind: "implement", source: "classifier:test", version: "kc1" };
        },
      },
      routedModel: { provider: "fm-mock", id: "mock-1" },
    });
    const planned = supervisor.intake.plan({
      title: "Transitions",
      intent: intentOf("Original scope"),
    });
    tasks.updateFields(planned.id, { model: "gpt-6-astra" }, "firstmate");
    const starting = supervisor.starts.startQueuedNow(planned.key);
    tasks.updateFields(planned.id, { model: "" }, "firstmate");
    await starting;
    await tick();
    // A named model skips the classifier; once cleared there is nothing to
    // skip, so the row is classified as it starts (docs/kind-classifier.md).
    expect(asked).toHaveLength(1);
    expect(tasks.get(planned.id)?.shape).toMatchObject({
      kind: "implement",
      kind_source: "classifier:test",
    });
  });

  it("routes on a basis the captain named while queued classification is in flight, asking the classifier once (INF-83)", async () => {
    let release:
      | ((value: { kind: "implement"; source: string; version: string }) => void)
      | undefined;
    const verdict = new Promise<{ kind: "implement"; source: string; version: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const asked: KindInput[] = [];
    const routed: WorkShape[] = [];
    const { supervisor, tasks } = setup(fakeCrewmate(), {
      classifier: {
        classify: async (input) => {
          asked.push(input);
          return verdict;
        },
      },
      routedModel: { provider: "fm-mock", id: "mock-1" },
      onRouteDecide: ({ shape }) => routed.push(shape),
    });
    // A basis is verified by its report; it waits for the captain's word, so nothing starts it.
    const spec = tasks.create({
      id: "spec-1",
      title: "Accepted spec",
      prompt: "p",
      repoId: null,
      startPolicy: "on-request",
    });
    tasks.turns.recordReport(spec.id, { text: "Replacement-only shell-height interpolation." });
    const planned = supervisor.intake.plan({
      title: "Transitions",
      intent: intentOf("Original scope"),
    });
    const starting = supervisor.starts.startQueuedNow(planned.key);
    tasks.updateFields(planned.id, { basis: spec.key }, "firstmate");
    release?.({ kind: "implement", source: "classifier:test", version: "kc1" });
    await starting;
    await tick();
    // The classifier is consulted once per row (docs/kind-classifier.md), and
    // its verdict is stamped beside the basis, which the router reads
    // verified: implement on a verified basis is grounded (R4).
    expect(asked).toHaveLength(1);
    expect(routed).toEqual([
      expect.objectContaining({ kind: "implement", basis: spec.key, basis_verified: true }),
    ]);
    expect(tasks.get(planned.id)?.shape).toMatchObject({ kind: "implement", basis: spec.key });
  });

  it("delivers historical full reports and uncut card amendments, then pins the served content", async () => {
    const crew = fakeCrewmate();
    const { supervisor, tasks, specs, repos, cardStore } = setup(crew);
    const source = tasks.create({
      id: "full-spec",
      title: "Accepted transitions",
      prompt: "p",
      repoId: null,
    });
    const specification = `Full specification: stable external pager and intrinsic iframe isolation. ${"Each scoped clause stays word for word. ".repeat(30)}`;
    tasks.turns.recordReport(source.id, { text: specification });
    tasks.turns.recordReport(source.id, { text: "Complete; no investigation remains." });
    // The source is verified by its report, not by an invented approval.
    await supervisor.intake.commission({
      title: "Build transitions",
      intent: intentOf("build it"),
      shape: { basis: source.key },
    });
    await tick();
    expect(crew.promptCalls[0]).toContain("stable external pager and intrinsic iframe isolation");
    expect(crew.promptCalls[0]).toContain(
      "Its report - the final answer it recorded:\nComplete; no investigation remains.",
    );
    expect(crew.promptCalls[0]?.split("Complete; no investigation remains.").length).toBe(2);
    expect(crew.promptCalls[0]).toContain(specification);
    const pinned = tasks
      .timeline(tasks.list().find((row) => row.title === "Build transitions")?.id ?? "")
      .find((event) => event.kind === "briefed") as TaskEvent;
    // The receipt keeps the long report by reference, the short one as a
    // copy, and reads back as exactly what was served.
    expect(pinned.text).not.toContain("Each scoped clause stays word for word.");
    expect(pinned.text).toContain("Complete; no investigation remains.");
    expect(pinned.text.length).toBeLessThan(crew.promptCalls[0]?.length ?? 0);
    expect(tasks.servedBrief(pinned)).toBe(crew.promptCalls[0]);
    // Both readers of the receipt read the brief as served: the tasks query
    // and the record's timeline.
    const builder = tasks.get(pinned.taskId);
    const read = await specs[0]?.onQueryTasks?.({ key: builder?.key });
    expect(read?.rows[0]?.brief).toBe(crew.promptCalls[0]);
    const protocol = new TaskProtocol({
      tasks,
      repos,
      cards: { listOpen: () => cardStore.listOpen(), snapshot: () => supervisor.cards.snapshot() },
      broadcastEvent: () => {},
      emit: () => {},
    });
    try {
      const shown = protocol.detail(pinned.taskId).events.find((event) => event.id === pinned.id);
      expect(shown?.text).toBe(crew.promptCalls[0]);
    } finally {
      protocol.dispose();
    }
  });

  /**
   * INF-1217, direction A (the captain chose "Build A: fewer searches,
   * explain and record"): crewmates searched the whole disk for a project's
   * folder or another task's files, which made macOS ask about other apps'
   * data. The `tasks` read names both places instead.
   */
  it("names each project's folder, and the computer and evidence folder a task ran with", async () => {
    const crew = fakeCrewmate();
    const { supervisor, tasks, specs, repos, paths } = setup(crew);
    const personal = repos.ensurePersonal(paths.defaultWorkspaceDir);
    await supervisor.intake.commission({
      title: "Find the retained archive",
      intent: intentOf("find it"),
    });
    await tick();
    const ran = tasks.list().find((row) => row.title === "Find the retained archive");
    if (!ran) throw new Error("The commissioned task is missing");
    const read = await specs[0]?.onQueryTasks?.({ key: ran.key });
    expect(read?.rows[0]).toMatchObject({
      computer: HOME.the,
      evidence_folder: crewmateEvidenceDir(paths, ran.id),
    });
    // A list stays the compact index.
    const listed = await specs[0]?.onQueryTasks?.({});
    expect(listed?.rows[0]).not.toHaveProperty("evidence_folder");
    const project = tasks.projects.list().find((entry) => entry.repoId === personal.id);
    const projects = await specs[0]?.onQueryTasks?.({ projects: true });
    expect(projects?.rows).toEqual([]);
    expect(projects?.projects).toContainEqual({
      key: project?.key,
      name: project?.name,
      folder: personal.path,
    });
  });

  it("delivers an external filing origin as provenance without claiming it is an accepted basis", async () => {
    const crew = fakeCrewmate();
    const { supervisor, tasks } = setup(crew);
    const origin = tasks.create({
      id: "origin",
      title: "Investigate the meter",
      prompt: "p",
      repoId: null,
    });
    tasks.turns.recordReport(origin.id, {
      text: "Recorded finding: claim query omits queued rows.",
    });
    const filing = tasks.fileFollowup({
      id: "filing",
      originId: origin.id,
      title: "Fix claim",
      goal: "Include queued rows",
      why: "Queued rows missing",
      prompt: "Goal: Include queued rows",
    }).record;
    await supervisor.starts.startQueuedNow(filing.key);
    await tick();
    expect(crew.promptCalls[0]).toContain(origin.key);
    expect(crew.promptCalls[0]).toContain("Recorded finding: claim query omits queued rows.");
    expect(crew.promptCalls[0]).not.toContain("whose answer is the spec for it");
    expect(tasks.get(filing.id)?.shape?.basis).toBeUndefined();
  });

  // INF-1430 piece 1: a crewmate's follow-up declares no deliverable, so the
  // classifier is offered every kind and the kind it gives decides it.
  it("offers a filed follow-up every kind, and its kind decides its deliverable", async () => {
    const crew = fakeCrewmate();
    const asked: KindInput[] = [];
    const { supervisor, tasks } = setup(crew, {
      classifier: {
        classify: async (input) => {
          asked.push(input);
          return { kind: "research", source: "classifier:test", version: "kc4" };
        },
      },
    });
    const origin = tasks.create({ id: "origin", title: "Meter", prompt: "p", repoId: null });
    const filing = tasks.fileFollowup({
      id: "filing",
      originId: origin.id,
      title: "Why the meter skips",
      goal: "Explain why the meter skips a tick",
      why: "Seen while fixing the meter",
      prompt: "Goal: Explain why the meter skips a tick",
    }).record;
    await supervisor.starts.startQueuedNow(filing.key);
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.deliverable).toBeUndefined();
    expect(tasks.get(filing.id)?.shape).toMatchObject({ kind: "research", deliverable: "answer" });
  });

  it("update_task start_now starts a gated row now and refuses what is not queued work", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessions } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Tonight",
      intent: intentOf("later"),
      startAfter: { at: Date.now() + 60 * 60 * 1000 },
    });
    expect(legacyStateOf(tasks.get(taskId))).toBe("queued");
    const key = tasks.get(taskId)?.key;

    expect(await supervisor.starts.startQueuedNow(key ?? "")).toContain(
      `${key} "Tonight" is starting.`,
    );
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "active", gate: null });
    expect(tasks.timeline(taskId).some((event) => event.text.includes("started on request"))).toBe(
      true,
    );
    expect(sessions.open).toHaveBeenCalledTimes(1);

    // Not queued work any more: a plain refusal, nothing thrown.
    expect(await supervisor.starts.startQueuedNow(taskId)).toContain("not queued work");
    // A live blocker is a real wait; the refusal names it.
    const a = supervisor.intake.plan({
      title: "A",
      intent: intentOf("a"),
      startPolicy: "when-ready",
    });
    const b = supervisor.intake.plan({ title: "B", intent: intentOf("b"), blockedBy: [a.id] });
    expect(await supervisor.starts.startQueuedNow(b.key)).toContain(`it waits on ${a.key} "A"`);
    expect(tasks.get(b.id)?.status).toBe("open");
  });

  it("a start refusal says the task starts when its work closes and names the dead edge to remove, never dropping the blocker (FI3-244, INF-3167)", async () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    const a = supervisor.intake.plan({ title: "A", intent: intentOf("a") });
    const c = supervisor.intake.plan({ title: "C", intent: intentOf("c") });
    const b = supervisor.intake.plan({
      title: "B",
      intent: intentOf("b"),
      blockedBy: [a.id, c.id],
    });

    // Live blockers: the task starts when their work closes; a wait is
    // reshaped by split or fold, and removed only when it names the wrong
    // task (INF-3167, the captain's choice A).
    const live = await supervisor.starts.startQueuedNow(b.key);
    expect(live).toContain(`${a.key} "A"`);
    expect(live).toContain(`${c.key} "C"`);
    expect(live).toContain(
      "It starts when that work closes, or on batched pull requests when the work it builds on is approved to merge, unless its needs_merge names that work. When only part of that work gives what it needs, split that part into its own task or fold this task into it; remove a wait with link_tasks remove only when it names the wrong task.",
    );
    expect(live).not.toContain("to start it sooner");
    expect(live).toContain("Dropping a blocker never clears its wait.");

    // Dropping a blocker leaves its edge dead, still in the way: the refusal
    // names that edge, and the live one still waits for its work.
    expect(supervisor.intake.dropTask(a.key, { reason: "not wanted" })).toMatch(/^Dropped/);
    const dead = await supervisor.starts.startQueuedNow(b.key);
    expect(dead).toContain(`${a.key} "A" (dropped)`);
    expect(dead).toContain(
      `remove the dead edge blocks ${a.key} -> ${b.key} with link_tasks remove; it can start once the rest is done.`,
    );
    expect(dead).not.toContain(`blocks ${c.key}`);
    expect(dead).not.toMatch(/drop the blocker/i);
    expect(tasks.get(b.id)?.status).toBe("open");
    // The captain's refusal says what is in the way, without the tool's way out.
    const captain = await supervisor.starts.startQueuedNow(b.key, { audience: "captain" });
    expect(captain).toMatch(new RegExp(`^Cannot start ${b.key} "B" now: it waits on .*\\.$`));
    expect(captain).toContain(`${a.key} "A" (dropped)`);
    expect(captain).not.toContain("link_tasks");
    expect(dead.startsWith(captain)).toBe(true);

    // With only dead edges left, removing them is the whole way out.
    expect(supervisor.intake.dropTask(c.key, { reason: "not wanted either" })).toMatch(/^Dropped/);
    const deadOnly = await supervisor.starts.startQueuedNow(b.key);
    expect(deadOnly).toContain("Dropped work never clears a wait: remove the dead edges");
    expect(deadOnly).toContain(`blocks ${a.key} -> ${b.key}`);
    expect(deadOnly).toContain(`blocks ${c.key} -> ${b.key}`);
    expect(deadOnly).toMatch(/with link_tasks remove\.$/);

    // The way out it names works: with the edges gone, the start goes through.
    expect(supervisor.intake.unlinkTasks(a.key, b.key, "blocks")).toMatch(/^Removed/);
    expect(supervisor.intake.unlinkTasks(c.key, b.key, "blocks")).toMatch(/^Removed/);
    expect(await supervisor.starts.startQueuedNow(b.key)).toContain(`${b.key} "B" is starting.`);
    await tick();
    expect(tasks.get(b.id)?.status).toBe("active");
  });

  it("starts a filed task on the model the captain named, keeping its key, parent and links (FI3-436)", async () => {
    const crewmate = fakeCrewmate({ model: { provider: "openai-codex", id: "gpt-6-astra" } });
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor, tasks, ops } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      onRouteDecide: (args) => decideCalls.push(args),
    });
    const parent = supervisor.intake.plan({ title: "Gauge work", intent: intentOf("gauge work") });
    const spec = supervisor.intake.plan({ title: "Gauge spec", intent: intentOf("spec it") });
    const filed = supervisor.intake.plan({
      title: "Calibrate the gauge",
      intent: intentOf("calibrate the gauge"),
      parent: parent.key,
      shape: { basis: spec.key },
    });
    supervisor.intake.linkTasks(spec.key, filed.key, "related");
    const before = tasks.list().length;

    // The model the captain named is an edit to the filed row, then the start.
    expect(tasks.updateFields(filed.id, { model: "gpt-6-astra" }, "firstmate")).toEqual([
      "model gpt-6-astra",
    ]);
    expect(await supervisor.starts.startQueuedNow(filed.key)).toContain(
      `${filed.key} "Calibrate the gauge" is starting.`,
    );
    await tick();
    // It started on the model named, so no wake follows the answer (INF-5123).
    expect(ops.filter((line) => line.includes(`task ${filed.id} `))).toEqual([]);

    expect(decideCalls.at(-1)?.shape).toMatchObject({
      override_model_id: "gpt-6-astra",
      basis: spec.key,
    });
    const started = tasks.get(filed.id);
    expect(started).toMatchObject({
      key: filed.key,
      status: "active",
      parentId: parent.id,
      model: "openai-codex/gpt-6-astra",
    });
    expect(tasks.graph.linksTo(filed.id)).toEqual([
      expect.objectContaining({ fromId: spec.id, type: "related" }),
    ]);
    // No replacement: the same row started, and nothing was dropped.
    expect(tasks.list()).toHaveLength(before);
    expect(tasks.list().filter((row) => row.status === "dropped")).toEqual([]);

    // Once a crewmate holds it, its model is no longer the record's to change.
    expect(() => tasks.updateFields(filed.id, { model: "gpt-6-luna" }, "firstmate")).toThrow(
      "only be named on open work",
    );
  });

  it("starts a filed task at the reasoning the captain named, which only open work can change (FI3-1812)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, sessionSpecs } = setup(crewmate, {
      reasoningChoice: () => "low",
      routeResult: {
        choice: { provider: "fm-mock", id: "mock-1" },
        bucket: "high",
        servedBucket: "high",
        rule: "R3",
      },
    });
    const filed = supervisor.intake.plan({ title: "Trim the log", intent: intentOf("trim it") });
    expect(tasks.updateFields(filed.id, { reasoning: "medium" }, "firstmate")).toEqual([
      "reasoning medium",
    ]);
    expect(tasks.updateFields(filed.id, { reasoning: null }, "firstmate")).toEqual([
      "reasoning follows Models",
    ]);
    expect(tasks.get(filed.id)?.shape).not.toHaveProperty("override_reasoning");
    expect(tasks.updateFields(filed.id, { reasoning: "xhigh" }, "firstmate")).toEqual([
      "reasoning extra high",
    ]);
    expect(await supervisor.starts.startQueuedNow(filed.key)).toContain(
      `${filed.key} "Trim the log" is starting.`,
    );
    await tick();
    expect(tasks.get(filed.id)?.status).toBe("active");
    expect(sessionSpecs[0]?.thinking).toEqual({ level: "xhigh" });
    expect(tasks.get(filed.id)?.shape).toMatchObject({ override_reasoning: "xhigh" });
    // A running conversation keeps the level it opened at.
    expect(() => tasks.updateFields(filed.id, { reasoning: "low" }, "firstmate")).toThrow(
      "only be named on open work",
    );
  });

  it("waits and asks, never starting on another model, when no computer serves the model the captain named", async () => {
    // Routing on this computer can serve only another model.
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ops, sessionSpecs, events } = setup(crewmate, {
      routedModel: { provider: "fm-mock", id: "mock-1" },
    });
    const filed = supervisor.intake.plan({ title: "Trim the log", intent: intentOf("trim it") });
    const named = `${CLAUDE_PROVIDER_ID}/claude-fable-5-1`;
    const said = () =>
      events.flatMap((event) =>
        event.type === "firstmate_note" && event.taskId === filed.id ? [event.text] : [],
      );
    tasks.updateFields(filed.id, { model: named }, "firstmate");

    await supervisor.starts.startQueuedNow(filed.key);
    await tick();
    // It stays open, saying what it waits for, and no crewmate opened.
    expect(tasks.get(filed.id)?.status).toBe("open");
    expect(tasks.get(filed.id)?.shape?.placement_wait).toMatchObject({
      kind: "model",
      words: placementNamedModelWait(named),
    });
    expect(sessionSpecs).toEqual([]);
    expect(ops.filter((op) => op.includes(`queued task ${filed.id}`))).toEqual([
      expect.stringContaining(`was asked to run on ${named}`),
    ]);
    expect(said()).toEqual([`"Trim the log": ${placementNamedModelWait(named)}`]);
    // Asked again, as the ready sweep asks, it still waits and Activity says it once.
    await supervisor.starts.startQueuedNow(filed.key);
    await tick();
    expect(tasks.get(filed.id)?.status).toBe("open");
    expect(sessionSpecs).toEqual([]);
    expect(said()).toHaveLength(1);

    // On the captain's words the model is cleared, and the start goes through.
    tasks.updateFields(filed.id, { model: "" }, "firstmate");
    await supervisor.starts.startQueuedNow(filed.key);
    await tick();
    expect(tasks.get(filed.id)?.status).toBe("active");
    expect(tasks.get(filed.id)?.shape?.placement_wait).toBeUndefined();
  });

  it("runs a named model this Mac's account-less runtime serves when routing placed it on none, and waits for one it lacks", async () => {
    // Routing placed it on no model: the session opens on the account-less
    // runtime, here a models.json provider serving one model.
    const crewmate = fakeCrewmate();
    const served = { provider: "fm-mock", id: "mock-1" };
    const { supervisor, tasks, sessionSpecs } = setup(crewmate, {
      routeResult: { bucket: "high", rule: "R0" },
      accountlessModels: () => [served],
    });
    const missing = supervisor.intake.plan({ title: "Trim the log", intent: intentOf("trim it") });
    tasks.updateFields(missing.id, { model: "fm-mock/mock-9" }, "firstmate");
    await supervisor.starts.startQueuedNow(missing.key);
    await tick();
    expect(tasks.get(missing.id)?.status).toBe("open");
    expect(tasks.get(missing.id)?.shape?.placement_wait?.words).toBe(
      placementNamedModelWait("fm-mock/mock-9"),
    );
    expect(sessionSpecs).toEqual([]);

    const named = supervisor.intake.plan({ title: "Mend the dial", intent: intentOf("mend it") });
    tasks.updateFields(named.id, { model: "fm-mock/mock-1" }, "firstmate");
    await supervisor.starts.startQueuedNow(named.key);
    await tick();
    expect(tasks.get(named.id)?.status).toBe("active");
    expect(sessionSpecs).toEqual([expect.objectContaining({ model: served })]);
  });

  it("never confirms the named model on a start with no model recorded (FI3-444)", async () => {
    const crewmate = fakeCrewmate({ model: undefined });
    const { supervisor, tasks, ops } = setup(crewmate);
    const filed = supervisor.intake.plan({ title: "Trim the log", intent: intentOf("trim it") });
    tasks.updateFields(filed.id, { model: "claude-fable-5-1" }, "firstmate");
    expect(await supervisor.starts.startQueuedNow(filed.key)).toContain(
      `${filed.key} "Trim the log" is starting.`,
    );
    await tick();
    expect(ops).toContain(
      `[fm-op] task ${filed.id} "Trim the log", which you started, is running now, with no model recorded, so claude-fable-5-1 is not confirmed.`,
    );
  });

  it("starts dropped, never-reported work again with its saved work, copied asks and moved waits, never escalation", async () => {
    const crewmate = fakeCrewmate();
    const routes: { shape: WorkShape }[] = [];
    const { supervisor, tasks, sessions, ops } = setup(crewmate, {
      routedModel: { provider: "fm-mock", id: "mock-1" },
      onRouteDecide: (args) => routes.push(args),
    });
    const parent = seedTask(tasks, { id: "live-chart", title: "Chart", status: "idle" });
    const basis = supervisor.intake.plan({ title: "Spec", intent: intentOf("describe it") });
    tasks.close(basis.id, { status: "done", reason: "answered", actor: "host" });
    const intent = {
      ...intentOf("finish the chart"),
      constraints: [{ kind: "free" as const, text: "implement the approved chart" }],
    };
    // The attempt the dropped one escalated from, so its lineage names real work.
    const rejected = seedTask(tasks, {
      id: "first-chart",
      title: "Finish the chart",
      status: "completed",
      outcome: "Not right.",
    });
    const old = seedTask(tasks, {
      id: "dropped-chart",
      title: "Finish the chart",
      status: "cancelled",
      intent,
      parentId: parent.id,
      shape: {
        kind: "fix",
        basis: basis.key,
        override_model_id: "fm-mock/mock-1",
        override_reasoning: "high",
        delivery_ask: "local-only",
        autonomy_ask: false,
        rigor_ask: "reviewed",
        policies: { autonomy: true, rigor: "standard", revision: 3 },
        escalation: { from: rejected.key, attempt: 1, floor: "high" },
        escalate_from: rejected.key,
        rigor: "quick",
        autonomy: false,
      },
    });
    tasks.placement.markWorkspaceRemoved(old.id);
    tasks.note(old.id, "working copy removed; its work is saved", {
      news: false,
      data: { saved: { ref: "refs/infinitary/kept/dropped-chart" } },
    });
    const waiter = tasks.create({
      id: "waiter-chart",
      title: "Share",
      prompt: "share it",
      repoId: null,
      startPolicy: "on-request",
      blockedBy: [old.id],
    });
    const closed = tasks.create({
      id: "closed-chart",
      title: "Older",
      prompt: "old",
      repoId: null,
    });
    tasks.graph.link(old.id, closed.id, "blocks", "host");
    tasks.close(closed.id, { status: "dropped", reason: "cancelled", actor: "host" });
    const result = supervisor.starts.startAgain(old.key, "captain");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.text);
    expect(await result.started).toContain(result.task.key);
    await tick();
    const fresh = tasks.get(result.task.id);
    expect(fresh).toMatchObject({
      status: "active",
      title: old.title,
      intent,
      goal: old.goal,
      repoId: old.repoId,
      projectId: old.projectId,
      priority: old.priority,
      parentId: parent.id,
      shape: {
        basis: basis.key,
        override_model_id: "fm-mock/mock-1",
        override_reasoning: "high",
        delivery_ask: "local-only",
        autonomy_ask: false,
        rigor_ask: "reviewed",
        policies: { autonomy: true, rigor: "standard", revision: 0 },
      },
    });
    expect(routes.at(-1)?.shape).not.toHaveProperty("escalation");
    expect(routes.at(-1)?.shape).not.toHaveProperty("escalate_from");
    expect(tasks.get(old.id)).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
      outcome: null,
    });
    expect(tasks.graph.linksTo(fresh?.id ?? "")).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromId: old.id, type: "replaced-by" })]),
    );
    expect(tasks.graph.blockers(waiter.id).map((row) => row.id)).toEqual([fresh?.id]);
    expect(tasks.graph.blockers(closed.id).map((row) => row.id)).toEqual([old.id]);
    expect(crewmate.promptCalls[0]).toContain(`starts dropped work ${old.key}`);
    expect(crewmate.promptCalls[0]).toContain("refs/infinitary/kept/dropped-chart");
    expect(crewmate.promptCalls[0]).toContain("start from it");
    expect(crewmate.promptCalls[0]).toContain("not preloaded");
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(ops).toEqual([]);
    expect(tasks.taskCardClicksSince(0)).toEqual([
      expect.objectContaining({ taskId: old.id, op: "start-again" }),
    ]);
    const seq = tasks.boardSeq();
    expect(supervisor.starts.startAgain(old.key)).toEqual({
      ok: false,
      text: `${fresh?.key} already replaces ${old.key}. Open that task instead.`,
    });
    expect(tasks.boardSeq()).toBe(seq);
  });

  it("start again refuses closed successes, live work, replacements, stronger retries and parents without writes", () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    const open = supervisor.intake.plan({ title: "Open", intent: intentOf("do it") });
    const done = seedTask(tasks, { id: "done-again", title: "Done", status: "idle" });
    tasks.close(done.id, { status: "done", reason: "merged", actor: "host" });
    const parent = seedTask(tasks, { id: "parent-again", title: "Parent", status: "cancelled" });
    seedTask(tasks, { id: "part-again", parentId: parent.id, title: "Part", status: "cancelled" });
    const retry = seedTask(tasks, { id: "retry-again", title: "Retry", status: "cancelled" });
    tasks.turns.recordEscalation({
      from: { id: retry.id, key: retry.key },
      to: { id: open.id, key: open.key },
      attempt: 1,
      tier: "high",
    });
    const seq = tasks.boardSeq();
    for (const id of [open.id, done.id, parent.id, retry.id]) {
      expect(supervisor.starts.startAgain(id).ok).toBe(false);
      expect(supervisor.hostOps.runTaskOp(id, "start-again")).toBeTruthy();
      expect(tasks.boardSeq()).toBe(seq);
    }
  });

  it("start again carries reports without reopening a closed parent, and start/steer point at it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const parent = seedTask(tasks, { id: "closed-parent", title: "Parent", status: "cancelled" });
    const old = seedTask(tasks, {
      id: "reported-drop",
      parentId: parent.id,
      title: "Reported",
      status: "cancelled",
      outcome: "The draft is written; tests remain.",
    });
    tasks.placement.markWorkspaceRemoved(old.id);
    expect(await supervisor.starts.startQueuedNow(old.key)).toContain("start_again");
    await expect(supervisor.steer.steerCrewmate(old.id, "continue")).rejects.toThrow("start_again");
    const result = supervisor.starts.startAgain(old.id);
    if (!result.ok) throw new Error(result.text);
    await result.started;
    await tick();
    expect(tasks.get(result.task.id)?.parentId).toBeNull();
    expect(crewmate.promptCalls[0]).toContain("The draft is written; tests remain.");
  });
});
