import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./affected-probes.ts";
import { MAC_UNIT_FILES } from "./mac-unit-tests.ts";

/**
 * A change's unit-file repeats on Linux CI (docs/testing.md, "This
 * project's rulings on tests"; INF-2074's ci-gate fix, the captain's checked
 * words: "Run a change's typecheck, lint and ten unit-file repeats on Linux
 * CI instead of the Mac mini's line, since unit tests need no Mac").
 *
 *   node scripts/unit-repeats.ts [--base <ref>] [--head <ref>] [--shard <index/count>] [--run]
 *
 * prints the Vitest files the change adds or edits since its merge base with
 * `--base`, and the Mac-only ones (`scripts/mac-unit-tests.ts`) whose repeats
 * stay on a Mac. `--run` (`pnpm test:repeats`, ci.yml's `unit-repeats` shards)
 * runs them ten times in a row with no retries, stopping at the first failed
 * round, and says so in the job summary when there is one. `--shard` delegates
 * the same file split to Vitest on every round; together the shards cover
 * every selected file without extending a step's deadline. An empty `--base`
 * repeats nothing: a push to main was repeated on its pull request. A base
 * that cannot be read fails, since the job cannot tell what the change edits.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** How many rounds a change's own test files run in a row (INF-840). */
export const REPEATS = 10;

const VITEST_FILE = /^(src|tests)\/.+\.test\.tsx?$/;

export type Selection = { repeat: string[]; onMac: string[] };

/** The changed Vitest files that still exist, split into Linux repeats and Mac-only ones. */
export function selectRepeats(
  changed: readonly string[],
  exists: (path: string) => boolean = (path) => existsSync(join(ROOT, path)),
): Selection {
  const files = changed.filter((path) => VITEST_FILE.test(path) && exists(path)).toSorted();
  const mac = new Set<string>(MAC_UNIT_FILES);
  return {
    repeat: files.filter((path) => !mac.has(path)),
    onMac: files.filter((path) => mac.has(path)),
  };
}

/** Keep every round on Vitest's own shard, with the complete candidate set. */
export function repetitionArgs(files: readonly string[], shard?: string): string[] | undefined {
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
  return ["exec", "vitest", "run", "--retry", "0", ...split, ...files];
}

/** Ten fresh invocations, never a retry; any failed or interrupted round ends this shard. */
export function runRepetitions(
  files: readonly string[],
  shard: string | undefined,
  run: (args: string[]) => number | null,
  report: (lines: string[]) => void,
): number {
  if (files.length === 0) return 0;
  const command = repetitionArgs(files, shard);
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
      ? [`No Vitest file this change adds or edits since ${base} runs on Linux.`]
      : [
          shard === undefined
            ? `These files run ${REPEATS} times in a row, since ${base}:`
            : `Vitest shard ${shard} runs ${REPEATS} times in a row from these candidates, since ${base}; together the shards cover every file:`,
          ...repeat.map((file) => `- \`${file}\``),
        ];
  if (onMac.length > 0)
    lines.push(
      "",
      "These need a Mac (scripts/mac-unit-tests.ts), so their repeats stay on a Mac:",
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
  if (base === "") {
    report(["A push to main repeats nothing: its pull request ran the repeats."]);
    return;
  }
  const changed = changedPaths(base, value("--head", "HEAD"));
  if (changed === undefined) {
    console.error(`The change's base ${base} cannot be read, so its edited test files are unknown.`);
    process.exitCode = 1;
    return;
  }
  const selection = selectRepeats(changed);
  const shard = args.includes("--shard") ? value("--shard", "") : undefined;
  report(summaryLines(base, selection, shard));
  if (!args.includes("--run") || selection.repeat.length === 0) return;
  process.exitCode = runRepetitions(
    selection.repeat,
    shard,
    (command) => spawnSync("pnpm", command, { cwd: ROOT, stdio: "inherit" }).status,
    report,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
