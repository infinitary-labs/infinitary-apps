import { appendFileSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_SUITES, RENDERER_SUITES } from "../tests/e2e/lanes.ts";
import { MAC_ONLY_TAG } from "../tests/e2e/tags.ts";
import { needsMac } from "../tests/lint/e2eMacTag.ts";
import type { Reasons } from "./affected-journeys.ts";

// INF-658: the captain chose six minutes of journeys, not a job timeout; it sizes the Linux jobs.
export const JOURNEY_BUDGET_MS = 6 * 60 * 1000;
/** The PC's self-hosted Linux places, five at once (INF-1720's plan). */
export const LINUX_PLACES = 5;
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

/**
 * A test runs on the Mac only when it needs a Mac (docs/principles.md,
 * 2026-10-28): every picked file runs on Linux, and the Mac runs the picked
 * files that hold a test tagged MAC_ONLY_TAG, only those tests. A request may
 * run every picked file on the Mac as well (`everyOnMac`).
 */
export function budget(
  reasons: Reasons,
  times: Map<string, number>,
  tagged: (file: string) => boolean,
  everyOnMac = false,
) {
  // New and previously skipped journeys use the slowest measured file in their lane.
  const cost = (file: string) =>
    times.get(file) ||
    Math.max(
      1,
      ...[...times].filter(([path]) => laneOf(path) === laneOf(file)).map(([, ms]) => ms),
    );
  const ordered = [...reasons.keys()].sort((a, b) => a.localeCompare(b));
  const mac = ordered.filter((file) => everyOnMac || tagged(file));
  // INF-658's measured Linux rates: one Mac minute of parallel work per minute,
  // and 0.6 Mac minutes of serial work per minute. Sum is conservative for parallel files.
  const linuxCost = (file: string) => cost(file) / (laneOf(file) === "desktop" ? 0.6 : 1);
  type Bin = { lane: "parallel" | "desktop"; files: string; estimatedMs: number };
  // Longest file first, each into its lane's least loaded job: within six
  // minutes while `places` is unbounded, otherwise into exactly `places` jobs.
  const pack = (lane: Bin["lane"], places: number): Bin[] => {
    const bins: Bin[] = [];
    for (const file of ordered
      .filter((file) => laneOf(file) === lane)
      .sort((a, b) => linuxCost(b) - linuxCost(a) || a.localeCompare(b))) {
      const lightest = bins.toSorted((a, b) => a.estimatedMs - b.estimatedMs)[0];
      let bin =
        lightest && (bins.length >= places || lightest.estimatedMs + linuxCost(file) <= JOURNEY_BUDGET_MS)
          ? lightest
          : undefined;
      if (!bin) {
        bin = { lane, files: "", estimatedMs: 0 };
        bins.push(bin);
      }
      bin.files = [bin.files, file].filter(Boolean).join(" ");
      bin.estimatedMs += linuxCost(file);
    }
    return bins;
  };
  const lanes = (["parallel", "desktop"] as const).filter((lane) =>
    ordered.some((file) => laneOf(file) === lane),
  );
  let linux = lanes.flatMap((lane) => pack(lane, Number.POSITIVE_INFINITY));
  if (linux.length > LINUX_PLACES) {
    // INF-1720's plan: the journeys run on the PC's Linux places, five at once,
    // so it packs into at most one job per place, each repeating the setup
    // once. Each lane takes places by its share of the work, one at least.
    const work = (lane: Bin["lane"]) =>
      ordered.filter((file) => laneOf(file) === lane).reduce((sum, file) => sum + linuxCost(file), 0);
    const total = lanes.reduce((sum, lane) => sum + work(lane), 0);
    const first = lanes[0] as Bin["lane"];
    const share =
      lanes.length === 1
        ? LINUX_PLACES
        : Math.min(LINUX_PLACES - 1, Math.max(1, Math.round((LINUX_PLACES * work(first)) / total)));
    linux = lanes.flatMap((lane) => pack(lane, lane === first ? share : LINUX_PLACES - share));
  }
  return {
    mac,
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
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const result = budget(
    reasons,
    times,
    (file) => needsMac(read(file) ?? "", file),
    process.argv.includes("--every-on-mac"),
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
      `### Journey placement\n\nMac: ${result.mac.length} files${process.argv.includes("--every-on-mac") ? ", every test, as requested" : `, only their tests tagged ${MAC_ONLY_TAG}`}.\n\n` +
        result.mac.map((file) => `- Mac: ${file}: ${reasons.get(file)?.join("; ")}`).join("\n") +
        "\n\n" +
        result.linux
          .map(
            (bin, index) =>
              `- Linux ${index + 1} (${bin.lane}): ${(bin.estimatedMs / 60000).toFixed(1)} minutes: ${bin.files}`,
          )
          .join("\n") +
        `\n\nUnmeasured files (slowest measured lane file used): ${result.unmeasured.join(", ") || "none"}. Estimates exclude setup and runner waits; indivisible files, and groups past the PC's ${LINUX_PLACES} Linux places, can exceed six minutes.\n`,
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
