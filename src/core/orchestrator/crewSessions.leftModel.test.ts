/**
 * A running task's next conversation when its model left every level
 * (docs/routing.md, "A model that left every level"): a reopen after a quit
 * and the context-limit restart keep the routed model only while a level in
 * Settings → Intelligence → Models still holds it or the task names it;
 * otherwise the task routes again, records that choice, and says so once.
 * Each case drives a real CrewSupervisor through the crew harness over a
 * real Router and a real ModelSlots record, so taking a model off its levels
 * is the same `setSlotMembership` call the Models board makes.
 */
import { englishOf, said } from "@shared/i18n/said";
import { offeringKey, SLOTS } from "@shared/modelSlots";
import { expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { QuotaService } from "../quota/quotaService";
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import { ModelSlots } from "../routing/modelSlots";
import { Router } from "../routing/router";
import type { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { TaskProtocol } from "../tasks/taskProtocol";
import type { CrewmateSpec } from "./crewSession";
import type { AccountAttachment } from "./crewSupervisorOptions";

fakeCrewTimersEachTest();

const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
const terra = { provider: "openai-codex", id: "gpt-6.1-terra" };
const luna = { provider: "openai-codex", id: "gpt-6.1-luna" };
const opus = { provider: "anthropic-claude", id: "claude-opus-5-5" };

type Ref = { provider: string; id: string };

/** The sign-ins the routing reads: one per provider, each serving its listed models. */
function signIns(models: Ref[]) {
  const providers = [...new Set(models.map((model) => model.provider))];
  return providers.map((providerId) => ({
    accountId: providerId === "anthropic-claude" ? "acct-claude" : "acct-codex",
    accountLabel: "personal",
    providerId,
    models: models.filter((model) => model.provider === providerId),
  }));
}

/**
 * The real routing stack over sign-ins serving `models` (Sol and Terra on
 * one Codex sign-in unless given), seeded from the starter map.
 */
function realRouting(models: Ref[] = [sol, terra]) {
  let slots: ModelSlots | undefined;
  const make = (db: ReturnType<typeof openInMemoryDatabase>) => {
    const settings = new SettingsStore(db);
    slots = new ModelSlots({
      settings,
      accounts: () => signIns(models),
      quotaModels: () => undefined,
    });
    // First activation: the starter map places Sol at high and Terra at medium.
    slots.reconcile();
    return new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: {
        latestModels: () => ({
          generatedAt: "now",
          models: models.map((model) => ({
            provider: model.provider === "anthropic-claude" ? "claude" : "codex",
            id: model.id,
            label: model.id,
            effectivePercentRemaining: 80,
          })),
        }),
        latest: () => undefined,
      } as unknown as QuotaService,
      availableModels: () => models,
      slots,
    });
  };
  const board = () => {
    if (!slots) throw new Error("routing not built yet");
    return slots;
  };
  /** Settings → Intelligence → Models: `model` leaves every level. */
  const takeOffEveryLevel = (model: Ref) => {
    for (const slot of SLOTS) board().setSlotMembership(offeringKey(model), slot, false);
    expect(board().slotsOf(model)).toEqual([]);
  };
  /** Settings → Intelligence → Models: `model` takes high. */
  const placeHigh = (model: Ref) => board().setSlotMembership(offeringKey(model), "high", true);
  /** Sol leaves every level, and `to` (Terra unless given) takes high. */
  const takeSolOffEveryLevel = (to: Ref = terra) => {
    takeOffEveryLevel(sol);
    placeHigh(to);
  };
  return { make, takeSolOffEveryLevel, takeOffEveryLevel, placeHigh };
}

type Harness = ReturnType<typeof setup>;

/** The routing rows the task's ledger holds, oldest first. */
function routedModels(h: Harness, taskId: string): string[] {
  return (
    h.db
      .prepare("SELECT model FROM routing_decisions WHERE task_id = ? ORDER BY id")
      .all(taskId) as { model: string }[]
  ).map((row) => row.model);
}

/** The timeline lines saying the task routed again because its model left every level. */
function reroutedNotes(h: Harness, taskId: string): string[] {
  return h.tasks
    .timeline(taskId)
    .filter((entry) => entry.kind === "note" && entry.data && "rerouted" in entry.data)
    .map((entry) => entry.text);
}

/** The account decisions the task's ledger holds, by provider and account, oldest first. */
function accountPicks(h: Harness, taskId: string): string[] {
  return (
    h.db
      .prepare(
        "SELECT provider, account_id FROM decisions WHERE kind = 'account' AND task_id = ? ORDER BY id",
      )
      .all(taskId) as { provider: string; account_id: string | null }[]
  ).map((row) => `${row.provider}/${row.account_id}`);
}

/**
 * Relaunch the app and steer the task, so it reopens; answers what the
 * reopen asked for, if it opened one. `accounts` is the relaunch's account
 * surface, and `whilePicking`, when given, runs while its account pick waits.
 */
async function relaunchAndSteer(
  h: Harness,
  taskId: string,
  opened: Ref = terra,
  accounts?: AccountAttachment,
): Promise<CrewmateSpec | undefined> {
  const specs: CrewmateSpec[] = [];
  const boot = fakeCrewmate({ model: opened });
  const relaunched = reboot(
    h,
    vi.fn(async () => boot),
    {
      specs,
      router: h.router as unknown as Router,
      ...(accounts ? { accounts } : {}),
    },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  if (specs.length > 0) {
    boot.finishPrompt();
    await tick();
  }
  await relaunched.disposeAll();
  expect(specs.length).toBeLessThanOrEqual(1);
  return specs[0];
}

/**
 * An account surface whose pick waits until `release`, running `whilePicking`
 * first; it records its pick only when the move asks it to.
 */
function pausedAccounts(accountId: string, whilePicking: () => void) {
  const recorded = vi.fn();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async () => accountId),
    pickForSpawn: vi.fn(async () => {
      whilePicking();
      await gate;
      return { accountId, record: recorded };
    }),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
  };
  return { accounts, recorded, release: () => release() };
}

/** Commission a task on Sol, let its first turn end, and quit. */
async function startedOnSol(h: Harness, crewmate: ReturnType<typeof fakeCrewmate>) {
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  expect(h.specs[0]?.model).toEqual(sol);
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();
  return taskId;
}

it("routes a reopened task again, once and said once, when its model left every level", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  expect(h.specs[0]?.model).toEqual(sol);
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();

  routing.takeSolOffEveryLevel();

  const reopened = await relaunchAndSteer(h, taskId);
  expect(reopened?.model).toEqual(terra);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(h.tasks.get(taskId)?.model).toBe(offeringKey(terra));
  // The line names both models as Settings does, saved as a fact any language words.
  const line = said("crewmateRoutedAgain", {
    left: h.router?.modelLabel(sol) ?? "",
    model: h.router?.modelLabel(terra) ?? "",
  });
  expect(reroutedNotes(h, taskId)).toEqual([englishOf(line)]);
  expect(
    h.tasks.timeline(taskId).find((entry) => entry.data && "rerouted" in entry.data)?.data?.said,
  ).toEqual(line);

  // The next reopen finds Terra on a level: it keeps it, and says nothing more.
  const again = await relaunchAndSteer(h, taskId);
  expect(again?.model).toEqual(terra);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
});

it("opens the context-limit restart's new conversation on a model a level holds", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const restarted = fakeCrewmate({
    model: terra,
    sessionId: "s2",
    resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
  });
  const h = setup(crewmate, { realRouter: routing.make, crewmates: [restarted] });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  expect(h.sessionSpecs[0]?.model).toEqual(sol);

  // While the task runs, the captain takes Sol off every level.
  routing.takeSolOffEveryLevel();

  crewmate.emit({
    type: "turn_failed",
    taskId,
    error: "This request exceeds the context window. Shorten it before trying again.",
    contextOverflow: true,
  });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();

  await vi.waitFor(() => expect(h.sessionSpecs).toHaveLength(2));
  const opened = h.sessionSpecs[1]?.shape;
  expect(opened?.turns === "rolling" && opened.record.resume).toBeUndefined();
  expect(h.sessionSpecs[1]?.model).toEqual(terra);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
});

it("keeps a model the task names on reopen, whatever the levels hold", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project on sol"),
    shape: { override_model_id: offeringKey(sol) },
  });
  await tick();
  expect(h.specs[0]?.model).toEqual(sol);
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();

  routing.takeSolOffEveryLevel();

  const reopened = await relaunchAndSteer(h, taskId);
  expect(reopened?.model).toEqual(sol);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
});

it("words the reroute's Activity line from its saved fact", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  await relaunchAndSteer(h, taskId);

  // The record's own read: the Activity row carries the fact for the window to word.
  const record = new TaskProtocol({
    tasks: h.tasks,
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
    now: () => Date.now(),
    coalesceMs: 0,
  }).detail(taskId);
  const fact = said("crewmateRoutedAgain", {
    left: h.router?.modelLabel(sol) ?? "",
    model: h.router?.modelLabel(terra) ?? "",
  });
  const row = record.activityLog.find((line) => line.said);
  expect(row).toMatchObject({ text: englishOf(fact), said: fact });
});

it("routes to another provider's model with the account the selector picks, recorded once", async () => {
  const routing = realRouting([sol, opus]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel(opus);

  const pool: AccountPool = {
    list: (providerId) =>
      [
        { id: "acct-codex", providerId: "openai-codex", label: "personal", enabled: true },
        { id: "acct-claude", providerId: "anthropic-claude", label: "work", enabled: true },
      ].filter((account) => !providerId || account.providerId === providerId),
    pinnedAccount: () => undefined,
    connectedSync: () => true,
    withheldReason: () => undefined,
    markSelected: vi.fn(),
  };
  const selector = new AccountSelector({
    pool,
    quota: { latest: () => undefined },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(h.db),
  });
  const accounts: AccountAttachment = {
    selectForSpawn: (task, provider, crew) => selector.selectForSpawn(task, provider, crew),
    pickForSpawn: (task, provider, crew) => selector.pickForSpawn(task, provider, crew),
    reselectForResume: (task, held) => selector.reselectForResume(task, held),
    labelOf: (id) => selector.labelOf(id),
  };

  const reopened = await relaunchAndSteer(h, taskId, opus, accounts);
  expect(reopened?.model).toEqual(opus);
  expect(routedModels(h, taskId)).toEqual([sol.id, opus.id]);
  expect(h.tasks.get(taskId)?.accountId).toBe("acct-claude");
  expect(accountPicks(h, taskId)).toEqual(["anthropic-claude/acct-claude"]);
  expect(pool.markSelected).toHaveBeenCalledWith("acct-claude");
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
});

it("opens nothing and records no account pick when the task stops while its account is picked", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();

  const paused = pausedAccounts("acct-codex", () => {
    h.tasks.close(taskId, { status: "dropped", reason: "cancelled", actor: "captain" });
  });
  const reopening = relaunchAndSteer(h, taskId, terra, paused.accounts);
  await tick();
  paused.release();
  const reopened = await reopening;

  expect(reopened).toBeUndefined();
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(paused.recorded).not.toHaveBeenCalled();
  expect(reroutedNotes(h, taskId)).toEqual([]);
});

it("keeps the old model when the replacement leaves its level while the account is picked", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();

  // While the account for Terra is picked, Terra leaves every level and Luna takes high.
  const paused = pausedAccounts("acct-codex", () => {
    routing.takeOffEveryLevel(terra);
    routing.placeHigh(luna);
  });
  const reopening = relaunchAndSteer(h, taskId, sol, paused.accounts);
  await tick();
  paused.release();
  const reopened = await reopening;

  expect(reopened?.model).toEqual(sol);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(paused.recorded).not.toHaveBeenCalled();
  expect(reroutedNotes(h, taskId)).toEqual([]);
});
