import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compareToBaseline } from "../scripts/interaction-metrics.ts";
import { replaySession } from "../scripts/replay/engine.ts";
import { discoverFixtures, readBaseline } from "../scripts/replay-captain-session.ts";

/**
 * The P3 exit check, proven: CI blocks a lint change whose replay regresses a
 * metric. Here `src/core/pi/cardLint.ts` loses its lint at both boundaries
 * (every card passes; the shape rules and the merge-claim consistency check
 * with them), which is exactly the change that brought back the Sep 4-5
 * fake merge buttons - merge-labelled actions with no settle effect - and
 * the committed baseline must refuse it.
 */
vi.mock("../src/core/pi/cardLint.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/pi/cardLint.ts")>()),
  lintFirstmateCard: () => undefined,
  lintCrewmateCard: () => undefined,
}));

const FIXTURES = fileURLToPath(new URL("./fixtures/replay/", import.meta.url));
const BASELINE = fileURLToPath(new URL("./fixtures/replay/baseline.json", import.meta.url));

describe("the replay gate catches a card-lint regression", () => {
  it("shows the fake merge buttons again and fails the baseline on them", async () => {
    const sources = discoverFixtures(FIXTURES).find((entry) => entry.name === "sep04");
    if (!sources) throw new Error("sep04 fixture is missing");
    const report = await replaySession(sources);
    expect(report.metrics.fake_merge_buttons.value).toBe(3);
    const regressions = compareToBaseline(
      { sep04: report.metrics },
      {
        sep04: readBaseline(BASELINE).sessions.sep04 ?? {},
      },
    );
    expect(regressions.map((regression) => regression.metric)).toContain("fake_merge_buttons");
  }, 60_000);
});
