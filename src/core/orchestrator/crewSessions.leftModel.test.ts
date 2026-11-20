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
import { ModelSlots } from "../routing/modelSlots";
import { Router } from "../routing/router";
import type { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import type { CrewmateSpec } from "./crewSession";

fakeCrewTimersEachTest();

const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
const terra = { provider: "openai-codex", id: "gpt-6.1-terra" };

/** The real routing stack over one Codex sign-in serving Sol and Terra, seeded from the starter map. */
function realRouting() {
  let slots: ModelSlots | undefined;
  const make = (db: ReturnType<typeof openInMemoryDatabase>) => {
    const settings = new SettingsStore(db);
    slots = new ModelSlots({
      settings,
      accounts: () => [
        {
          accountId: "acct-codex",
          accountLabel: "personal",
          providerId: "openai-codex",
          models: [sol, terra],
        },
      ],
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
          models: [sol, terra].map((model) => ({
            provider: "codex",
            id: model.id,
            label: model.id,
            effectivePercentRemaining: 80,
          })),
        }),
        latest: () => undefined,
      } as unknown as QuotaService,
      availableModels: () => [sol, terra],
      slots,
    });
  };
  /** Settings → Intelligence → Models: Sol leaves every level, Terra takes high. */
  const takeSolOffEveryLevel = () => {
    if (!slots) throw new Error("routing not built yet");
    for (const slot of SLOTS) slots.setSlotMembership(offeringKey(sol), slot, false);
    slots.setSlotMembership(offeringKey(terra), "high", true);
    expect(slots.slotsOf(sol)).toEqual([]);
  };
  return { make, takeSolOffEveryLevel };
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

/** Relaunch the app and steer the task, so it reopens; answers what the reopen asked for. */
async function relaunchAndSteer(h: Harness, taskId: string): Promise<CrewmateSpec | undefined> {
  const specs: CrewmateSpec[] = [];
  const boot = fakeCrewmate({ model: terra });
  const relaunched = reboot(
    h,
    vi.fn(async () => boot),
    { specs, router: h.router as unknown as Router },
  );
  await relaunched.steer.steerCrewmate(taskId, "carry on");
  await tick();
  expect(specs).toHaveLength(1);
  boot.finishPrompt();
  await tick();
  await relaunched.disposeAll();
  return specs[0];
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
  expect(reroutedNotes(h, taskId)).toHaveLength(1);

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
