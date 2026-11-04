import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The lint a crewmate runs before it pushes (INF-2588's report, fix 1): only the
 * files this branch changed, plus the generated-file checks. It is not gated by
 * CI mode, so the Mac mini can run it; the full lint stays in the pull request's
 * `typecheck-lint-build` check (INF-2074, docs/testing.md "Where the heavy
 * checks run").
 */
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

function baseRef(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", ref);
    } catch {
      // Try the next name.
    }
  }
  return "HEAD";
}

/** Files that exist now and differ from the branch's base, committed or not. */
export function changedFiles(base = baseRef()): string[] {
  const tracked = git("diff", "--name-only", "--diff-filter=ACMR", base).split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked])].filter(Boolean);
}

const GENERATORS = [
  "generate-phone-contract.ts",
  "generate-phone-theme.ts",
  "generate-phone-scene.ts",
  "generate-phone-cards.ts",
  "generate-runbook-fallback.ts",
];

function run(label: string, command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) console.error(`check:changed: ${label} failed`);
  return result.status === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = changedFiles();
  const lintable = files.filter((file) => /\.(tsx?|json|md)$/.test(file));
  const renderer = files.filter((file) => /^src\/renderer\/.*\.tsx?$/.test(file));
  console.log(`check:changed: ${files.length} changed file(s)`);
  const results: boolean[] = [];
  if (lintable.length)
    results.push(
      run("biome", "pnpm", ["exec", "biome", "check", "--no-errors-on-unmatched", ...lintable]),
    );
  if (renderer.length)
    results.push(
      run("adherence", "pnpm", [
        "exec",
        "eslint",
        "--config",
        "eslint.adherence.config.mjs",
        "--no-config-lookup",
        ...renderer,
      ]),
    );
  for (const generator of GENERATORS)
    results.push(run(generator, "node", [`scripts/${generator}`, "--check"]));
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
