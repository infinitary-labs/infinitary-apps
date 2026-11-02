import { describe, expect, it, vi } from "vitest";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import { REPEATS, repetitionArgs, runRepetitions, selectRepeats } from "../scripts/unit-repeats.ts";

/** INF-2259 and the captain's subsequent INF-2273 override: ordinary local
 * coverage plus two more runs for every edited unit file, including portable
 * files, without a duplicate PR CI repeat job. */
describe("a change's local unit-file rounds", () => {
  // A changed list shaped like a real pull request's: product code, docs, a
  // journey, a renamed-away test, a Mac-only test and two ordinary tests.
  it("picks every surviving edited Vitest file locally and identifies native prerequisites", () => {
    const macOnly = MAC_UNIT_FILES[0];
    const gone = "tests/removed-in-this-change.test.ts";
    const changed = [
      "src/core/placed/loadLine.ts",
      "src/core/placed/loadLine.test.ts",
      "docs/testing.md",
      "tests/e2e/request-merge.spec.ts",
      "tests/checks-mode.test.ts",
      "src/renderer/src/cards/CardStack.test.tsx",
      gone,
      macOnly,
      "tests/fixtures/accepted-plan/inf64.json",
    ];
    const selection = selectRepeats(changed, (path) => path !== gone);
    expect(selection.repeat).toEqual([
      "src/core/placed/loadLine.test.ts",
      macOnly,
      "src/renderer/src/cards/CardStack.test.tsx",
      "tests/checks-mode.test.ts",
    ]);
    expect(selection.onMac).toEqual([macOnly]);
  });

  // INF-2203, separated from INF-1109: its 37-file workload reached round ten
  // but exceeded the CI deadline. Keep every file, ten fresh rounds and retry 0.
  it.each([undefined, "1/2", "2/2"])(
    "passes every candidate and the chosen shard %s to Vitest without retries",
    (shard) => {
      const files = [
        "src/core/orchestrator/crewSupervisor.test.ts",
        "src/core/placed/placedSessions.test.ts",
      ];
      expect(repetitionArgs(files, shard)).toEqual([
        "exec",
        "vitest",
        "run",
        "--retry",
        "0",
        ...(shard === undefined ? [] : ["--shard", shard]),
        ...files,
      ]);
    },
  );

  it("uses the declared local worker count without adding another round", () => {
    const file = "tests/unit-repeats.test.ts";
    const run = vi.fn((_args: string[]) => 0);
    expect(runRepetitions([file], undefined, run, () => {}, "2")).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [args] of run.mock.calls)
      expect(args).toEqual(["exec", "vitest", "run", "--retry", "0", "--maxWorkers", "2", file]);
    expect(() => repetitionArgs([file], undefined, "0")).toThrow("Invalid worker count");
  });

  it("keeps a one-file change on the first shard without allowing missing tests", () => {
    const files = ["src/core/helper/sessionHost.test.ts"];
    expect(repetitionArgs(files, "1/2")).toEqual(repetitionArgs(files));
    expect(repetitionArgs(files, "2/2")).toBeUndefined();
  });

  it.each(["", "0/2", "3/2", "1/0", "1/2/3"])(
    "refuses the invalid shard %s instead of silently dropping repetitions",
    (shard) => {
      expect(() => repetitionArgs(["tests/unit-repeats.test.ts"], shard)).toThrow(
        "Invalid repetition shard",
      );
    },
  );

  it.each(["1/2", "2/2"])(
    "includes ordinary coverage in three fresh complete rounds for shard %s",
    (shard) => {
      const files = [
        "src/core/orchestrator/crewSupervisor.test.ts",
        "src/core/placed/placedSessions.test.ts",
      ];
      const run = vi.fn((_args: string[]) => 0);
      const report = vi.fn();
      expect(runRepetitions(files, shard, run, report)).toBe(0);
      // INF-2259 accepted override: ordinary run plus two more, not ten.
      expect(run).toHaveBeenCalledTimes(3);
      for (const [args] of run.mock.calls) expect(args).toEqual(repetitionArgs(files, shard));
      expect(report).toHaveBeenLastCalledWith([`All ${REPEATS} rounds passed.`]);
    },
  );

  it.each([1, null])("stops at a failed or interrupted round (%s), never retrying it", (status) => {
    const run = vi
      .fn<(_args: string[]) => number | null>()
      .mockReturnValueOnce(0)
      .mockReturnValue(status);
    const report = vi.fn();
    expect(runRepetitions(["tests/unit-repeats.test.ts"], "1/2", run, report)).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith([
      `Round 2 of ${REPEATS} failed; later rounds did not run.`,
    ]);
  });

  it("invokes nothing for an empty selection or the unused shard of a lone file", () => {
    const run = vi.fn((_args: string[]) => 0);
    const report = vi.fn();
    expect(runRepetitions([], "1/2", run, report)).toBe(0);
    expect(runRepetitions(["tests/unit-repeats.test.ts"], "2/2", run, report)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(["Shard 2/2 owns no selected test files."]);
  });

  it("repeats nothing when the change edits no test file", () => {
    expect(selectRepeats(["docs/testing.md", ".github/workflows/ci.yml"], () => true)).toEqual({
      repeat: [],
      onMac: [],
    });
  });
});
