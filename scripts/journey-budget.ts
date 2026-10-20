import { appendFileSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_SUITES, E2E_MAX_WORKERS, RENDERER_SUITES } from "../tests/e2e/lanes.ts";
import { importsOf, type Reasons } from "./affected-journeys.ts";

// INF-658: the captain chose six minutes of journeys, not a job timeout.
export const JOURNEY_BUDGET_MS = 6 * 60 * 1000;
const parallel = new Set([...APPLICATION_SUITES, ...RENDERER_SUITES].map((file) => basename(file)));
export const laneOf = (file: string): "parallel" | "desktop" =>
  parallel.has(basename(file)) ? "parallel" : "desktop";

export type ReportSuite = {
  file?: string;
  suites?: ReportSuite[];
  specs?: { file?: string; tests: { results: { duration: number; status: string }[] }[] }[];
};

/** Keep actual work, including hooks and retries reported by Playwright. */
export function journeyTimes(report: { suites: ReportSuite[] }): Map<string, number> {
  const times = new Map<string, number>();
  const walk = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file ?? "";
      if (!file.endsWith(".spec.ts") || file.startsWith("../")) continue;
      const path = `tests/e2e/${basename(file)}`;
      const duration = spec.tests
        .flatMap((test) => test.results)
        .filter((result) => result.status !== "skipped")
        .reduce((sum, result) => sum + result.duration, 0);
      times.set(path, (times.get(path) ?? 0) + duration);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  if (![...times.values()].some((time) => time > 0))
    throw new Error("The passing verify result contains no measured journeys");
  return times;
}

/** Explicitly edited specs first, then the shortest test-import path, then screen readers. */
export function proximity(
  file: string,
  reasons: string[],
  changed: Set<string>,
  read: (file: string) => string | undefined,
): number {
  if (changed.has(file)) return 0;
  let frontier = [file];
  const seen = new Set(frontier);
  for (let depth = 1; frontier.length; depth++) {
    const next: string[] = [];
    for (const importer of frontier) {
      for (const dependency of importsOf(
        importer,
        read(importer) ?? "",
        (path) => read(path) !== undefined,
      )) {
        if (changed.has(dependency)) return depth;
        if (!seen.has(dependency) && !dependency.startsWith("src/")) {
          seen.add(dependency);
          next.push(dependency);
        }
      }
    }
    frontier = next;
  }
  return reasons.some((why) => /reads |names |holds /.test(why)) ? 1 : Number.MAX_SAFE_INTEGER;
}

/** Files stay intact: serial desktop work adds; parallel files pack onto ten workers. */
export function macTime(files: string[], cost: (file: string) => number): number {
  const workers = Array<number>(E2E_MAX_WORKERS).fill(0);
  let serial = 0;
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    if (laneOf(file) === "desktop") serial += cost(file);
    else {
      const index = workers.indexOf(Math.min(...workers));
      workers[index] = (workers[index] ?? 0) + cost(file);
    }
  }
  return serial + Math.max(...workers);
}

export function budget(
  reasons: Reasons,
  times: Map<string, number>,
  distance: (file: string) => number,
) {
  // New and previously skipped journeys use the slowest measured file in their lane.
  const cost = (file: string) =>
    times.get(file) ||
    Math.max(
      1,
      ...[...times].filter(([path]) => laneOf(path) === laneOf(file)).map(([, ms]) => ms),
    );
  const ordered = [...reasons.keys()].sort(
    (a, b) => distance(a) - distance(b) || a.localeCompare(b),
  );
  const mac: string[] = [];
  const overflow: string[] = [];
  for (const file of ordered) {
    if (macTime([...mac, file], cost) <= JOURNEY_BUDGET_MS) mac.push(file);
    else overflow.push(file);
  }
  const linux: { lane: "parallel" | "desktop"; files: string; estimatedMs: number }[] = [];
  for (const lane of ["parallel", "desktop"] as const) {
    // INF-658's measured Linux rates: one Mac minute of parallel work per minute,
    // and 0.6 Mac minutes of serial work per minute. Sum is conservative for parallel files.
    const linuxCost = (file: string) => cost(file) / (lane === "desktop" ? 0.6 : 1);
    for (const file of overflow
      .filter((file) => laneOf(file) === lane)
      .sort((a, b) => linuxCost(b) - linuxCost(a) || a.localeCompare(b))) {
      let bin = linux
        .filter(
          (bin) => bin.lane === lane && bin.estimatedMs + linuxCost(file) <= JOURNEY_BUDGET_MS,
        )
        .sort((a, b) => a.estimatedMs - b.estimatedMs)[0];
      if (!bin) {
        bin = { lane, files: "", estimatedMs: 0 };
        linux.push(bin);
      }
      bin.files = [bin.files, file].filter(Boolean).join(" ");
      bin.estimatedMs += linuxCost(file);
    }
  }
  return {
    mac,
    estimatedMacMs: macTime(mac, cost),
    linux,
    unmeasured: ordered.filter((file) => !times.get(file)),
  };
}

function main() {
  const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1] ?? "";
  const reasons = new Map<string, string[]>(
    Object.entries(JSON.parse(readFileSync(value("--selection"), "utf8"))),
  );
  const times = journeyTimes(JSON.parse(readFileSync(value("--timings"), "utf8")));
  const changed = new Set(readFileSync(value("--changed"), "utf8").trim().split("\n"));
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const result = budget(reasons, times, (file) =>
    proximity(file, reasons.get(file) ?? [], changed, read),
  );
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `count=${result.mac.length}\nfiles=${result.mac.join(" ")}\nlinux-count=${result.linux.length}\nlinux=${JSON.stringify({ include: result.linux })}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Journey placement\n\nMac: ${result.mac.length} files, estimated ${(result.estimatedMacMs / 60000).toFixed(1)} minutes.\n\n` +
        result.mac.map((file) => `- Mac: ${file}: ${reasons.get(file)?.join("; ")}`).join("\n") +
        "\n\n" +
        result.linux
          .map(
            (bin, index) =>
              `- Linux ${index + 1} (${bin.lane}): ${(bin.estimatedMs / 60000).toFixed(1)} minutes: ${bin.files}`,
          )
          .join("\n") +
        `\n\nUnmeasured files (slowest measured lane file used): ${result.unmeasured.join(", ") || "none"}. Estimates exclude setup and runner waits; indivisible files can exceed six minutes.\n`,
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
