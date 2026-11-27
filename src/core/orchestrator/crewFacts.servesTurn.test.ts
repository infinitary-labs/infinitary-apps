/**
 * The "still moving" witness as `CrewFacts.servesTurn` reads it
 * (docs/report-sort.md, docs/inbox.md): only lane rows a turn would serve,
 * due or tried inside `SERVABLE_BOUND_MS`, keep a report quiet. The intent
 * is INF-7116's fix 2: a policy notice the builder had already heard sat on
 * its lane for 31 hours, and the witness read it as guidance still coming,
 * so neither the report sort nor the idle ladder ever woke the first mate.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts).
 */

import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { INBOX_BACKOFF_MS } from "../storage/inboxStore";
import { SERVABLE_BOUND_MS } from "./crewFacts";

fakeCrewTimersEachTest();

describe("CrewFacts.servesTurn", () => {
  async function idleTask() {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Careful change",
      intent: intentOf("Build the change"),
    });
    await tick();
    return { ...harness, crewmate, taskId };
  }

  it("does not read a policy notice alone as the crewmate still moving", async () => {
    const { supervisor, tasks, inbox, crewmate, ops, sorts, taskId } = await idleTask();
    tasks.updateFields(taskId, { policies: { rigor: "reviewed" } }, "firstmate");
    const record = tasks.get(taskId);
    const policies = tasks.policiesOf(record);
    if (!record || !policies) throw new Error("The commissioned task has no policies");
    crewmate.emit({ type: "assistant_delta", taskId, text: "Committed; ready for review." });
    inbox.enqueue(taskId, {
      facts: {
        kind: "task-policies-changed",
        task: { id: taskId, key: record.key, title: record.title },
        policies,
      },
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    // The notice is still on the lane, and the report woke the first mate.
    expect(inbox.allFor(taskId).map((row) => row.facts?.kind)).toEqual(["task-policies-changed"]);
    expect(supervisor.facts.servesTurn(taskId, Date.now())).toBe(false);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "stopped" });
    expect(ops.filter((line) => line.includes("reported on task"))).toHaveLength(1);
  });

  it("counts guidance a turn would serve only while it is due or tried inside the bound", async () => {
    const { supervisor, inbox, crewmate, taskId } = await idleTask();
    crewmate.finishPrompt();
    await tick();
    // No tick after this: the sweep would serve the row at once.
    const created = Date.now();
    const id = inbox.enqueue(taskId, "Open the Careful code review before you report again.");
    expect(supervisor.facts.servesTurn(taskId, created)).toBe(true);
    expect(supervisor.facts.servesTurn(taskId, created + SERVABLE_BOUND_MS - 1)).toBe(true);
    expect(supervisor.facts.servesTurn(taskId, created + SERVABLE_BOUND_MS)).toBe(false);

    // Tried again 20 minutes on and refused by the provider: it waits out
    // its backoff and counts until the bound has passed since it fell due.
    const tried = created + 20 * 60_000;
    vi.setSystemTime(tried);
    inbox.markDelivered([id]);
    inbox.releaseAfterProviderFailure([id]);
    expect(supervisor.facts.servesTurn(taskId, tried + 60_000)).toBe(true);
    const due = tried + (INBOX_BACKOFF_MS[0] ?? 0);
    expect(supervisor.facts.servesTurn(taskId, due + SERVABLE_BOUND_MS - 1)).toBe(true);
    expect(supervisor.facts.servesTurn(taskId, due + SERVABLE_BOUND_MS)).toBe(false);
  });
});
