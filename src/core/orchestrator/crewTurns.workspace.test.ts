/**
 * The personal workspace's turns as `CrewTurns` commits them
 * (talk-to-personalize Step 4): a personal commission bound to the workspace
 * with no working copy, its directions served on every turn, each turn
 * committed with its report, and a commit that fails keeping the task open.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The workspace is a real git folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  reboot,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  type SetupExtras,
  served,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { BUILD_IN_PLACE_OPENING } from "./intentBrief";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

/**
 * The personal workspace (talk-to-personalize Step 4): a personal-ui commission
 * is bound to the personal workspace by the host, runs with no worktree
 * and the two panel checks, stamps and commits through the personal
 * delegate, routes a saved report like any other (INF-1677), and refuses every
 * other settle and every settle-effect card.
 */
describe("CrewSupervisor personal workspace (Step 4)", () => {
  function liveSetup(crewmate: FakeCrewmate, extras: SetupExtras = {}) {
    const base = setup(crewmate, extras);
    const workspaceDir = join(base.paths.fleetDir, "personal");
    mkdirSync(workspaceDir, { recursive: true });
    execFileSync("git", ["-C", workspaceDir, "init", "-q", "-b", "main"]);
    const commits: { taskId: string; message: string }[] = [];
    const lints: { id?: string }[] = [];
    const captures: { id: string; taskId: string }[] = [];
    const places: { id?: string; taskId: string }[] = [];
    const live = { begun: [] as string[], ended: [] as string[] };
    const personal = {
      workspaceDir,
      repo: () => base.repos.ensurePersonal(workspaceDir),
      surfaces: () => [{ id: "open-prs", title: "Open PRs", placement: { x: "right" as const } }],
      beginLiveTask: (taskId: string) => {
        live.begun.push(taskId);
      },
      endLiveTask: (taskId: string) => {
        live.ended.push(taskId);
      },
      commitTurn: vi.fn(async (taskId: string, message: string) => {
        commits.push({ taskId, message });
        return { committed: true, sha: "abcdef0123456789", touched: ["tokyo-clock"], findings: [] };
      }),
      lint: vi.fn(async (input: { id?: string }) => {
        lints.push(input);
        return "tokyo-clock: No findings.";
      }),
      place: vi.fn(async (input: { id?: string; taskId: string }) => {
        places.push(input);
        return {
          ok: true as const,
          waitedMs: 0,
          panels: [
            {
              id: "tokyo-clock",
              title: "Tokyo clock",
              placed: true,
              mount: {
                id: "tokyo-clock",
                kind: "personal" as const,
                version: "v1",
                state: "stopped" as const,
                rail: "left" as const,
                why: "TypeError: Cannot read properties of undefined (reading 'map')",
              },
              last: null,
            },
          ],
        };
      }),
      capture: vi.fn(async (input: { id: string; taskId: string }) => {
        captures.push(input);
        return { ok: false as const, id: input.id, reason: "no host" };
      }),
    };
    // The delegate is an option of the supervisor; the harness built one
    // without it, so a second supervisor is built over the same stores.
    const supervisor = reboot(base, base.sessions.open, {
      specs: base.specs,
      personal,
      ...(extras.knowledge ? { knowledge: extras.knowledge(base.repos) } : {}),
      recordSort: (input) => {
        base.sorts.push({ taskId: input.taskId, verdict: input.verdict, rule: input.rule });
        input.effect?.();
      },
      broadcastEvent: (event) => base.events.push(event),
    });
    supervisor.setFirstmateHooks({
      notifyOp: (wake) => base.ops.push(served(wake)),
      retryConverse: vi.fn(),
    });
    return { ...base, supervisor, personal, workspaceDir, commits, lints, captures, places, live };
  }

  it("binds a personal-ui commission to the personal workspace with no worktree, the checks, and a brief that names no delivery", async () => {
    const crewmate = fakeCrewmate();
    const h = liveSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: {
        goal: "A Tokyo clock panel",
        userWords: "make me a tokyo clock",
        kind: "personal-ui",
      },
      // A repo_id the model passed along is ignored: the host binds the workspace.
      repoId: (await h.repos.setup({ kind: "init", name: "elsewhere" })).repo.id,
    });
    await tick();
    const record = h.tasks.get(taskId);
    expect(record).toMatchObject({
      status: "active",
      repoDir: h.workspaceDir,
      worktreeDir: "",
      branch: "",
      workspaceState: "none",
    });
    expect(h.repos.get(record?.repoId ?? "")).toMatchObject({
      name: "personal",
      kind: "personal",
      delivery: "local-only",
    });
    expect(h.workspace.createTaskWorktree).not.toHaveBeenCalled();
    const spec = h.specs.at(-1);
    expect(spec?.cwd).toBe(h.workspaceDir);
    expect(typeof spec?.onLintPanel).toBe("function");
    expect(typeof spec?.onCapturePanel).toBe("function");
    expect(await spec?.onLintPanel?.({})).toBe("tokyo-clock: No findings.");
    await spec?.onCapturePanel?.({ id: "tokyo-clock" });
    expect(h.captures).toEqual([{ id: "tokyo-clock", taskId }]);
    // INF-607: the version goes on the captain's rail, and the window's
    // answer is the crewmate's and the timeline's, never the feed's.
    const placed = await spec?.onPlacePanel?.({ id: "tokyo-clock" });
    expect(h.places).toEqual([{ id: "tokyo-clock", taskId }]);
    expect(placed).toMatchObject({ ok: true, panels: [{ mount: { state: "stopped" } }] });
    const placing = h.tasks
      .timeline(taskId)
      .find((event) => event.kind === "note" && event.data?.placed !== undefined);
    expect(placing?.feed).toBe(false);
    expect(placing?.text).toContain(
      "its body stopped drawing: TypeError: Cannot read properties of undefined (reading 'map')",
    );
    expect(h.live.begun).toEqual([taskId]);
    const brief = crewmate.promptCalls[0] ?? "";
    // A workspace kind, not a posture: the brief writes no Delivery line
    // and no Rigor line, and leads the workspace facts with the in-place
    // sentence the posture used to carry.
    expect(brief).not.toContain("Delivery:");
    expect(brief).not.toContain("Care:");
    expect(brief).toContain(`${BUILD_IN_PLACE_OPENING}: this task carries no delivery posture`);
    expect(brief).toContain(`Workspace: ${h.workspaceDir}`);
    expect(brief).toContain('Surfaces now: open-prs "Open PRs" (right rail)');
    // Nothing stamped a tier on the record either.
    expect(h.tasks.get(taskId)?.shape?.rigor).toBeUndefined();
  });

  /**
   * INF-1054 (the captain's "A. One store, one way in: panel instructions
   * are ordinary directions"): a panel instruction is a direction scoped to
   * the personal workspace, so the crewmate building a panel hears it, and a
   * retired one is gone from the next set. Its conversation holds the set
   * it read until the set changes (INF-2599: "Send a crewmate its directions
   * once, and again only when they change").
   */
  it("serves the personal workspace's directions, then again only without a retired one", async () => {
    const crewmate = fakeCrewmate();
    let knowledge: KnowledgeService | undefined;
    const h = liveSetup(crewmate, {
      knowledge: (registry) => {
        knowledge ??= new KnowledgeService({
          projects: { get: (id) => registry.get(id), list: () => registry.list() },
        });
        return knowledge;
      },
    });
    const personal = h.repos.ensurePersonal(h.workspaceDir);
    knowledge?.directions.change({
      op: "add",
      id: "compact-rows",
      scope: personal.id,
      text: "Always use compact rows in my panels.",
      reason: "captain said so",
    });
    knowledge?.directions.change({
      op: "add",
      id: "tokyo-time",
      scope: personal.id,
      text: "Show times in Tokyo time.",
      reason: "captain said so",
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: { goal: "g", userWords: "w", kind: "personal-ui" },
    });
    await tick();
    expect(crewmate.promptCalls[0]).toContain("Always use compact rows in my panels.");
    expect(crewmate.promptCalls[0]).toContain("Show times in Tokyo time.");
    // The model reads the turn's input: its first request starts.
    crewmate.emit({ type: "request_started" });
    crewmate.finishPrompt();
    await tick();
    await h.supervisor.steer.steerCrewmate(taskId, "make it bigger");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain("make it bigger");
    expect(crewmate.promptCalls.at(-1)).not.toContain("Show times in Tokyo time.");
    crewmate.emit({ type: "request_started" });
    crewmate.finishPrompt();
    await tick();
    knowledge?.directions.change({
      op: "retire",
      id: "compact-rows",
      reason: "captain retired it",
    });
    await h.supervisor.steer.steerCrewmate(taskId, "and blue");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain("and blue");
    expect(crewmate.promptCalls.at(-1)).toContain("Show times in Tokyo time.");
    expect(crewmate.promptCalls.at(-1)).not.toContain("Always use compact rows in my panels.");
  });

  // INF-1677: a panel build ends with the default completion. The host saves
  // the turn, the report reaches the first mate, and its finished close ends it.
  it("commits the turn with the report, routes it, and closes done when the first mate declares it finished", async () => {
    const crewmate = fakeCrewmate();
    const h = liveSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: { goal: "g", userWords: "w", kind: "personal-ui" },
    });
    await tick();
    // No settle mode applies to a personal task, with the reason.
    expect(await h.supervisor.settling.settle.settleTask(taskId, "land")).toContain(
      "builds in place on the personal workspace",
    );
    expect(await h.supervisor.settling.settle.settleTask(taskId, "discard")).toContain(
      "nothing to merge, land, or discard",
    );
    expect(await h.supervisor.settling.settle.settleTask(taskId, "merge-pr")).toContain(
      "personal workspace",
    );
    expect(h.tasks.get(taskId)?.status).toBe("active");

    crewmate.emit({ type: "assistant_delta", taskId, text: "Tokyo clock panel added." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    // The report routes only once its commit is saved.
    await vi.waitFor(() => expect(h.ops).toHaveLength(1));
    expect(h.commits).toEqual([{ taskId, message: "Tokyo clock panel added." }]);
    expect(h.ops[0]).toContain("Tokyo clock panel added.");
    expect(h.tasks.get(taskId)?.status).toBe("active");
    expect(crewmate.dispose).not.toHaveBeenCalled();
    expect(
      (
        await h.supervisor.settling.declared.closeFinishedFolderWork(
          taskId,
          "the clock is on the right rail",
        )
      ).text,
    ).toContain("as finished");
    expect(h.tasks.get(taskId)).toMatchObject({
      status: "done",
      closedReason: "finished",
      delivery: { mode: "in-place" },
      workspaceState: "none",
    });
    expect(h.workspace.removeTaskWorktree).not.toHaveBeenCalled();
    // The report is the feed line; the commit is a timeline note, never a feed line.
    const kinds = h.tasks.timeline(taskId).map((event) => [event.kind, event.feed]);
    expect(kinds).toContainEqual(["report", true]);
    expect(kinds).toContainEqual(["note", false]);
    // A refused settle above is a note of its own (a refused merge is a row).
    expect(
      h.tasks.timeline(taskId).find((event) => event.kind === "note" && !event.data?.refused)?.text,
    ).toContain("committed abcdef0 in the personal workspace (tokyo-clock)");
    expect(h.ops).toHaveLength(1);
    expect(h.live.ended).toContain(taskId);
    expect(crewmate.dispose).toHaveBeenCalled();
  });

  it("keeps the task open and tells the Firstmate when the commit fails, and routes the report once a later one commits", async () => {
    const crewmate = fakeCrewmate();
    const h = liveSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: { goal: "g", userWords: "w", kind: "personal-ui" },
    });
    await tick();
    const refusal = "fatal: Unable to create '.git/index.lock': File exists.";
    h.personal.commitTurn.mockRejectedValueOnce(new Error(refusal));
    crewmate.emit({ type: "assistant_delta", taskId, text: "Tokyo clock panel added." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.ops).toHaveLength(1));
    await tick();
    // Not done and not built in place: the files are saved, uncommitted.
    expect(h.tasks.get(taskId)?.status).toBe("active");
    expect(h.tasks.get(taskId)?.delivery?.mode).toBeUndefined();
    expect(crewmate.dispose).not.toHaveBeenCalled();
    expect(
      h.tasks.timeline(taskId).find((event) => event.data?.commitFailed !== undefined)?.data,
    ).toMatchObject({ commitFailed: refusal });
    // The Firstmate hears git's words about this task.
    expect(h.ops[0]).toContain(taskId);
    expect(h.ops[0]).toContain(refusal);

    // The failed turn's report is not routed as finished work.
    expect(h.ops[0]).not.toContain("Tokyo clock panel added.");

    // A steer starts the next turn; its report commits again and routes.
    await h.supervisor.steer.steerCrewmate(taskId, "the lock is gone, report again");
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "Tokyo clock panel added again." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.ops).toHaveLength(2));
    expect(h.ops[1]).toContain("Tokyo clock panel added again.");
    expect(h.commits).toEqual([{ taskId, message: "Tokyo clock panel added again." }]);
    expect(h.tasks.get(taskId)?.status).toBe("active");
  });

  it("routes a report beside its note, and the finished close keeps the note", async () => {
    const crewmate = fakeCrewmate();
    const h = liveSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: { goal: "g", userWords: "w", kind: "personal-ui" },
    });
    await tick();
    const spec = h.specs.at(-1);
    const cardId = syncCardId(
      await spec?.onCard?.({
        title: "Clock is ready",
        body: "<p>The Tokyo clock is ready.</p><p>Your panel shows the current time.</p>",
        actions: [],
      }),
    );
    expect(cardId).toBeDefined();
    spec?.onReport?.("Tokyo clock panel added.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    // A note is not a decision: the report wakes the first mate like any other.
    await vi.waitFor(() => expect(h.ops).toHaveLength(1));
    expect(h.sorts.at(-1)).toMatchObject({ taskId, verdict: "captain" });
    expect(h.commits).toEqual([{ taskId, message: "Tokyo clock panel added." }]);
    expect(
      (
        await h.supervisor.settling.declared.closeFinishedFolderWork(
          taskId,
          "the clock is on the right rail",
        )
      ).text,
    ).toContain("as finished");
    expect(h.tasks.get(taskId)?.closedReason).toBe("finished");
    expect(h.supervisor.cards.snapshot().find((card) => card.id === cardId)).toMatchObject({
      taskId,
      actions: [],
    });
  });

  // With its note up the wait is quiet; with no card up the captain has
  // nothing to answer, so the first mate owes the card (INF-11).
  it.each([false, true])("keeps a declared captain wait open (note: %s)", async (note) => {
    const crewmate = fakeCrewmate();
    const h = liveSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: { goal: "g", userWords: "w", kind: "personal-ui" },
    });
    await tick();
    const spec = h.specs.at(-1);
    const cardId = note
      ? syncCardId(
          await spec?.onCard?.({
            title: "Clock is ready",
            body: "<p>The Tokyo clock is ready.</p><p>Your panel shows the current time.</p>",
            actions: [],
          }),
        )
      : undefined;
    spec?.onReport?.("Please check the clock's time zone.", undefined, {
      wait: { reason: "check the time zone", ...(cardId ? { cardId } : {}) },
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.commits).toHaveLength(1));
    await tick();
    expect(h.tasks.get(taskId)?.status).toBe("active");
    expect(h.tasks.get(taskId)?.delivery?.captainWait).toMatchObject({
      reason: "check the time zone",
    });
    if (note) {
      expect(h.sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });
      expect(h.ops).toEqual([]);
    } else {
      expect(h.sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "captain-gate" });
      expect(h.ops).toEqual([
        expect.stringContaining(
          "It waits on the captain to check the time zone, and no card of its is on their screen.",
        ),
      ]);
    }
    expect(crewmate.dispose).not.toHaveBeenCalled();
  });

  it("keeps the task open when the report sits beside the crewmate's own decision card, and refuses a settle-effect card", async () => {
    const crewmate = fakeCrewmate();
    const h = liveSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Tokyo clock",
      intent: { goal: "g", userWords: "w", kind: "personal-ui" },
    });
    await tick();
    const spec = h.specs.at(-1);
    // The refusal is the tool's error text, thrown at the boundary.
    expect(() =>
      spec?.onCard?.({
        requiredActions: [],
        title: "Clock is ready",
        body: completionBody("<p>Done.</p><ul><li>The clock renders in both themes.</li></ul>"),
        actions: [
          { id: "merge", label: "Merge", default: true, effect: SETTLE_MERGE },
          { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
        ],
      }),
    ).toThrow(/builds in place on the personal workspace/);
    const cardId = syncCardId(
      await spec?.onCard?.({
        title: "Which zone?",
        body: "<p>Tokyo or Osaka?</p><ul><li>Tokyo is the office.</li><li>Osaka is home.</li></ul>",
        actions: [
          { id: "tokyo", label: "Tokyo", default: true },
          { id: "osaka", label: "Osaka" },
        ],
      }),
    );
    expect(cardId).toBeDefined();
    crewmate.emit({ type: "assistant_delta", taskId, text: "Waiting on the zone." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    // The commit still happened; the decision is the captain's, so the task
    // stays - and the whose-turn rule says the same thing about the wake:
    // his card is up, so nothing is owed to the Firstmate (S7c).
    expect(h.commits).toEqual([{ taskId, message: "Waiting on the zone." }]);
    expect(h.tasks.get(taskId)?.status).toBe("active");
    expect(h.ops.filter((line) => line.includes("reported on task"))).toEqual([]);
    expect(h.sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "captain-card" });
  });

  it("refuses a personal-ui commission when this build has no personal workspace", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    await expect(
      supervisor.intake.commission({
        title: "Clock",
        intent: { goal: "g", userWords: "w", kind: "personal-ui" },
      }),
    ).rejects.toThrow(/Personal panels are not available/);
    expect(tasks.list()).toEqual([]);
  });
});
