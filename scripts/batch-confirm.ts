import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPEATS } from "./unit-repeats.ts";

/**
 * The swept batch's confirm (docs/testing.md, "The swept batch"; the
 * captain's pick on INF-3012, "A only: the confirm step"): when a batch's
 * checks fail, the shipped queue calls infinitary-batch-checks.yml once more
 * on the same composed batch with the failed test files, and this runs only
 * those files, three rounds with no retries, stopping at the first failure.
 *
 *   node scripts/batch-confirm.ts --files "<file> <file>" [-- <journey args>]
 *
 * The queue reads the files from the failed jobs' logs: Vitest names a file
 * by its path from the project's root, Playwright by its path from the
 * journeys' folder. The journey arguments go to the parallel lanes only, as
 * verify.yml gives them half the job's cores.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const JOURNEYS = "tests/e2e/";
const JOURNEY = /^tests\/e2e\/[^/]+\.spec\.ts$/;

/** Each failed file at its path from the project's root; a file found nowhere throws, since nothing could confirm it. */
export function confirmFiles(
  named: readonly string[],
  exists: (path: string) => boolean = (path) => existsSync(resolve(ROOT, path)),
): string[] {
  return [
    ...new Set(
      named.map((file) => {
        if (exists(file)) return file;
        if (exists(`${JOURNEYS}${file}`)) return `${JOURNEYS}${file}`;
        throw new Error(`The failed test file ${file} is not in the composed batch.`);
      }),
    ),
  ];
}

/** One round's commands: the Vitest files in one run, then the journeys, the serial desktop lane apart from the parallel ones (tests/e2e/lanes.ts). */
export function confirmRound(files: readonly string[], journeyArgs: readonly string[] = []): string[][] {
  const journeys = files.filter((file) => JOURNEY.test(file));
  const units = files.filter((file) => !JOURNEY.test(file));
  const playwright = ["exec", "playwright", "test", "--no-deps", "--retries", "0", "--pass-with-no-tests"];
  return [
    ...(units.length ? [["test", ...units]] : []),
    ...(journeys.length
      ? [
          [...playwright, "--project=desktop", ...journeys],
          [...playwright, "--project=styles", "--project=renderer", "--project=application", ...journeyArgs, ...journeys],
        ]
      : []),
  ];
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--files");
  const named = (at < 0 ? "" : (args[at + 1] ?? "")).split(/\s+/).filter(Boolean);
  if (!named.length) throw new Error("Name the failed test files to confirm.");
  const files = confirmFiles(named);
  const round = confirmRound(files, args.includes("--") ? args.slice(args.indexOf("--") + 1) : []);
  for (let index = 1; index <= REPEATS; index++) {
    console.log(`Confirm round ${index} of ${REPEATS}: ${files.join(" ")}`);
    for (const command of round) {
      const result = spawnSync("pnpm", command, { stdio: "inherit" });
      if (result.status !== 0) {
        console.log(`Failed in round ${index} of ${REPEATS}.`);
        process.exit(result.status ?? 1);
      }
    }
  }
  console.log(`Passed ${REPEATS} of ${REPEATS} rounds.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
