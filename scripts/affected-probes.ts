import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The probes a change runs (docs/test-cohorts.md, "Probes"). A probe is an
 * integration file that can fail with no code change, because it leans on
 * what the runner has: SSH and Remote Login stand-ins, dns-sd, release
 * rehearsals, the connection listener, real Playwright runs and whole-core
 * command-line runs. They run as vitest's `probe` project, never in the
 * integration shards. This local chooser runs only affected probes; CI runs
 * every probe on main and on request, never on pull requests. The
 * verify.yml linux-checks lane runs them all before every alpha and on demand.
 *
 *   node scripts/affected-probes.ts [--base <ref>] [--head <ref>] [--run]
 *
 * prints the probe files, each with why it runs, and exits 0 whether or not
 * any is affected. `--run` (`pnpm test:probes`) also runs them. A probe runs when the change edits
 *
 * 1. the probe file itself;
 * 2. a path its row below names: a directory ending in "/" matches what is
 *    under it, a file matches exactly; or
 * 3. a path of the lane itself (`LANE`), which runs every probe.
 *
 * A base that cannot be read runs every probe. A row naming a path that no
 * longer exists is refused, so a moved subject cannot silently stop its
 * probes running before the release does.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** What every probe depends on: how the lane picks and runs them, and the runner's packages. */
export const LANE = [
  "scripts/affected-probes.ts",
  "vitest.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  ".github/workflows/ci.yml",
  "tests/helpers/vitestGlobalSetup.ts",
  "tests/helpers/scratchDirs.ts",
  "tests/helpers/scratchDirCleanup.ts",
  "tests/helpers/runTempRoot.ts",
] as const;

/** The probe files, by what they reach outside the code, with the paths each group watches. */
export const PROBES = [
  {
    why: "work on another Mac: SSH, Remote Login and dns-sd stand-ins, the relay and the connection listener",
    files: [
      "src/core/devices/computerUpdate.test.ts",
      "src/core/devices/dnsSd.test.ts",
      "src/core/devices/joinCommand.test.ts",
      "src/core/devices/relay.test.ts",
      "src/core/devices/remoteLogin.test.ts",
      "src/core/devices/sshConnections.test.ts",
      "src/core/helper/cleanUp.test.ts",
      "src/core/helper/connect.test.ts",
      "src/core/helper/fromHome.test.ts",
      "src/core/helper/workingCopies.test.ts",
    ],
    paths: [
      "src/core/devices/",
      "src/core/helper/",
      "src/core/connection/",
      "src/core/placed/workDevices.ts",
      "src/shared/connection.ts",
      "src/shared/devices.ts",
      "src/shared/nearbyMacs.ts",
      "src/shared/remoteLogin.ts",
      "src/shared/sshConnection.ts",
      "src/shared/work.ts",
      "tests/helpers/computerClaude.ts",
      "tests/helpers/connectionClient.ts",
      "tests/helpers/dnsSdStandIn.ts",
      "tests/helpers/socketForward.ts",
      "tests/helpers/sshServer.ts",
      "tests/helpers/standInFirstmate.ts",
    ],
  },
  {
    why: "release rehearsals: the tap and release-asset publication, Homebrew's cask readers and the release-notes gate",
    files: [
      "tests/cask-consumers.test.ts",
      "tests/release-notes.test.ts",
      "tests/release-publication.test.ts",
    ],
    paths: [
      ".github/workflows/release.yml",
      "packaging/",
      "scripts/publish-release-asset.sh",
      "scripts/publish-tap.sh",
      "scripts/mark-mac-installation.mjs",
      "scripts/release-notes.ts",
      "scripts/tap-publication.ts",
      "src/core/releaseNotes/",
      "src/core/update/",
      "src/main/host/macInstallation.ts",
      "src/shared/update.ts",
      "tests/helpers/olderCask.ts",
      "tests/helpers/standInGh.ts",
    ],
  },
  {
    why: "real Playwright runs: the lanes and each run's evidence",
    files: ["tests/e2e-lanes.test.ts", "tests/run-evidence-playwright.test.ts"],
    paths: [
      "playwright.config.ts",
      "scripts/refuse-build-during-e2e.ts",
      "tests/e2e/globalSetup.ts",
      "tests/e2e/lanes.ts",
      "tests/e2e/micPreflight.ts",
      "tests/e2e/runEvidence.ts",
    ],
  },
  {
    why: "real Playwright runs frozen by the test: journey waits on the load clock",
    files: ["tests/load-clock.test.ts"],
    paths: [
      "patches/playwright-core@1.62.1.patch",
      "patches/playwright@1.62.1.patch",
      "tests/fixtures/load-clock/",
      "tests/helpers/budgets.ts",
    ],
  },
  {
    why: "nested vitest runs frozen by the test: unit limits and waits on the load clock",
    files: ["tests/wait-window.test.ts"],
    paths: [
      "patches/@vitest__runner@4.1.10.patch",
      "patches/vitest@4.1.10.patch",
      "tests/fixtures/frozen-work/",
      "tests/helpers/budgets.ts",
      "tests/helpers/waitWindow.ts",
    ],
  },
  {
    why: "whole-core sessions on the mock provider: the account evaluation and the benchmark's attempt",
    files: ["tests/account-eval.test.ts", "tests/bench-attempt.test.ts"],
    paths: [
      "scripts/bench/",
      "scripts/evals/",
      "tests/e2e/mockClaudeClient.ts",
      "tests/e2e/mockProvider.ts",
    ],
  },
  {
    why: "the benchmark's patch replay and task pool: real git apply and Python's tomllib",
    files: ["tests/bench-patch-pool.test.ts"],
    paths: ["scripts/bench/"],
  },
  {
    why: "command-line runs on the app's own storage: task export and the module runner",
    files: ["tests/export-tasks.test.ts", "tests/module-runner.test.ts"],
    paths: ["scripts/export-tasks.ts", "scripts/moduleRunner.ts", "scripts/task-records.ts"],
  },
  {
    why: "Secrets custody on a real Linux Secret Service: a private session bus and gnome-keyring, which the probe installs on a throwaway GitHub-hosted runner",
    files: ["src/main/host/linuxSecretCustody.test.ts"],
    paths: ["src/core/secrets/", "src/main/host/linuxSecretCustody.ts"],
  },
  {
    why: "the Claude client against a stand-in API, under the Firstmate's seat",
    files: ["src/core/claude/claudeFirstmateSession.integration.test.ts"],
    paths: [
      "src/core/claude/",
      "src/core/orchestrator/seat.ts",
      "tests/e2e/mockClaudeClient.ts",
      "tests/helpers/anthropicDialect.ts",
      "tests/helpers/claudeSeatHarness.ts",
      "tests/helpers/seatSession.ts",
    ],
  },
] as const;

/** Every probe file, in the order the rows list them. */
export const PROBE_FILES: readonly string[] = PROBES.flatMap((row) => row.files);

export type Reasons = Map<string, string[]>;

const covers = (path: string, file: string) => (path.endsWith("/") ? file.startsWith(path) : file === path);

/** The probes the changed paths reach, each with why; every probe when `changed` is unknown. */
export function selectProbes(
  changed: readonly string[] | undefined,
  exists: (path: string) => boolean = (path) => existsSync(join(ROOT, path)),
): Reasons {
  for (const path of [...LANE, ...PROBES.flatMap((row) => [...row.files, ...row.paths])]) {
    if (!exists(path)) throw new Error(`Stale probe path: ${path} no longer exists`);
  }
  const reasons: Reasons = new Map();
  const add = (file: string, why: string) => reasons.set(file, [...(reasons.get(file) ?? []), why]);
  if (changed === undefined) {
    for (const file of PROBE_FILES) add(file, "the change's base could not be read");
    return reasons;
  }
  const lane = changed.filter((file) => LANE.some((path) => covers(path, file)));
  for (const row of PROBES) {
    const edits = changed.filter((file) => row.paths.some((path) => covers(path, file)));
    for (const file of row.files) {
      if (changed.includes(file)) add(file, "the change edits this probe");
      if (edits.length > 0) add(file, `the change edits ${edits.slice(0, 3).join(", ")}`);
      if (lane.length > 0) add(file, `the change edits the lane's ${lane.slice(0, 3).join(", ")}`);
    }
  }
  return reasons;
}

/** The paths a change edits from its merge base, or undefined when that base cannot be read. */
export function changedPaths(base: string, head: string): string[] | undefined {
  try {
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: ROOT,
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
  const value = (flag: string, fallback: string) => {
    const at = args.indexOf(flag);
    return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
  };
  const base = value("--base", "origin/main");
  const reasons = selectProbes(changedPaths(base, value("--head", "HEAD")));
  const files = PROBE_FILES.filter((file) => reasons.has(file));
  const lines =
    files.length === 0
      ? [`No probe covers what this change edits since ${base}.`]
      : files.map((file) => `- \`${file}\`: ${(reasons.get(file) ?? []).join("; ")}`);
  console.log(lines.join("\n"));
  if (!args.includes("--run")) return;
  if (files.length === 0) return;
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "probe", ...files], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
