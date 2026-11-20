import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LISTED_WAITS, readsFile, waitProblems, waitsIn } from "../scripts/main-thread-waits";

/**
 * The wait check (INF-2061's approved plan: "It refuses execSync,
 * execFileSync and spawnSync in the app's main process, except listed
 * ones"). `pnpm check` runs it over the tree; here, what it refuses. The
 * listed case is the code's own file; the refused ones are the shapes a
 * change would add.
 */
describe("the wait check", () => {
  const INSTALLATION = "src/main/host/macInstallation.ts";
  const installation = readFileSync(INSTALLATION, "utf8");
  // Every listed file's own waits, so a later listing keeps the code's own list passing.
  const listedWaits = () =>
    Object.keys(LISTED_WAITS).flatMap((path) => waitsIn(path, readFileSync(path, "utf8")));

  it("finds the listed calls in their files, and passes them", () => {
    const waits = waitsIn(INSTALLATION, installation);
    expect(waits.map((wait) => wait.call)).toEqual(["execFileSync"]);
    expect(installation.split("\n")[(waits[0]?.line ?? 0) - 1]).toContain("execFileSync(");
    expect(waitProblems(listedWaits(), LISTED_WAITS)).toEqual([]);
  });

  it("refuses an unlisted wait in the core, called by name or through the module", () => {
    const BRANCHES = "src/core/workspace/branches.ts";
    const text = [
      'import { execFileSync, spawn } from "node:child_process";',
      'import * as child from "node:child_process";',
      "export function currentBranch(dir: string): string {",
      '  return execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" });',
      "}",
      "export function status(dir: string): string {",
      '  return child.spawnSync("git", ["-C", dir, "status"]).stdout.toString();',
      "}",
    ].join("\n");
    const waits = waitsIn(BRANCHES, text);
    expect(waits).toEqual([
      { path: BRANCHES, line: 4, call: "execFileSync" },
      { path: BRANCHES, line: 7, call: "spawnSync" },
    ]);
    const problems = waitProblems([...waits, ...listedWaits()], LISTED_WAITS);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^src\/core\/workspace\/branches\.ts:4: execFileSync /);
  });

  it("reads only code: a call a comment, a string or a template's words name is no call", () => {
    const text = [
      "// execSync would hold the main thread here.",
      "/** Never spawnSync: the window freezes. */",
      'const advice = "use execFile, not execFileSync";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template
      "const line = `execSync is refused ${advice.length} times`;",
      "const worker = String.raw`require('node:child_process').execSync('true')`;",
    ].join("\n");
    expect(waitsIn("src/core/advice.ts", text)).toEqual([]);
    // Code inside a template's ${...} is code.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template
    expect(waitsIn("src/core/advice.ts", "const out = `${execSync('true')}`;")).toEqual([
      { path: "src/core/advice.ts", line: 1, call: "execSync" },
    ]);
  });

  it("drops a listed file that no longer waits, and a listing with no reason", () => {
    expect(waitProblems([], { [INSTALLATION]: "a reason" })).toEqual([
      `scripts/main-thread-waits.ts: LISTED_WAITS holds ${INSTALLATION}, which no longer waits on another program; remove the entry`,
    ]);
    const waits = waitsIn(INSTALLATION, installation);
    expect(waitProblems(waits, { [INSTALLATION]: " " })).toEqual([
      `scripts/main-thread-waits.ts: ${INSTALLATION} is listed with no reason`,
    ]);
  });

  it("reads the code the main process runs, never the window's, a preload's or a test", () => {
    expect(readsFile("src/core/services.ts")).toBe(true);
    expect(readsFile("src/main/host/macInstallation.ts")).toBe(true);
    expect(readsFile("src/shared/forge.ts")).toBe(true);
    expect(readsFile("src/renderer/src/app/HomeScreen.tsx")).toBe(false);
    expect(readsFile("src/preload/index.ts")).toBe(false);
    expect(readsFile("src/core/freeze/freezeRecorder.test.ts")).toBe(false);
  });
});
