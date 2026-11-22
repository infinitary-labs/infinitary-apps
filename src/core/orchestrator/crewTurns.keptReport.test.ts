/**
 * A report a crewmate makes in a turn the provider then fails (INF-3165,
 * the captain's direction A on INF-3142: "keep the report and say so"):
 * the record keeps it from the call, the first mate's wake names it, and
 * the crewmate's next turn opens with a check-first note naming it, so a
 * finished piece of work is reported again instead of rebuilt, and no
 * effect of the failed turn is replayed blindly (docs/inbox.md, "A report a
 * failed turn kept").
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers and the record.
 */
import { describe, expect, it } from "vitest";
import { endTurn, fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import { failTurn, idleLadderHarness, settle } from "../../../tests/helpers/idleLadderHarness";
import { keptReportNote } from "./wakes";

fakeCrewTimersEachTest();

describe("a report its turn's provider failure would have lost", () => {
  const { stopped, sweepWhenDue } = idleLadderHarness();

  it("is kept on the record, named in the wake, and named once on the retry", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, inbox, events, tasks, specs, ops } = harness;
    const guidance = "review version abc123 and report the verdict";
    await supervisor.steer.steerCrewmate(taskId, guidance);
    await settle();
    const onReport = specs[0]?.onReport;
    if (!onReport) throw new Error("Missing production report callback");
    const reportsBefore = events.filter((event) => event.type === "task_report").length;

    await onReport("Verdict: pass. No findings at abc123.", "Review passed", { finished: true });
    await failTurn(crewmate, taskId, "API Error: 529 Overloaded");

    // Nothing routed on it: no report line, no finished close, the record's
    // counted outcome is still the earlier turn's.
    expect(events.filter((event) => event.type === "task_report")).toHaveLength(reportsBefore);
    expect(tasks.get(taskId)?.outcome).toBe("Done with step one.");
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(tasks.turns.keptReport(taskId)).toMatchObject({
      text: "Verdict: pass. No findings at abc123.",
      summary: "Review passed",
    });
    const wake = ops.at(-1) ?? "";
    expect(wake).toContain("failed at the provider: API Error: 529 Overloaded");
    expect(wake).toContain('Before it failed, the crewmate reported "Review passed"');
    expect(wake).toContain("did not count as the turn's result");
    // The guidance is still kept for the honest retry.
    expect(inbox.allFor(taskId)).toMatchObject([{ failures: 1 }]);

    const prompts = crewmate.promptCalls.length;
    await sweepWhenDue(harness, taskId);
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toBe(`${keptReportNote("Review passed")}\n\n${guidance}`);

    // That turn fails too: the same kept report is not named twice.
    await failTurn(crewmate, taskId, "API Error: 529 Overloaded");
    await sweepWhenDue(harness, taskId);
    expect(crewmate.promptCalls.at(-1)).toBe(guidance);

    await onReport("Verdict: pass. No findings at abc123.", "Review passed", {});
    await endTurn(crewmate, taskId);
    expect(tasks.get(taskId)?.outcome).toBe("Verdict: pass. No findings at abc123.");
    expect(tasks.turns.keptReport(taskId)).toBeUndefined();
    expect(inbox.allFor(taskId)).toEqual([]);
  });

  it("is never named after a turn whose report counted", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, tasks, specs } = harness;
    await supervisor.steer.steerCrewmate(taskId, "check the second library");
    await settle();
    await specs[0]?.onReport?.("Checked the second library: it builds.", undefined, {});
    await endTurn(crewmate, taskId);
    expect(tasks.turns.keptReport(taskId)).toBeUndefined();

    await supervisor.steer.steerCrewmate(taskId, "now the third");
    await settle();
    expect(crewmate.promptCalls.at(-1)).toBe("now the third");
  });

  it("is named in the wake of a failed turn that carried no guidance to retry", async () => {
    const { crewmate, taskId, tasks, specs, ops } = await stopped();
    // A turn the provider began on its own: it reports, then fails.
    crewmate.emit({ type: "continuation_started" });
    await settle();
    await specs[0]?.onReport?.("Pushed the fix and opened the pull request.", undefined, {});
    crewmate.emit({ type: "continuation_ended", error: "upstream 500" });
    await settle();

    expect(tasks.get(taskId)?.outcome).toBe("Done with step one.");
    expect(tasks.turns.keptReport(taskId)?.summary).toBe(
      "Pushed the fix and opened the pull request.",
    );
    const wake = ops.at(-1) ?? "";
    expect(wake).toContain("failed: upstream 500");
    expect(wake).toContain(
      'Before it failed, the crewmate reported "Pushed the fix and opened the pull request."',
    );
  });
});
