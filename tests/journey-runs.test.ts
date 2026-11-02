import { describe, expect, it, vi } from "vitest";
import { journeyRounds, runJourneyRounds } from "../scripts/journey-runs.ts";

// INF-2259 approved hybrid process: ordinary selected proof counts as round
// one, and directly edited selected journey files need only two more.
// These are actual journey paths selected by the existing device/freeze route.
const files = ["tests/e2e/devices.spec.ts", "tests/e2e/main-thread-freeze.spec.ts"];

describe("selected journey rounds", () => {
  it("runs ordinary coverage once and only directly edited selected files twice more", () => {
    const rounds = journeyRounds(files, [files[0]!, "src/core/devices/computerUpdate.ts"]);
    const run = vi.fn(() => 0);
    expect(runJourneyRounds(rounds, run)).toBe(0);
    expect(run.mock.calls).toEqual([
      [files, 1],
      [[files[0]], 2],
      [[files[0]], 3],
    ]);
  });

  it.each([1, null])(
    "stops on failure or interruption (%s), without counting later rounds",
    (failure) => {
      const run = vi.fn().mockReturnValueOnce(0).mockReturnValue(failure);
      expect(runJourneyRounds(journeyRounds(files, files), run)).toBe(1);
      expect(run.mock.calls).toEqual([
        [files, 1],
        [files, 2],
      ]);
    },
  );

  it("does not repeat affected but unedited files or an edited file outside the selection", () => {
    expect(journeyRounds(files, ["tests/e2e/latency.check.spec.ts"])).toEqual([files]);
    expect(journeyRounds([], files)).toEqual([]);
  });
});
