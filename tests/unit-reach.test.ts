import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { directUnitReach } from "../scripts/unit-reach.ts";

// INF-2394 measure 3: exercise the actual consumers that motivated local
// direct reach, without a synthetic graph or a transitive dependency sweep.
const root = resolve(import.meta.dirname, "..");
describe("local direct unit reach", () => {
  it("selects relative and aliased direct imports but not unrelated or transitive readers", () => {
    const readers = [
      "tests/generate-self-source.test.ts",
      "tests/phone-order.test.ts",
      "tests/unit-repeats.test.ts",
    ];
    expect(directUnitReach(["src/shared/ipc.ts"], readers, root)).toEqual([
      "tests/generate-self-source.test.ts",
      "tests/phone-order.test.ts",
    ]);
    // unit-repeats.test imports unit-repeats, which imports unit-reach.
    expect(
      directUnitReach(["scripts/unit-reach.ts"], ["tests/unit-repeats.test.ts"], root),
    ).toEqual([]);
  });

  it("resolves the renderer UI alias for its direct panel consumers", () => {
    expect(
      directUnitReach(
        ["src/renderer/src/design/index.ts"],
        ["src/panels/now/boardMoves.test.ts"],
        root,
      ),
    ).toEqual(["src/panels/now/boardMoves.test.ts"]);
  });

  it("selects workflow readers by literal path, not just module imports", () => {
    const readers = [
      "tests/unit-repeats-workflow.test.ts",
      "tests/release-workflows.test.ts",
      "tests/phone-order.test.ts",
    ];
    expect(directUnitReach([".github/workflows/ci.yml"], readers, root)).toEqual([
      "tests/release-workflows.test.ts",
      "tests/unit-repeats-workflow.test.ts",
    ]);
    expect(directUnitReach(["unrelated/ci.yml"], readers, root)).toEqual([]);
    expect(
      directUnitReach(
        [".github/workflows/main.yml"],
        ["tests/unit-repeats-workflow.test.ts"],
        root,
      ),
    ).toEqual([]);
  });

  it("selects joined paths and workflow template directory readers", () => {
    expect(
      directUnitReach(
        ["packaging/old-cask-switch.json"],
        ["tests/release-workflows.test.ts"],
        root,
      ),
    ).toEqual(["tests/release-workflows.test.ts"]);
    expect(
      directUnitReach(
        [".github/workflows/republish-casks.yml"],
        ["tests/release-workflows.test.ts"],
        root,
      ),
    ).toEqual(["tests/release-workflows.test.ts"]);
  });

  // INF-2426: b4c11e3fd and 61ba81374 edited the testing runbook's text and
  // broke the crewmate budget and the guidance contract on main, because the
  // runbook text is imported by piResources.ts, never by a test.
  // INF-1988 moves Testing to Markdown; Care remains a real imported JSON fixture.
  it("selects the tests that read a runbook's text through the module importing it", () => {
    const readers = [
      "tests/crewmate-fixed-context.test.ts",
      "src/core/pi/piResources.test.ts",
      // seat.ts imports piResources.ts: an importer of the importer stays out.
      "src/core/orchestrator/seat.test.ts",
    ];
    expect(directUnitReach(["resources/runbooks/care/default.json"], readers, root)).toEqual([
      "src/core/pi/piResources.test.ts",
      "tests/crewmate-fixed-context.test.ts",
    ]);
    expect(
      directUnitReach(
        ["resources/runbooks/naming/runbook.json"],
        ["src/core/workspace/conventional.test.ts", ...readers],
        root,
      ),
    ).toEqual(["src/core/workspace/conventional.test.ts"]);
  });

  it("leaves edited tests to their three rounds rather than adding a fourth", () => {
    const reader = "tests/phone-order.test.ts";
    expect(directUnitReach(["src/shared/ipc.ts", reader], [reader], root)).toEqual([]);
  });
});
