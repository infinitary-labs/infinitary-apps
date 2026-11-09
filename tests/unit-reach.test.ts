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
      "tests/release-workflows-main-check.test.ts",
      "tests/phone-order.test.ts",
    ];
    expect(directUnitReach([".github/workflows/ci.yml"], readers, root)).toEqual([
      "tests/release-workflows-main-check.test.ts",
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
        ["tests/release-workflows-resolve.test.ts"],
        root,
      ),
    ).toEqual(["tests/release-workflows-resolve.test.ts"]);
    expect(
      directUnitReach(
        [".github/workflows/republish-casks.yml"],
        ["tests/release-workflows-pr-checks.test.ts"],
        root,
      ),
    ).toEqual(["tests/release-workflows-pr-checks.test.ts"]);
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

  // INF-2925's audit, the captain's fix-1: "Widen the pull request's unit
  // selection one step for served text, so a runbook or generated-fallback
  // change runs the budget and prompt tests." PR 1166 changed exactly these
  // files; its pull request selected only tests/release-notes.test.ts, and
  // its 41 tokens over the crew budget first failed in the swept batch.
  it("selects the budget and prompt tests for a runbook and generated-fallback change", () => {
    const changed = [
      "docs/runbooks.md",
      "release-notes/changes/repairs-stop-on-evidence.json",
      "resources/runbooks/delivery/crew.md",
      "src/core/pi/piResources.test.ts",
      "src/core/runbooks/fallback.generated.ts",
      "src/core/runbooks/runbooks.test.ts",
    ];
    const readers = [
      "tests/crewmate-fixed-context.test.ts",
      "tests/firstmate-fixed-context.test.ts",
      "tests/served-boundary.test.ts",
      // seat.ts imports piResources.ts: an importer of the importer stays out.
      "src/core/orchestrator/seat.test.ts",
    ];
    expect(directUnitReach(changed, readers, root)).toEqual([
      "tests/crewmate-fixed-context.test.ts",
      "tests/firstmate-fixed-context.test.ts",
      "tests/served-boundary.test.ts",
    ]);
    // A runbook the app loads from its folder reaches the tests that name
    // the folder, never ones that only name the resources folder above it.
    expect(
      directUnitReach(
        ["resources/runbooks/care/guide.md"],
        [
          "src/core/runbooks/runbooks.test.ts",
          "tests/eval-host-runbooks.test.ts",
          "src/shared/resources.test.ts",
        ],
        root,
      ),
    ).toEqual(["src/core/runbooks/runbooks.test.ts", "tests/eval-host-runbooks.test.ts"]);
  });

  // INF-3262's accepted repair: these real indirect contracts failed late;
  // declare only their owners, without selecting arbitrary transitive readers.
  it("selects the six audited contracts only for their declared indirect owners", () => {
    const inventories = ["src/shared/actions.test.ts", "src/shared/ipc.test.ts"];
    const migrations = [
      "src/core/storage/decisionMigrations.test.ts",
      "src/core/storage/inboxMigrations.test.ts",
      "src/core/storage/retireKeepOpen.test.ts",
    ];
    const policy = ["src/core/orchestrator/settleService.boundary.test.ts"];
    const readers = [...inventories, ...migrations, ...policy];
    expect(directUnitReach(["src/shared/channels/settings.ts"], readers, root)).toEqual(
      inventories,
    );
    expect(directUnitReach(["src/core/storage/migrations.ts"], readers, root)).toEqual(migrations);
    // Other migration tests directly import taskService; this pins only the
    // formerly missed policy consumer, not the existing direct readers.
    expect(directUnitReach(["src/core/tasks/taskService.ts"], policy, root)).toEqual(policy);
    expect(directUnitReach(["src/renderer/src/design/index.ts"], readers, root)).toEqual([]);
    // The channel folder is an explicit owner, including a deleted definition.
    expect(directUnitReach(["src/shared/channels/removed.ts"], readers, root)).toEqual(inventories);
    expect(
      directUnitReach(["src/shared/channels/settings.ts", ...inventories], readers, root),
    ).toEqual([]);
  });

  it("leaves edited tests to their three rounds rather than adding a fourth", () => {
    const reader = "tests/phone-order.test.ts";
    expect(directUnitReach(["src/shared/ipc.ts", reader], [reader], root)).toEqual([]);
  });
});
