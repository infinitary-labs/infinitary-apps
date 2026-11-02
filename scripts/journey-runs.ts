import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./affected-probes.ts";

/** INF-2259: ordinary proof once; directly edited selected files twice more.
 * Each round is fresh, without retries. A failure or interruption stops later rounds.
 * Selection is supplied by the existing chooser, never inferred from timing data.
 */
export function journeyRounds(files: readonly string[], changed: readonly string[]): string[][] {
  const selected = [...new Set(files)];
  const edited = selected.filter((file) => changed.includes(file));
  return selected.length === 0 ? [] : [selected, ...(edited.length ? [edited, edited] : [])];
}

export function journeyArguments(files: readonly string[], extra: readonly string[] = []): string[] {
  return ["exec", "playwright", "test", "--no-deps", "--retries", "0", "--max-failures", "1", ...extra, ...files];
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
  const changed = changedPaths(value("--base") || "origin/main", "HEAD");
  if (changed === undefined) throw new Error("Cannot read the comparison for edited journey files.");
  const extra = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
  const rounds = journeyRounds(files, changed);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const destination = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const reports: Record<string, unknown>[] = [];
  const outcomes: { head: string; round: number; files: string[]; exit: number | null; reportPresent: boolean }[] = [];
  const status = runJourneyRounds(rounds, (selected, round) => {
    const report = destination ? `${destination}.round-${round}.json` : undefined;
    console.log(JSON.stringify({ head, platform: process.platform, base: value("--base") || "origin/main", round, files: selected }));
    const result = spawnSync("pnpm", journeyArguments(selected, extra), {
      stdio: "inherit",
      env: { ...process.env, ...(report ? { PLAYWRIGHT_JSON_OUTPUT_FILE: report } : {}) },
    });
    const reportPresent = Boolean(report && existsSync(report));
    if (reportPresent && report) reports.push(JSON.parse(readFileSync(report, "utf8")));
    outcomes.push({ head, round, files: selected, exit: result.status, reportPresent });
    console.log(JSON.stringify(outcomes.at(-1)));
    return result.status;
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
  process.exitCode = status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
