/**
 * A started task's moves as `TaskMoves` drives them (docs/helper.md,
 * "Moving a started task"): a Move from a sign-in card, and a started task
 * moved to another computer at a safe pause with its key, branch, working
 * copy and record kept.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The moves to another computer drive real git.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Card } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import { CLAUDE_PROVIDER_ID, COPILOT_PROVIDER_ID } from "@shared/providers";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateEvidenceDir } from "../paths";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { CrewMachines } from "../placed/crewMachines";
import type { SessionSpec } from "../session/session";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import { git } from "../workspace/git";
import { packWork, unpackWork } from "../workspace/workMove";
import type {
  DependencyInstall,
  WorkspaceService as RealWorkspaceService,
} from "../workspace/workspaceService";
import { QUIT_SETTLE_MS } from "./crewRuntime";
import type { CrewSupervisor } from "./crewSupervisor";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  // INF-849: a card left up after the task moved does nothing again.
  it("refuses a second Move from a card whose task already left that provider", async () => {
    const copilot = { provider: COPILOT_PROVIDER_ID, id: "gpt-5.1" };
    const crewmate = fakeCrewmate({ model: copilot });
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: copilot,
      movePick: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
    });
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    crewmate.finishPrompt();
    await tick();
    expect(supervisor.moves.requestMove(taskId, { by: "captain", from: "xai" })).toEqual({
      ok: false,
      text: `${tasks.get(taskId)?.key} "t" already moved off Grok.`,
    });
  });

  // INF-849, the captain: "it's better if we can show "Move to <model>"" - a
  // click moves to the model its card named, or does not move.
  it("refuses a Move whose card named a model the app would no longer pick", async () => {
    const copilot = { provider: COPILOT_PROVIDER_ID, id: "gpt-5.1" };
    const crewmate = fakeCrewmate({ model: copilot });
    const { supervisor, tasks } = setup(crewmate, {
      routedModel: copilot,
      movePick: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
      modelName: (model) => (model.id === "gpt-6.1-sol" ? "GPT-6.1 Sol" : model.id),
    });
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    crewmate.finishPrompt();
    await tick();
    expect(
      supervisor.moves.requestMove(taskId, {
        by: "captain",
        from: COPILOT_PROVIDER_ID,
        offered: "xai/grok-5",
      }),
    ).toEqual({
      ok: false,
      text: `${tasks.get(taskId)?.key} "t" did not move: the app would now pick GPT-6.1 Sol, not the model its card offered.`,
    });
    expect(tasks.get(taskId)?.model).toBe(`${COPILOT_PROVIDER_ID}/gpt-5.1`);
  });

  // INF-849: "A turn is never cut short" - a move asked for mid-turn waits
  // for the turn to end; from a Claude conversation, which Pi cannot reopen,
  // the crewmate starts a new conversation told it moved.
  it("moves a crewmate mid-turn once its turn ends, and tells a new conversation it moved", async () => {
    const claude = { provider: CLAUDE_PROVIDER_ID, id: "claude-fable-5" };
    const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const crewmate = fakeCrewmate({
      model: claude,
      sessionId: "0f3a2c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
      resume: { backend: "claude", sessionId: "0f3a2c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b" },
    });
    const moved = fakeCrewmate({
      model: codex,
      sessionId: "s-moved",
      resume: { backend: "pi", sessionFile: "/tmp/s-moved.jsonl" },
    });
    const { supervisor, tasks, specs, sessionSpecs } = setup(crewmate, {
      routedModel: claude,
      crewmates: [moved],
      movePick: (shape) =>
        shape.override_model_id === "openai-codex/gpt-6.1-sol" ? codex : undefined,
    });
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const asked = supervisor.moves.requestMove(taskId, {
      by: "firstmate",
      model: "openai-codex/gpt-6.1-sol",
    });
    expect(asked.ok).toBe(true);
    expect(asked.text).toContain("once its crewmate's turn ends");
    expect(specs).toHaveLength(1);
    expect(crewmate.aborts).toEqual([]);
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(specs).toHaveLength(2));
    // The next message reaches the new conversation after what it is told first.
    await supervisor.steer.steerCrewmate(taskId, "carry on");
    await vi.waitFor(() => expect(moved.promptCalls.length).toBeGreaterThan(0));
    expect(moved.promptCalls[0]).toContain("carry on");
    expect(specs.at(-1)).toMatchObject({ model: codex });
    const shape = sessionSpecs.at(-1)?.shape;
    expect(shape?.turns === "rolling" && shape.record.resume).toBe(undefined);
    expect(moved.promptCalls[0]).toContain(
      "your task moved to Codex, which cannot reopen a conversation another provider held",
    );
    // INF-1288: moving creates a second association, not a rewritten history.
    expect(tasks.archive.sessions(taskId)).toMatchObject([
      {
        conversation: crewmate.sessionId,
        provider: claude.provider,
        model: claude.id,
        began: "start",
        current: false,
      },
      {
        conversation: moved.sessionId,
        provider: codex.provider,
        model: codex.id,
        began: "move",
        current: true,
      },
    ]);
    expect(tasks.get(taskId)?.model).toBe("openai-codex/gpt-6.1-sol");
    expect(tasks.timeline(taskId).map((event) => [event.actor, event.text])).toContainEqual([
      "firstmate",
      "the first mate moved it from Claude to gpt-6.1-sol on Codex",
    ]);
  });
});

/**
 * INF-1713, the captain: "this task is only about moving a task from one
 * machine to another". A started task moves to another computer at a safe
 * pause and keeps its key, branch, uncommitted work and files; a move that
 * does not finish leaves it where it was.
 */
// Integration budget (docs/test-cohorts.md): real git, the slowest test
// (worker to worker, two moves) 2.112 s on the Mac mini.
describe("a started task moves to another computer (INF-1713, real git)", {
  timeout: 10_000,
}, () => {
  const movingFixtures: {
    supervisor: CrewSupervisor;
    workspace: RealWorkspaceService;
    tasks: TaskService;
  }[] = [];
  afterEach(async () => {
    for (const { supervisor, workspace, tasks } of movingFixtures.splice(0)) {
      await supervisor.disposeAll();
      // Quit is bounded. Drain actual move work before its pool, but do not
      // ask this stopped launch to reopen a durably deferred conversation.
      await movesFinished(tasks, supervisor);
      await workspace.poolSettled();
      await workspace.deletionsSettled();
    }
  });
  function movesFinished(tasks: TaskService, supervisor: CrewSupervisor): Promise<void> {
    return vi.waitFor(() => {
      const unfinished = tasks.list().filter((task) => {
        const move = task.shape?.computer_move;
        if (!move || move.phase === "waiting") return false;
        // A committed move cannot retire its source until it reopens. Once
        // this launch's operation ends, that record belongs to the next one.
        // An install still in flight remains busy, even after bounded quit.
        if (
          move.phase === "retiring" &&
          (move.restartFrom !== undefined || move.preparing) &&
          !supervisor.sessions.conversationBusy(task.id)
        )
          return false;
        return true;
      });
      expect(unfinished.map((task) => task.id)).toEqual([]);
    }, REAL_GIT_WAIT);
  }
  beforeEach(() => {
    vi.useRealTimers();
  });
  const REAL_GIT_WAIT = { timeout: 8_000, interval: 25 };
  const MINI = "mini-device";
  const author = ["-c", "user.name=T", "-c", "user.email=t@l"];

  const AIR = "air-device";
  const NAMES: Record<string, string> = { [MINI]: "Kun's Mac mini", [AIR]: "Kun's MacBook Air" };

  /**
   * A project with an origin, a task started here, and two computers that
   * take moves: the Mac mini and the MacBook Air. `moveIn` says how a
   * computer takes the work: it fails before copying, fails after it
   * copied (its answer lost on the way), or waits until `arrive` lets it,
   * `copied` once its copy is whole.
   */
  async function startedHere(
    options: {
      moveIn?: "fail" | "fail-after-copy" | "wait";
      bootFails?: boolean;
      /** Runs while a conversation opens there, before that computer answers. */
      opening?: () => void;
      install?: () => Promise<DependencyInstall>;
      retire?: () => Promise<void>;
      browser?: { current: TaskBrowserFact | undefined; withCaptain?: boolean };
    } = {},
  ) {
    const crewmate = fakeCrewmate();
    const boots = [MINI, AIR, MINI].map((machine, n) =>
      fakeCrewmate({
        sessionId: `s-${machine}-${n}`,
        resume: { backend: "pi", sessionFile: `/${machine}/s-${n}.jsonl` },
      }),
    );
    const boot = boots[0] as FakeCrewmate;
    const root = scratchDir("infinitary-move-there-");
    const thereOf = (machine: string) => join(root, machine);
    const there = thereOf(MINI);
    const opened: SessionSpec[] = [];
    let bootFails = options.bootFails === true;
    const factory = {
      backend: "pi" as const,
      controlProfile: PI_CONTROL_PROFILE,
      open: async (spec: SessionSpec) => {
        if (bootFails) {
          bootFails = false;
          throw new Error("Kun's Mac mini did not answer in time");
        }
        opened.push(spec);
        const boot = boots[opened.length - 1] as FakeCrewmate;
        options.opening?.();
        return boot;
      },
    };
    const arrive = deferred<void>();
    const copied = deferred<void>();
    const moveIn = vi.fn(
      async (
        machine: string,
        _taskId: string,
        _attempt: string,
        input: { repoId: string | null; head: string; branch: string; pack: string },
      ) => {
        if (options.moveIn === "fail") throw new Error("the Mac mini's disk is full");
        // The computer's own side: a copy of the project at the moved
        // commit, with the pack unpacked into it and its task folders.
        const work = join(thereOf(machine), "work");
        await git(root, ["clone", "--quiet", h.repo.path, work]);
        await git(work, ["checkout", "--quiet", "-B", input.branch, input.head]);
        await unpackWork(work, input.pack, { evidence: join(thereOf(machine), "evidence") });
        copied.resolve();
        // A computer that holds the work but has not answered yet.
        if (options.moveIn === "wait") await arrive.promise;
        if (options.moveIn === "fail-after-copy")
          throw new Error("the answer from Kun's Mac mini was lost on the way");
        return { cwd: work, branch: input.branch };
      },
    );
    // A computer's own side of packing: its copy and folders, as it holds them.
    const moveOut = vi.fn(
      async (machine: string, _taskId: string, _attempt: string, pack: string) => {
        const { manifest } = await packWork(
          join(thereOf(machine), "work"),
          `fm/task-${h.taskId}`,
          { evidence: join(thereOf(machine), "evidence") },
          pack,
        );
        return { head: manifest.head, branch: manifest.branch, repoDir: h.repo.path };
      },
    );
    // That computer's side of letting a copy go: its working copy and the
    // task's folders there are removed for good (the real owners' removal is
    // placedWorkingCopies.test.ts's move journey).
    const retireMoved = vi.fn(async (machine: string) => {
      await options.retire?.();
      await rm(thereOf(machine), { recursive: true, force: true });
    });
    const install = vi.fn(
      options.install ?? (async (): Promise<DependencyInstall> => ({ outcome: "skipped" })),
    );
    const reach: Record<string, boolean> = { mini: true };
    const machines = {
      computers: () => [MINI, AIR],
      ready: () => reach.mini,
      takesMoves: () => true,
      nameOf: (id: string) => NAMES[id],
      placeOf: (id: string) => ({ label: NAMES[id], where: `on ${NAMES[id]}` }),
      signInWait: () => undefined,
      folders: (id: string) => ({
        work: join(thereOf(id), "work"),
        sessions: join(thereOf(id), "sessions"),
      }),
      factories: () => ({ pi: factory, claude: { ...factory, backend: "claude" as const } }),
      served: async () => ({ accounts: { has: () => true }, modelAccounts: { has: () => true } }),
      servingAccount: () => undefined,
      accountOf: () => undefined,
      cutOffOf: () => undefined,
      knows: () => false,
      install,
      moveIn,
      moveOut,
      retireMoved,
    } as unknown as CrewMachines;
    const browser = options.browser;
    const h0 = setup(crewmate, {
      realWorkspace: true,
      machines,
      ...(browser
        ? {
            browsers: {
              forTask: () => undefined,
              fact: () => browser.current,
              withCaptain: () => browser.withCaptain === true,
              requestHelp: async () => ({ ok: false, text: "no browser" }),
              takeControl: async () => ({ ok: false, text: "no browser" }),
            } as unknown as CrewSupervisorOptions["browsers"],
          }
        : {}),
    });
    movingFixtures.push({
      supervisor: h0.supervisor,
      workspace: h0.realWorkspace as RealWorkspaceService,
      tasks: h0.tasks,
    });
    const { repo } = await h0.repos.setup({ kind: "init", name: "meter" });
    writeFileSync(join(repo.path, "meter.ts"), "export const unit = 'kWh';\n");
    await git(repo.path, ["add", "meter.ts"]);
    await git(repo.path, [...author, "commit", "--quiet", "-m", "chore: start"]);
    const remote = join(scratchDir("infinitary-move-origin-"), "origin.git");
    await git(dirname(remote), ["init", "--bare", "--initial-branch=main", remote]);
    h0.repos.configure(repo.id, { origin: remote, delivery: "direct-pr" });
    const h = {
      ...h0,
      crewmate,
      boot,
      boots,
      opened,
      moveIn,
      moveOut,
      retireMoved,
      install,
      arrive,
      copied,
      machines,
      repo,
      there,
      thereOf,
      reach,
      taskId: "",
    };
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("Fix the meter's unit."),
      repoId: repo.id,
    });
    h.taskId = taskId;
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    const cwd = h.tasks.get(taskId)?.worktreeDir ?? "";
    // Mid-turn work of every kind: a commit, a staged file, an edit, an untracked file, evidence.
    writeFileSync(join(cwd, "meter.ts"), "export const unit = 'Wh';\n");
    await git(cwd, [...author, "commit", "--quiet", "-am", "fix: meter unit"]);
    writeFileSync(join(cwd, "staged.ts"), "export const staged = true;\n");
    await git(cwd, ["add", "staged.ts"]);
    writeFileSync(join(cwd, "meter.ts"), "export const unit = 'mWh';\n");
    writeFileSync(join(cwd, "notes.md"), "untracked notes\n");
    mkdirSync(crewmateEvidenceDir(h.paths, taskId), { recursive: true });
    writeFileSync(join(crewmateEvidenceDir(h.paths, taskId), "before.txt"), "evidence\n");
    return { ...h, taskId, cwd };
  }

  it("waits for the turn to end, starts no new turn meanwhile, and carries the work to the Mac mini", async () => {
    const h = await startedHere();
    const asked = await h.supervisor.moves.requestComputerMove(
      h.taskId,
      "Kun's Mac mini",
      "captain",
    );
    expect(asked.ok).toBe(true);
    expect(asked.text).toContain("once its crewmate's current turn ends");
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get(h.taskId) as TaskRecord)).toEqual({
      computerMove: {
        from: HERE.this,
        to: "Kun's Mac mini",
        state: "waiting",
        waitingFor: ["its crewmate's current turn ends"],
      },
    });
    // The Mac mini goes out of reach: the turn ends on its own, and the
    // task does not move, nor start a new turn, until it is back.
    h.reach.mini = false;
    h.crewmate.finishPrompt();
    await vi.waitFor(
      () => expect(h.supervisor.sessions.conversationBusy(h.taskId)).toBe(false),
      REAL_GIT_WAIT,
    );
    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "Check the header too.")).toBe(
      "recorded-held",
    );
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get(h.taskId) as TaskRecord)).toEqual({
      computerMove: {
        from: HERE.this,
        to: "Kun's Mac mini",
        state: "waiting",
        waitingFor: ["Kun's Mac mini is in reach"],
      },
    });
    expect(h.moveIn).not.toHaveBeenCalled();
    h.reach.mini = true;
    await h.supervisor.watch.sweepGates(Date.now());

    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    expect(h.crewmate.promptCalls).toHaveLength(1);
    const work = join(h.there, "work");
    // The commit, the staged file, the edit, the untracked file and the evidence all arrived.
    expect(await git(work, ["log", "-1", "--format=%s"])).toBe("fix: meter unit");
    expect(await git(work, ["diff", "--cached", "--name-only"])).toBe("staged.ts");
    expect(readFileSync(join(work, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("untracked notes\n");
    expect(readFileSync(join(h.there, "evidence", "before.txt"), "utf8")).toBe("evidence\n");
    // The same task, key and branch; its old working copy here is gone.
    expect(h.tasks.get(h.taskId)).toMatchObject({
      status: "active",
      worktreeDir: "",
      branch: `fm/task-${h.taskId}`,
    });
    expect(existsSync(h.cwd)).toBe(false);
    // A new conversation there, told it moved, with the steer that waited.
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatchObject({ machine: MINI });
    // Never the conversation it left here.
    expect(JSON.stringify(h.opened[0])).not.toContain("s1.jsonl");
    await vi.waitFor(() => expect(h.boot.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boot.promptCalls[0]).toContain("your task moved to Kun's Mac mini");
    expect(h.boot.promptCalls[0]).toContain("Check the header too.");
    const notes = h.tasks.timeline(h.taskId).map((event) => event.text);
    expect(notes).toContain(
      `the captain moved it from ${HERE.this} to Kun's Mac mini; it keeps its key, branch, working copy and files`,
    );
    expect(notes).toContain(`the working copy it left on ${HERE.this} was removed`);
    await h.supervisor.disposeAll();
  });

  it("cancels a move that has not started crossing, and the task carries on where it is", async () => {
    const h = await startedHere();
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    expect(h.supervisor.moves.cancelComputerMove(h.taskId, "captain")).toEqual({
      ok: true,
      text: `${h.tasks.get(h.taskId)?.key} "Fix the meter" stays on ${HERE.this}.`,
    });
    h.crewmate.finishPrompt();
    await vi.waitFor(
      () => expect(h.supervisor.sessions.conversationBusy(h.taskId)).toBe(false),
      REAL_GIT_WAIT,
    );
    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "Check the header too.")).toBe(
      "mid-turn",
    );
    expect(h.crewmate.promptCalls.at(-1)).toContain("Check the header too.");
    expect(h.moveIn).not.toHaveBeenCalled();
    expect(h.tasks.get(h.taskId)).toMatchObject({ deviceId: null, worktreeDir: h.cwd });
    await h.supervisor.disposeAll();
  });

  it("leaves the task and its work where they were when the destination cannot take it", async () => {
    const h = await startedHere({ moveIn: "fail" });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "firstmate")).ok).toBe(
      true,
    );
    h.crewmate.finishPrompt();
    await vi.waitFor(
      () => expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined(),
      REAL_GIT_WAIT,
    );
    expect(h.retireMoved).toHaveBeenCalledWith(MINI, h.taskId);
    expect(h.tasks.get(h.taskId)).toMatchObject({ deviceId: null, worktreeDir: h.cwd });
    expect(readFileSync(join(h.cwd, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      `its move to Kun's Mac mini did not finish: the Mac mini's disk is full. It stays on ${HERE.this}`,
    );
    // Its conversation here reopens as it was.
    await h.supervisor.steer.steerCrewmate(h.taskId, "carry on");
    await vi.waitFor(
      () => expect(h.crewmate.promptCalls.at(-1)).toContain("carry on"),
      REAL_GIT_WAIT,
    );
    expect(h.opened).toHaveLength(0);
    await h.supervisor.disposeAll();
  });

  /** The next launch: a new supervisor over the same record, inbox and computers. */
  function relaunched(h: Awaited<ReturnType<typeof startedHere>>) {
    const reopened = fakeCrewmate();
    const fresh = reboot(
      h,
      vi.fn(async () => reopened),
      {
        workspace: h.realWorkspace as RealWorkspaceService,
        machines: h.machines,
      },
    );
    fresh.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
    return { fresh, reopened };
  }

  // Review INF-1772 R11, the captain: "Add the missing tests". The checks below
  // are the ones it named: worker to worker, a quit, a lost answer, a stale
  // message, a move that waits across a quit, a waiting card, and a failure
  // after the work started copying; R3, R4, R5 and R9 are the review's fixes.

  it("moves from one computer that runs work to another, and removes the copy it left", async () => {
    const h = await startedHere();
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, AIR, "firstmate")).ok).toBe(
      true,
    );
    await h.supervisor.watch.sweepGates(Date.now());
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(AIR);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    expect(h.moveOut).toHaveBeenCalledWith(
      MINI,
      h.taskId,
      expect.any(String),
      expect.any(String),
      undefined,
    );
    const work = join(h.thereOf(AIR), "work");
    expect(await git(work, ["log", "-1", "--format=%s"])).toBe("fix: meter unit");
    expect(await git(work, ["diff", "--cached", "--name-only"])).toBe("staged.ts");
    expect(readFileSync(join(work, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("untracked notes\n");
    expect(readFileSync(join(h.thereOf(AIR), "evidence", "before.txt"), "utf8")).toBe("evidence\n");
    expect(h.retireMoved).toHaveBeenLastCalledWith(MINI, h.taskId);
    expect(existsSync(h.thereOf(MINI))).toBe(false);
    expect(h.opened.map((spec) => spec.machine)).toEqual([MINI, AIR]);
    // Told it moved with the next thing on its lane, there and never on the Mac mini.
    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "Check the header too.")).toBe(
      "mid-turn",
    );
    await vi.waitFor(() => expect(h.boots[1]?.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boots[1]?.promptCalls[0]).toContain("your task moved to Kun's MacBook Air");
    expect(h.boot.promptCalls).toHaveLength(0);
    await h.supervisor.disposeAll();
  });

  it("reopens there in the conversation it is opening when that computer's first word asks for it meanwhile", async () => {
    // INF-2292: task-move.spec.ts stayed retiring with "The task closed
    // while its transcript was being located." The Mac mini's first record
    // reached here before its open answered, and `adoptPlaced` opened a
    // second conversation over the one the move was opening.
    let adopting: Promise<void> | undefined;
    const h = await startedHere({
      opening: () => {
        adopting ??= h.supervisor.adoptPlaced(h.taskId);
      },
    });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    await adopting;
    // One conversation there, the one the move opened, and it is the task's.
    expect(h.opened.map((spec) => spec.machine)).toEqual([MINI]);
    expect(existsSync(h.cwd)).toBe(false);
    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "Check the header too.")).toBe(
      "mid-turn",
    );
    await vi.waitFor(() => expect(h.boot.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boot.promptCalls[0]).toContain("your task moved to Kun's Mac mini");
    await h.supervisor.disposeAll();
  });

  it("opens a new conversation there after a quit right after the commit, never the old one, and installs before the waiting steer", async () => {
    // R3: the conversation it left is written with the commit; R9: dependencies before the lane's turn.
    const installing = deferred<DependencyInstall>();
    const h = await startedHere({ bootFails: true, install: () => installing.promise });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(
      () =>
        expect(h.tasks.get(h.taskId)?.shape?.computer_move?.problem).toBe(
          "it moved, but could not reopen yet: Kun's Mac mini did not answer in time",
        ),
      REAL_GIT_WAIT,
    );
    expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
    // The copy it left stays until a new conversation opened there.
    expect(existsSync(h.cwd)).toBe(true);
    await h.supervisor.disposeAll();

    const { fresh } = relaunched(h);
    expect(await fresh.steer.steerCrewmate(h.taskId, "Check the header too.")).toBe(
      "recorded-held",
    );
    await fresh.watch.sweepGates(Date.now());
    await vi.waitFor(() => expect(h.opened).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.opened[0]).toMatchObject({ machine: MINI });
    expect(JSON.stringify(h.opened[0])).not.toContain("s1.jsonl");
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledWith(MINI, h.taskId), REAL_GIT_WAIT);
    // Nothing on its lane starts a turn while its dependencies install.
    await fresh.watch.sweepGates(Date.now());
    expect(h.boot.promptCalls).toHaveLength(0);
    installing.resolve({ outcome: "online", ms: 900 });
    await vi.waitFor(() => expect(h.boot.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boot.promptCalls[0]).toContain("your task moved to Kun's Mac mini");
    expect(h.boot.promptCalls[0]).toContain("Check the header too.");
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
      expect(existsSync(h.cwd)).toBe(false);
    }, REAL_GIT_WAIT);
    expect(h.crewmate.promptCalls).toHaveLength(1);
    await fresh.disposeAll();
  });

  it("installs again at the next launch when a quit cut its install off, before the steer that waited", async () => {
    // Review INF-1772 round 2 R9: the record holds its lane until the install is over.
    const installs = [deferred<DependencyInstall>(), deferred<DependencyInstall>()];
    let installing = 0;
    const h = await startedHere({
      install: () => {
        const next = installs[installing++];
        if (!next) throw new Error("A third install was asked for.");
        return next.promise;
      },
    });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(1), REAL_GIT_WAIT);
    expect(h.tasks.get(h.taskId)?.shape?.computer_move).toMatchObject({ preparing: true });
    expect(h.tasks.get(h.taskId)?.shape?.computer_move?.restartFrom).toBeUndefined();
    // The quit, mid-install: this launch never hears it end.
    await h.supervisor.disposeAll();

    const { fresh } = relaunched(h);
    expect(await fresh.steer.steerCrewmate(h.taskId, "Check the header too.")).toBe(
      "recorded-held",
    );
    await fresh.watch.sweepGates(Date.now());
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(2), REAL_GIT_WAIT);
    await fresh.watch.sweepGates(Date.now());
    expect(h.boots.flatMap((boot) => boot.promptCalls)).toHaveLength(0);
    installs[1]?.resolve({ outcome: "online", ms: 900 });
    await vi.waitFor(() => expect(h.boots[1]?.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boots[1]?.promptCalls[0]).toContain("Check the header too.");
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
      expect(existsSync(h.cwd)).toBe(false);
    }, REAL_GIT_WAIT);
    installs[0]?.resolve({ outcome: "online", ms: 900 });
    await fresh.disposeAll();
  });

  it("keeps a move that waits for a safe pause across a quit, and moves at the next launch", async () => {
    const h = await startedHere();
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    // Quit mid-turn: the move waits on the record.
    await h.supervisor.disposeAll();
    expect(h.tasks.get(h.taskId)?.shape?.computer_move).toMatchObject({
      to: MINI,
      phase: "waiting",
    });

    const { fresh, reopened } = relaunched(h);
    await fresh.watch.sweepGates(Date.now());
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    // A new conversation there; the copy it left here is gone.
    expect(h.opened).toEqual([expect.objectContaining({ machine: MINI })]);
    expect(existsSync(h.cwd)).toBe(false);
    expect(readFileSync(join(h.there, "work", "meter.ts"), "utf8")).toBe(
      "export const unit = 'mWh';\n",
    );
    // Its old conversation here never reopened.
    expect(reopened.promptCalls).toHaveLength(0);
    await fresh.disposeAll();
  });

  it("leaves the task here when the work crossed but the Mac mini's answer was lost", async () => {
    const h = await startedHere({ moveIn: "fail-after-copy" });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(
      () => expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined(),
      REAL_GIT_WAIT,
    );
    // It copied there, then failed: what it made there is removed, and the task stays here whole.
    expect(h.retireMoved).toHaveBeenCalledWith(MINI, h.taskId);
    expect(existsSync(h.there)).toBe(false);
    expect(h.tasks.get(h.taskId)).toMatchObject({ deviceId: null, worktreeDir: h.cwd });
    expect(readFileSync(join(h.cwd, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(await git(h.cwd, ["diff", "--cached", "--name-only"])).toBe("staged.ts");
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      `its move to Kun's Mac mini did not finish: the answer from Kun's Mac mini was lost on the way. It stays on ${HERE.this}`,
    );
    expect(h.opened).toHaveLength(0);
    await h.supervisor.disposeAll();
  });

  it("ends a move a quit cut off while its work crossed, and the task stays here", async () => {
    const h = await startedHere({ moveIn: "wait" });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    // Review INF-1772 round 3 R11: the Mac mini already made its copy when
    // the quit comes, and nothing more of it is still being written there.
    await h.copied.promise;
    expect(existsSync(join(h.there, "work", "meter.ts"))).toBe(true);
    expect(h.tasks.get(h.taskId)?.shape?.computer_move?.phase).toBe("moving");
    // The quit: this launch never hears the Mac mini's answer. Round 4 R11:
    // `arrive` stays unresolved, as a quit leaves the call, so the quit
    // launch's move can never go on to commit after it.
    await h.supervisor.disposeAll();
    const { fresh } = relaunched(h);
    await fresh.watch.sweepGates(Date.now());
    await vi.waitFor(
      () => expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined(),
      REAL_GIT_WAIT,
    );
    expect(h.retireMoved).toHaveBeenCalledWith(MINI, h.taskId);
    expect(existsSync(h.there)).toBe(false);
    expect(h.tasks.get(h.taskId)).toMatchObject({ deviceId: null, worktreeDir: h.cwd });
    expect(readFileSync(join(h.cwd, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      `its move to Kun's Mac mini did not finish: Infinitary stopped while its work moved. It stays on ${HERE.this}`,
    );
    await fresh.disposeAll();
  });

  it("holds a steer sent while the work crosses for the new conversation, never the old one", async () => {
    const h = await startedHere({ moveIn: "wait" });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.moveIn).toHaveBeenCalled(), REAL_GIT_WAIT);
    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "Use watt-hours.")).toBe(
      "recorded-held",
    );
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.crewmate.promptCalls).toHaveLength(1);
    h.arrive.resolve();
    await vi.waitFor(() => expect(h.boot.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boot.promptCalls[0]).toContain("Use watt-hours.");
    expect(h.crewmate.promptCalls).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  it("keeps a card waiting on the captain with its thread and the reported wait, and the captain's reply and choice reach the conversation there", async () => {
    // Review INF-1772 round 3 R11: the card, its thread, the crewmate's
    // reported wait and a reply the captain sends while it moves all survive.
    const installing = deferred<DependencyInstall>();
    const h = await startedHere({ install: () => installing.promise });
    // Its crewmate asks the captain, says it waits on that card, then its turn ends with the card up.
    const cardId = await h.specs[0]?.onCard?.({
      title: "Which unit should the meter show?",
      body: "<p>The meter can show watt-hours or kilowatt-hours.</p>",
      actions: [
        { id: "wh", label: "Watt-hours", default: true },
        { id: "kwh", label: "Kilowatt-hours" },
      ],
    });
    const card = h.cardStore.get(String(cardId)) as Card;
    expect(card).toMatchObject({ status: "ready", taskId: h.taskId });
    h.specs[0]?.onReport?.("Asked the captain which unit the meter shows.", undefined, {
      wait: { reason: "Which unit the meter shows", cardId: card.id },
    });
    h.supervisor.cards.addMessage(card.id, "captain", "Which one do the other meters show?");
    h.supervisor.cards.addMessage(card.id, "crewmate", "The other meters show kilowatt-hours.");
    const thread = h.supervisor.cards
      .thread(card.id)
      .messages.map(({ who, text }) => ({ who, text }));
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    // It moved; its new conversation there waits on its dependencies.
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledWith(MINI, h.taskId), REAL_GIT_WAIT);
    expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
    expect(h.cardStore.get(card.id)).toMatchObject({ status: "ready", taskId: h.taskId });
    expect(
      h.supervisor.cards.thread(card.id).messages.map(({ who, text }) => ({ who, text })),
    ).toEqual(thread);
    expect(h.tasks.get(h.taskId)?.delivery?.captainWait).toMatchObject({
      reason: "Which unit the meter shows",
      cardId: card.id,
    });
    // The captain replies meanwhile: the reply waits for the conversation there.
    h.supervisor.cardActions.replyToCard(card.id, "Use watt-hours for the small screen.");
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.boot.promptCalls).toHaveLength(0);
    installing.resolve({ outcome: "online", ms: 900 });
    await vi.waitFor(() => expect(h.boot.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.boot.promptCalls[0]).toContain("your task moved to Kun's Mac mini");
    expect(h.boot.promptCalls[0]).toContain("Use watt-hours for the small screen.");
    expect(h.cardStore.get(card.id)).toMatchObject({ status: "ready", taskId: h.taskId });
    h.boot.finishPrompt();
    await vi.waitFor(
      () => expect(h.supervisor.sessions.conversationBusy(h.taskId)).toBe(false),
      REAL_GIT_WAIT,
    );
    h.supervisor.cardActions.act(card.id, "wh");
    await vi.waitFor(() => expect(h.boot.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
    expect(h.boot.promptCalls[1]).toContain("Watt-hours");
    expect(h.crewmate.promptCalls).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  it("removes what an unfinished move made there once, however many sweeps run meanwhile", async () => {
    // R4: one removal at a time, and its end clears only the move it removed.
    const removing = deferred<void>();
    const h = await startedHere({ moveIn: "fail", retire: () => removing.promise });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.retireMoved).toHaveBeenCalledTimes(1), REAL_GIT_WAIT);
    await h.supervisor.watch.sweepGates(Date.now());
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.retireMoved).toHaveBeenCalledTimes(1);
    expect(h.tasks.get(h.taskId)?.shape?.computer_move?.phase).toBe("undoing");
    removing.resolve();
    await vi.waitFor(
      () => expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined(),
      REAL_GIT_WAIT,
    );
    expect(h.retireMoved).toHaveBeenCalledTimes(1);
    await h.supervisor.disposeAll();
  });

  it("waits while its browser is open or in the captain's hands, and moves once it is closed", async () => {
    // R5: a live page, or one in the captain's hands, never moves or closes under the captain.
    const browser = {
      current: { state: "open" } as unknown as TaskBrowserFact | undefined,
      withCaptain: false,
    };
    const h = await startedHere({ browser });
    expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(true);
    h.crewmate.finishPrompt();
    await vi.waitFor(
      () => expect(h.supervisor.sessions.conversationBusy(h.taskId)).toBe(false),
      REAL_GIT_WAIT,
    );
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get(h.taskId) as TaskRecord)).toEqual({
      computerMove: {
        from: HERE.this,
        to: "Kun's Mac mini",
        state: "waiting",
        waitingFor: ["its browser is closed"],
      },
    });
    expect(h.moveIn).not.toHaveBeenCalled();
    // Stopped, but handed to the captain for a sign-in: still waiting.
    browser.current = undefined;
    browser.withCaptain = true;
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.moveIn).not.toHaveBeenCalled();
    browser.withCaptain = false;
    await h.supervisor.watch.sweepGates(Date.now());
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    await h.supervisor.disposeAll();
  });

  it.each(["reopening", "retiring"] as const)(
    "disposal waits for a move that is %s before the fixture settles its pool",
    async (phase) => {
      // INF-1935: disposal must own source retirement even before it queues pool work.
      const entered = deferred<void>();
      const release = deferred<void>();
      const h = await startedHere({
        ...(phase === "reopening"
          ? {
              install: async () => {
                entered.resolve();
                await release.promise;
                return { outcome: "skipped" as const };
              },
            }
          : {}),
      });
      const workspace = h.realWorkspace as RealWorkspaceService;
      const remove = workspace.removeTaskWorktree.bind(workspace);
      const retirement = vi
        .spyOn(workspace, "removeTaskWorktree")
        .mockImplementation(async (work) => {
          if (phase === "retiring") {
            entered.resolve();
            await release.promise;
          }
          await remove(work);
        });
      expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(
        true,
      );
      h.crewmate.finishPrompt();
      await entered.promise;
      // The quit's bound is wall-clock time, and the real git the released
      // move still runs can outlast it on a loaded runner (INF-2649). Its
      // expiry is the next test's subject, so this one holds the bound
      // still: disposal ends only when the move does.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let disposal: Promise<void>;
      try {
        disposal = h.supervisor.disposeAll();
      } finally {
        vi.useRealTimers();
      }
      let retiredAtDisposal = false;
      try {
        // A microtask checkpoint, not a timing window: the blocked operation
        // cannot finish until this test releases it.
        const state = await Promise.race([
          disposal.then(() => "disposed"),
          Promise.resolve()
            .then(() => {})
            .then(() => "pending"),
        ]);
        expect(state).toBe("pending");
      } finally {
        release.resolve();
        await disposal;
        retiredAtDisposal = !existsSync(h.cwd) && !h.tasks.get(h.taskId)?.shape?.computer_move;
        // Also settle on a failing baseline so the regression never leaks its fixture.
        await vi.waitFor(
          () => expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined(),
          REAL_GIT_WAIT,
        );
        await workspace.poolSettled();
        retirement.mockRestore();
      }
      expect(existsSync(h.cwd)).toBe(false);
      expect(retiredAtDisposal).toBe(true);
      expect(workspace.pooledTrees()).toHaveLength(1);
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
    },
  );

  it.each(["reopening", "retiring"] as const)(
    "settles %s before fixture cleanup even after the bounded quit expires",
    async (phase) => {
      // INF-1935 / INF-2386: a bounded quit is not the fixture's completion barrier.
      const entered = deferred<void>();
      const release = deferred<void>();
      const h = await startedHere({
        ...(phase === "reopening"
          ? {
              install: async () => {
                entered.resolve();
                await release.promise;
                return { outcome: "skipped" as const };
              },
            }
          : {}),
      });
      const workspace = h.realWorkspace as RealWorkspaceService;
      const remove = workspace.removeTaskWorktree.bind(workspace);
      const retirement = vi
        .spyOn(workspace, "removeTaskWorktree")
        .mockImplementation(async (work) => {
          if (phase === "retiring") {
            entered.resolve();
            await release.promise;
          }
          await remove(work);
        });
      expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(
        true,
      );
      h.crewmate.finishPrompt();
      await entered.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const disposal = h.supervisor.disposeAll();
        await vi.advanceTimersByTimeAsync(QUIT_SETTLE_MS);
        await disposal;
      } finally {
        vi.useRealTimers();
      }
      let finished = false;
      const completion = movesFinished(h.tasks, h.supervisor).then(() => {
        finished = true;
      });
      try {
        expect(h.tasks.get(h.taskId)?.shape?.computer_move?.phase).toBe("retiring");
        if (phase === "reopening") {
          expect(h.tasks.get(h.taskId)?.shape?.computer_move?.preparing).toBe(true);
          expect(h.supervisor.sessions.conversationBusy(h.taskId)).toBe(true);
        }
        await Promise.resolve();
        expect(finished).toBe(false);
      } finally {
        release.resolve();
        await completion;
        await workspace.poolSettled();
        await workspace.deletionsSettled();
        retirement.mockRestore();
      }
      expect(existsSync(h.cwd)).toBe(false);
      expect(workspace.pooledTrees()).toHaveLength(1);
    },
  );

  it("settles fixture cleanup after quitting at the destination commit, then reopens only at the next launch", async () => {
    // INF-2380: the real commit notification permits quit before reopening.
    // The operation can end while its durable move waits for the next launch.
    const h = await startedHere();
    let disposal: Promise<void> | undefined;
    const stopWatching = h.tasks.onChange(() => {
      if (h.tasks.get(h.taskId)?.deviceId !== MINI) return;
      stopWatching();
      disposal = h.supervisor.disposeAll();
    });
    try {
      expect((await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "captain")).ok).toBe(
        true,
      );
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(disposal).toBeDefined(), REAL_GIT_WAIT);
      await disposal;
      expect(h.opened).toHaveLength(0);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toMatchObject({
        phase: "retiring",
        preparing: true,
        restartFrom: "s1",
      });
      expect(h.supervisor.sessions.conversationBusy(h.taskId)).toBe(false);
      expect(existsSync(h.cwd)).toBe(true);
      // Exercise the same barrier as afterEach before any next-launch work.
      await movesFinished(h.tasks, h.supervisor);
      await (h.realWorkspace as RealWorkspaceService).poolSettled();
      await (h.realWorkspace as RealWorkspaceService).deletionsSettled();
      expect(h.opened).toHaveLength(0);

      const { fresh } = relaunched(h);
      try {
        await fresh.watch.sweepGates(Date.now());
        await vi.waitFor(() => {
          expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
          expect(existsSync(h.cwd)).toBe(false);
        }, REAL_GIT_WAIT);
        expect(h.opened).toEqual([expect.objectContaining({ machine: MINI })]);
        expect(JSON.stringify(h.opened[0])).not.toContain("s1.jsonl");
        expect(readFileSync(join(h.there, "work", "meter.ts"), "utf8")).toBe(
          "export const unit = 'mWh';\n",
        );
      } finally {
        await fresh.disposeAll();
      }
    } finally {
      stopWatching();
    }
  });

  it("carries the ignored files the move names to keep", async () => {
    // R7, the captain: "Build the planned way to name ignored files that must move".
    const h = await startedHere();
    writeFileSync(join(h.cwd, ".gitignore"), ".env.local\nbuild/\n");
    writeFileSync(join(h.cwd, ".env.local"), "METER_KEY=local\n");
    mkdirSync(join(h.cwd, "build"));
    writeFileSync(join(h.cwd, "build", "meter.js"), "built\n");
    expect(
      (await h.supervisor.moves.requestComputerMove(h.taskId, MINI, "firstmate", [".env.local"]))
        .ok,
    ).toBe(true);
    expect(h.tasks.get(h.taskId)?.shape?.computer_move?.keep).toEqual([".env.local"]);
    expect(
      (await h.supervisor.moves.requestComputerMove(h.taskId, AIR, "firstmate", ["../elsewhere"]))
        .text,
    ).toContain("is already moving");
    h.crewmate.finishPrompt();
    await vi.waitFor(() => {
      expect(h.tasks.get(h.taskId)?.deviceId).toBe(MINI);
      expect(h.tasks.get(h.taskId)?.shape?.computer_move).toBeUndefined();
    }, REAL_GIT_WAIT);
    expect(readFileSync(join(h.there, "work", ".env.local"), "utf8")).toBe("METER_KEY=local\n");
    expect(existsSync(join(h.there, "work", "build", "meter.js"))).toBe(false);
    await h.supervisor.disposeAll();
  });
});
