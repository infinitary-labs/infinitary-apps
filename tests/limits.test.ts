import { describe, expect, it } from "vitest";
import { type LimitEntry, limitProblems, namedLimitsIn, readsFile } from "../scripts/limits";

/**
 * The limits ledger (INF-484 move 8, the captain's approved plan: "a ledger
 * of named limits classifies each as fact, consent or physical limit with its
 * way out, and its baseline only shrinks"; docs/agents-reach.md). `pnpm check`
 * runs it over the tree; here, what it refuses. The declarations are the
 * code's own lines.
 */
describe("the limits ledger", () => {
  const API = "src/core/forge/api.ts";
  const PROJECTS = "src/core/forge/projects.ts";
  const apiText = [
    "/** The most one answer may carry, in bytes. */",
    "export const API_RESPONSE_MAX_BYTES = 256 * 1024;",
    "export const API_PER_PAGE_MAX = 100;",
  ].join("\n");
  const projectsText = "const MAX_LISTED = 8;";
  const limits = [...namedLimitsIn(API, apiText), ...namedLimitsIn(PROJECTS, projectsText)];
  const ledger: Record<string, Record<string, LimitEntry>> = {
    [API]: {
      API_RESPONSE_MAX_BYTES: { rests: "physical limit", way: "refused naming 256 KiB" },
      API_PER_PAGE_MAX: { rests: "outside fact", way: "follow nextPath" },
    },
  };
  const baseline = { [PROJECTS]: { MAX_LISTED: "a fuller name narrows it" } };

  it("finds a named limit by a limit word between its underscores, and only there", () => {
    expect(limits).toEqual([
      { path: API, line: 2, name: "API_RESPONSE_MAX_BYTES" },
      { path: API, line: 3, name: "API_PER_PAGE_MAX" },
      { path: PROJECTS, line: 1, name: "MAX_LISTED" },
    ]);
    // A word that only contains a limit word is not one, and a declaration a
    // comment quotes declares nothing.
    expect(
      namedLimitsIn(
        "src/core/browser/taskBrowsers.ts",
        [
          "const CAPTURE_REASON_SHOWN = 120;",
          "const MINUTE = 60_000;",
          ' * `const PLAN_LABEL_LIMITS = contractChange("plan-label-limits")` for the',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(readsFile("src/shared/cards.ts")).toBe(true);
    expect(readsFile("src/shared/cards.test.ts")).toBe(false);
    expect(readsFile("src/renderer/src/cards/CardStack.tsx")).toBe(false);
  });

  it("passes when every named limit is in exactly one list with its way out", () => {
    expect(limitProblems(limits, ledger, baseline)).toEqual([]);
  });

  it("refuses a named limit the ledger does not hold, pointing at the agent", () => {
    const added = namedLimitsIn("src/shared/composer.ts", "export const PASTE_FILES_MAX = 4;");
    const problems = limitProblems([...limits, ...added], ledger, baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/shared/composer.ts:1: PASTE_FILES_MAX");
    expect(problems[0]).toContain("give that judgment to the agent");
  });

  it("refuses an entry the code no longer declares, so the baseline shrinks with the code", () => {
    const problems = limitProblems(limits.slice(0, 2), ledger, baseline);
    expect(problems).toEqual([expect.stringContaining("BASELINE holds MAX_LISTED")]);
    expect(problems[0]).toContain("the baseline shrinks");
  });

  it("refuses a limit in both lists, and an entry with no way out", () => {
    expect(
      limitProblems(limits, ledger, { ...baseline, [API]: { API_PER_PAGE_MAX: "none yet" } }),
    ).toEqual([expect.stringContaining("API_PER_PAGE_MAX is in both LIMITS and BASELINE")]);
    expect(
      limitProblems(
        limits,
        { [API]: { ...ledger[API], API_PER_PAGE_MAX: { rests: "outside fact", way: " " } } },
        baseline,
      ),
    ).toEqual([expect.stringContaining("API_PER_PAGE_MAX names no way out")]);
  });
});
