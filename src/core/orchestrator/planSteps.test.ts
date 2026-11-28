/**
 * A plan's steps for the captain (INF-7250 finding 3, which the captain chose
 * to start: "i assume this just means every user step is its own task, with
 * the right dependency chain setup?"; docs/required-actions.md, "A plan's
 * steps"). The plan card declares each step only the captain can do; the
 * plan keeps it and starts nothing, whatever the captain chose, and the first
 * mate's start_steps makes each its own task with its own card, once.
 */
import type { RequiredAction } from "@shared/requiredActions";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { firstmateSeat } from "../../../tests/helpers/firstmateTools";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import type { BoundTool } from "../session/tools";
import { bindTool } from "../session/tools";
import { seedTask } from "../tasks/seedTask";
import type { CrewmateSpec } from "./crewSession";

fakeCrewTimersEachTest();

/** INF-7139's part 2, the captain's own request to Google, as its plan would declare it. */
const GOOGLE_REQUEST: RequiredAction = {
  id: "google-request",
  target: "Google Cloud",
  title: "Ask Google to verify the app's sign-in",
  consequence: "Until Google answers, the Gemini sign-in cannot start.",
  instructions: ["Open the Google Cloud console.", "Submit the verification request."],
  criterion: "Google shows the request as submitted.",
  prerequisites: [],
  completion: { kind: "manual", label: "I submitted it" },
};

/** A read-only planner whose plan card is up. */
async function plannerWithPlanCard() {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, {
    classifier: {
      classify: async () =>
        ({ kind: "research", source: "classifier:test", version: "kc1" }) as const,
    },
  });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Plan the Gemini sign-in",
    intent: {
      ...intentOf("plan a Google sign-in for Gemini plans"),
      constraints: [{ kind: "read-only" }],
    },
  });
  await tick();
  const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
  await emitCard.run({
    title: "Build the Gemini sign-in in three parts",
    body: "<p>Part 1 adds the guard. Part 2 is your request to Google. Part 3 adds the sign-in once Google answers.</p>",
    required_actions: [GOOGLE_REQUEST],
    actions: [
      { id: "abandon", label: "Abandon" },
      { id: "defer", label: "Save and defer" },
      { id: "build", label: "Approve and build", default: true },
    ],
  } as never);
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
  const plan = h.cardStore.listOpen().find((card) => card.taskId === taskId);
  if (!plan) throw new Error("the plan card is not up");
  const steps = () => h.tasks.list().filter((row) => row.delivery?.captainAction);
  return { ...h, taskId, plan, steps };
}

describe("a plan's steps for the captain", () => {
  it("are kept on the plan and start nothing until the first mate starts them, then each is its own task with its own card, once", async () => {
    const h = await plannerWithPlanCard();
    expect(h.tasks.get(h.taskId)?.delivery?.requiredActionOffer?.actions).toEqual([GOOGLE_REQUEST]);
    expect(h.steps()).toEqual([]);

    // The captain's choice closes the plan; the host never reads it as approval.
    h.supervisor.cardActions.act(h.plan.id, "build");
    await tick();
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "answered" });
    expect(h.steps()).toEqual([]);

    const started = h.supervisor.startPlanSteps(h.taskId);
    if (!("steps" in started)) throw new Error(started.refused);
    expect(started.steps.map((step) => step.title)).toEqual([GOOGLE_REQUEST.title]);
    const [step] = started.steps;
    expect(step).toMatchObject({ kind: "operation", status: "open" });
    await h.supervisor.watch.sweepGates(Date.now());
    const card = h.cardStore.listOpen().find((shown) => shown.taskId === step?.id);
    expect(card?.title).toBe(GOOGLE_REQUEST.title);

    // A second call answers the same step and files nothing new.
    const again = h.supervisor.startPlanSteps(h.taskId);
    expect("steps" in again && again.steps.map((row) => row.id)).toEqual([step?.id]);
    expect(h.steps()).toHaveLength(1);
  });

  it("name on the step's card the part filed after it went up to wait on it", async () => {
    const h = await plannerWithPlanCard();
    h.supervisor.cardActions.act(h.plan.id, "build");
    await tick();
    const started = h.supervisor.startPlanSteps(h.taskId);
    const step = "steps" in started ? started.steps[0] : undefined;
    if (!step) throw new Error("the plan's step filed no task");
    await h.supervisor.watch.sweepGates(Date.now());
    const before = h.cardStore.listOpen().find((shown) => shown.taskId === step.id);
    expect(before?.body).not.toContain("waits on this step");

    const part = seedTask(h.tasks, {
      id: "part-3",
      title: "Add the Gemini sign-in",
      status: "queued",
      startPolicy: "when-ready",
    });
    h.tasks.graph.link(step.id, part.id, "blocks", "firstmate");
    await h.supervisor.watch.sweepGates(Date.now());
    const after = h.cardStore.listOpen().find((shown) => shown.taskId === step.id);
    expect(after?.id).toBe(before?.id);
    expect(after?.body).toContain("Add the Gemini sign-in waits on this step.");
    expect(h.tasks.get(part.id)?.status).toBe("open");
  });
});

describe("the first mate's update_task start_steps", () => {
  function toolOf(tools: BoundTool[], name: string): BoundTool {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`the first mate has no ${name}`);
    return tool;
  }

  it("answers each step's key on a plan and refuses a task whose card declared none", async () => {
    const { tools, tasks } = await firstmateSeat();
    seedTask(tasks, {
      id: "gemini-plan",
      title: "Plan the Gemini sign-in",
      status: "completed",
      shape: { kind: "research", deliverable: "answer" },
    });
    tasks.delivery.declareRequiredActions("gemini-plan", {
      cardId: "card-gemini-plan",
      offerId: "offer-plan",
      actions: [GOOGLE_REQUEST],
    });
    seedTask(tasks, {
      id: "guard",
      title: "Add the sign-in guard",
      status: "completed",
      shape: { kind: "implement", deliverable: "change" },
    });
    const updateTask = toolOf(tools, "update_task");

    const { text } = await updateTask.run({ task: "gemini-plan", start_steps: true } as never);
    const step = tasks.list().find((row) => row.delivery?.captainAction);
    expect(text).toContain(`${step?.key}: ${GOOGLE_REQUEST.title} (waiting on the captain)`);

    const refused = await updateTask.run({ task: "guard", start_steps: true } as never);
    expect(refused.text).toContain("declared no steps for the captain on a plan card");
    expect(tasks.list().filter((row) => row.delivery?.captainAction)).toHaveLength(1);
  });
});
