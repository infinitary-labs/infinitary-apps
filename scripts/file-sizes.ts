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
 * The headroom (docs/testing.md, "The size check's headroom") reads the same
 * line against a change: `--headroom --base <commit>` refuses a code file the
 * change grows past the warning line, or grows further past it, so two
 * changes that each add lines to a large file cannot together pass the
 * ceiling in a merge batch.
 *
 *   node scripts/file-sizes.ts          exits 1 naming each file out of step
 *   node scripts/file-sizes.ts --list   every code file over the ceiling, with its lines
 *   node scripts/file-sizes.ts --warn   exits 1 naming each code file over the warning line
 *   node scripts/file-sizes.ts --headroom --base <commit>
 *                                       exits 1 naming each code file the change grows past the warning line
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
 * ceiling. The branch check reads it only against a change's own growth
 * (`sizeHeadroom`, the captain's pick on INF-6259's audit); no merge batch
 * or release reads it.
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

/**
 * Each code file a change grows past the warning line, or further past it:
 * `after` holds the change's code files with their lines now, and `before`
 * their lines at the change's base, under the path they had there; a file
 * the base lacks starts at 0. A file the change shrinks or leaves the same
 * length passes, wherever it stands, so a split never has to finish in one
 * change.
 */
export function sizeHeadroom(
  before: Record<string, number | undefined>,
  after: Record<string, number>,
): string[] {
  return Object.entries(after)
    .filter(([path, lines]) => lines > SIZE_WARNING_LINE && lines > (before[path] ?? 0))
    .sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
    .map(([path, lines]) => {
      const was = before[path] ?? 0;
      return `${path}: ${was} lines at the change's base, ${lines} now; a change may not grow a code file past the ${SIZE_WARNING_LINE}-line warning line, so split it along its owners first`;
    });
}

/**
 * The lines of each code file that differs from `base` in the working copy,
 * now and at `base`: a renamed file is measured at the base under its old
 * path, so moving a large file is not read as growing it, and an untracked
 * file counts as new.
 */
function changeSizes(root: string, base: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const before: Record<string, number | undefined> = {};
  const after: Record<string, number> = {};
  const fields = git(["diff", "--name-status", "-z", "-M", "--diff-filter=ACMR", base]).split("\0").filter(Boolean);
  const pairs: [string, string | undefined][] = [];
  for (let at = 0; at < fields.length; ) {
    const status = fields[at++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[at++]!;
      pairs.push([fields[at++]!, status.startsWith("R") ? from : undefined]);
    } else {
      const path = fields[at++]!;
      pairs.push([path, status === "A" ? undefined : path]);
    }
  }
  for (const path of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))
    pairs.push([path, undefined]);
  for (const [path, from] of pairs) {
    if (!isCodeFile(path)) continue;
    after[path] = lineCount(readFileSync(resolve(root, path), "utf8"));
    before[path] = from === undefined ? undefined : lineCount(git(["show", `${base}:${from}`]));
  }
  return { before, after };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const treeSizes = () => {
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
    return sizes;
  };
  if (process.argv.includes("--headroom")) {
    const base = process.argv[process.argv.indexOf("--base") + 1];
    if (!process.argv.includes("--base") || !base) throw new Error("--headroom needs --base <commit>");
    const { before, after } = changeSizes(root, base);
    const refusals = sizeHeadroom(before, after);
    if (refusals.length) {
      printErrors(refusals, { title: "Size headroom" });
      process.exitCode = 1;
    }
  } else if (process.argv.includes("--list")) {
    for (const [path, lines] of Object.entries(treeSizes()).filter(([, lines]) => lines > SIZE_CEILING).sort(([, a], [, b]) => b - a))
      console.log(`${String(lines).padStart(7)}  ${path}`);
  } else if (process.argv.includes("--warn")) {
    const warnings = sizeWarnings(treeSizes(), OVER_CEILING);
    if (warnings.length) {
      printErrors(warnings, { title: "Size warning line" });
      process.exitCode = 1;
    }
  } else {
    const problems = sizeProblems(treeSizes(), OVER_CEILING);
    if (problems.length) {
      printErrors(problems, { title: "Size check" });
      process.exitCode = 1;
    }
  }
}
