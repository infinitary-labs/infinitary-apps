import { describe, expect, it } from "vitest";
import {
  type AloneTest,
  laterTests,
  shardTests,
  sharesOneApp,
  skipped,
  skippedAll,
  summary,
  withTag,
} from "../scripts/e2e-alone.ts";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";

/**
 * The run-alone pass (scripts/e2e-alone.ts; docs/testing.md "Each test owns
 * its prerequisites") picks, from Playwright's own listing, each test after
 * the first in a spec file that shares one app across its tests.
 */

const spec = (
  title: string,
  file: string,
  line: number,
  lane = "application",
  tags: string[] = [],
) => ({
  title,
  file,
  line,
  tags,
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
      { file: "keys.spec.ts", line: 30, lane: "desktop", title: "types", tags: [] },
      { file: "rows.spec.ts", line: 40, lane: "application", title: "moves a row", tags: [] },
      {
        file: "rows.spec.ts",
        line: 60,
        lane: "application",
        title: "the board › drops row 1",
        tags: [],
      },
    ]);
  });
});

/**
 * INF-873's approved plan: the pass runs on Linux, where a Mac-only test
 * skips, so the Mac runs those alone by their tag, and a skip anywhere else
 * is a test the pass never checked.
 */
describe("the run-alone pass on Linux and the Mac", () => {
  const macOnly: AloneTest = {
    file: "multiline-composer.spec.ts",
    line: 200,
    lane: "desktop",
    title: "shell keys edit the draft, undo like typing, and send the words as edited",
    tags: [MAC_ONLY_TAG],
  };
  const plain: AloneTest = { ...macOnly, line: 250, title: "Cmd+Z takes back a run", tags: [] };

  it("reads a test's tags from the listing, which drops their @, and keeps the tagged ones", () => {
    // Playwright 1.62's --list --reporter=json writes `tag: "@mac-only"` as "mac-only".
    const listed = laterTests({
      suites: [
        {
          title: "multiline-composer.spec.ts",
          specs: [
            spec("Shift+Enter adds lines", "multiline-composer.spec.ts", 87, "desktop"),
            spec(macOnly.title, macOnly.file, 200, "desktop", ["mac-only"]),
            spec(plain.title, plain.file, 250, "desktop"),
          ],
        },
      ],
    });
    expect(listed).toEqual([macOnly, plain]);
    expect(withTag(listed, MAC_ONLY_TAG)).toEqual([macOnly]);
    expect(withTag(listed, undefined)).toEqual(listed);
  });

  // INF-1417 / INF-1392: hosted fresh-state jobs preserve every file:line/lane
  // once, including desktop and Mac-only selections; they never split a loop's line.
  it("partitions the listing exhaustively, deterministically and without overlap", () => {
    const listed = laterTests({
      suites: [
        {
          title: plain.file,
          specs: [
            spec("Shift+Enter adds lines", plain.file, 87, "desktop"),
            spec(macOnly.title, macOnly.file, macOnly.line, macOnly.lane, ["mac-only"]),
            spec(plain.title, plain.file, plain.line, plain.lane),
            spec("at the smallest window", plain.file, 296, "desktop"),
            spec("at the smallest window again", plain.file, 296, "desktop"),
          ],
        },
      ],
    });
    const shards = [1, 2, 3, 4].map((index) => shardTests(listed, `${index}/4`));
    expect(shards).toEqual([[listed[0]], [listed[1]], [listed[2]], []]);
    expect(shards.flat()).toEqual(listed);
    expect(shardTests(listed, "1/2")).toEqual([listed[0], listed[2]]);
    expect(shardTests(listed, "2/2")).toEqual([listed[1]]);
    expect(
      new Set(shards.flat().map((test) => `${test.file}:${test.line}:${test.lane}`)).size,
    ).toBe(listed.length);
    expect(shardTests(listed, "1/1")).toEqual(listed);
    expect(shardTests(listed, undefined)).toEqual(listed);
    expect(shardTests(withTag(listed, MAC_ONLY_TAG), "1/4")).toEqual([macOnly]);
    expect(shardTests(listed, "1/4")).toEqual(shards[0]);
  });

  it("rejects invalid shard selections rather than silently omitting checks", () => {
    for (const shard of ["", "0/4", "5/4", "1/0", "1", "1.5/4", "1/4extra", "1/9007199254740992"]) {
      expect(() => shardTests([plain], shard)).toThrow("--shard must be index/total");
    }
  });

  it("knows a run whose test skipped from one whose test ran", () => {
    // The stats of Playwright's JSON result for one test selected by file:line.
    const stats = (expected: number, skipped: number) => ({
      stats: {
        startTime: "2026-10-22T18:00:00.000Z",
        duration: 9000,
        expected,
        skipped,
        unexpected: 0,
        flaky: 0,
      },
    });
    expect(skippedAll(stats(0, 1))).toBe(true);
    expect(skippedAll(stats(1, 0))).toBe(false);
    // A loop's tests share a line: one ran, so the line was checked.
    expect(skippedAll(stats(1, 1))).toBe(false);
    expect(skippedAll({})).toBe(false);
  });

  it("records a Mac-only test that skips off a Mac as skipped, and fails any other skip", () => {
    expect(skipped(macOnly, "linux", 3)).toEqual({ ...macOnly, status: "skipped", seconds: 3 });
    const untagged = skipped(plain, "linux", 3);
    expect(untagged.status).toBe("failed");
    expect(untagged.error).toContain(MAC_ONLY_TAG);
    expect(skipped(macOnly, "darwin", 3).status).toBe("failed");
  });

  it("summarizes the pass's counts, skips apart, and names each test that failed alone", () => {
    const text = summary([
      { ...macOnly, status: "skipped", seconds: 3 },
      { ...plain, status: "passed", seconds: 5 },
      { ...plain, line: 296, title: "at the smallest window", status: "failed", seconds: 7 },
    ]);
    expect(text).toContain(`Run alone: 1 passed, 1 failed, 1 skipped as ${MAC_ONLY_TAG}`);
    expect(text).toContain("- `multiline-composer.spec.ts:296` at the smallest window (desktop)");
    expect(text).not.toContain(":250`");
  });
});
