import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Suite, untaggedSkips } from "../scripts/untagged-skips.ts";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";
import { scratchDir } from "./helpers/scratchDirs";
import { lintMacTag, macTests, needsMac } from "./lint/e2eMacTag";

/**
 * The captain's principle of 2026-10-28 (INF-1763, docs/principles.md): a
 * test runs on the Mac only when it needs a Mac, Linux runs every test it
 * can, and the Mac runs only tests tagged MAC_ONLY_TAG outside the nightly
 * check and every alpha. Two checks hold the tag to what a test needs: the
 * lint in `pnpm check`, and the Linux journey jobs' refusal of a test that
 * skipped there without it.
 */

const untag = (source: string) => source.replace(/\{\s*tag: MAC_ONLY_TAG,?\s*\},\s*/, "");
const spec = (name: string) => readFileSync(new URL(`./e2e/${name}`, import.meta.url), "utf8");

function lint(source: string): { line: number; message: string }[] {
  const dir = join(scratchDir("infinitary-e2e-mac-tag-lint-"), "tests/e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "journey.spec.ts");
  writeFileSync(file, source);
  return lintMacTag([file]).map(({ line, message }) => ({ line, message }));
}

describe("the Mac tag lint", () => {
  it("passes this repository's tagged journeys and refuses one whose tag is removed", () => {
    // window-wash.spec.ts skips its one test off the Mac's window material.
    const wash = spec("window-wash.spec.ts");
    expect(needsMac(wash)).toBe(true);
    expect(lint(wash)).toEqual([]);
    const untagged = untag(wash);
    expect(untagged).not.toBe(wash);
    expect(needsMac(untagged)).toBe(false);
    expect(lint(untagged)).toEqual([
      { line: expect.any(Number), message: expect.stringContaining("THIS_DESKTOP") },
    ]);
    // A test that only runs a Mac step, the app menu's key here, needs the tag too.
    const sizes = spec("window-size.spec.ts");
    expect(lint(sizes)).toEqual([]);
    expect(lint(untag(sizes)).map((d) => d.message)).toEqual([
      expect.stringContaining("HAS_APP_MENU"),
    ]);
  });

  it("refuses a tag on a test that reads no Mac fact, and reads a skip or a describe around a test", () => {
    const source = `
test.describe("the shell keys", { tag: MAC_ONLY_TAG }, () => {
  test.skip(process.platform !== "darwin", "the shell keys' default keys are the Mac's");
  test("Shift-Return adds a line", async () => {});
});
test("Linux starts with no screen", async () => {
  test.skip(process.platform !== "linux", "only Linux starts with no screen");
});
test("the composer grows", { tag: MAC_ONLY_TAG }, async () => {
  const keys = [];
  if (/^key(down|up)$/.test(type)) keys.push(type);
});
`;
    expect(macTests(source).map(({ line, tagged, reads }) => ({ line, tagged, reads }))).toEqual([
      { line: 4, tagged: true, reads: ['"darwin"'] },
      { line: 6, tagged: false, reads: [] },
      { line: 9, tagged: true, reads: [] },
    ]);
    expect(lint(source)).toEqual([
      { line: 9, message: expect.stringContaining("reads no Mac fact") },
    ]);
  });

  it("reads a file's skip for every test in it, and each test a loop makes as one", () => {
    const source = `
test.skip(process.platform !== "darwin", "the microphone permission is macOS's");
test("while macOS asks, a line explains", { tag: [PERF_TAG, MAC_ONLY_TAG] }, async () => {});
for (const operation of ["add", "update"] as const) {
  test(\`an addressed Mac downloads: \${operation}\`, async () => {});
}
`;
    expect(lint(source)).toEqual([{ line: 5, message: expect.stringContaining('"darwin"') }]);
  });
});

describe("the Linux journey jobs' untagged-skip check", () => {
  // devices.spec.ts on the PC's Linux place, PR #676's starter journeys,
  // before its Mac-only download tests carried the tag.
  const report = JSON.parse(
    readFileSync(new URL("./fixtures/mac-tag/linux-devices-results.json", import.meta.url), "utf8"),
  ) as { suites: Suite[] };

  it("names each test that skipped on Linux without the tag, and passes them once tagged", () => {
    expect(untaggedSkips(report).map(({ file, line, lane }) => `${file}:${line} ${lane}`)).toEqual([
      "devices.spec.ts:929 desktop",
      "devices.spec.ts:929 desktop",
      "devices.spec.ts:1898 desktop",
      "devices.spec.ts:1898 desktop",
      "devices.spec.ts:1898 desktop",
    ]);
    // The JSON report writes a tag without its "@".
    const tagged = structuredClone(report);
    for (const spec of tagged.suites.flatMap((suite) => suite.specs ?? []))
      if (spec.line !== 709) spec.tags = [MAC_ONLY_TAG.slice(1)];
    expect(untaggedSkips(tagged)).toEqual([]);
  });
});
