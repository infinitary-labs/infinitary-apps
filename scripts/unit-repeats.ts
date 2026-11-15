import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths, PROBE_FILES } from "./affected-probes.ts";
import { MAC_UNIT_FILES } from "./mac-unit-tests.ts";
import { prRuns } from "./pr-paths.ts";
import { directUnitReach, unitFiles, VITEST_FILE } from "./unit-reach.ts";

/**
 * The captain's INF-2273 override to INF-2259: every edited Vitest file
 * gets its ordinary local run plus two more, including Linux-eligible files.
 * INF-2394 measure 3 adds one local round for unedited direct importers and
 * literal path readers; a data file counts as part of the module importing it
 * (INF-2426), and so does served text such as the generated runbook fallback
 * (INF-2925). No other transitive reach or added CI jobs; the pull request's
 * build check runs each edited file once more on Linux (`--reach`). Native files still require a Mac.
 *
 *   node scripts/unit-repeats.ts [--base <ref>] [--head <ref>] [--workers <n>] [--shard <index/count>] [--run]
 *   node scripts/unit-repeats.ts --reach [--base <ref>] [--run]   (the pull request's build check:
 *     edited test files and their unedited direct readers, once, on Linux)
 *
 * The existing changed-path reader owns selection. Fresh rounds stop at the
 * first failure or interruption, without retries. An unreadable base fails.
 * Explicit workers bound a local batch to its caller's load declaration;
 * optional Vitest sharding divides disjoint local batches, not extra CI gates.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** INF-2259 accepted override: ordinary coverage plus two more rounds. */
export const REPEATS = 3;

export type Selection = { repeat: string[]; onMac: string[] };
export type LocalSelection = Selection & { once: string[] };

/** Edited tests own three rounds; unedited direct readers own just one. */
export function selectLocalUnits(changed: readonly string[], root = ROOT): LocalSelection {
  const edited = selectRepeats(changed, (file) => existsSync(join(root, file)));
  const once = directUnitReach(changed, unitFiles(root), root);
  const mac = new Set<string>(MAC_UNIT_FILES);
  return {
    ...edited,
    once,
    onMac: [...edited.onMac, ...once.filter((file) => mac.has(file))].sort(),
  };
}

/**
 * The pull request's build check runs the unedited direct readers once, on
 * Linux, in the in-memory cohorts and the integration cohort: an integration
 * reader such as tests/release-workflows.test.ts was listed and never run, so
 * its break merged (INF-2478). It runs each edited Vitest file once there too,
 * beside its three local rounds: PRs #1398, #1455 and #1420 edited tests that
 * passed on the crewmate's Mac and first failed on Linux in the merge batch
 * (INF-3690's gap 3, the captain's "Yes: start it now"). A browser file
 * runs here too, in the browser project, when the browser step skips: a
 * change to src/shared/cards.ts alone reached twelve browser tests and ran
 * none (INF-2999). Naming the browser project costs a round with no browser
 * file nothing, and the step before installs the Chromium it draws in.
 * Three kinds stay with another run, listed apart with where each runs: an
 * unedited Mac-listed reader with the crewmate's local round, a probe with
 * main's full check, since it can fail with no code change
 * (docs/test-cohorts.md, "Probes"), and a browser file with the browser step
 * when the change touches the renderer or its browser tests, since that step
 * then runs every browser file.
 */
export const REACH_PROJECTS = ["pure", "unit", "unit-isolated", "integration", "browser"];

export type LinuxReach = { run: string[]; elsewhere: { file: string; where: string }[] };

export function selectLinuxReach(changed: readonly string[], root = ROOT): LinuxReach {
  const mac = new Set<string>(MAC_UNIT_FILES);
  const probes = new Set<string>(PROBE_FILES);
  // The paths step's own verdict on the same change (scripts/pr-paths.ts).
  // This list leaves out a rename's old path, which that step reads too, so
  // at worst a browser file runs in both steps, and never in neither.
  const browserStep = prRuns(changed).browser;
  const reach: LinuxReach = { run: [], elsewhere: [] };
  const edited = new Set(selectRepeats(changed, (file) => existsSync(join(root, file))).repeat);
  const readers = directUnitReach(changed, unitFiles(root), root);
  for (const file of [...new Set([...edited, ...readers])].toSorted()) {
    // Linux runs every file, a Mac-listed one's portable cases included
    // (scripts/mac-unit-tests.ts), so an edited one runs here too: #1420's
    // edited tests/run-temp-root.test.ts is Mac-listed and failed on Linux.
    if (mac.has(file) && !edited.has(file))
      reach.elsewhere.push({ file, where: "needs a Mac: the crewmate's local round" });
    else if (probes.has(file))
      reach.elsewhere.push({ file, where: "a probe: main's full check runs every probe" });
    else if (file.startsWith("tests/browser/") && browserStep)
      reach.elsewhere.push({
        file,
        where: "a browser test: the browser step runs every browser test for this change",
      });
    else reach.run.push(file);
  }
  return reach;
}

/**
 * One round, no retry, and a JSON report of the files that ran. Naming
 * reporters drops the GitHub one Vitest adds on its own inside GitHub
 * Actions, so it is named again there: a failure stays an annotation the
 * check's summary shows (docs/testing.md, "A failed check says why").
 */
export function reachArgs(
  files: readonly string[],
  reportFile: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return [
    "exec",
    "vitest",
    "run",
    "--retry",
    "0",
    "--reporter=default",
    ...(env.GITHUB_ACTIONS === "true" ? ["--reporter=github-actions"] : []),
    "--reporter=json",
    `--outputFile.json=${reportFile}`,
    ...REACH_PROJECTS.flatMap((project) => ["--project", project]),
    ...files,
  ];
}

/** The selected files Vitest's report does not show running: the step fails on any. */
export function unreported(
  files: readonly string[],
  report: { testResults?: { name: string }[] } | undefined,
  root = ROOT,
): string[] {
  const ran = new Set((report?.testResults ?? []).map((result) => relative(root, result.name)));
  return files.filter((file) => !ran.has(file));
}

/**
 * The most selected test files one Vitest run of the reader step takes (INF-4163).
 * The pure and unit projects share one module cache per worker (isolate: false), so a worker keeps what each file
 * leaves behind - its modules, state a test kept, native memory the heap does not count - until its run ends.
 * A branch whose selection reached 454 files ran two such workers at 3.2 and 2.4 GB on the check's runner, which has
 * 7.9 GB and no swap, and the same step on a sibling branch lost its runner.
 * A wider selection runs as several runs one after another, each with fresh workers, so a worker's memory follows
 * one run's files rather than the whole selection's.
 * On that runner, every file this step can select (1,239) in runs of at most 100 took 26 minutes, its largest worker
 * held 2.4 GB, and at least 2.1 GB stayed free except while tests/checks-mode.test.ts started the quick check's
 * programs all at once; runs of at most 200 saved 89 seconds and let a worker reach 2.9 GB.
 */
export const REACH_RUN_FILES = 100;

/** The selection cut in order into the fewest runs of at most `most` files, of nearly equal size. */
export function reachRuns(files: readonly string[], most = REACH_RUN_FILES): string[][] {
  const count = Math.ceil(files.length / most);
  const size = Math.ceil(files.length / count);
  return Array.from({ length: count }, (_, run) => files.slice(run * size, (run + 1) * size));
}

/**
 * Run the selected files once, in runs of at most REACH_RUN_FILES one after another. Every run goes, so one push
 * shows each failing reader; a failed run, an interrupted one, which ends the step there, or a file no run's report
 * shows fails it.
 */
export function runLinuxReach(
  files: readonly string[],
  run: (args: string[], reportFile: string) => number | null,
  report: (lines: string[]) => void,
  root = ROOT,
): number {
  if (files.length === 0) return 0;
  const runs = reachRuns(files);
  if (runs.length > 1)
    report([
      `The ${files.length} selected files run as ${runs.length} Vitest runs of at most ${REACH_RUN_FILES} files, one after another, each with fresh workers.`,
    ]);
  const dir = mkdtempSync(join(tmpdir(), "unit-reach-"));
  try {
    const ran: { name: string }[] = [];
    let failed = 0;
    for (const [index, part] of runs.entries()) {
      const file = join(dir, `report-${index + 1}.json`);
      const status = run(reachArgs(part, file), file);
      if (status === null) return failed || 1;
      if (status !== 0) {
        failed ||= status;
        continue;
      }
      if (existsSync(file)) ran.push(...(JSON.parse(readFileSync(file, "utf8")).testResults ?? []));
    }
    if (failed !== 0) return failed;
    const missing = unreported(files, { testResults: ran }, root);
    if (missing.length === 0) return 0;
    report([
      `These selected test files did not run in ${REACH_PROJECTS.join(", ")}:`,
      ...missing.map((path) => `- \`${path}\``),
    ]);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** All edited surviving Vitest files run locally; identify their native prerequisites. */
export function selectRepeats(
  changed: readonly string[],
  exists: (path: string) => boolean = (path) => existsSync(join(ROOT, path)),
): Selection {
  const files = changed.filter((path) => VITEST_FILE.test(path) && exists(path)).toSorted();
  const mac = new Set<string>(MAC_UNIT_FILES);
  return {
    repeat: files,
    onMac: files.filter((path) => mac.has(path)),
  };
}

/** Keep every round on Vitest's own shard, with the complete candidate set. */
export function repetitionArgs(
  files: readonly string[],
  shard?: string,
  workers?: string,
): string[] | undefined {
  if (workers !== undefined && !/^[1-9]\d*$/.test(workers))
    throw new Error(`Invalid worker count: ${workers}`);
  let split: string[] = [];
  if (shard !== undefined) {
    const parts = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
    const index = Number(parts?.[1]);
    const total = Number(parts?.[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total)
      throw new Error(`Invalid repetition shard: ${shard}`);
    // Vitest refuses more shards than files. Empty shards own no work; the
    // others use the available file count, without passWithNoTests hiding a
    // real selection error in a nonempty shard.
    const count = Math.min(total, files.length);
    if (index > count) return undefined;
    if (count > 1) split = ["--shard", `${index}/${count}`];
  }
  return [
    "exec",
    "vitest",
    "run",
    "--retry",
    "0",
    ...(workers === undefined ? [] : ["--maxWorkers", workers]),
    ...split,
    ...files,
  ];
}

/** Three fresh invocations (ordinary coverage plus two), never a retry; any failed or interrupted round ends this shard. */
export function runRepetitions(
  files: readonly string[],
  shard: string | undefined,
  run: (args: string[]) => number | null,
  report: (lines: string[]) => void,
  workers?: string,
): number {
  if (files.length === 0) return 0;
  const command = repetitionArgs(files, shard, workers);
  if (command === undefined) {
    report([`Shard ${shard} owns no selected test files.`]);
    return 0;
  }
  for (let round = 1; round <= REPEATS; round++) {
    report([`Round ${round} of ${REPEATS}`]);
    const status = run(command);
    if (status !== 0) {
      report([`Round ${round} of ${REPEATS} failed; later rounds did not run.`]);
      return status ?? 1;
    }
  }
  report([`All ${REPEATS} rounds passed.`]);
  return 0;
}

/** Run affected readers once before the edited-file rounds, stopping on any failure. */
export function runLocalUnits(
  selection: LocalSelection,
  shard: string | undefined,
  run: (args: string[]) => number | null,
  report: (lines: string[]) => void,
  workers?: string,
): number {
  if (selection.once.length) {
    const command = repetitionArgs(selection.once, shard, workers);
    if (command) {
      report(["Direct importers and path readers: one local round."]);
      const status = run(command);
      if (status !== 0) {
        report(["Direct-reader round failed; edited-file rounds did not run."]);
        return status ?? 1;
      }
      report(["Direct-reader round passed."]);
    }
  }
  return runRepetitions(selection.repeat, shard, run, report, workers);
}

function summaryLines(
  base: string,
  { repeat, once, onMac }: LocalSelection,
  shard?: string,
): string[] {
  const lines =
    repeat.length === 0
      ? [`No surviving Vitest file this change adds or edits since ${base} needs local rounds.`]
      : [
          shard === undefined
            ? `These files run ${REPEATS} total local rounds (ordinary coverage included), since ${base}:`
            : `Local Vitest shard ${shard} runs ${REPEATS} total rounds from these candidates, since ${base}; together the shards cover every file:`,
          ...repeat.map((file) => `- \`${file}\``),
        ];
  lines.push(
    "",
    "Unedited direct importers and literal path readers run once locally (no transitive reach):",
    ...once.map((file) => `- \`${file}\``),
  );
  if (onMac.length > 0)
    lines.push(
      "",
      "These included files need a Mac (scripts/mac-unit-tests.ts); they are not excluded from local rounds:",
      ...onMac.map((file) => `- \`${file}\``),
    );
  return lines;
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? (args[at + 1] ?? "") : fallback;
  };
  const base = value("--base", "origin/main");
  const report = (lines: string[]) => {
    console.log(lines.join("\n"));
    if (args.includes("--run") && process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        ["### Unit-file repeats", "", ...lines, ""].join("\n"),
      );
  };
  const changed = changedPaths(base, value("--head", "HEAD"));
  if (changed === undefined) {
    console.error(
      `The change's base ${base} cannot be read, so its edited test files are unknown.`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.includes("--reach")) {
    const { run, elsewhere } = selectLinuxReach(changed);
    const lines = [
      `Edited test files, unedited direct importers and literal path readers since ${base}, one round in CI:`,
      ...run.map((file) => `- \`${file}\``),
    ];
    if (elsewhere.length > 0)
      lines.push(
        "",
        "Test files this round leaves to another run:",
        ...elsewhere.map(({ file, where }) => `- \`${file}\` (${where})`),
      );
    report(lines);
    if (!args.includes("--run")) return;
    process.exitCode = runLinuxReach(
      run,
      (command) => spawnSync("pnpm", command, { cwd: ROOT, stdio: "inherit" }).status,
      report,
    );
    return;
  }
  const selection = selectLocalUnits(changed);
  const shard = args.includes("--shard") ? value("--shard", "") : undefined;
  const workers = args.includes("--workers") ? value("--workers", "") : undefined;
  report(summaryLines(base, selection, shard));
  if (!args.includes("--run") || selection.repeat.length + selection.once.length === 0) return;
  if (process.platform !== "darwin" && selection.onMac.length > 0)
    throw new Error(
      "This selected local batch includes native files that need a Mac; do not count skipped native cases as proof.",
    );
  process.exitCode = runLocalUnits(
    selection,
    shard,
    (command) => spawnSync("pnpm", command, { cwd: ROOT, stdio: "inherit" }).status,
    report,
    workers,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
