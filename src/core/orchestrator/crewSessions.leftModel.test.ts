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
import { softHoldWords } from "@shared/holds";
import { inLanguage } from "@shared/i18n/current";
import { englishOf, said, wordSaid } from "@shared/i18n/said";
import { wordedActivity } from "@shared/i18n/wordedActivity";
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
import { heldSteerText } from "../pi/crewTools";
import type { CrewMachines } from "../placed/crewMachines";
import type { QuotaService } from "../quota/quotaService";
import { type AccountPool, AccountSelector } from "../routing/accountRouter";
import { ModelSlots } from "../routing/modelSlots";
import { Router } from "../routing/router";
import type { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { TaskProtocol } from "../tasks/taskProtocol";
import { TaskTimeline } from "../tasks/taskTimeline";
import type { CrewmateSpec } from "./crewSession";
import type { AccountAttachment } from "./crewSupervisorOptions";

fakeCrewTimersEachTest();

const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
const terra = { provider: "openai-codex", id: "gpt-6.1-terra" };
const luna = { provider: "openai-codex", id: "gpt-6.1-luna" };
const opus = { provider: "anthropic-claude", id: "claude-opus-5-5" };
// Two models on one custom connection.
const served = "fm-custom-0123456789abcdef";
const dawn = { provider: served, id: "dawn-2" };
const dusk = { provider: served, id: "dusk-2" };

type Ref = { provider: string; id: string };

/** The sign-ins the routing reads: one per provider, each serving its listed models. */
function signIns(models: Ref[]) {
  const providers = [...new Set(models.map((model) => model.provider))];
  return providers.map((providerId) => ({
    accountId:
      providerId === "anthropic-claude"
        ? "acct-claude"
        : providerId === "openai-codex"
          ? "acct-codex"
          : "acct-custom",
    accountLabel: "personal",
    providerId,
    models: models.filter((model) => model.provider === providerId),
  }));
}

/**
 * The real routing stack over sign-ins serving `models` (Sol and Terra on
 * one Codex sign-in unless given), seeded from the starter map. The Models
 * board offers `offered` - these and any a computer that runs work serves.
 */
function realRouting(models: Ref[] = [sol, terra], offered: Ref[] = models) {
  let slots: ModelSlots | undefined;
  const make = (db: ReturnType<typeof openInMemoryDatabase>) => {
    const settings = new SettingsStore(db);
    slots = new ModelSlots({
      settings,
      accounts: () => signIns(offered),
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
            provider:
              model.provider === "anthropic-claude"
                ? "claude"
                : model.provider === "openai-codex"
                  ? "codex"
                  : model.provider,
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

/** The timeline lines saying the task waits because no other model can take it. */
function waitNotes(h: Harness, taskId: string): string[] {
  return h.tasks
    .timeline(taskId)
    .filter((entry) => entry.kind === "note" && entry.data && "modelWait" in entry.data)
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
function pausedAccounts(accountId: string | undefined, whilePicking: () => void) {
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
      return { ...(accountId ? { accountId } : {}), record: recorded, selected: () => {} };
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
    timeline: new TaskTimeline({ tasks: h.tasks }),
  }).detail(taskId);
  const fact = said("crewmateRoutedAgain", {
    left: h.router?.modelLabel(sol) ?? "",
    model: h.router?.modelLabel(terra) ?? "",
  });
  const row = record.activityLog.find((line) => line.said);
  expect(row).toMatchObject({ text: englishOf(fact), said: fact });
  // A window in German shows the line in German, both as the Activity row and
  // as the timeline reading of its event, which the record draws in its place.
  const german = inLanguage("de", () => wordSaid(fact));
  expect(german).not.toBe(englishOf(fact));
  const shown = inLanguage("de", () => wordedActivity(record));
  expect(shown.activityLog.find((line) => line.id === row?.id)?.text).toBe(german);
  const reading = shown.timeline?.find(
    (entry) =>
      entry.entry.content.ref.source === "task-event" &&
      entry.entry.content.ref.eventId === row?.id,
  );
  expect(reading?.entry.summary).toBe(german);
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

it("takes the replacement routing picks now when the first leaves its level while the account is picked", async () => {
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
  const reopening = relaunchAndSteer(h, taskId, luna, paused.accounts);
  await tick();
  paused.release();
  const reopened = await reopening;

  expect(reopened?.model).toEqual(luna);
  expect(routedModels(h, taskId)).toEqual([sol.id, luna.id]);
  // Only the pick for the model committed is recorded.
  expect(paused.recorded).toHaveBeenCalledTimes(1);
  expect(reroutedNotes(h, taskId)).toEqual([
    englishOf(
      said("crewmateRoutedAgain", {
        left: h.router?.modelLabel(sol) ?? "",
        model: h.router?.modelLabel(luna) ?? "",
      }),
    ),
  ]);
});

it("opens nothing and records no pick when the task stops while a pick that finds no account waits", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();

  const paused = pausedAccounts(undefined, () => {
    h.tasks.close(taskId, { status: "dropped", reason: "cancelled", actor: "captain" });
  });
  const reopening = relaunchAndSteer(h, taskId, terra, paused.accounts);
  await tick();
  paused.release();

  expect(await reopening).toBeUndefined();
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(paused.recorded).not.toHaveBeenCalled();
  expect(waitNotes(h, taskId)).toEqual([]);
});

it("waits and says so once when no other model can take the task, and its lane holds meanwhile", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();

  // No account serves Terra: nothing on the levels can take the task.
  const noAccount = pausedAccounts(undefined, () => {});
  noAccount.release();
  const specs: CrewmateSpec[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => fakeCrewmate({ model: terra })),
    { specs, router: h.router as unknown as Router, accounts: noAccount.accounts },
  );
  expect(await relaunched.steer.steerCrewmate(taskId, "carry on")).toBe("recorded-retrying");
  await tick();
  expect(specs).toEqual([]);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  const words = englishOf(said("crewmateWaitsForModel", { left: h.router?.modelLabel(sol) ?? "" }));
  expect(waitNotes(h, taskId)).toEqual([words]);
  // While nothing changed, the lane holds: the next message is kept, not tried.
  expect(await relaunched.steer.steerCrewmate(taskId, "and the logs")).toBe("recorded-held");
  // The first mate hears the hold and its way out.
  expect(heldSteerText(taskId, relaunched.facts.laneHold(taskId))).toContain(
    softHoldWords("model-levels", "firstmate"),
  );
  await relaunched.disposeAll();

  // The next launch's inbox sweep meets the same wait: the messages go back
  // undelivered, their delivery attempts unspent.
  const swept = reboot(
    h,
    vi.fn(async () => fakeCrewmate({ model: terra })),
    { specs, router: h.router as unknown as Router, accounts: noAccount.accounts },
  );
  await swept.watch.sweepInbox(Date.now() + 60_000);
  await tick();
  expect(specs).toEqual([]);
  expect(
    h.db
      .prepare("SELECT attempts, delivered_at FROM inbox WHERE recipient = ? ORDER BY id")
      .all(taskId),
  ).toEqual([
    { attempts: 0, delivered_at: null },
    { attempts: 0, delivered_at: null },
  ]);
  await swept.disposeAll();

  // The next launch tries once more and finds the same: it says nothing new.
  expect(await relaunchAndSteer(h, taskId, terra, noAccount.accounts)).toBeUndefined();
  expect(waitNotes(h, taskId)).toEqual([words]);
});

it("keeps the latest model the captain named by a move, whatever the levels hold", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const moved = fakeCrewmate({ model: terra, sessionId: "s2" });
  const h = setup(crewmate, { realRouter: routing.make, crewmates: [moved] });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.moves.runMove(taskId, { by: "captain", model: offeringKey(terra) });
  await vi.waitFor(() => expect(h.specs.at(-1)?.model).toEqual(terra));
  await h.supervisor.disposeAll();

  routing.takeOffEveryLevel(terra);

  const reopened = await relaunchAndSteer(h, taskId);
  expect(reopened?.model).toEqual(terra);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
});

it("routes again when the defaults standing in for levels leave the model out", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: luna });
  const h = setup(crewmate, { realRouter: routing.make });
  // The person places Luna at high in Sol's place, and the task starts on Luna.
  routing.takeOffEveryLevel(sol);
  routing.placeHigh(luna);
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  expect(h.specs[0]?.model).toEqual(luna);
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();

  // Every level emptied: the starter map's Sol and Terra stand in, without Luna.
  routing.takeOffEveryLevel(luna);
  routing.takeOffEveryLevel(terra);

  const reopened = await relaunchAndSteer(h, taskId, sol);
  expect(reopened?.model).toEqual(sol);
  expect(routedModels(h, taskId)).toEqual([luna.id, sol.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
});

it("routes a task on a computer that runs work among that computer's own models and account", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  // Terra and Luna both take high here; only Luna is signed in there.
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  const machines = {
    served: async () => ({
      available: [luna],
      catalog: [{ provider: "codex", id: luna.id, label: luna.id, effectivePercentRemaining: 80 }],
      note: "the computer's own sign-ins",
      accounts: new Map([["openai-codex", "there-codex"]]),
      modelAccounts: new Map(),
    }),
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });

  const routed = await relaunched.reopenModel(taskId, "mini", false);
  expect(routed).toMatchObject({ model: luna, accountId: "there-codex" });
  // Nothing is recorded until that computer answers a conversation opened on Luna.
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(0);
  expect(
    typeof routed === "object" && (await routed.commit({ model: luna, account: "there-codex" })),
  ).toBe("committed");
  expect(routedModels(h, taskId)).toEqual([sol.id, luna.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
  // Luna holds a level: the next reopen there keeps it.
  expect(await relaunched.reopenModel(taskId, "mini", false)).toBeUndefined();
  await relaunched.disposeAll();
});

it("routes a custom connection's task only among that connection's models, on its account", async () => {
  const routing = realRouting([sol, terra, dawn, dusk]);
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async (_task: string, provider: string) =>
      provider === served ? "acct-custom" : "acct-codex",
    ),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
  };
  const crewmate = fakeCrewmate({ model: dawn });
  const h = setup(crewmate, { realRouter: routing.make, accounts });
  // The person places Dawn at high in Sol's place, and the task starts there.
  routing.takeOffEveryLevel(sol);
  routing.placeHigh(dawn);
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  expect(h.specs[0]?.model).toEqual(dawn);
  expect(h.tasks.get(taskId)?.accountId).toBe("acct-custom");
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();

  // Dawn leaves every level; Sol and Dusk take high.
  routing.takeOffEveryLevel(dawn);
  routing.placeHigh(sol);
  routing.placeHigh(dusk);

  const reopened = await relaunchAndSteer(h, taskId, dusk, accounts);
  expect(reopened?.model).toEqual(dusk);
  expect(routedModels(h, taskId)).toEqual([dawn.id, dusk.id]);
  expect(h.tasks.get(taskId)?.accountId).toBe("acct-custom");
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
});

it("waits on a computer that runs work when none of its sign-ins serves a model", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel();
  // That computer answers its sign-ins: none serves any model.
  const machines = {
    served: async () => ({
      available: [],
      catalog: [],
      note: "the computer's own sign-ins",
      accounts: new Map(),
      modelAccounts: new Map(),
    }),
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });

  expect(await relaunched.reopenModel(taskId, "mini", false)).toBe("wait");
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(waitNotes(h, taskId)).toHaveLength(1);
  await relaunched.disposeAll();
});

it("keeps the context-limit restart through a wait for a model, then opens it fresh", async () => {
  const routing = realRouting();
  // Sol has an account here; Terra has one only once `terraSignedIn`.
  let terraSignedIn = false;
  const accountFor = (crew?: { model?: string }) =>
    crew?.model === terra.id && !terraSignedIn ? undefined : "acct-codex";
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async (_task: string, _provider: string, crew?: { model?: string }) =>
      accountFor(crew),
    ),
    pickForSpawn: vi.fn(async (_task: string, _provider: string, crew?: { model?: string }) => {
      const accountId = accountFor(crew);
      return { ...(accountId ? { accountId } : {}), record: () => {}, selected: () => {} };
    }),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
  };
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make, accounts });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));

  // While the task runs, Sol leaves every level, and Terra has no account.
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
  await tick();
  // The restart meets the wait: nothing opens, and it says so once.
  expect(h.sessionSpecs).toHaveLength(1);
  expect(waitNotes(h, taskId)).toHaveLength(1);
  await h.supervisor.disposeAll();

  // A later launch where Terra is signed in opens the kept restart fresh on Terra.
  terraSignedIn = true;
  const opened = await relaunchAndSteer(h, taskId, terra, accounts);
  expect(opened?.model).toEqual(terra);
  // A new conversation, not the one the context limit filled.
  expect(opened?.resumeToken).toBeUndefined();
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
});

it("waits rather than let the starter map stand in when the only model on the levels has no account", async () => {
  const routing = realRouting([sol, terra, luna, opus]);
  // Every model has an account here but Opus.
  const accountFor = (provider: string) => (provider === opus.provider ? undefined : "acct-codex");
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async (_task: string, provider: string) => accountFor(provider)),
    pickForSpawn: vi.fn(async (_task: string, provider: string) => {
      const accountId = accountFor(provider);
      return { ...(accountId ? { accountId } : {}), record: () => {}, selected: () => {} };
    }),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
  };
  const crewmate = fakeCrewmate({ model: luna });
  const h = setup(crewmate, { realRouter: routing.make, accounts });
  // The person places Luna at high in Sol's place, and the task starts on Luna.
  routing.takeOffEveryLevel(sol);
  routing.takeOffEveryLevel(terra);
  routing.placeHigh(luna);
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  expect(h.specs[0]?.model).toEqual(luna);
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();

  // Luna leaves every level, and Opus, with no account here, takes high alone.
  routing.takeOffEveryLevel(luna);
  routing.placeHigh(opus);

  // Passing over Opus leaves no level model: the starter map's Sol does not stand in.
  expect(await relaunchAndSteer(h, taskId, sol, accounts)).toBeUndefined();
  expect(routedModels(h, taskId)).toEqual([luna.id]);
  expect(waitNotes(h, taskId)).toHaveLength(1);
});

// INF-5438 finding 3 and 4: a context-limit restart that waited for a model
// opens fresh by itself once an account can serve one - with no new message
// and no relaunch - its brief served on its first turn.
it("opens a restart that waited for a model once an account serves one, with no message or relaunch", async () => {
  const routing = realRouting();
  let terraSignedIn = false;
  const accountFor = (crew?: { model?: string }) =>
    crew?.model === terra.id && !terraSignedIn ? undefined : "acct-codex";
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async (_task: string, _provider: string, crew?: { model?: string }) =>
      accountFor(crew),
    ),
    pickForSpawn: vi.fn(async (_task: string, _provider: string, crew?: { model?: string }) => {
      const accountId = accountFor(crew);
      return { ...(accountId ? { accountId } : {}), record: () => {}, selected: () => {} };
    }),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
    // What a pick reads of the accounts: Terra's sign-in is part of it.
    servingState: () => `terra:${terraSignedIn}`,
  };
  const crewmate = fakeCrewmate({ model: sol });
  const fresh = fakeCrewmate({ model: terra, sessionId: "s2" });
  const h = setup(crewmate, { realRouter: routing.make, accounts, crewmates: [fresh] });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
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
  await tick();
  expect(h.sessionSpecs).toHaveLength(1);
  expect(waitNotes(h, taskId)).toHaveLength(1);

  // Terra's sign-in arrives; the lane's next sweep opens the restart fresh.
  terraSignedIn = true;
  await h.supervisor.watch.sweepInbox(Date.now() + 60_000);
  await vi.waitFor(() => expect(h.sessionSpecs).toHaveLength(2));
  expect(h.sessionSpecs[1]?.model).toEqual(terra);
  // A new conversation, not the one that ran out of room.
  const reopened = h.sessionSpecs[1]?.shape;
  expect(reopened?.turns === "rolling" && reopened.record.resume).toBeUndefined();
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  await vi.waitFor(() => expect(fresh.promptCalls).toHaveLength(1));
  expect(fresh.promptCalls[0]).toContain("read every log part and report");
  // Delivered once.
  await tick();
  expect(fresh.promptCalls).toHaveLength(1);
  await h.supervisor.disposeAll();
});

// INF-5438 finding 4: a wait on a computer that runs work ends when a model
// only that computer serves takes a level, though nothing here changed.
it("stops waiting on a computer that runs work once a model only it serves takes a level", async () => {
  // The board offers Luna, which only that computer's sign-in serves.
  const routing = realRouting([sol, terra], [sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel();
  // That computer lists Sol, Terra and Luna, but its account serves only
  // Luna, which the person took off every level.
  routing.takeOffEveryLevel(luna);
  const machines = {
    served: async () => ({
      available: [sol, terra, luna],
      catalog: [],
      note: "the computer's own sign-ins",
      accounts: new Map(),
      modelAccounts: new Map([[offeringKey(luna), "acct-there"]]),
    }),
    servedState: () => "luna",
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });
  expect(await relaunched.reopenModel(taskId, "mini", false)).toBe("wait");
  expect(relaunched.moves.waitsForModel(taskId)).toBe(true);

  routing.placeHigh(luna);
  expect(relaunched.moves.waitsForModel(taskId)).toBe(false);
  await relaunched.disposeAll();
});

// INF-5438 finding 6: on this Mac a replacement routes only to an account
// that lists it, so the conversation opens on the model it announces.
it("waits rather than announce a model the account picked does not list", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  // The Codex account is picked for Terra but lists only Sol.
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async () => "acct-codex"),
    pickForSpawn: vi.fn(async () => ({
      accountId: "acct-codex",
      record: () => {},
      selected: () => {},
    })),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
    serves: (_accountId, model) => model.id === sol.id,
  };
  expect(await relaunchAndSteer(h, taskId, terra, accounts)).toBeUndefined();
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
  expect(waitNotes(h, taskId)).toHaveLength(1);
});

// INF-5438 finding 6: the move is recorded only once the conversation opened
// on the model routing chose; one that opened on another records nothing.
it("records no move when the conversation opens on another model than routing chose", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  // The runtime could not resolve Terra and opened on Sol.
  const asked = await relaunchAndSteer(h, taskId, sol);
  expect(asked?.model).toEqual(terra);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
});

// INF-5438 round 6 finding 1: a conversation created on another model than
// routing chose takes no words - the steer stays undelivered for the next
// open - and the task waits, saying so once.
it("sends no words to a conversation created on another model than routing chose, and waits", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  const specs: CrewmateSpec[] = [];
  // The runtime could not resolve Terra and created the conversation on Sol.
  const wrong = fakeCrewmate({ model: sol });
  const relaunched = reboot(
    h,
    vi.fn(async () => wrong),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs[0]?.model).toEqual(terra);
  expect(wrong.promptCalls).toEqual([]);
  // The words wait in the task's inbox for a conversation that can take them.
  expect(h.inbox.allFor(taskId).map((row) => JSON.stringify(row))).toEqual([
    expect.stringContaining("carry on"),
  ]);
  expect(relaunched.moves.waitsForModel(taskId)).toBe(true);
  expect(waitNotes(h, taskId)).toHaveLength(1);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  await relaunched.disposeAll();
});

// INF-5438 round 6 finding 3: routing that changes while the conversation
// opens discards the obsolete pick - a model back on a level is kept, and a
// replacement that left takes the current choice - and the conversation
// opened on the obsolete pick takes no words.
it("takes routing's current choice when the levels change while the conversation opens", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  const specs: CrewmateSpec[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => {
      const model = specs.at(-1)?.model ?? sol;
      // While Terra opens, the person takes it off every level and places Luna.
      if (opened.length === 0) {
        routing.takeOffEveryLevel(terra);
        routing.placeHigh(luna);
      }
      const session = fakeCrewmate({ model });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs.map((spec) => spec.model)).toEqual([terra, luna]);
  expect(opened[0]?.promptCalls).toEqual([]);
  expect(opened[1]?.promptCalls).toEqual(["carry on"]);
  expect(routedModels(h, taskId)).toEqual([sol.id, luna.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
  await relaunched.disposeAll();
});

it("keeps the routed model when it is back on a level by the time the conversation opens", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  const specs: CrewmateSpec[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => {
      // While Terra opens, the person puts Sol back on high.
      if (opened.length === 0) routing.placeHigh(sol);
      const session = fakeCrewmate({ model: specs.at(-1)?.model ?? sol });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs.map((spec) => spec.model)).toEqual([terra, sol]);
  expect(opened[0]?.promptCalls).toEqual([]);
  expect(opened[1]?.promptCalls).toEqual(["carry on"]);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
  await relaunched.disposeAll();
});

// INF-5438 round 6 finding 4, round 7 finding 5: the move on a computer that
// runs work records the account that computer answers it bound, only when
// that account serves the model there; a conversation bound to any other
// passes that model over, and the task waits once nothing else can take it.
it("records the account a computer that runs work bound, and passes the model over when it does not serve it", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  const machines = {
    served: async () => ({
      available: [luna],
      catalog: [{ provider: "codex", id: luna.id, label: luna.id, effectivePercentRemaining: 80 }],
      note: "the computer's own sign-ins",
      accounts: new Map([["openai-codex", "there-codex"]]),
      modelAccounts: new Map(),
    }),
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });

  // That computer bound another account, one that does not serve Luna there.
  const first = await relaunched.reopenModel(taskId, "mini", false);
  expect(
    typeof first === "object" && (await first.commit({ model: luna, account: "there-other" })),
  ).toBe("again");
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  // Luna is passed over, and nothing else there can take the task.
  expect(await relaunched.reopenModel(taskId, "mini", false)).toBe("wait");
  expect(waitNotes(h, taskId)).toHaveLength(1);

  // Tried again, it bound the account that serves Luna: that one is recorded.
  const second = await relaunched.reopenModel(taskId, "mini", false);
  expect(
    typeof second === "object" && (await second.commit({ model: luna, account: "there-codex" })),
  ).toBe("committed");
  expect(routedModels(h, taskId)).toEqual([sol.id, luna.id]);
  const row = h.db
    .prepare(
      "SELECT facts_json FROM decisions WHERE kind = 'routing' AND task_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(taskId) as { facts_json: string | null };
  expect(JSON.parse(row.facts_json ?? "{}").accountId).toBe("there-codex");
  await relaunched.disposeAll();
});

// INF-5438 round 6 finding 8: before this Mac's accounts said what they
// serve, an empty pool is not membership - nothing opens and nothing is
// said - and once they have, the task routes again as usual.
it("opens nothing and says nothing while this Mac's accounts have not said what they serve", async () => {
  const models: Ref[] = [sol, terra];
  const routing = realRouting(models);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  // The next launch has not read its accounts yet.
  models.length = 0;
  const specs: CrewmateSpec[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => fakeCrewmate({ model: specs.at(-1)?.model ?? sol })),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs).toEqual([]);
  expect(relaunched.moves.waitsForModel(taskId)).toBe(true);
  expect(waitNotes(h, taskId)).toEqual([]);
  expect(routedModels(h, taskId)).toEqual([sol.id]);

  // The accounts answer: Sol left every level, so the task routes to Terra.
  models.push(sol, terra);
  expect(relaunched.moves.waitsForModel(taskId)).toBe(false);
  await relaunched.disposeAll();
  expect((await relaunchAndSteer(h, taskId))?.model).toEqual(terra);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(waitNotes(h, taskId)).toEqual([]);
});

// INF-5438 round 7 finding 5: a replacement that opened on another model is
// passed over, and the task tries the other models routing would pick before
// it waits; the one that opens on its model takes the words.
it("tries the next model routing picks when a replacement opens on another model", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  // Terra and Luna both take high in Sol's place.
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  const specs: CrewmateSpec[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => {
      // The first replacement's runtime could not resolve it and opened on Sol.
      const session = fakeCrewmate({
        model: opened.length === 0 ? sol : (specs.at(-1)?.model ?? sol),
      });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  const [first, second] = specs.map((spec) => spec.model?.id);
  expect(specs).toHaveLength(2);
  expect([first, second].sort()).toEqual([luna.id, terra.id].sort());
  expect(opened[0]?.promptCalls).toEqual([]);
  expect(opened[1]?.promptCalls).toEqual(["carry on"]);
  expect(routedModels(h, taskId)).toEqual([sol.id, second]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
  expect(waitNotes(h, taskId)).toEqual([]);
  await relaunched.disposeAll();
});

// INF-5438 round 7 finding 2: the account picked here is read again once the
// conversation opened; one that no longer serves the model takes no words.
it("sends no words to a replacement whose account stopped serving it while it opened", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  let servesTerra = true;
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async () => "acct-codex"),
    pickForSpawn: vi.fn(async () => ({
      accountId: "acct-codex",
      record: () => {},
      selected: () => {},
    })),
    reselectForResume: vi.fn(async (_taskId: string, held: string | null) => ({
      ...(held ? { accountId: held } : {}),
      changed: false,
    })),
    labelOf: () => "personal",
    serves: (_accountId, model) => model.id === sol.id || servesTerra,
  };
  const specs: CrewmateSpec[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => {
      // While Terra opens, its account signs out of it.
      servesTerra = false;
      const session = fakeCrewmate({ model: specs.at(-1)?.model ?? sol });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router, accounts },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs.map((spec) => spec.model)).toEqual([terra]);
  expect(opened[0]?.promptCalls).toEqual([]);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(relaunched.moves.waitsForModel(taskId)).toBe(true);
  expect(waitNotes(h, taskId)).toHaveLength(1);
  await relaunched.disposeAll();
});

// INF-5438 round 7 findings 3 and 4: a conversation opened anew on the model
// the task kept takes no words when that model left every level while it
// opened, and writes nothing of its own - no renewal line or restart - before
// the task routes again and the replacement takes the words.
it("routes again when the kept model leaves every level while its conversation opens, writing nothing for the one let go", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  const specs: CrewmateSpec[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => {
      // While Sol reopens - renewing its instructions as it opens - the
      // person takes it off every level and places Terra.
      const first = opened.length === 0;
      if (first) routing.takeSolOffEveryLevel();
      const session = fakeCrewmate({
        model: specs.at(-1)?.model ?? sol,
        ...(first ? { renewal: { from: "s0", changed: ["instructions"] as const } } : {}),
      });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs.map((spec) => spec.model)).toEqual([sol, terra]);
  expect(opened[0]?.promptCalls).toEqual([]);
  expect(opened[1]?.promptCalls).toEqual(["carry on"]);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(
    h.tasks.timeline(taskId).filter((entry) => entry.data && "conversation" in entry.data),
  ).toEqual([]);
  await relaunched.disposeAll();
});

// INF-5438 round 7 finding 1: on a computer that runs work, the move commits
// only for an account that computer bound and that lists the model there -
// not its provider's pinned account that does not, and not none.
it("commits a move on a computer that runs work only for an account there that lists the model", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  // Its pinned Codex account lists no Luna; another lists it.
  const machines = {
    served: async () => ({
      available: [luna],
      catalog: [{ provider: "codex", id: luna.id, label: luna.id, effectivePercentRemaining: 80 }],
      note: "the computer's own sign-ins",
      accounts: new Map([["openai-codex", "there-pinned"]]),
      modelAccounts: new Map([[offeringKey(luna), "there-luna"]]),
      servedBy: new Map([[offeringKey(luna), new Set(["there-luna"])]]),
    }),
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });
  const commitOn = async (account?: string) => {
    const routed = await relaunched.reopenModel(taskId, "mini", false);
    if (typeof routed !== "object") throw new Error(`no route: ${routed}`);
    expect(routed.accountId).toBe("there-luna");
    return routed.commit({ model: luna, ...(account ? { account } : {}) });
  };

  // It bound none of its accounts (its own Claude login, say): nothing is recorded.
  expect(await commitOn()).toBe("again");
  expect(await relaunched.reopenModel(taskId, "mini", false)).toBe("wait");
  // It bound its pinned account, which does not list Luna: nothing is recorded.
  expect(await commitOn("there-pinned")).toBe("again");
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(await relaunched.reopenModel(taskId, "mini", false)).toBe("wait");
  // It bound the account that lists Luna.
  expect(await commitOn("there-luna")).toBe("committed");
  expect(routedModels(h, taskId)).toEqual([sol.id, luna.id]);
  await relaunched.disposeAll();
});

// INF-5438 round 7 finding 2: what that computer serves is read again once
// the conversation opened there; an account that stopped listing the model
// meanwhile records nothing.
it("reads again what a computer that runs work serves before it commits a move there", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  let listsLuna = true;
  const machines = {
    served: async () => ({
      available: [luna],
      catalog: [{ provider: "codex", id: luna.id, label: luna.id, effectivePercentRemaining: 80 }],
      note: "the computer's own sign-ins",
      accounts: new Map([["openai-codex", "there-codex"]]),
      modelAccounts: new Map(listsLuna ? [[offeringKey(luna), "there-codex"]] : []),
      servedBy: new Map(listsLuna ? [[offeringKey(luna), new Set(["there-codex"])]] : []),
    }),
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });
  const routed = await relaunched.reopenModel(taskId, "mini", false);
  if (typeof routed !== "object") throw new Error(`no route: ${routed}`);
  // While the conversation opened there, that account stopped listing Luna.
  listsLuna = false;
  expect(await routed.commit({ model: luna, account: "there-codex" })).toBe("again");
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
  await relaunched.disposeAll();
});

// INF-5438 round 7 finding 9: an older computer holding the task's
// conversation open waits because only its update lets the task move, even
// when another model there can take it; it says that reason once, and the
// wait ends when that computer no longer holds the conversation.
it("tells why an older computer holding the conversation open waits, and stops waiting once it holds none", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  let held = true;
  const machines = {
    served: async () => ({
      available: [luna],
      catalog: [{ provider: "codex", id: luna.id, label: luna.id, effectivePercentRemaining: 80 }],
      note: "the computer's own sign-ins",
      accounts: new Map([["openai-codex", "there-codex"]]),
      modelAccounts: new Map([[offeringKey(luna), "there-codex"]]),
    }),
    servedState: () => "luna",
    nameOf: () => "Mac mini",
    conversationOpen: () => held,
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });

  expect(await relaunched.reopenModel(taskId, "mini", true)).toBe("wait");
  expect(await relaunched.reopenModel(taskId, "mini", true)).toBe("wait");
  const update = englishOf(
    said("crewmateWaitsForUpdate", {
      left: h.router?.modelLabel(sol) ?? "",
      computer: "Mac mini",
    }),
  );
  expect(waitNotes(h, taskId)).toEqual([update]);
  expect(relaunched.moves.modelWaitWords(taskId)).toBe(update);
  expect(relaunched.moves.waitsForModel(taskId)).toBe(true);
  // That computer restarted and holds the conversation no more.
  held = false;
  expect(relaunched.moves.waitsForModel(taskId)).toBe(false);
  expect(await relaunched.reopenModel(taskId, "mini", false)).toMatchObject({ model: luna });
  await relaunched.disposeAll();
});

// INF-5438 round 8 finding 3: a conversation created anew for a model the
// task names, which comes back on another model, takes no words and moves
// nothing.
it("sends no words to a conversation created for a named model that opens on another", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project on sol"),
    shape: { override_model_id: offeringKey(sol) },
  });
  await tick();
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();
  routing.takeSolOffEveryLevel();
  const specs: CrewmateSpec[] = [];
  // The runtime could not resolve Sol and created the conversation on Terra.
  const wrong = fakeCrewmate({ model: terra });
  const relaunched = reboot(
    h,
    vi.fn(async () => wrong),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs[0]?.model).toEqual(sol);
  expect(wrong.promptCalls).toEqual([]);
  expect(routedModels(h, taskId)).toEqual([sol.id]);
  expect(reroutedNotes(h, taskId)).toEqual([]);
  expect(h.tasks.get(taskId)?.model).toBe(offeringKey(sol));
  await relaunched.disposeAll();
});

// INF-5438 round 9 finding 3: a conversation created for a named model that
// says no model at all is not taken as the one asked, and takes no words.
it("sends no words to a conversation created for a named model that says no model", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project on sol"),
    shape: { override_model_id: offeringKey(sol) },
  });
  await tick();
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.disposeAll();
  const specs: CrewmateSpec[] = [];
  const unsaid = fakeCrewmate({ model: undefined });
  expect(unsaid.modelRef()).toBeUndefined();
  const relaunched = reboot(
    h,
    vi.fn(async () => unsaid),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs[0]?.model).toEqual(sol);
  expect(unsaid.promptCalls).toEqual([]);
  await relaunched.disposeAll();
});

// INF-5438 round 8 finding 6: a replacement whose conversation could not be
// created there passes that model over, unspent, and the next model routing
// picks takes the words once.
it("opens the next model routing picks when a replacement's conversation cannot be created", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  routing.placeHigh(luna);
  const specs: CrewmateSpec[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async () => {
      const model = specs.at(-1)?.model ?? sol;
      if (specs.length === 1) throw new Error(`Unknown model ${model.provider}/${model.id}`);
      const session = fakeCrewmate({ model });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  const [first, second] = specs.map((spec) => spec.model?.id);
  expect(specs).toHaveLength(2);
  expect([first, second].sort()).toEqual([luna.id, terra.id].sort());
  expect(opened.map((session) => session.promptCalls)).toEqual([["carry on"]]);
  expect(routedModels(h, taskId)).toEqual([sol.id, second]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
  await relaunched.disposeAll();
});

// INF-5438 round 9 finding 5: a replacement whose conversation cannot be
// created on one account here is tried on a sibling account on the same model.
it("tries a sibling account on the same model when a replacement cannot open on the first", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  routing.takeSolOffEveryLevel();
  const pool: AccountPool = {
    list: (providerId) =>
      [
        { id: "acct-codex", providerId: "openai-codex", label: "personal", enabled: true },
        { id: "acct-codex-work", providerId: "openai-codex", label: "work", enabled: true },
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
  const specs: CrewmateSpec[] = [];
  const tried: (string | undefined)[] = [];
  const opened: ReturnType<typeof fakeCrewmate>[] = [];
  const relaunched = reboot(
    h,
    vi.fn(async (spec) => {
      tried.push(spec.binding.accountId);
      if (tried.length === 1) throw new Error("This account cannot open that model.");
      const session = fakeCrewmate({ model: terra });
      opened.push(session);
      return session;
    }),
    { specs, router: h.router as unknown as Router, accounts },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(specs.map((spec) => spec.model?.id)).toEqual([terra.id, terra.id]);
  expect(tried).toHaveLength(2);
  expect(new Set(tried)).toEqual(new Set(["acct-codex", "acct-codex-work"]));
  expect(opened.map((session) => session.promptCalls)).toEqual([["carry on"]]);
  expect(h.tasks.get(taskId)?.accountId).toBe(tried[1]);
  expect(routedModels(h, taskId)).toEqual([sol.id, terra.id]);
  expect(reroutedNotes(h, taskId)).toHaveLength(1);
  await relaunched.disposeAll();
});

// INF-5438 round 8 finding 11: the sibling account a resume would move to is
// written and said only once its conversation is accepted.
it("writes and says no account change for a reopen whose conversation is refused", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  const before = h.tasks.get(taskId)?.accountId ?? null;
  const record = vi.fn();
  const selected = vi.fn();
  const accounts: AccountAttachment = {
    selectForSpawn: vi.fn(async () => "acct-codex"),
    pickForSpawn: vi.fn(async () => ({
      accountId: "acct-codex",
      record: () => {},
      selected: () => {},
    })),
    reselectForResume: vi.fn(async () => ({
      accountId: "acct-codex-sibling",
      changed: true,
      record,
      selected,
    })),
    labelOf: () => "work",
  };
  const specs: CrewmateSpec[] = [];
  // Sol is still on its level and kept; the conversation came back on Terra.
  const wrong = fakeCrewmate({ model: terra });
  const relaunched = reboot(
    h,
    vi.fn(async () => wrong),
    {
      specs,
      router: h.router as unknown as Router,
      accounts,
      broadcastEvent: (event) => h.events.push(event),
    },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  const notes = h.events.flatMap((event) =>
    event.type === "firstmate_note" && event.taskId === taskId ? [event.text] : [],
  );
  expect(specs[0]?.model).toEqual(sol);
  expect(wrong.promptCalls).toEqual([]);
  expect(accounts.reselectForResume).toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();
  expect(h.tasks.get(taskId)?.accountId ?? null).toBe(before);
  expect(notes.filter((note) => note.includes("previous account"))).toEqual([]);
  await relaunched.disposeAll();
});

// INF-5438 round 8 finding 12: an order held for a model says why it waits.
it("says why an order waits for a model, for each reason it waits", () => {
  expect(heldSteerText("INF-1", { kind: "model", cause: "unread" })).toContain(
    "have not said yet which models they serve",
  );
  expect(heldSteerText("INF-1", { kind: "model", cause: "update" })).toContain("must be updated");
  const none = heldSteerText("INF-1", { kind: "model", cause: "none" });
  expect(none).toContain("no other model there can take it");
  expect(none).not.toContain("updated");
});

// INF-5438 round 10 finding 2: a context restart whose new conversation is
// not accepted (it came back on another model) keeps the restart on the
// lane, so the next open starts fresh instead of resuming the conversation
// the context limit filled.
it("keeps a context-limit restart whose new conversation was not accepted, and opens it fresh next", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  // Sol is still held, but the restart's conversation comes back on Luna.
  const drifted = fakeCrewmate({ model: luna, sessionId: "s2" });
  const h = setup(crewmate, { realRouter: routing.make, crewmates: [drifted] });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  crewmate.emit({
    type: "turn_failed",
    taskId,
    error: "This request exceeds the context window. Shorten it before trying again.",
    contextOverflow: true,
  });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
  await tick();
  expect(h.sessionSpecs).toHaveLength(2);
  expect(drifted.promptCalls).toEqual([]);
  expect(
    h.tasks.timeline(taskId).some((entry) => entry.text?.includes("could not open") === true),
  ).toBe(false);
  await h.supervisor.disposeAll();

  const opened = await relaunchAndSteer(h, taskId, sol);
  expect(opened?.model).toEqual(sol);
  // A new conversation, not the one the context limit filled.
  expect(opened?.resumeToken).toBeUndefined();
});

// INF-5438 round 11 finding 3: a context restart is kept on its lane before
// its new conversation is asked for, so one whose open fails outright on the
// model it keeps still opens fresh next, never resuming the conversation the
// context limit filled.
it("keeps a context-limit restart whose new conversation failed to open, and opens it fresh next", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  const open = h.sessions.open as unknown as ReturnType<typeof vi.fn>;
  open.mockImplementationOnce(async () => {
    throw new Error("This model is not served here right now.");
  });
  crewmate.emit({
    type: "turn_failed",
    taskId,
    error: "This request exceeds the context window. Shorten it before trying again.",
    contextOverflow: true,
  });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
  await tick();
  expect(
    h.tasks.timeline(taskId).some((entry) => entry.text?.includes("could not open") === true),
  ).toBe(true);
  await h.supervisor.disposeAll();

  // The next launch's sweep meets the same failure: the restart goes back
  // with its delivery attempt unspent, so unattended recovery keeps it.
  const failing = reboot(
    h,
    vi.fn(async () => {
      throw new Error("This model is not served here right now.");
    }),
    { router: h.router as unknown as Router },
  );
  await failing.watch.sweepInbox(Date.now() + 60_000);
  await tick();
  expect(
    h.db
      .prepare("SELECT attempts, delivered_at FROM inbox WHERE recipient = ? ORDER BY id")
      .all(taskId),
  ).toEqual([{ attempts: 0, delivered_at: null }]);
  await failing.disposeAll();

  const opened = await relaunchAndSteer(h, taskId, sol);
  expect(opened?.model).toEqual(sol);
  // A new conversation, not the one the context limit filled.
  expect(opened?.resumeToken).toBeUndefined();
});

// INF-5438 round 10 finding 6: a move the captain named opens on its model
// or takes no words; the next words go to a conversation on that model.
it("sends no words to a moved task's conversation that opened on another model than the move named", async () => {
  const routing = realRouting();
  const crewmate = fakeCrewmate({ model: sol });
  const drifted = fakeCrewmate({ model: luna, sessionId: "s2" });
  const moved = fakeCrewmate({ model: terra, sessionId: "s3" });
  const h = setup(crewmate, { realRouter: routing.make, crewmates: [drifted, moved] });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Read the project",
    intent: intentOf("read the project and report"),
  });
  await tick();
  crewmate.finishPrompt();
  await tick();
  await h.supervisor.moves.runMove(taskId, { by: "captain", model: offeringKey(terra) });
  await tick();
  await h.supervisor.steer.steerCrewmate(taskId, "carry on").catch(() => undefined);
  await tick();
  expect(drifted.promptCalls).toEqual([]);
  expect(moved.promptCalls).toEqual(["carry on"]);
  expect(h.specs.slice(1).map((spec) => spec.model)).toEqual([terra, terra]);
  await h.supervisor.disposeAll();
});

// INF-5438 round 10 findings 1 and 9: on a computer that runs work, a model
// two accounts there list is bound to the one with allowance left, never its
// pinned account whose allowance is spent; and an account that opened it on
// another model is passed over for its sibling on the same model.
it("binds a replacement there to an account with allowance left, and tries its sibling after a wrong open", async () => {
  const routing = realRouting([sol, terra, luna]);
  const crewmate = fakeCrewmate({ model: sol });
  const h = setup(crewmate, { realRouter: routing.make });
  const taskId = await startedOnSol(h, crewmate);
  h.tasks.placement.setDevice(taskId, "mini");
  routing.takeSolOffEveryLevel(luna);
  const reading = (accountId: string, percentRemaining: number) => ({
    provider: "codex",
    label: "Codex",
    accountId,
    status: "ok" as const,
    stale: false,
    windows: [{ id: "five_hour", label: "5h", percentRemaining }],
  });
  let pinnedLeft = 0;
  const machines = {
    served: async () => ({
      available: [luna],
      catalog: [{ provider: "codex", id: luna.id, label: luna.id, effectivePercentRemaining: 80 }],
      note: "the computer's own sign-ins",
      readings: [reading("there-pinned", pinnedLeft), reading("there-funded", 60)],
      accounts: new Map([["openai-codex", "there-pinned"]]),
      modelAccounts: new Map([[offeringKey(luna), "there-pinned"]]),
      servedBy: new Map([[offeringKey(luna), new Set(["there-pinned", "there-funded"])]]),
    }),
  } as unknown as CrewMachines;
  const relaunched = reboot(h, vi.fn(), { router: h.router as unknown as Router, machines });
  const route = async () => {
    const routed = await relaunched.reopenModel(taskId, "mini", false);
    if (typeof routed !== "object") throw new Error(`no route: ${routed}`);
    return routed;
  };
  // The pinned account's allowance there is spent: the funded sibling.
  expect((await route()).accountId).toBe("there-funded");

  // Both have allowance; the pinned one opens it on Sol: its sibling next.
  pinnedLeft = 70;
  const first = await route();
  expect(first.accountId).toBe("there-pinned");
  expect(await first.commit({ model: sol, account: "there-pinned" })).toBe("again");
  const next = await route();
  expect(next.accountId).toBe("there-funded");
  expect(await next.commit({ model: luna, account: "there-funded" })).toBe("committed");
  expect(routedModels(h, taskId)).toEqual([sol.id, luna.id]);
  await relaunched.disposeAll();
});
