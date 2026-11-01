import { describe, expect, it } from "vitest";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import { selectRepeats } from "../scripts/unit-repeats.ts";

/**
 * INF-2074's ci-gate fix, the captain's checked words: "Run a change's
 * typecheck, lint and ten unit-file repeats on Linux CI instead of the Mac
 * mini's line, since unit tests need no Mac". ci.yml's unit-repeats job runs
 * what selectRepeats picks; a file that needs a Mac keeps its repeats there.
 */
describe("a change's unit-file repeats on Linux", () => {
  // A changed list shaped like a real pull request's: product code, docs, a
  // journey, a renamed-away test, a Mac-only test and two ordinary tests.
  it("picks the Vitest files the change keeps, leaving Mac-only files to a Mac", () => {
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
      "src/renderer/src/cards/CardStack.test.tsx",
      "tests/checks-mode.test.ts",
    ]);
    expect(selection.onMac).toEqual([macOnly]);
  });

  it("repeats nothing when the change edits no test file", () => {
    expect(selectRepeats(["docs/testing.md", ".github/workflows/ci.yml"], () => true)).toEqual({
      repeat: [],
      onMac: [],
    });
  });
});
