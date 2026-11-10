import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The quick check a crewmate runs before every push (INF-2588's report, fix 1;
 * INF-2674's typecheck fix; INF-2970's fix to run the pull request check's
 * lints here too): Biome on only the files this branch changed, the adherence
 * lint on its renderer files, every node script `pnpm check` runs (the
 * project lints and the generated-file checks), the release-notes check the
 * pull request runs first, and the whole-project typecheck. Together they take
 * seconds, so they run side by side and print in order. It is not gated by CI mode, so the Mac mini can
 * run it; the full lint and the typecheck also stay in the pull request's
 * `typecheck-lint-build` check (INF-2074, docs/testing.md "Where the heavy
 * checks run").
 */
// Its stderr rides a failure's message, so a probe that misses prints nothing.
const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * The commit the branch grew from: its merge base with main, or HEAD's own
 * commit in a checkout with no main to compare with, such as the main
 * check's one-commit checkout of a push, where nothing is committed since.
 */
export function baseRef(cwd?: string): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref], cwd);
    } catch {
      // Try the next name.
    }
  }
  return git(["rev-parse", "HEAD"], cwd);
}

/** Files that exist now and differ from the branch's base, committed or not. */
export function changedFiles(base = baseRef()): string[] {
  const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", base]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...new Set([...tracked, ...untracked])].filter(Boolean);
}

/**
 * The node scripts `pnpm check` runs after its whole-project Biome, read from
 * package.json so a lint added there runs here too. `checks-mode.ts` is left
 * out: it is the CI-mode refusal this quick check exists to step around.
 */
export function checkScripts(check: string): string[][] {
  return check
    .split("&&")
    .map((command) => command.trim().split(/\s+/))
    .filter(([program, script]) => program === "node" && script?.startsWith("scripts/"))
    .filter(([, script]) => script !== "scripts/checks-mode.ts")
    .map(([, ...args]) => args);
}

export interface Step {
  label: string;
  command: string;
  args: string[];
}

/**
 * Biome on every changed file, so Biome's own configuration picks which of
 * them it checks, as it does for the whole-project Biome in `pnpm check`: its
 * `files.includes` and the languages it knows. A list of extensions here
 * dropped the queue's .mjs sources, so a formatting slip in one passed this
 * check and failed the pull request's (INF-3297).
 */
export function biomeStep(files: string[]): Step | undefined {
  if (!files.length) return undefined;
  return {
    label: "biome",
    command: "pnpm",
    args: [
      "exec",
      "biome",
      "check",
      "--no-errors-on-unmatched",
      "--files-ignore-unknown=true",
      ...files,
    ],
  };
}

function run(step: Step): Promise<{ step: Step; ok: boolean; output: string }> {
  return new Promise((done) => {
    const child = spawn(step.command, step.args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => done({ step, ok: false, output: `${output}${error.message}\n` }));
    child.on("close", (status) => done({ step, ok: status === 0, output }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = baseRef();
  const files = changedFiles(base);
  const renderer = files.filter((file) => /^src\/renderer\/.*\.tsx?$/.test(file));
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  console.log(`check:changed: ${files.length} changed file(s)`);
  const steps: Step[] = [];
  const biome = biomeStep(files);
  if (biome) steps.push(biome);
  if (renderer.length)
    steps.push({
      label: "adherence",
      command: "pnpm",
      args: [
        "exec",
        "eslint",
        "--config",
        "eslint.adherence.config.mjs",
        "--no-config-lookup",
        ...renderer,
      ],
    });
  for (const args of checkScripts(scripts.check ?? ""))
    steps.push({ label: args.join(" "), command: "node", args });
  // The pull request's first step. It reads commits, so it waits for the
  // branch's first one; before that there is nothing to push.
  if (base !== git(["rev-parse", "HEAD"]))
    steps.push({
      label: "release notes",
      command: "node",
      args: ["scripts/release-notes.ts", "change", "--base", base],
    });
  else console.log("check:changed: no commit since main yet, so the release-notes check waits");
  // Called directly, not through `pnpm typecheck`, which CI mode refuses.
  steps.push({ label: "typecheck", command: "node", args: ["scripts/typecheck.ts", "--pretty"] });
  const results = await Promise.all(steps.map(run));
  for (const { step, ok, output } of results) {
    process.stdout.write(output);
    if (!ok) console.error(`check:changed: ${step.label} failed`);
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
