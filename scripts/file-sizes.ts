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
 * The warning line sits below the ceiling (docs/testing.md, "The size
 * check's warning line"). `--warn` fails naming each code file past it,
 * largest first, less the files on `OVER_CEILING`, whose splits the list
 * already owns; `size-warning.yml` runs it after a change
 * reaches main, and nothing waits on it, so a file is split before it
 * reaches the ceiling and holds a merge.
 *
 *   node scripts/file-sizes.ts          exits 1 naming each file out of step
 *   node scripts/file-sizes.ts --list   every code file over the ceiling, with its lines
 *   node scripts/file-sizes.ts --warn   exits 1 naming each code file over the warning line
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printErrors } from "./github-errors.ts";

/** The captain's bar: a code file longer than this is too long. */
export const SIZE_CEILING = 2000;

/**
 * The warning line, the captain's pick for INF-4496's fix 3 ("1,800
 * lines"): a code file past it gets a split task before it reaches the
 * ceiling. It only warns: no merge or release reads it.
 */
export const SIZE_WARNING_LINE = 1800;

/** The extensions of the files the check reads; data, lockfiles and pictures are not code. */
export const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".c", ".h", ".sh", ".css"];

/**
 * The code files already over the ceiling when the check began. It only
 * shrinks: each piece of INF-2625's plan that brings a file under the ceiling
 * removes its entry in the same pull request.
 */
export const OVER_CEILING: readonly string[] = ["tests/helpers/phoneHome.ts"];

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

/**
 * Each code file over the warning line and not on the list, largest first
 * and by path among equals, as one line: the first is the file the next
 * split takes.
 */
export function sizeWarnings(sizes: Record<string, number>, listed: readonly string[]): string[] {
  const onList = new Set(listed);
  return Object.entries(sizes)
    .filter(([path, lines]) => lines > SIZE_WARNING_LINE && !onList.has(path))
    .sort(([pathA, a], [pathB, b]) => b - a || pathA.localeCompare(pathB))
    .map(
      ([path, lines]) =>
        `${path}: ${lines} lines, over the ${SIZE_WARNING_LINE}-line warning line; split it along its owners before it reaches the ${SIZE_CEILING}-line ceiling`,
    );
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
  } else if (process.argv.includes("--warn")) {
    const warnings = sizeWarnings(sizes, OVER_CEILING);
    if (warnings.length) {
      printErrors(warnings, { title: "Size warning line" });
      process.exitCode = 1;
    }
  } else {
    const problems = sizeProblems(sizes, OVER_CEILING);
    if (problems.length) {
      printErrors(problems, { title: "Size check" });
      process.exitCode = 1;
    }
  }
}
