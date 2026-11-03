import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether a pull request's Linux automatic startup fixtures have anything to
 * check (INF-2486 cut F, approved by the captain with cuts B to E). A change
 * whose every path is prose or another workflow cannot move the startup
 * classifier, its fixture scripts, the action that runs them or ci.yml's own
 * job, so `ci.yml`'s `linux-startup` job skips its fixture step and still
 * reports. Any other path, an empty list or an unreadable diff runs it.
 *
 *   node scripts/startup-paths.ts --base <ref>   (ci.yml's linux-startup job)
 *
 * Plain Node with no install, like the release notes step: it prints the
 * verdict and writes `run=true|false` to $GITHUB_OUTPUT when that is set.
 */

/** The one workflow that defines the startup job itself. */
const CI_WORKFLOW = ".github/workflows/ci.yml";

/** A path that cannot change what the startup fixtures check. */
export function proseOrOtherWorkflow(path: string): boolean {
  return (
    path.startsWith("docs/") ||
    path.startsWith("primitives/") ||
    path.startsWith("release-notes/") ||
    path.endsWith(".md") ||
    (path.startsWith(".github/workflows/") && path !== CI_WORKFLOW)
  );
}

/** True when the fixtures must run; an unknown change always runs them. */
export function startupReached(paths: readonly string[] | undefined): boolean {
  if (paths === undefined || paths.length === 0) return true;
  return !paths.every(proseOrOtherWorkflow);
}

/** Every path the change touches since base, a rename counted at both ends. */
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
  if (!base) throw new Error("usage: node scripts/startup-paths.ts --base <ref>");
  const paths = changedSince(base);
  const run = startupReached(paths);
  console.log(
    paths === undefined
      ? `Could not read the change since ${base}; the startup fixtures run.`
      : run
        ? `The change touches a path the startup fixtures check; they run.`
        : `Every one of ${paths.length} changed paths is docs, primitives, Markdown, release notes or a workflow other than ci.yml; the startup fixtures skip.`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
