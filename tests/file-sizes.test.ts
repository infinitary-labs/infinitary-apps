import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isCodeFile,
  lineCount,
  SIZE_CEILING,
  SIZE_WARNING_LINE,
  sizeHeadroom,
  sizeProblems,
  sizeWarnings,
} from "../scripts/file-sizes";

/**
 * The size check (INF-2625's approved plan: "it refuses a file over 2,000
 * lines unless it is on a list that only shrinks"). `pnpm check` runs it over
 * the tree; here, what it reads and what it refuses, on the project's own
 * files.
 */
describe("the size check", () => {
  // The list is sizeProblems' argument, so these cases pass their own and never
  // read the live list, which shrinks to nothing as files are split.
  const LISTED = "tests/helpers/phoneHome.ts";
  const OVER = SIZE_CEILING + 1;
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
      "tests/fixtures/replay/fleet-captain-only/tables.json",
    ])
      expect(isCodeFile(path), path).toBe(false);
  });

  it("passes a listed file over the ceiling and an unlisted one under it", () => {
    const sizes = { [LISTED]: OVER, [WAITS]: lineCount(readFileSync(WAITS, "utf8")) };
    expect(sizeProblems(sizes, [LISTED])).toEqual([]);
  });

  it("refuses an unlisted file that grows over the ceiling", () => {
    const problems = sizeProblems({ [LISTED]: OVER, [WAITS]: SIZE_CEILING + 1 }, [LISTED]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${WAITS}: ${SIZE_CEILING + 1} lines`));
  });

  it("refuses an entry whose file came under the ceiling or left, so the list shrinks", () => {
    const problems = sizeProblems({ [LISTED]: OVER, [WAKES]: SIZE_CEILING }, [
      LISTED,
      WAKES,
      "src/core/orchestrator/gone.ts",
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(`${WAKES} is ${SIZE_CEILING} lines, at or under the ceiling`);
    expect(problems[1]).toContain("src/core/orchestrator/gone.ts is listed but is no longer");
  });

  // INF-4496's fix 3, the captain's pick: "Give the size check a warning line,
  // as the prompt budget has ... The four files at 2,000 go first", at "1,800
  // lines". Main's size warning fails naming each file past the line, so its
  // red run starts a split task before the file holds a merge at the ceiling.
  describe("its warning line", () => {
    const SHELL = "src/main/shell.test.ts";

    it("names each unlisted file past the line, largest first and by path among equals", () => {
      const warnings = sizeWarnings(
        {
          [WAITS]: SIZE_WARNING_LINE + 1,
          [SHELL]: SIZE_CEILING,
          [WAKES]: SIZE_CEILING,
          "tests/e2e/mockProvider.ts": SIZE_WARNING_LINE,
        },
        [],
      );
      expect(warnings.map((line) => line.split(":")[0])).toEqual([WAKES, SHELL, WAITS]);
      expect(warnings[0]).toMatch(
        new RegExp(`^${WAKES}: ${SIZE_CEILING} lines, over the ${SIZE_WARNING_LINE}-line`),
      );
    });

    it("leaves a listed file to the list that owns its split", () => {
      expect(sizeWarnings({ [LISTED]: OVER }, [LISTED])).toEqual([]);
    });

    it("warns below the ceiling, where the size check still passes", () => {
      const sizes = { [WAITS]: SIZE_WARNING_LINE + 1 };
      expect(SIZE_WARNING_LINE).toBeLessThan(SIZE_CEILING);
      expect(sizeProblems(sizes, [])).toEqual([]);
      expect(sizeWarnings(sizes, [])).toHaveLength(1);
    });
  });

  // The captain's pick on INF-6259's audit: "refuse a change that grows a
  // code file past, or further past, 1,800 lines". Two changes that each grew
  // a file under the ceiling together passed it in the merge batch, seven
  // times in two weeks.
  describe("its headroom against a change", () => {
    it("refuses a file the change grows past the warning line", () => {
      const refusals = sizeHeadroom(
        { [WAKES]: SIZE_WARNING_LINE - 10 },
        { [WAKES]: SIZE_WARNING_LINE + 1 },
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(
        new RegExp(
          `^${WAKES}: ${SIZE_WARNING_LINE - 10} lines at the change's base, ${SIZE_WARNING_LINE + 1} now`,
        ),
      );
    });

    it("refuses a file already past the line that the change grows further, listed or not", () => {
      expect(
        sizeHeadroom({ [WAKES]: SIZE_WARNING_LINE + 50 }, { [WAKES]: SIZE_WARNING_LINE + 51 }),
      ).toHaveLength(1);
      expect(sizeHeadroom({ [LISTED]: OVER }, { [LISTED]: OVER + 1 })).toHaveLength(1);
    });

    it("refuses a new file that starts past the line", () => {
      expect(sizeHeadroom({ [WAITS]: undefined }, { [WAITS]: SIZE_WARNING_LINE + 1 })).toHaveLength(
        1,
      );
    });

    it("passes a file past the line that the change shrinks or keeps the same length", () => {
      expect(
        sizeHeadroom(
          { [WAKES]: SIZE_CEILING, [LISTED]: OVER },
          { [WAKES]: SIZE_WARNING_LINE + 5, [LISTED]: OVER },
        ),
      ).toEqual([]);
    });

    it("passes growth that stays at or under the line", () => {
      expect(sizeHeadroom({ [WAITS]: 100 }, { [WAITS]: SIZE_WARNING_LINE })).toEqual([]);
    });
  });
});
