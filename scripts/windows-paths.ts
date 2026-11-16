import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { lightPath } from "./pr-paths.ts";

/**
 * Whether a combined batch runs the Windows installer check (docs/windows.md,
 * "The checks"): the captain's pick on INF-4243, "On each combined batch that
 * touches Windows-relevant files, and on every alpha". A path is
 * Windows-relevant when it changes what the Windows installer holds or how
 * it is checked: the desktop app's build, less what only the Mac or Linux
 * packages are made from, plus the Windows check's own files.
 *
 *   node scripts/windows-paths.ts --base <ref>   (batch-checks.yml's windows job)
 *
 * Plain Node with no install: it prints its verdict and writes
 * `windows=true|false` to $GITHUB_OUTPUT when that is set. An empty list or
 * an unreadable diff runs the check.
 */

/** A path only the Mac's or Linux's packages are made from. */
function otherSystemOnly(path: string): boolean {
  return (
    path === "electron-builder.linux.yml" ||
    path.startsWith("packaging/linux/") ||
    path.startsWith("packaging/mac/") ||
    path.startsWith("scripts/linux-") ||
    path.startsWith("scripts/mac-") ||
    path === "scripts/load-supervisor.c" ||
    path === "scripts/git-launcher.c"
  );
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/windows.yml";
const JOURNEY_CONFIG = "playwright.windows.config.ts";

/**
 * The Windows check's own files, read from the checkout rather than listed,
 * so a new step or helper is never missed: its workflow and the composite
 * actions that workflow uses, its installer config, this script, and its
 * journey's config and every test file the journey reaches by its imports.
 */
export function windowsCheckFiles(root = ROOT): { files: Set<string>; folders: string[] } {
  const files = new Set([WORKFLOW, "electron-builder.win.yml", "scripts/windows-paths.ts"]);
  const uses = readFileSync(join(root, WORKFLOW), "utf8").matchAll(
    /uses:\s*\.\/(\.github\/actions\/[\w-]+)/g,
  );
  const folders = [...new Set([...uses].map((use) => `${use[1]}/`))];
  const journey = readdirSync(join(root, "tests/windows")).map((name) => `tests/windows/${name}`);
  const queue = [JOURNEY_CONFIG, ...journey];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of readFileSync(join(root, file), "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const base = normalize(join(dirname(file), spec[1] as string)).replaceAll("\\", "/");
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
        (candidate) => candidate.startsWith("tests/") && existsSync(join(root, candidate)) && /\.tsx?$/.test(candidate),
      );
      if (found) queue.push(found);
    }
  }
  return { files, folders };
}

export function windowsPath(path: string, own = windowsCheckFiles()): boolean {
  if (own.files.has(path) || own.folders.some((folder) => path.startsWith(folder))) return true;
  return !lightPath(path) && !otherSystemOnly(path) && !path.startsWith(".github/");
}

/** Whether these changed paths run the Windows check; an unknown change runs it. */
export function windowsRuns(paths: readonly string[] | undefined, root = ROOT): boolean {
  if (paths === undefined || paths.length === 0) return true;
  const own = windowsCheckFiles(root);
  return paths.some((path) => windowsPath(path, own));
}

function changedSince(base: string): string[] | undefined {
  try {
    return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");
  const base = at >= 0 ? args[at + 1] : undefined;
  if (!base) throw new Error("usage: node scripts/windows-paths.ts --base <ref>");
  const paths = changedSince(base);
  const own = windowsCheckFiles();
  const windows = windowsRuns(paths);
  if (paths === undefined) console.log(`Could not read the change since ${base}; the Windows check runs.`);
  else
    console.log(
      windows
        ? `The batch touches what the Windows installer holds or how it is checked; the Windows check runs (${paths.filter((path) => windowsPath(path, own)).slice(0, 5).join(", ")}).`
        : `None of ${paths.length} changed paths reaches the Windows installer; the Windows check skips.`,
    );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `windows=${windows}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
