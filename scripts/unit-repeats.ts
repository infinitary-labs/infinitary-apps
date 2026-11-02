import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./affected-probes.ts";
import { MAC_UNIT_FILES } from "./mac-unit-tests.ts";

/**
 * The captain's INF-2273 override to INF-2259: every edited Vitest file
 * gets its ordinary local run plus two more, including Linux-eligible files.
 * No PR repeat jobs duplicate that proof. Native files still require a Mac.
 *
 *   node scripts/unit-repeats.ts [--base <ref>] [--head <ref>] [--workers <n>] [--shard <index/count>] [--run]
 *
 * The existing changed-path reader owns selection. Fresh rounds stop at the
 * first failure or interruption, without retries. An unreadable base fails.
 * Explicit workers bound a local batch to its caller's load declaration;
 * optional Vitest sharding divides disjoint local batches, not extra CI gates.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** INF-2259 accepted override: ordinary coverage plus two more rounds. */
export const REPEATS = 3;

const VITEST_FILE = /^(src|tests)\/.+\.test\.tsx?$/;

export type Selection = { repeat: string[]; onMac: string[] };

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
export function repetitionArgs(files: readonly string[], shard?: string, workers?: string): string[] | undefined {
  if (workers !== undefined && !/^[1-9]\d*$/.test(workers)) throw new Error(`Invalid worker count: ${workers}`);
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
  return ["exec", "vitest", "run", "--retry", "0", ...(workers === undefined ? [] : ["--maxWorkers", workers]), ...split, ...files];
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

function summaryLines(base: string, { repeat, onMac }: Selection, shard?: string): string[] {
  const lines =
    repeat.length === 0
      ? [`No surviving Vitest file this change adds or edits since ${base} needs local rounds.`]
      : [
          shard === undefined
            ? `These files run ${REPEATS} total local rounds (ordinary coverage included), since ${base}:`
            : `Local Vitest shard ${shard} runs ${REPEATS} total rounds from these candidates, since ${base}; together the shards cover every file:`,
          ...repeat.map((file) => `- \`${file}\``),
        ];
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
    console.error(`The change's base ${base} cannot be read, so its edited test files are unknown.`);
    process.exitCode = 1;
    return;
  }
  const selection = selectRepeats(changed);
  const shard = args.includes("--shard") ? value("--shard", "") : undefined;
  const workers = args.includes("--workers") ? value("--workers", "") : undefined;
  report(summaryLines(base, selection, shard));
  if (!args.includes("--run") || selection.repeat.length === 0) return;
  if (process.platform !== "darwin" && selection.onMac.length > 0)
    throw new Error("This selected local batch includes native files that need a Mac; do not count skipped native cases as proof.");
  process.exitCode = runRepetitions(
    selection.repeat,
    shard,
    (command) => spawnSync("pnpm", command, { cwd: ROOT, stdio: "inherit" }).status,
    report,
    workers,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
