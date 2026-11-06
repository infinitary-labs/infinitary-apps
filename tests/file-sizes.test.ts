import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isCodeFile,
  lineCount,
  OVER_CEILING,
  SIZE_CEILING,
  sizeProblems,
} from "../scripts/file-sizes";

/**
 * The size check (INF-2625's approved plan: "it refuses a file over 2,000
 * lines unless it is on a list that only shrinks"). `pnpm check` runs it over
 * the tree; here, what it reads and what it refuses, on the project's own
 * files.
 */
describe("the size check", () => {
  const LISTED = "src/core/browser/taskBrowsers.ts";
  const WAKES = "src/core/orchestrator/wakes.ts";
  const WAITS = "scripts/main-thread-waits.ts";

  it("counts lines as wc -l does", () => {
    const text = readFileSync(WAITS, "utf8");
    expect(lineCount(text)).toBe(text.match(/\n/g)?.length);
    expect(lineCount(`${text}tail`)).toBe(lineCount(text) + 1);
  });

  it("reads code and skips data, generated, vendored and fixture files", () => {
    expect(isCodeFile(LISTED)).toBe(true);
    expect(isCodeFile("ios/Infinitary/InfinitaryUITests/PhoneJourney.swift")).toBe(true);
    expect(isCodeFile("tests/e2e/mockProvider.ts")).toBe(true);
    for (const path of [
      "docs/contract.json",
      "pnpm-lock.yaml",
      "packaging/build/icon.icns",
      "scripts/bench/data/empty-patch-sweep.json",
      "ios/Infinitary/InfinitaryApp/CardAssets/CardHost.generated.js",
      ".claude/skills/infinitary-design/vendor/react-dom.development.js",
      ".claude/skills/infinitary-design/_ds_bundle.js",
      "tests/fixtures/replay/sep04-real/tables.json",
    ])
      expect(isCodeFile(path), path).toBe(false);
  });

  it("passes a listed file over the ceiling and an unlisted one under it", () => {
    expect(OVER_CEILING).toContain(LISTED);
    expect(OVER_CEILING).not.toContain(WAITS);
    const sizes = { [LISTED]: 17380, [WAITS]: lineCount(readFileSync(WAITS, "utf8")) };
    expect(sizeProblems(sizes, [LISTED])).toEqual([]);
  });

  it("refuses an unlisted file that grows over the ceiling", () => {
    const problems = sizeProblems({ [LISTED]: 17380, [WAITS]: SIZE_CEILING + 1 }, [LISTED]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${WAITS}: ${SIZE_CEILING + 1} lines`));
  });

  it("refuses an entry whose file came under the ceiling or left, so the list shrinks", () => {
    const problems = sizeProblems({ [LISTED]: 17380, [WAKES]: SIZE_CEILING }, [
      LISTED,
      WAKES,
      "src/core/orchestrator/gone.ts",
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(`${WAKES} is ${SIZE_CEILING} lines, at or under the ceiling`);
    expect(problems[1]).toContain("src/core/orchestrator/gone.ts is listed but is no longer");
  });
});
