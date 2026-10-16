import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compareToBaseline } from "../scripts/interaction-metrics.ts";
import { replaySession } from "../scripts/replay/engine.ts";
import { discoverFixtures, readBaseline } from "../scripts/replay-captain-session.ts";
import { CrewSupervisor } from "../src/core/orchestrator/crewSupervisor.ts";

/**
 * The P3 exit check, kept honest past S7c. The Sep 14 failure mode was a
 * steer refused because something else held the task ("try again in a
 * moment"), and the fix - first the claim's durable queue, now the
 * retirement of the claim altogether - is only worth as much as the gate
 * that would catch its return. Bring the refusal back at the one verb that
 * used to speak it and the replay counts it again, above the baseline.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/replay/", import.meta.url));

describe("the replay gate catches a lock-refusal regression", () => {
  it("counts the refused steers again and fails the baseline on them", async () => {
    vi.spyOn(CrewSupervisor.prototype, "steerCrewmate").mockImplementation(async (taskId) => {
      throw new Error(
        `task ${taskId} is being triaged by fleet supervision right now; try again in a moment`,
      );
    });

    const sources = discoverFixtures(FIXTURES).find((entry) => entry.name === "sep14");
    if (!sources) throw new Error("sep14 fixture is missing");
    const report = await replaySession(sources);
    vi.restoreAllMocks();

    expect(report.metrics.lock_refusals.value).toBeGreaterThanOrEqual(2);
    const baseline = readBaseline(`${FIXTURES}baseline.json`).sessions.sep14 ?? {};
    const regressions = compareToBaseline({ sep14: report.metrics }, { sep14: baseline });
    expect(regressions.map((regression) => regression.metric)).toContain("lock_refusals");
  }, 60_000);
});
