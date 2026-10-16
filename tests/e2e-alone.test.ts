import { describe, expect, it } from "vitest";
import { laterTests, sharesOneApp } from "../scripts/e2e-alone.ts";

/**
 * The run-alone pass (scripts/e2e-alone.ts; docs/testing.md "Each test owns
 * its prerequisites") picks, from Playwright's own listing, each test after
 * the first in a spec file that shares one app across its tests.
 */

const spec = (title: string, file: string, line: number, lane = "application") => ({
  title,
  file,
  line,
  tests: [{ projectName: lane }],
});

describe("the run-alone pass", () => {
  it("covers a file that shares one app across its tests, and no other", () => {
    expect(sharesOneApp(`test.beforeAll(async () => {\n  launched = await launchApp();\n});`)).toBe(
      true,
    );
    expect(
      sharesOneApp(
        `test.describe("x", () => {\n  test.beforeAll(() => {\n    dir = make();\n  });\n});`,
      ),
    ).toBe(true);
    expect(sharesOneApp(`test.beforeEach(async () => {\n  app = await launchApp();\n});`)).toBe(
      false,
    );
    expect(sharesOneApp(`test("one", async () => {\n  const app = await launchApp();\n});`)).toBe(
      false,
    );
  });

  it("runs each test after the first in its file, once per line and lane, named by its describe", () => {
    const report = {
      suites: [
        {
          title: "rows.spec.ts",
          specs: [spec("adds a row", "rows.spec.ts", 12), spec("moves a row", "rows.spec.ts", 40)],
          suites: [
            {
              title: "the board",
              specs: [
                // A loop's tests share their line, and file:line selects them together.
                spec("drops row 1", "rows.spec.ts", 60),
                spec("drops row 2", "rows.spec.ts", 60),
              ],
            },
          ],
        },
        // A file whose only test is its first has nothing to run alone.
        { title: "lone.spec.ts", specs: [spec("stands alone", "lone.spec.ts", 9, "desktop")] },
        {
          title: "keys.spec.ts",
          specs: [
            spec("types", "keys.spec.ts", 30, "desktop"),
            spec("routes", "keys.spec.ts", 8, "desktop"),
          ],
        },
      ],
    };
    expect(laterTests(report)).toEqual([
      { file: "keys.spec.ts", line: 30, lane: "desktop", title: "types" },
      { file: "rows.spec.ts", line: 40, lane: "application", title: "moves a row" },
      { file: "rows.spec.ts", line: 60, lane: "application", title: "the board › drops row 1" },
    ]);
  });
});
