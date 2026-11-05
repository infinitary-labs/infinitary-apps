/**
 * The size check (INF-2625's plan, the captain's "i'd consider any file
 * longer than 2000 lines as too long"; docs/testing.md, "The size check").
 * It refuses a code file the project tracks that is longer than
 * `SIZE_CEILING` lines, unless the file is on `OVER_CEILING`, the list of
 * files that were already longer when the check began. The list only
 * shrinks: a listed file that is back under the ceiling, or gone, must leave
 * it, and a new entry is a move its pull request explains. A code file is
 * one with a code extension, less generated files, vendored code, fixtures
 * and the design skill's built bundle. Plain Node type stripping, no
 * install; `pnpm check` runs it.
 *
 *   node scripts/file-sizes.ts          exits 1 naming each file out of step
 *   node scripts/file-sizes.ts --list   every code file over the ceiling, with its lines
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The captain's bar: a code file longer than this is too long. */
export const SIZE_CEILING = 2000;

/** The extensions of the files the check reads; data, lockfiles and pictures are not code. */
export const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".c", ".h", ".sh", ".css"];

/**
 * The code files already over the ceiling when the check began. It only
 * shrinks: each piece of INF-2625's plan that brings a file under the ceiling
 * removes its entry in the same pull request.
 */
export const OVER_CEILING: readonly string[] = [
  "ios/Infinitary/InfinitaryUITests/PhoneJourney.swift",
  "src/core/browser/taskBrowsers.test.ts",
  "src/core/browser/taskBrowsers.ts",
  "src/core/core.test.ts",
  "src/core/orchestrator/cardService.test.ts",
  "src/core/orchestrator/cardService.ts",
  "src/core/orchestrator/crewSupervisor.test.ts",
  "src/core/orchestrator/crewSupervisor.ts",
  "src/core/orchestrator/firstmateAgent.test.ts",
  "src/core/orchestrator/firstmateAgent.ts",
  "src/core/orchestrator/wakes.ts",
  "src/core/services.ts",
  "src/core/tasks/taskProtocol.test.ts",
  "src/core/tasks/taskService.ts",
  "tests/e2e/mockProvider.ts",
  "tests/e2e/task-browser.spec.ts",
  "tests/helpers/phoneHome.ts",
];

/** Whether the check reads this tracked file. */
export function isCodeFile(path: string): boolean {
  if (!CODE_EXTENSIONS.some((extension) => path.endsWith(extension))) return false;
  const parts = path.split("/");
  if (parts.includes("vendor") || parts.includes("fixtures") || parts.includes("Fixtures")) return false;
  if (/\.generated\.[^/]+$/.test(path)) return false;
  return path !== ".claude/skills/infinitary-design/_ds_bundle.js";
}

/** The number of lines in a file's text, as `wc -l` counts them. */
export function lineCount(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Each problem with the code files' sizes against the list, as one line. */
export function sizeProblems(sizes: Record<string, number>, listed: readonly string[]): string[] {
  const problems: string[] = [];
  const onList = new Set(listed);
  for (const [path, lines] of Object.entries(sizes)) {
    if (lines > SIZE_CEILING && !onList.has(path))
      problems.push(
        `${path}: ${lines} lines, over the ${SIZE_CEILING}-line ceiling; split it along its owners (the list in scripts/file-sizes.ts only shrinks)`,
      );
  }
  for (const path of listed) {
    const lines = sizes[path];
    if (lines === undefined)
      problems.push(`scripts/file-sizes.ts: ${path} is listed but is no longer a code file the project tracks; remove its entry`);
    else if (lines <= SIZE_CEILING)
      problems.push(`scripts/file-sizes.ts: ${path} is ${lines} lines, at or under the ceiling; remove its entry, and the list shrinks`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const sizes: Record<string, number> = {};
  for (const path of tracked) {
    if (!isCodeFile(path)) continue;
    let text: string;
    try {
      text = readFileSync(resolve(root, path), "utf8");
    } catch {
      continue; // deleted in the working copy and not yet staged
    }
    sizes[path] = lineCount(text);
  }
  if (process.argv.includes("--list")) {
    for (const [path, lines] of Object.entries(sizes).filter(([, lines]) => lines > SIZE_CEILING).sort(([, a], [, b]) => b - a))
      console.log(`${String(lines).padStart(7)}  ${path}`);
  } else {
    const problems = sizeProblems(sizes, OVER_CEILING);
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    }
  }
}
