/**
 * Opening and reopening a crewmate's session (`CrewSessions`, INF-1272):
 * a start on the model and account the routing chose, a reopen after a quit
 * on the task's own model and effort, the work an update saves first, and a
 * recorded conversation reopened only in its own backend's shape.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "@shared/deviceNames";
import type { FmEvent } from "@shared/events";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { levelDefaultReasoning, type WorkShape } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import {
  catalogLessRouter,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  routingOffRouter,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { FakeSessionOptions } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { CrewMachines } from "../placed/crewMachines";
import type { SessionSpec } from "../session/session";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { carryOnWords, RESTART_RESUMED_WORDS } from "../tasks/recordActivity";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { WorkspaceService } from "../workspace/workspaceService";
import { type CrewmateSpec, crewmateRenewedNote, crewmateRestartText } from "./crewSession";
import type { AccountAttachment } from "./crewSupervisorOptions";
import { RESTART_REPLAY_NOTE, renderWake } from "./wakes";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  // INF-1381: Dynamic routing off must still bind a signed-in model/account,
  // or explain why none serves, before a coding session can ask Pi for a key.
  it.each(["openai-codex", CLAUDE_PROVIDER_ID])(
    "starts routing-off work on an explicit %s model and isolated account",
    async (provider) => {
      const model = { provider, id: provider === "openai-codex" ? "gpt-5.5" : "claude-sonnet-5-5" };
      const crewmate = fakeCrewmate({ model });
      const selectForSpawn = vi.fn(() => "acct_signed_in");
      const { supervisor, tasks, sessionSpecs } = setup(crewmate, {
        realRouter: (db) => routingOffRouter(db, [model]),
        accounts: {
          selectForSpawn,
          reselectForResume: () => ({ changed: false }),
          labelOf: () => "Personal",
        },
      });
      const { taskId } = await supervisor.intake.commission({
        title: "Read the project",
        intent: intentOf("read the project without changing it"),
        shape: { override_model_id: `${provider}/${model.id}` },
      });
      await tick();
      // The account is ranked for the routed model (INF-1714).
      expect(selectForSpawn).toHaveBeenCalledWith(taskId, provider, { model: model.id });
      expect(sessionSpecs).toHaveLength(1);
      expect(sessionSpecs[0]?.model).toEqual(model);
      expect(sessionSpecs[0]?.binding).toMatchObject({ accountId: "acct_signed_in" });
      expect(tasks.get(taskId)?.accountId).toBe("acct_signed_in");
      expect(tasks.get(taskId)?.model).toBe(`${provider}/${model.id}`);
      expect(crewmate.promptCalls).toHaveLength(1);
    },
  );

  it.each(["empty-pool", "account-disappeared"])(
    "explains routing-off startup with %s without opening an account-less session",
    async (scenario) => {
      const model = { provider: "openai-codex", id: "gpt-5.5" };
      const { supervisor, sessionSpecs } = setup(fakeCrewmate(), {
        realRouter: (db) => routingOffRouter(db, scenario === "empty-pool" ? [] : [model]),
        accounts: {
          selectForSpawn: () => undefined,
          reselectForResume: () => ({ changed: false }),
          labelOf: () => undefined,
        },
      });
      await expect(
        supervisor.intake.commission({
          title: "Read the project",
          intent: intentOf("read the project"),
        }),
      ).rejects.toThrow(
        scenario === "empty-pool"
          ? "No signed-in model can take this task now. Check your accounts and their allowance in Settings → Intelligence."
          : "No eligible account can serve the selected model now. Check your accounts and their allowance in Settings → Intelligence.",
      );
      expect(sessionSpecs).toHaveLength(0);
    },
  );

  // INF-2523: a fresh install signed in only to OpenRouter started its
  // crewmate with no model and no account, and the account-less session
  // failed as if the key had lapsed.
  it("starts a crewmate on an OpenRouter model under its key when OpenRouter is the only sign-in", async () => {
    const model = { provider: "openrouter", id: "~anthropic/claude-sonnet-latest" };
    const crewmate = fakeCrewmate({ model });
    const selectForSpawn = vi.fn(() => "acct_openrouter");
    const { supervisor, tasks, sessionSpecs } = setup(crewmate, {
      realRouter: (db) => catalogLessRouter(db, [model]),
      accountlessServes: () => false,
      accounts: {
        selectForSpawn,
        reselectForResume: () => ({ changed: false }),
        labelOf: () => "OpenRouter key",
      },
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Read the project",
      intent: intentOf("read the project without changing it"),
    });
    await tick();
    expect(selectForSpawn).toHaveBeenCalledWith(taskId, "openrouter", { model: model.id });
    expect(sessionSpecs).toHaveLength(1);
    expect(sessionSpecs[0]?.model).toEqual(model);
    expect(sessionSpecs[0]?.binding).toMatchObject({ accountId: "acct_openrouter" });
    expect(tasks.get(taskId)?.accountId).toBe("acct_openrouter");
    expect(tasks.get(taskId)?.model).toBe(`openrouter/${model.id}`);
    expect(crewmate.promptCalls).toHaveLength(1);
  });

  it("refuses in words a start no model can take when the account-less runtime serves none", async () => {
    const { supervisor, sessionSpecs } = setup(fakeCrewmate(), {
      realRouter: (db) => catalogLessRouter(db, []),
      accountlessServes: () => false,
    });
    await expect(
      supervisor.intake.commission({
        title: "Read the project",
        intent: intentOf("read the project"),
      }),
    ).rejects.toThrow(
      "No signed-in model can take this task now. Check your accounts and their allowance in Settings → Intelligence.",
    );
    expect(sessionSpecs).toHaveLength(0);
  });

  it("still opens on the account-less runtime when it serves a model of its own", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, sessionSpecs } = setup(crewmate, {
      realRouter: (db) => catalogLessRouter(db, []),
      accountlessServes: () => true,
    });
    await supervisor.intake.commission({
      title: "Read the project",
      intent: intentOf("read the project"),
    });
    await tick();
    expect(sessionSpecs).toHaveLength(1);
    expect(sessionSpecs[0]?.model).toBeUndefined();
    expect(crewmate.promptCalls).toHaveLength(1);
  });

  it("binds the selected account at spawn and records usage under it (broker phase 4)", async () => {
    const crewmate = fakeCrewmate();
    const selectForSpawn = vi.fn(() => "acct_work2");
    const recordUsage = vi.fn();
    const accounts: AccountAttachment = {
      selectForSpawn,
      reselectForResume: () => ({ changed: false }),
      labelOf: () => "Work #2",
    };
    const { supervisor, sessionSpecs, tasks } = setup(crewmate, {
      accounts,
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      recordUsage,
    });
    const { taskId } = await supervisor.intake.commission({
      title: "acct",
      intent: intentOf("do the work"),
    });
    await tick();
    expect(selectForSpawn).toHaveBeenCalledWith(taskId, "openai-codex", { model: "gpt-5.5" });
    // The account is the session's binding: its own store, direct injection.
    expect(sessionSpecs[0]?.binding).toMatchObject({ accountId: "acct_work2" });
    expect(tasks.get(taskId)?.accountId).toBe("acct_work2");

    crewmate.emit({ type: "turn_end", taskId, usage: { input: 5, cost: 0.02 } });
    await tick();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, accountId: "acct_work2" }),
    );
  });

  it("records a typed cut-off on the crewmate's account, once per failed turn and never from words", async () => {
    const crewmate = {
      ...fakeCrewmate(),
      controlProfile: { ...PI_CONTROL_PROFILE, backgroundWork: "client", failureSignals: "typed" },
    } satisfies FakeCrewmate;
    const noteCutOff = vi.fn();
    const { supervisor } = setup(crewmate, {
      accounts: {
        selectForSpawn: () => "acct_claude",
        reselectForResume: () => ({ changed: false }),
        labelOf: () => "Claude",
      },
      routedModel: { provider: CLAUDE_PROVIDER_ID, id: "claude-opus" },
      noteCutOff,
    });
    const { taskId } = await supervisor.intake.commission({ title: "t", intent: intentOf("work") });
    await tick();
    const fail = (event: FmEvent) => {
      crewmate.emit(event);
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
    };
    // A failure with no class is not a cut-off, whatever it says.
    fail({ type: "turn_failed", taskId, error: "403: permission_error" });
    await tick();
    expect(noteCutOff).not.toHaveBeenCalled();

    await supervisor.steer.steerCrewmate(taskId, "go on");
    await tick();
    fail({ type: "turn_failed", taskId, error: "Claude said no.", cutOff: { class: "refused" } });
    await tick();
    expect(noteCutOff).toHaveBeenCalledTimes(1);
    expect(noteCutOff).toHaveBeenCalledWith("acct_claude", { class: "refused" });
  });

  it("threads spawn_crewmate's model override into the routing decision", async () => {
    const crewmate = fakeCrewmate();
    const decideCalls: { shape: WorkShape }[] = [];
    const { supervisor } = setup(crewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      onRouteDecide: (args) => decideCalls.push(args),
    });
    await supervisor.intake.commission({
      title: "Redesign the dock",
      intent: intentOf("use gpt-6-astra for this"),
      shape: { override_model_id: "gpt-6-astra" },
    });
    await tick();
    expect(decideCalls.at(-1)?.shape.override_model_id).toBe("gpt-6-astra");
  });

  it("hands spawn_crewmate the model that took new work the captain named one for (FI3-444)", async () => {
    const fable = { provider: CLAUDE_PROVIDER_ID, id: "claude-fable-5-1" };
    const spawn = async (crewmate: FakeCrewmate, named?: string) => {
      const { supervisor, tasks } = setup(crewmate, { routedModel: fable });
      const handle = await supervisor.intake.commission({
        title: "Teach the colors",
        intent: intentOf("start it with a fable crewmate"),
        ...(named ? { shape: { override_model_id: named } } : {}),
      });
      await tick();
      return { handle, model: tasks.get(handle.taskId)?.model };
    };

    // The named model took it: the handle carries it beside the record's.
    const served = await spawn(fakeCrewmate({ model: fable }), "claude-fable-5-1");
    expect(served.handle.model).toEqual({
      named: "claude-fable-5-1",
      took: `${CLAUDE_PROVIDER_ID}/claude-fable-5-1`,
    });
    expect(served.model).toBe(`${CLAUDE_PROVIDER_ID}/claude-fable-5-1`);
    // The session runs on another model than the one named: that one is what took it.
    const fellBack = await spawn(fakeCrewmate(), "claude-fable-5-1");
    expect(fellBack.handle.model).toEqual({ named: "claude-fable-5-1", took: "fm-mock/mock-1" });
    expect(fellBack.model).toBe("fm-mock/mock-1");
    // Nothing named: the handle stays as it was.
    const plain = await spawn(fakeCrewmate({ model: fable }));
    expect(plain.handle).toEqual({ taskId: plain.handle.taskId, crewmate: "crewmate 1" });
  });

  it("hands spawn_crewmate no model when none is recorded, never the named one (FI3-444)", async () => {
    const crewmate = fakeCrewmate({ model: undefined });
    const { supervisor, tasks } = setup(crewmate);
    const handle = await supervisor.intake.commission({
      title: "Teach the colors",
      intent: intentOf("start it with a fable crewmate"),
      shape: { override_model_id: "claude-fable-5-1" },
    });
    expect(tasks.get(handle.taskId)?.model).toBeNull();
    expect(handle.model).toEqual({ named: "claude-fable-5-1", took: null });
  });

  it("re-checks the account at a resume attachment point and moves to a sibling", async () => {
    const crewmate = fakeCrewmate();
    const accounts: AccountAttachment = {
      selectForSpawn: () => undefined,
      reselectForResume: vi.fn(() => ({ accountId: "acct_new", changed: true })),
      labelOf: () => "Work #2",
    };
    const reasoningChoice = vi.fn(() => "low" as const);
    const { supervisor, specs, sessionSpecs, tasks, events } = setup(crewmate, {
      accounts,
      reasoningChoice,
      routedModel: { provider: "openai-codex", id: "gpt-6.1-sol" },
    });
    // A task left idle by a previous process, bound to a removed account.
    seedTask(tasks, {
      id: "t-resume",
      title: "Old task",
      prompt: "old work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-resume",
      sessionFile: "/tmp/old-session.jsonl",
      accountId: "acct_dead",
      status: "idle",
      createdAt: Date.now(),
    });

    await supervisor.steer.steerCrewmate("t-resume", "carry on");
    await tick();
    expect(accounts.reselectForResume).toHaveBeenCalledWith("t-resume", "acct_dead");
    expect(specs[0]).toMatchObject({ resumeToken: "/tmp/old-session.jsonl" });
    expect(reasoningChoice).not.toHaveBeenCalled();
    expect(specs[0]?.thinkingLevel).toBeUndefined();
    expect(sessionSpecs[0]?.binding).toMatchObject({ accountId: "acct_new" });
    expect(tasks.get("t-resume")?.accountId).toBe("acct_new");
    // The move is announced as a feed line, never silent.
    const note = events.find((event) => event.type === "firstmate_note");
    expect(note && "text" in note ? note.text : "").toContain('Task "Old task" moved to Work #2');
  });

  // INF-1272, the captain: "a reopened task keeps its model". An update that
  // changes a Claude crewmate's instructions starts its conversation over,
  // with no transcript to restore a model from; the reopen asks for the
  // model and effort its routing chose, here or on a computer that runs work.
  describe("a reopen asks for the task's own model and effort (INF-1272)", () => {
    const fable = { provider: CLAUDE_PROVIDER_ID, id: "claude-fable-5-1" };

    /** The next launch: a new supervisor over the same record and routing ledger. */
    function relaunch(h: ReturnType<typeof setup>, boot: FakeCrewmate, machines?: CrewMachines) {
      const specs: CrewmateSpec[] = [];
      const fresh = reboot(
        h,
        vi.fn(async () => boot),
        {
          specs,
          ...(h.router
            ? { router: h.router as unknown as import("../routing/router").Router }
            : {}),
          ...(machines ? { machines } : {}),
        },
      );
      return { fresh, specs };
    }

    const moves = (h: ReturnType<typeof setup>, taskId: string) =>
      h.tasks.timeline(taskId).filter((event) => event.kind === "note" && event.data?.servedModel);

    it("reopens a Fable crewmate at extra-high effort after a quit, with no model-move line", async () => {
      const crewmate = fakeCrewmate({ model: fable });
      const h = setup(crewmate, {
        routeResult: { choice: fable, bucket: "premium", rule: "R0" },
        reasoningChoice: () => "medium",
      });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Project scopes",
        intent: intentOf("build it on fable at extra high reasoning"),
        shape: { override_model_id: "claude-fable-5-1", override_reasoning: "xhigh" },
      });
      await tick();
      expect(h.specs[0]).toMatchObject({ model: fable, thinkingLevel: "xhigh" });
      crewmate.finishPrompt();
      await tick();
      await h.supervisor.disposeAll();

      // The update changed its instructions: its conversation starts over,
      // and the client answers on whatever the reopen asked for.
      const boot = fakeCrewmate({ model: fable });
      const { fresh, specs } = relaunch(h, boot);
      await fresh.steer.steerCrewmate(taskId, "carry on");
      await tick();
      expect(specs[0]).toMatchObject({
        resumeToken: "/tmp/s1.jsonl",
        model: fable,
        thinkingLevel: "xhigh",
      });
      boot.emit({ type: "model_served", model: fable });
      expect(h.tasks.get(taskId)?.model).toBe(`${CLAUDE_PROVIDER_ID}/claude-fable-5-1`);
      expect(moves(h, taskId)).toEqual([]);
      await fresh.disposeAll();
    });

    it("reopens a moved task on the model it moved to, and a fallback on the model it asked for", async () => {
      const opus55 = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-5-5" };
      const opus48 = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-4-8" };
      const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
      const crewmate = fakeCrewmate({ model: opus55 });
      const h = setup(crewmate, {
        routedModel: opus55,
        crewmates: [fakeCrewmate({ model: codex })],
        movePick: (shape) =>
          shape.override_model_id === "openai-codex/gpt-6.1-sol" ? codex : undefined,
        reasoningChoice: (ref) => (ref.provider === "openai-codex" ? "low" : undefined),
      });
      const { taskId } = await h.supervisor.intake.commission({
        title: "t",
        intent: intentOf("work"),
      });
      await tick();
      crewmate.finishPrompt();
      await tick();
      // Claude Code moved the session after a safeguard stopped a reply: a
      // fallback, never a routing choice.
      crewmate.emit({ type: "model_served", model: opus48, fallback: { from: opus55 } });
      expect(h.tasks.get(taskId)?.model).toBe(`${CLAUDE_PROVIDER_ID}/claude-opus-4-8`);
      await h.supervisor.disposeAll();

      const boot = fakeCrewmate({ model: opus55 });
      const reopened = relaunch(h, boot);
      await reopened.fresh.steer.steerCrewmate(taskId, "carry on");
      await tick();
      // No word on its effort and no Settings choice: the routed level's default.
      expect(reopened.specs[0]).toMatchObject({
        model: opus55,
        thinkingLevel: levelDefaultReasoning("high"),
      });
      boot.finishPrompt();
      await tick();

      // The first mate moves it; the next launch reopens it where it moved.
      expect(
        reopened.fresh.moves.requestMove(taskId, {
          by: "firstmate",
          model: "openai-codex/gpt-6.1-sol",
        }).ok,
      ).toBe(true);
      await tick();
      expect(reopened.specs.at(-1)).toMatchObject({ model: codex, thinkingLevel: "low" });
      await reopened.fresh.disposeAll();
      const again = relaunch(h, fakeCrewmate({ model: codex }));
      await again.fresh.steer.steerCrewmate(taskId, "carry on");
      await tick();
      expect(again.specs[0]).toMatchObject({ model: codex, thinkingLevel: "low" });
      await again.fresh.disposeAll();
    });

    it("tells the first mate once when a task answers on a model it did not ask for", async () => {
      const opus = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-5-5" };
      const crewmate = fakeCrewmate({ model: fable });
      const h = setup(crewmate, {
        routeResult: { choice: fable, bucket: "premium", rule: "R0" },
        modelName: (model) => (model.id === fable.id ? "Fable 5.1" : "Opus 5.5"),
      });
      // The first mate's lane as it really is, so a once-named wake goes out once.
      h.supervisor.setFirstmateHooks({
        notifyOp: (wake, origin, ref) =>
          h.inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref),
        retryConverse: vi.fn(),
      });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Orbit prototype",
        intent: intentOf("build it on fable"),
        shape: { override_model_id: "claude-fable-5-1" },
      });
      await tick();
      const notices = () =>
        h.inbox
          .allFor(FIRSTMATE_RECIPIENT)
          .filter((row) => row.facts?.kind === "model-unasked")
          .map((row) => renderWake(row));
      // The model asked for answers: nothing to tell.
      crewmate.emit({ type: "model_served", model: fable });
      expect(notices()).toEqual([]);
      // Its conversation opened on the client's default instead.
      crewmate.emit({ type: "model_served", model: opus });
      const key = h.tasks.get(taskId)?.key || taskId;
      expect(notices()).toEqual([
        `[fm-op] ${key} "Orbit prototype" now answers on Opus 5.5, not on Fable 5.1, the model it asked for: its conversation opened on Opus 5.5 although the app asked for Fable 5.1. The captain named Fable 5.1 for this task.`,
      ]);
      // Back on Fable and off it again: the same move is told once.
      crewmate.emit({ type: "model_served", model: fable });
      crewmate.emit({ type: "model_served", model: opus });
      expect(notices()).toHaveLength(1);
    });

    it("names the cause of a fallback, and says when the routing chose the model", async () => {
      const opus48 = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-4-8" };
      const opus55 = { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-5-5" };
      const crewmate = fakeCrewmate({ model: opus55 });
      const h = setup(crewmate, { routedModel: opus55 });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Read logs",
        intent: intentOf("go"),
      });
      await tick();
      crewmate.emit({
        type: "model_served",
        model: opus48,
        fallback: { from: opus55, category: "cyber" },
      });
      const key = h.tasks.get(taskId)?.key || taskId;
      expect(h.ops).toContain(
        `[fm-op] ${key} "Read logs" now answers on claude-opus-4-8, not on claude-opus-5-5, the model it asked for: Claude Code moved it after claude-opus-5-5's safeguards stopped a reply (cyber). The app's routing chose claude-opus-5-5; the captain named no model.`,
      );
    });

    it("names at launch the tasks a quit paused, which carry on by themselves", async () => {
      const crewmate = fakeCrewmate({ model: fable });
      const finished = fakeCrewmate({ model: fable });
      const h = setup(crewmate, {
        routeResult: { choice: fable, bucket: "premium", rule: "R0" },
        crewmates: [finished],
      });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Project scopes",
        intent: intentOf("build it"),
      });
      await h.supervisor.intake.commission({
        title: "Skill packs",
        intent: intentOf("build it too"),
      });
      await tick();
      // The second task's turn ended; the first is mid-turn when the app quits.
      finished.finishPrompt();
      await tick();
      await h.supervisor.disposeAll();
      h.inbox.resetInFlight();
      const events: FmEvent[] = [];
      const fresh = reboot(
        h,
        vi.fn(async () => fakeCrewmate({ model: fable })),
        {
          broadcastEvent: (event) => events.push(event),
        },
      );
      fresh.watch.announceCarryOn();
      // Only the task whose turn the quit cut; the one that had finished waits.
      expect(events).toEqual([
        {
          type: "firstmate_note",
          text: carryOnWords([
            { key: h.tasks.get(taskId)?.key || taskId, title: "Project scopes" },
          ]),
        },
      ]);
      await fresh.disposeAll();
    });

    // INF-1582 finding 5: an update's deliberate abort remains a pause, not a recovery failure.
    it("records restart recovery without a wake while an update pauses its turn", async () => {
      const crewmate = fakeCrewmate();
      const h = setup(crewmate);
      const { taskId } = await h.supervisor.intake.commission({
        title: "Update observation",
        intent: intentOf("keep working"),
      });
      await tick();
      h.tasks.placement.setDevice(taskId, "mac-mini");
      const wakesBefore = h.ops.length;
      await h.supervisor.updates.pauseForUpdate("mac-mini");
      const paused = h.supervisor.facts.crewStatus(taskId)[0]?.restart;
      expect(paused?.text).toContain("is being updated");
      crewmate.emit({ type: "turn_failed", taskId, error: "The turn was aborted for the update." });
      crewmate.emit({ type: "request_started" });
      expect(h.supervisor.facts.crewStatus(taskId)[0]?.restart).toEqual(paused);
      expect(h.ops).toHaveLength(wakesBefore);
      await h.supervisor.disposeAll();
    });

    // INF-2245 (INF-2223's approved stop-and-resume update): this computer's
    // own update saves its crew's work, and the restart carries it on once.
    describe("saving work before this computer's update", () => {
      /**
       * A crewmate whose session stops safely, as Pi's and Claude's do: it
       * names the call it still runs, and the test either lets that call
       * finish (`stopped`, which cuts the turn) or sees the stop withdrawn.
       */
      function safelyStoppingCrewmate(options: FakeSessionOptions = {}) {
        const crewmate = fakeCrewmate(options);
        const stops: { signal?: AbortSignal; finish: () => void }[] = [];
        crewmate.stopSafely = (stop) =>
          new Promise((resolve) => {
            // No prompt is running yet: nothing to wait for, and the next is refused.
            if (!crewmate.isStreaming()) {
              resolve("stopped");
              return;
            }
            stop?.waiting?.([{ callId: "call-1", toolName: "bash" }]);
            stop?.signal?.addEventListener("abort", () => resolve("withdrawn"), { once: true });
            stops.push({
              signal: stop?.signal,
              finish: () => {
                stop?.waiting?.([]);
                resolve("stopped");
                crewmate.finishPrompt();
              },
            });
          });
        return Object.assign(crewmate, { stops });
      }

      const updateRows = (h: ReturnType<typeof setup>, taskId: string) =>
        h.inbox
          .allFor(taskId)
          .filter((row) => row.facts?.kind === "turn-resumed")
          .map((row) => row.facts);

      it("waits for the running call, holds new words, and carries the turn on after the restart", async () => {
        let now = 1000;
        const crewmate = safelyStoppingCrewmate();
        const h = setup(crewmate, { now: () => now });
        const { taskId } = await h.supervisor.intake.commission({
          title: "Release notes",
          intent: intentOf("write the notes"),
        });
        await tick();
        expect(crewmate.promptCalls).toHaveLength(1);
        const waiting: string[][] = [];
        const saving = h.supervisor.updates.saveForUpdate({
          waiting: (tasks) => waiting.push(tasks),
        });
        expect(waiting.at(-1)).toEqual(["Release notes"]);
        // The captain's words while it saves wait on the lane, never steered in.
        expect(
          await h.supervisor.steer.steerCrewmate(taskId, "Mention the new keys too", "captain"),
        ).toBe("recorded-held");
        expect(crewmate.steer).not.toHaveBeenCalled();
        let saved = false;
        void saving.then(() => {
          saved = true;
        });
        await tick();
        expect(saved).toBe(false);
        // The call it ran finishes, and only then is the turn cut.
        crewmate.stops[0]?.finish();
        expect(await saving).toBe("saved");
        expect(waiting.at(-1)).toEqual([]);
        expect(updateRows(h, taskId)).toEqual([{ kind: "turn-resumed", stopped: "update" }]);
        expect(h.supervisor.updates.resumingAfterUpdate()).toEqual(["Release notes"]);
        // A second ask for the same update joins the first.
        expect(await h.supervisor.updates.saveForUpdate()).toBe("saved");
        expect(crewmate.stops).toHaveLength(1);

        await h.supervisor.disposeAll();
        h.inbox.resetInFlight();
        const resumed = fakeCrewmate();
        const fresh = reboot(
          h,
          vi.fn(async () => resumed),
          {
            tasks: new TaskService({ db: h.db, repos: h.repos, strict: true, now: () => now }),
            now: () => now,
          },
        );
        now += 100_000;
        await fresh.watch.sweepInbox(now);
        await tick();
        // One turn carries it on, with why it stopped before the words that waited.
        expect(resumed.promptCalls).toHaveLength(1);
        const served = resumed.promptCalls[0] ?? "";
        expect(served).toContain("while Infinitary was updated");
        expect(served).toContain("Mention the new keys too");
        expect(served.indexOf("while Infinitary was updated")).toBeLessThan(
          served.indexOf("Mention the new keys too"),
        );
        await fresh.disposeAll();
      });

      it("lets the turn go on with Update later and steers in what waited", async () => {
        const crewmate = safelyStoppingCrewmate();
        const h = setup(crewmate);
        const { taskId } = await h.supervisor.intake.commission({
          title: "Release notes",
          intent: intentOf("write the notes"),
        });
        await tick();
        const later = new AbortController();
        const saving = h.supervisor.updates.saveForUpdate({ signal: later.signal });
        await h.supervisor.steer.steerCrewmate(taskId, "Mention the new keys too", "captain");
        later.abort();
        expect(await saving).toBe("withdrawn");
        await tick();
        // Nothing was cut: the turn runs on, and nothing carries it on later.
        expect(crewmate.isStreaming()).toBe(true);
        expect(updateRows(h, taskId)).toEqual([]);
        expect(h.supervisor.updates.resumingAfterUpdate()).toEqual([]);
        expect(crewmate.steer).toHaveBeenCalledTimes(1);
        expect(crewmate.steer.mock.calls[0]?.[0]).toContain("Mention the new keys too");
        await h.supervisor.disposeAll();
      });

      it("leaves an idle task as it was and starts nothing until the update is let go", async () => {
        const crewmate = safelyStoppingCrewmate();
        const h = setup(crewmate);
        const { taskId } = await h.supervisor.intake.commission({
          title: "Release notes",
          intent: intentOf("write the notes"),
        });
        await tick();
        crewmate.finishPrompt();
        await tick();
        expect(await h.supervisor.updates.saveForUpdate()).toBe("saved");
        // Already idle: no stop, no row that would wake it after the restart.
        expect(crewmate.stops).toEqual([]);
        expect(updateRows(h, taskId)).toEqual([]);
        await h.supervisor.steer.steerCrewmate(taskId, "One more paragraph", "captain");
        await tick();
        expect(crewmate.promptCalls).toHaveLength(1);
        // The update did not replace the copy: what waited goes now.
        h.supervisor.updates.releaseUpdate();
        await tick();
        expect(crewmate.promptCalls).toHaveLength(2);
        expect(crewmate.promptCalls[1]).toContain("One more paragraph");
        await h.supervisor.disposeAll();
      });

      it("sends a turn's words again when the update holds it before its model takes it", async () => {
        const crewmate = safelyStoppingCrewmate();
        const h = setup(crewmate);
        const { taskId } = await h.supervisor.intake.commission({
          title: "Release notes",
          intent: intentOf("write the notes"),
        });
        await tick();
        crewmate.finishPrompt();
        await tick();
        // Its next turn has begun and not reached its model when the save begins.
        let saving: Promise<string> | undefined;
        const setActivity = h.tasks.turns.setActivity.bind(h.tasks.turns);
        vi.spyOn(h.tasks.turns, "setActivity").mockImplementation((...args) => {
          const result = setActivity(...args);
          if (args[0] === taskId && args[1] === "running" && !saving)
            saving = h.supervisor.updates.saveForUpdate();
          return result;
        });
        await h.supervisor.steer.steerCrewmate(taskId, "One more paragraph", "captain");
        await tick();
        expect(saving).toBeDefined();
        expect(await saving).toBe("saved");
        await tick();
        expect(crewmate.promptCalls).toHaveLength(1);
        expect(updateRows(h, taskId)).toEqual([]);
        expect(h.inbox.allFor(taskId).map((row) => [row.text, row.deliveredAt])).toEqual([
          [expect.stringContaining("One more paragraph"), null],
        ]);
        h.supervisor.updates.releaseUpdate();
        await tick();
        expect(crewmate.promptCalls).toHaveLength(2);
        expect(crewmate.promptCalls[1]).toContain("One more paragraph");
        await h.supervisor.disposeAll();
      });
    });

    // INF-1582 finding 5 also covers a work computer restarting while its home stays open.
    it("records restart recovery without a wake when the work computer reopens", async () => {
      const crewmate = fakeCrewmate();
      const h = setup(crewmate);
      const { taskId } = await h.supervisor.intake.commission({
        title: "Work computer recovery",
        intent: intentOf("keep working"),
      });
      await tick();
      h.tasks.placement.setDevice(taskId, "mac-mini");
      const wakesBefore = h.ops.length;
      h.supervisor.placedReopened(taskId);
      expect(h.supervisor.facts.crewStatus(taskId)[0]?.restart?.text).toContain(
        "has not confirmed a new request",
      );
      crewmate.emit({ type: "request_started" });
      expect(h.supervisor.facts.crewStatus(taskId)[0]?.restart?.text).toBe(RESTART_RESUMED_WORDS);
      expect(h.ops).toHaveLength(wakesBefore);
      expect(crewmate.steer).not.toHaveBeenCalled();
      await h.supervisor.disposeAll();
    });

    // INF-1582 finding 5: answer from recorded recovery, without steering the crew.
    it.each(["resumed", "refused", "missing conversation", "held", "remote running", "guided"])(
      "records restart recovery without a wake: %s",
      async (outcome) => {
        let now = 1000;
        const original = fakeCrewmate();
        const h = setup(original, { now: () => now });
        const { taskId } = await h.supervisor.intake.commission({
          title: "Restart observation",
          intent: intentOf("keep working"),
        });
        await tick();
        await h.supervisor.disposeAll();
        h.inbox.resetInFlight();
        const recoveredTasks = new TaskService({
          db: h.db,
          repos: h.repos,
          strict: true,
          now: () => now,
        });
        if (outcome === "missing conversation") h.tasks.turns.setSessionFile(taskId, null);
        if (outcome === "remote running") {
          h.tasks.placement.setDevice(taskId, "mac-mini");
          h.tasks.turns.setActivity(taskId, "running");
          h.inbox.deleteFor(taskId);
        }
        const resumed = fakeCrewmate();
        const open = vi.fn(async () => {
          if (outcome === "refused") throw new Error("The saved conversation could not be opened.");
          return resumed;
        });
        const wake = vi.fn();
        const fresh = reboot(h, open, {
          tasks: recoveredTasks,
          now: () => now,
          ...(outcome === "held"
            ? {
                serveability: {
                  cutOff: () => ({ class: "signed_out" as const, since: 500 }),
                  providerName: () => "Claude",
                },
              }
            : {}),
        });
        fresh.setFirstmateHooks({ notifyOp: wake, retryConverse: vi.fn() });
        // Before the sweep there is no evidence of an automatic continuation.
        fresh.watch.announceCarryOn();
        expect(fresh.facts.crewStatus(taskId)[0]?.restart?.text).toContain(
          "has not started a request yet",
        );
        if (outcome === "held") h.tasks.placement.setAccountId(taskId, "test-account");
        now += 100_000;
        if (outcome === "guided")
          await fresh.steer.steerCrewmate(taskId, "Please check the restart", "captain");
        else await fresh.watch.sweepInbox(now);
        if (outcome === "resumed") {
          await tick();
          expect(resumed.promptCalls).toHaveLength(1);
          resumed.emit({
            type: "input_read",
            textSha256: createHash("sha256").update(resumed.promptCalls[0]!).digest("hex"),
          });
          resumed.emit({ type: "request_started" });
          expect(fresh.facts.crewStatus(taskId)[0]?.restart).toEqual({
            at: new Date(now).toISOString(),
            text: RESTART_RESUMED_WORDS,
          });
          expect(
            h.tasks
              .timeline(taskId)
              .filter(
                (row) =>
                  (row.data?.restartOutcome as { outcome?: string } | undefined)?.outcome ===
                  "resumed",
              ),
          ).toHaveLength(1);
        } else {
          const expected =
            outcome === "held"
              ? "sign-in or allowance"
              : outcome === "missing conversation"
                ? "saved conversation is unavailable"
                : outcome === "remote running"
                  ? "computer is out of reach"
                  : outcome === "guided"
                    ? "new guidance arrived"
                    : "could not be opened";
          expect(fresh.facts.crewStatus(taskId)[0]?.restart?.text).toContain(expected);
        }
        expect(wake).not.toHaveBeenCalled();
        expect(resumed.steer).not.toHaveBeenCalled();
        const recorded = fresh.facts.crewStatus(taskId)[0]?.restart;
        await fresh.disposeAll();
        const readOnly = reboot(
          h,
          vi.fn(async () => fakeCrewmate()),
          { tasks: recoveredTasks },
        );
        expect(readOnly.facts.crewStatus(taskId)[0]?.restart).toEqual(recorded);
        await readOnly.disposeAll();
      },
    );

    it("reopens a task on a computer that runs work asking for its own model and effort", async () => {
      const crewmate = fakeCrewmate({ model: fable });
      const h = setup(crewmate, {
        routeResult: { choice: fable, bucket: "premium", rule: "R0" },
        reasoningChoice: () => "xhigh",
      });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Skill packs",
        intent: intentOf("build it on fable"),
      });
      await tick();
      crewmate.finishPrompt();
      await tick();
      await h.supervisor.disposeAll();
      // The record now names the Mac mini, where its working copy lives.
      h.tasks.placement.setDevice(taskId, "mac-mini");
      const boot = fakeCrewmate({ model: fable });
      const opened: SessionSpec[] = [];
      const factory = {
        backend: "claude" as const,
        controlProfile: PI_CONTROL_PROFILE,
        open: async (spec: SessionSpec) => {
          opened.push(spec);
          return boot;
        },
      };
      const machines = {
        computers: () => [],
        folders: () => ({ work: "/Users/kun/work/wt", sessions: "/Users/kun/work/sessions" }),
        factories: () => ({ claude: factory, pi: { ...factory, backend: "pi" as const } }),
        ready: () => true,
        nameOf: () => "Kun's Mac mini",
        placeOf: () => ({ where: "on Kun's Mac mini", name: "Kun's Mac mini" }),
        served: async () => ({ accounts: new Map() }),
        servingAccount: () => undefined,
        accountOf: () => undefined,
        cutOffOf: () => undefined,
        knows: () => false,
      } as unknown as CrewMachines;
      const { fresh, specs } = relaunch(h, boot, machines);
      await fresh.steer.steerCrewmate(taskId, "carry on");
      await tick();
      expect(specs[0]).toMatchObject({
        machineId: "mac-mini",
        model: fable,
        thinkingLevel: "xhigh",
      });
      expect(opened[0]).toMatchObject({ machine: "mac-mini", model: fable });
      await fresh.disposeAll();
    });
  });

  it("reopens a recorded conversation only in its own backend's shape, and says when it starts fresh", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, sessionSpecs, tasks } = setup(crewmate);
    // A record whose token is not a Pi session file (another backend's id):
    // Pi cannot reopen it, so the crewmate starts over rather than failing.
    seedTask(tasks, {
      id: "t-foreign",
      title: "Old task",
      prompt: "old work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-foreign",
      sessionFile: "0f3a2c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
      status: "idle",
      createdAt: Date.now(),
    });

    const earlierToken = tasks.get("t-foreign")?.sessionFile ?? "";
    tasks.turns.setSessionFile("t-foreign", earlierToken, {
      file: `/tmp/records/${earlierToken}.jsonl`,
      computer: HOME.the,
      device_id: "local",
      provider: CLAUDE_PROVIDER_ID,
      model: "claude-fable-5",
      account_id: null,
      began: "start",
    });
    await supervisor.steer.steerCrewmate("t-foreign", "carry on");
    await tick();
    expect(specs[0]?.resumeToken).toBe("0f3a2c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b");
    expect(sessionSpecs[0]?.shape).toMatchObject({ turns: "rolling" });
    expect(sessionSpecs[0]?.shape.turns === "rolling" && sessionSpecs[0].shape.record.resume).toBe(
      undefined,
    );
    const notes = tasks.timeline("t-foreign").filter((event) => event.kind === "note");
    expect(notes.map((event) => event.text)).toContain(
      "its earlier conversation could not be reopened, so it starts a fresh one",
    );
    expect(crewmate.promptCalls.at(-1)).toContain("carry on");
    const replacedSessions = tasks.archive.sessions("t-foreign");
    expect(replacedSessions).toMatchObject([
      { conversation: earlierToken, began: "start", current: false },
      { conversation: "s1", began: "unopenable", current: true },
    ]);
    crewmate.finishPrompt();
    await tick();
    await supervisor.steer.steerCrewmate("t-foreign", "Inspect the header too.");
    await tick();
    expect(tasks.archive.sessions("t-foreign")).toHaveLength(2);
    expect(tasks.archive.sessions("t-foreign").filter((session) => session.current)).toHaveLength(
      1,
    );
    console.info(
      "INF-1295 failed reopen association lifecycle",
      JSON.stringify({ replacedSessions, continuedSessions: tasks.archive.sessions("t-foreign") }),
    );
  });

  it("carries a crewmate whose conversation renewed under changed instructions into its new one", async () => {
    // The earlier conversation's saved transcript, which the crewmate is pointed at.
    const earlier = join(scratchDir("infinitary-renewed-"), "earlier.jsonl");
    writeFileSync(earlier, "");
    const renewal = { from: earlier, changed: ["prompt"] as const };
    const crewmate = fakeCrewmate({
      sessionId: "s-new",
      resume: { backend: "pi", sessionFile: "/tmp/s-new.jsonl" },
      renewal,
    });
    const { supervisor, tasks } = setup(crewmate);
    seedTask(tasks, {
      id: "t-renew",
      title: "Old task",
      prompt: "old work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-renew",
      sessionFile: earlier,
      status: "idle",
      createdAt: Date.now(),
    });
    tasks.recordBrief("t-renew", ["Goal: count the rivets."]);
    tasks.turns.setSessionFile("t-renew", earlier, {
      file: earlier,
      computer: HOME.the,
      device_id: "local",
      provider: "fm-mock",
      model: "mock-1",
      account_id: null,
      began: "start",
    });

    await supervisor.steer.steerCrewmate("t-renew", "carry on");
    await tick();
    // The record says so, and names the new conversation before its turn ends.
    const note = tasks
      .timeline("t-renew")
      .find((event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal));
    expect(note?.data).toMatchObject({ conversation: { from: earlier, changed: ["prompt"] } });
    expect(tasks.get("t-renew")?.sessionFile).toBe("/tmp/s-new.jsonl");
    // INF-1288: renewal is recorded before the first turn completes.
    expect(tasks.archive.sessions("t-renew")).toMatchObject([
      { conversation: "earlier", began: "start", file: earlier, current: false },
      { conversation: "s-new", began: "renewal", file: "/tmp/s-new.jsonl", current: true },
    ]);
    console.info(
      "INF-1295 local renewal associations",
      JSON.stringify(tasks.archive.sessions("t-renew")),
    );
    // Its first prompt says why, where its record and earlier conversation
    // are, and its brief, then the message that woke it.
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(crewmate.promptCalls[0]).toBe(
      `${crewmateRestartText({
        restart: renewal,
        taskKey: tasks.get("t-renew")?.key ?? "",
        brief: "Goal: count the rivets.",
        earlier,
      })}\n\ncarry on`,
    );
    // Once a turn took it in, the next prompt is the message alone.
    crewmate.finishPrompt();
    await tick();
    await supervisor.steer.steerCrewmate("t-renew", "and then this");
    await tick();
    expect(crewmate.promptCalls.at(-1)).toBe("and then this");
  });

  it("serves a renewed conversation's reason once after a restart before a clean turn (INF-416 piece B)", async () => {
    // INF-416 piece B: the reason is a once-named lane wake, not memory, so a
    // quit before the turn ends clean still serves it, and only on that turn.
    const earlier = join(scratchDir("infinitary-renewed-restart-"), "earlier.jsonl");
    writeFileSync(earlier, "");
    const renewal = { from: earlier, changed: ["prompt"] as const };
    const crewmate = fakeCrewmate({
      sessionId: "s-new",
      resume: { backend: "pi", sessionFile: "/tmp/s-new.jsonl" },
      renewal,
    });
    let now = Date.now();
    const clock = () => now;
    const { supervisor, tasks, db, paths, workspace, cardStore } = setup(crewmate, { now: clock });
    seedTask(tasks, {
      id: "t-renew-restart",
      title: "Old task",
      prompt: "old work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-renew-restart",
      sessionFile: earlier,
      status: "idle",
      createdAt: now,
    });
    tasks.recordBrief("t-renew-restart", ["Goal: count the rivets."]);
    const reason = crewmateRestartText({
      restart: renewal,
      taskKey: tasks.get("t-renew-restart")?.key ?? "",
      brief: "Goal: count the rivets.",
      earlier,
    });

    await supervisor.steer.steerCrewmate("t-renew-restart", "carry on");
    await tick();
    // The words are the same as the in-memory prefix they replace.
    expect(crewmate.promptCalls).toEqual([`${reason}\n\ncarry on`]);

    // The app quits before that turn ends clean. A fresh supervisor over the
    // same database is the next boot, and its session reports no renewal.
    supervisor.disposeAll();
    const bootCrewmate = fakeCrewmate();
    const fresh = reboot(
      { paths, db, workspace },
      vi.fn(async () => bootCrewmate),
      { now: clock, cardStore },
    );
    fresh.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
    expect(new InboxStore(db, { now: clock }).resetInFlight()).toBe(2);
    now += 120_000;
    await fresh.watch.sweepInbox(now);
    await tick();

    const served = bootCrewmate.promptCalls[0] ?? "";
    expect(served).toBe(
      `${RESTART_REPLAY_NOTE}\n\n${reason}\n\n${RESTART_REPLAY_NOTE}\n\ncarry on`,
    );
    expect(served.split(reason)).toHaveLength(2);

    bootCrewmate.emit({ type: "turn_end", taskId: "t-renew-restart" });
    bootCrewmate.finishPrompt();
    await tick();
    await fresh.steer.steerCrewmate("t-renew-restart", "and then this");
    await tick();
    expect(bootCrewmate.promptCalls.at(-1)).toBe("and then this");
    expect(bootCrewmate.promptCalls.at(-1)).not.toContain(reason);
    fresh.disposeAll();
  });

  it("refuses to start a crewmate on a backend nothing serves, rather than guessing", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, sessions } = setup(crewmate, {
      accounts: {
        selectForSpawn: () => "acct_claude",
        reselectForResume: () => ({ changed: false }),
        labelOf: () => "Claude",
      },
      routedModel: { provider: CLAUDE_PROVIDER_ID, id: "claude-opus-5-5" },
      // The account binds to Claude, and this supervisor has only Pi's factory.
      bind: async (accountId) => ({ backend: "claude", accountId: accountId ?? "" }),
    });
    await expect(
      supervisor.intake.commission({ title: "Job", intent: intentOf("Start") }),
    ).rejects.toThrow('No backend is registered to serve account "acct_claude".');
    expect(sessions.open).not.toHaveBeenCalled();
  });

  it("keeps a session's own bookkeeping off the feed, and its turns on it", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, events } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await tick();
    crewmate.emit({ type: "request_started" });
    crewmate.emit({ type: "assistant_delta", taskId, text: "On it." });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.emit({ type: "turn_closed", text: "On it." });
    await tick();
    const types = events.map((event) => event.type);
    expect(types).toContain("assistant_delta");
    expect(types).toContain("turn_end");
    expect(types).not.toContain("turn_closed");
    expect(types).not.toContain("request_started");
  });

  it("never resumes a task that ran on a subscription this build no longer offers", async () => {
    // An idle task a Cursor crewmate left behind: its resume token is
    // Cursor's own chat id, which no remaining transport can reopen.
    const crewmate = fakeCrewmate();
    const { supervisor, specs, tasks, inbox } = setup(crewmate, {
      routedModel: { provider: "cursor", id: "composer-2.5" },
    });
    seedTask(tasks, {
      id: "t-cursor",
      title: "Tidy the README",
      prompt: "old work",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-t-cursor",
      sessionFile: "chat-0f3a",
      accountId: "acct_cursor",
      status: "idle",
      createdAt: Date.now(),
    });

    // A steer is refused as text, with the way out.
    await expect(supervisor.steer.steerCrewmate("t-cursor", "carry on")).rejects.toThrow(
      /no longer offers.*Spawn a follow-up/,
    );
    // Guidance a previous process left on its lane is kept on the record,
    // never retried into a transport that cannot hold it.
    inbox.enqueue("t-cursor", "also fix the links");
    await supervisor.watch.sweepInbox(Date.now());
    await tick();
    expect(specs).toEqual([]);
    expect(inbox.allFor("t-cursor")).toEqual([]);
    const note = tasks.timeline("t-cursor").find((event) => event.kind === "note");
    expect(note).toMatchObject({ feed: true, data: { undelivered: 1 } });
    expect(note?.text).toContain("also fix the links");
    expect(tasks.get("t-cursor")).toMatchObject({ status: "active", activity: "idle" });
  });

  it("restores unresolved cards across restarts", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs, db, paths } = setup(crewmate);
    await supervisor.intake.commission({
      title: "persist",
      intent: intentOf("show every card kind"),
    });
    await tick();
    specs[0]?.onCard?.({
      title: "Persisted note",
      body: "Still here.",
      actions: [],
    });
    await tick();
    // A fresh supervisor over the same database (a restart).
    const fresh = reboot(
      {
        paths,
        db,
        workspace: { removeTaskWorktree: vi.fn(async () => {}) } as unknown as WorkspaceService,
      },
      vi.fn(async () => crewmate),
    );
    const titles = fresh.cards.snapshot().map((card) => card.title);
    expect(titles).toContain("Persisted note");
  });
});
