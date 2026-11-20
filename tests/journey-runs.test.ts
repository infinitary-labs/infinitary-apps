import { describe, expect, it, vi } from "vitest";
import { laneFiles } from "../scripts/journey-groups.ts";
import {
  aloneArguments,
  editedOnceArguments,
  journeyRounds,
  laneRuns,
  runJourneyRounds,
} from "../scripts/journey-runs.ts";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";

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

// INF-4891: a Mac journey request ran its four files in one Playwright run,
// so the automatic placement journey, a serial desktop-lane file that reads
// this computer's memory live, ran beside three application journeys' apps
// and waited for memory too. A run of every lane keeps desktop apart and last.
describe("a round's runs by lane", () => {
  const request = [
    "tests/e2e/app-actions.spec.ts",
    "tests/e2e/automatic-placement.spec.ts",
    "tests/e2e/phase5-quota.spec.ts",
    "tests/e2e/settings-save-recovery.spec.ts",
  ];

  it("runs the parallel lanes' selected files together, then the desktop lane's by themselves", () => {
    const desktop = laneFiles("desktop");
    expect(laneRuns(request)).toEqual([
      { lane: "parallel", files: request.filter((file) => !desktop.includes(file)) },
      { lane: "desktop", files: request.filter((file) => desktop.includes(file)) },
    ]);
  });

  it("keeps a selection from one lane in one run", () => {
    const desktop = laneFiles("desktop");
    for (const file of request)
      expect(laneRuns([file])).toEqual([
        { lane: desktop.includes(file) ? "desktop" : "parallel", files: [file] },
      ]);
  });
});

// INF-2340 (captain's route "alone-at-author"): the run-alone pass moved from
// main's full check to the proof of edited journeys, over the directly edited
// selected files only, with the Mac's tag when the rounds keep only its tests.
describe("the edited journeys' run-alone pass", () => {
  it("runs alone only the directly edited selected files, where the job keeps the result", () => {
    expect(
      aloneArguments(files, [files[1]!, "src/core/devices/computerUpdate.ts"], {
        out: "playwright-report/alone",
      }),
    ).toEqual(["scripts/e2e-alone.ts", "--out", "playwright-report/alone", files[1]]);
    expect(aloneArguments(files, files, { tag: "@mac-only" })).toEqual([
      "scripts/e2e-alone.ts",
      "--tag",
      "@mac-only",
      ...files,
    ]);
  });

  it("runs nothing alone when no selected journey file was edited", () => {
    expect(
      aloneArguments(files, [
        "src/core/devices/computerUpdate.ts",
        "tests/e2e/latency.check.spec.ts",
      ]),
    ).toBeUndefined();
  });

  // INF-4500's weekly audit, addition 3 (the captain's choice: "One Mac round
  // for each edited journey"): the secrets journey's edits passed Linux and
  // failed later on the Mac. A request names the edited journey and one that
  // only imports a changed file; the Mac runs every test of the edited one once.
  it("runs each edited journey once on the Mac, every test but the tagged ones its rounds ran", () => {
    const named = ["tests/e2e/secrets.spec.ts", "tests/e2e/now-panel.spec.ts"];
    const changed = ["tests/e2e/secrets.spec.ts", "src/main/host/darwinKeychain.ts"];
    expect(editedOnceArguments(named, changed, MAC_ONLY_TAG)).toEqual([
      "exec",
      "playwright",
      "test",
      "--no-deps",
      "--retries",
      "0",
      "--max-failures",
      "1",
      "--grep-invert",
      MAC_ONLY_TAG,
      "--pass-with-no-tests",
      "tests/e2e/secrets.spec.ts",
    ]);
    expect(
      editedOnceArguments(named, ["src/main/host/darwinKeychain.ts"], MAC_ONLY_TAG),
    ).toBeUndefined();
  });
});
