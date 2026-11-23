import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./affected-probes.ts";
import { type JourneyLane, laneFiles } from "./journey-groups.ts";

/** INF-2259: ordinary proof once; directly edited selected files twice more.
 * Each round is fresh, without retries. A failure or interruption stops later rounds.
 * Selection is supplied by the existing chooser, never inferred from timing data.
 */
export function journeyRounds(files: readonly string[], changed: readonly string[]): string[][] {
  const selected = [...new Set(files)];
  const edited = selected.filter((file) => changed.includes(file));
  return selected.length === 0 ? [] : [selected, ...(edited.length ? [edited, edited] : [])];
}

/** INF-4500's weekly audit, addition 3 (the captain's choice: "One Mac round
 * for each edited journey"): after the rounds of a file's tests that need a
 * Mac, each directly edited selected file runs once more on the Mac, every
 * test but those carrying `tag`, which the rounds already ran. A file with
 * no such test passes; none edited runs nothing.
 */
export function editedOnceArguments(
  files: readonly string[],
  changed: readonly string[],
  tag: string,
): string[] | undefined {
  const edited = [...new Set(files)].filter((file) => changed.includes(file));
  if (edited.length === 0) return undefined;
  return journeyArguments(edited, ["--grep-invert", tag, "--pass-with-no-tests"]);
}

/** INF-4891: a round's Playwright runs, one per lane, as a run of every lane
 * orders them (tests/e2e/lanes.ts, docs/testing.md "E2E scheduling"): the
 * parallel lanes' selected files together, then the serial desktop lane's in
 * a run of their own. Under --no-deps one run starts both lanes side by side,
 * and a desktop file reads the host's own load, focus or paint time: beside
 * three application journeys on a Mac, the automatic placement journey read
 * their apps' memory as its own computer's and waited for memory too.
 */
export function laneRuns(files: readonly string[]): { lane: JourneyLane; files: string[] }[] {
  const serial = new Set(laneFiles("desktop"));
  const runs: { lane: JourneyLane; files: string[] }[] = [
    { lane: "parallel", files: files.filter((file) => !serial.has(file)) },
    { lane: "desktop", files: files.filter((file) => serial.has(file)) },
  ];
  return runs.filter((run) => run.files.length > 0);
}

export function journeyArguments(files: readonly string[], extra: readonly string[] = []): string[] {
  return ["exec", "playwright", "test", "--no-deps", "--retries", "0", "--max-failures", "1", ...extra, ...files];
}

/** INF-2340 (captain's route "alone-at-author"): the run-alone pass belongs to
 * the proof of edited journeys, not to main's full check. After every round
 * passes, the directly edited selected files' later tests each run by
 * themselves (scripts/e2e-alone.ts, docs/testing.md "Each test owns its
 * prerequisites"); `--alone-tag` keeps only that tag's tests, as the Mac does.
 */
export function aloneArguments(
  files: readonly string[],
  changed: readonly string[],
  options: { out?: string; tag?: string } = {},
): string[] | undefined {
  const edited = [...new Set(files)].filter((file) => changed.includes(file));
  if (edited.length === 0) return undefined;
  return [
    "scripts/e2e-alone.ts",
    ...(options.out ? ["--out", options.out] : []),
    ...(options.tag ? ["--tag", options.tag] : []),
    ...edited,
  ];
}

/**
 * The ref the edited files are read against: the requested base when this
 * checkout holds it, or else the branch of that name where the project
 * lives. A checkout fetches branches only as `origin/<name>`, so a request
 * naming `main` failed every job before it ran a journey (INF-6259's weekly
 * audit). A base neither names is refused with words rather than read as
 * no edits.
 */
export function comparisonBase(base: string, resolves: (ref: string) => boolean): string {
  if (resolves(base)) return base;
  const remote = `origin/${base}`;
  if (!base.startsWith("origin/") && resolves(remote)) return remote;
  throw new Error(`The comparison base ${base} names no commit in this checkout, nor does ${remote}; request a branch where the project lives or a commit.`);
}

export function runJourneyRounds(
  rounds: readonly string[][],
  run: (files: string[], round: number) => number | null,
): number {
  for (const [index, files] of rounds.entries()) {
    const status = run(files, index + 1);
    if (status !== 0) return status ?? 1;
  }
  return 0;
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? "" : args[index + 1] ?? "";
  };
  const files = value("--files").split(/\s+/).filter(Boolean);
  if (!files.length || files.some((file) => !/^tests\/e2e\/[^/]+\.spec\.ts$/.test(file) || !existsSync(file)))
    throw new Error("Name existing selected journey files, not an empty or unreadable selection.");
  const base = comparisonBase(value("--base") || "origin/main", (ref) =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" }).status === 0,
  );
  const changed = changedPaths(base, "HEAD");
  if (changed === undefined) throw new Error("Cannot read the comparison for edited journey files.");
  const extra = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
  const rounds = journeyRounds(files, changed);
  const onceTag = value("--edited-once-except");
  const once = onceTag ? editedOnceArguments(files, changed, onceTag) : undefined;
  const planned = once ? [...rounds, files.filter((file) => changed.includes(file))] : rounds;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const destination = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const reports: Record<string, unknown>[] = [];
  const outcomes: { head: string; round: number; lane: JourneyLane; files: string[]; exit: number | null; reportPresent: boolean }[] = [];
  const status = runJourneyRounds(planned, (selected, round) => {
    for (const { lane, files: part } of laneRuns(selected)) {
      const command = round > rounds.length && once ? editedOnceArguments(part, changed, onceTag) : journeyArguments(part, extra);
      if (!command) continue;
      const report = destination ? `${destination}.round-${round}-${lane}.json` : undefined;
      console.log(JSON.stringify({ head, platform: process.platform, base, round, lane, files: part }));
      const result = spawnSync("pnpm", command, {
        stdio: "inherit",
        env: { ...process.env, ...(report ? { PLAYWRIGHT_JSON_OUTPUT_FILE: report } : {}) },
      });
      const reportPresent = Boolean(report && existsSync(report));
      if (reportPresent && report) reports.push(JSON.parse(readFileSync(report, "utf8")));
      outcomes.push({ head, round, lane, files: part, exit: result.status, reportPresent });
      console.log(JSON.stringify(outcomes.at(-1)));
      if (result.status !== 0) return result.status;
    }
    return 0;
  });
  // Keep every fresh round beside the combined reading used by the existing
  // skipped-test and timing readers, including the partial failed round.
  if (destination && reports.length) {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify({
      ...reports[0],
      suites: reports.flatMap((report) => (report.suites as unknown[]) ?? []),
      errors: reports.flatMap((report) => (report.errors as unknown[]) ?? []),
      stats: Object.fromEntries(["duration", "expected", "unexpected", "flaky", "skipped"].map((key) => [key,
        reports.reduce((sum, report) => sum + Number((report.stats as Record<string, unknown> | undefined)?.[key] ?? 0), 0),
      ])),
      rounds: outcomes,
    }));
  }
  const alone = status === 0
    ? aloneArguments(files, changed, { out: value("--alone-out") || undefined, tag: value("--alone-tag") || undefined })
    : undefined;
  if (alone) {
    console.log(JSON.stringify({ head, platform: process.platform, alone: alone.slice(1) }));
    process.exitCode = spawnSync(process.execPath, alone, { stdio: "inherit" }).status ?? 1;
    return;
  }
  process.exitCode = status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
