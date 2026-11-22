/**
 * A crewmate's turn that fails on the model's context limit (a user report:
 * a crewmate on a custom connection whose compaction never wrote a summary
 * failed every wake-up with "This request exceeds the context window", and
 * each retry appended the same lane rows to the same conversation again).
 * The expected behavior is the report's: the crewmate gets the same one
 * fresh-conversation recovery the first mate has, and when that fails too
 * the turn is not retried into the same conversation and the first mate is
 * told the task needs action. Each case drives a real CrewSupervisor through
 * the crew harness (tests/helpers/crewHarness.ts).
 */
import { expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { legacyStateOf } from "../tasks/seedTask";

fakeCrewTimersEachTest();

/** The refusal the report saw on each failed turn, as a custom connection words it. */
const OVERFLOW = "This request exceeds the context window. Shorten it before trying again.";

/** One turn ending as Pi ends it after its own overflow compact-and-retry failed. */
async function overflow(crewmate: FakeCrewmate, taskId: string): Promise<void> {
  crewmate.emit({ type: "turn_failed", taskId, error: OVERFLOW, contextOverflow: true });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
}

/** Longer than the honest retry's longest backoff, then the lane's sweep the minute ticker runs. */
async function waitOutRetries(supervisor: ReturnType<typeof setup>["supervisor"]): Promise<void> {
  await vi.advanceTimersByTimeAsync(16 * 60_000);
  await supervisor.watch.sweepInbox(Date.now());
  await tick();
}

it("continues a crewmate whose turn overflowed in one fresh conversation that keeps its brief", async () => {
  const crewmate = fakeCrewmate();
  const fresh = fakeCrewmate({
    sessionId: "s2",
    resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
  });
  const { supervisor, inbox, sessionSpecs, ops, tasks } = setup(crewmate, { crewmates: [fresh] });
  const { taskId } = await supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  await supervisor.steer.steerCrewmate(taskId, "include the second log folder too");
  await overflow(crewmate, taskId);

  // The full conversation is let go, and a new one opens without resuming it.
  await vi.waitFor(() => expect(sessionSpecs).toHaveLength(2));
  expect(sessionSpecs[0]?.shape).toMatchObject({ turns: "rolling" });
  const opened = sessionSpecs[1]?.shape;
  expect(opened?.turns === "rolling" && opened.record.resume).toBeUndefined();
  expect(crewmate.dispose).toHaveBeenCalled();
  // Its first turn says why, carries the brief, and the guidance the failed
  // turn held goes once into the new conversation.
  await vi.waitFor(() => expect(fresh.promptCalls).toHaveLength(1));
  const told = fresh.promptCalls[0] ?? "";
  expect(told).toContain("context limit");
  expect(told.split("Goal: read every log part and report")).toHaveLength(2);
  expect(told.split("include the second log folder too")).toHaveLength(2);
  expect(legacyStateOf(tasks.get(taskId))).toBe("running");
  // The recovery is not an outage of the provider, and nobody is woken for it.
  expect(inbox.outage(taskId).failures).toBe(0);
  expect(ops.filter((line) => line.includes(OVERFLOW))).toHaveLength(0);
  await waitOutRetries(supervisor);
  expect(crewmate.promptCalls).toHaveLength(1);
});

it("stops retrying and tells the first mate when the fresh conversation overflows too", async () => {
  const crewmate = fakeCrewmate();
  const fresh = fakeCrewmate({
    sessionId: "s2",
    resume: { backend: "pi", sessionFile: "/tmp/s2.jsonl" },
  });
  const third = fakeCrewmate({
    sessionId: "s3",
    resume: { backend: "pi", sessionFile: "/tmp/s3.jsonl" },
  });
  const { supervisor, inbox, sessionSpecs, ops, tasks } = setup(crewmate, {
    crewmates: [fresh, third],
  });
  const { taskId } = await supervisor.intake.commission({
    title: "Read the big logs",
    intent: intentOf("read every log part and report"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  await overflow(crewmate, taskId);
  await vi.waitFor(() => expect(fresh.promptCalls).toHaveLength(1));
  await overflow(fresh, taskId);

  // One recovery only: no third conversation, and nothing goes again into
  // the one that overflowed, however long the lane waits.
  for (let round = 0; round < 4; round++) await waitOutRetries(supervisor);
  expect(sessionSpecs).toHaveLength(2);
  expect(fresh.promptCalls).toHaveLength(1);
  expect(inbox.outage(taskId).failures).toBe(0);
  // The first mate hears it once, as a failed turn it must act on.
  const told = ops.filter((line) => line.includes(OVERFLOW));
  expect(told).toHaveLength(1);
  expect(told[0]).not.toMatch(/still failing at the provider/);
  expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
});
