import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, platform, release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WorkloadRun = {
  unitMs: number;
  desktopWithBuildMs: number;
  unitExit: number | null;
  desktopExit: number | null;
};

export function median(values: number[]): number {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Expected nonnegative finite timing samples");
  }
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** Never turn a timeout or failed test into an apparent performance win. */
export function compareWorkloads(before: WorkloadRun[], after: WorkloadRun[]) {
  if (before.length !== 5 || after.length !== 5) throw new Error("Exactly five runs per revision are required");
  if ([...before, ...after].some((run) => run.unitExit !== 0 || run.desktopExit !== 0)) {
    throw new Error("Failed or interrupted workloads cannot establish acceptance");
  }
  const total = (runs: WorkloadRun[]) => median(runs.map((run) => run.unitMs + run.desktopWithBuildMs));
  const beforeMs = total(before);
  const afterMs = total(after);
  if (!beforeMs) throw new Error("Baseline must have positive duration");
  return { beforeMs, afterMs, ratio: afterMs / beforeMs, withinTimeBudget: afterMs <= beforeMs * 0.2 };
}

/** Includes command startup, runner cleanup, and the desktop build on every run. */
export function measureCommand(args: string[], logPath: string, env = process.env): { ms: number; exit: number | null } {
  const start = performance.now();
  const result = spawnSync("pnpm", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024, env });
  const ms = performance.now() - start;
  writeFileSync(logPath, `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`);
  return { ms, exit: result.status };
}

function main(args: string[]) {
  // Current acceptance: a measured desktop improvement, not a five-run/80% gate.
  // Both modes execute the same suite and include its build and cleanup.
  if (args[0] === "desktop" && (args.length === 2 || (args.length === 3 && args[2] === "--serial"))) {
    const dir = resolve(args[1]!);
    mkdirSync(dir, { recursive: true });
    const serial = args[2] === "--serial";
    const startedAt = new Date().toISOString();
    const measured = measureCommand(
      ["test:e2e", "--reporter=json", ...(serial ? ["--workers=1"] : [])],
      resolve(dir, "desktop.log"),
      { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(dir, "desktop.json") },
    );
    const record = {
      sha: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      mode: serial ? "serial-control" : "configured",
      node: process.version,
      platform: `${platform()} ${release()}`,
      availableParallelism: availableParallelism(),
      startedAt,
      desktopWithBuildMs: measured.ms,
      exit: measured.exit,
    };
    writeFileSync(resolve(dir, "measurement.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
    return measured.exit === 0 ? 0 : 1;
  }
  if (args[0] === "compare" && args.length === 3) {
    const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { runs: WorkloadRun[] };
    const comparison = compareWorkloads(read(args[1]!).runs, read(args[2]!).runs);
    console.log(JSON.stringify(comparison, null, 2));
    console.log("Timing only: also review assertion retention, skips, resource allowance and cold-start evidence.");
    return comparison.withinTimeBudget ? 0 : 1;
  }
  if (args[0] !== "record" || args.length !== 2) {
    throw new Error("Usage: node scripts/test-workload.ts desktop <directory> [--serial] | record <directory> | compare <before.json> <after.json>");
  }
  const dir = resolve(args[1]!);
  mkdirSync(dir, { recursive: true });
  const record = {
    sha: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    node: process.version,
    platform: `${platform()} ${release()}`,
    availableParallelism: availableParallelism(),
    startedAt: new Date().toISOString(),
    runs: [] as WorkloadRun[],
  };
  for (let i = 1; i <= 5; i++) {
    const unit = measureCommand(["test", "--reporter=json", `--outputFile=${resolve(dir, `unit-${i}.json`)}`], resolve(dir, `unit-${i}.log`));
    const desktop = unit.exit === 0
      ? measureCommand(["test:e2e", "--reporter=json"], resolve(dir, `desktop-${i}.log`))
      : { ms: 0, exit: null };
    record.runs.push({ unitMs: unit.ms, desktopWithBuildMs: desktop.ms, unitExit: unit.exit, desktopExit: desktop.exit });
    writeFileSync(resolve(dir, "workload.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Run ${i}: unit ${unit.ms.toFixed(0)}ms (${unit.exit}), desktop + build ${desktop.ms.toFixed(0)}ms (${desktop.exit})`);
    if (unit.exit !== 0 || desktop.exit !== 0) return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
