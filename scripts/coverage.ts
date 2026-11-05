/**
 * Coverage of named files (INF-2625's plan; docs/testing.md, "Measuring
 * coverage"). Before a piece of the restructure moves a file, it measures
 * which of the file's lines and branches the tests reach, on untouched main,
 * so its guardrail tests cover what the tests do not. This runs Vitest with
 * the V8 coverage provider over only the named files and prints a table. It
 * sets no threshold and fails nothing for low coverage: the number is
 * information for the piece, never a gate. Plain Node type stripping;
 * `pnpm coverage` runs it.
 *
 *   pnpm coverage <file>...                  the named files, from their own tests
 *   pnpm coverage <file>... -- <vitest args> the named files, from the tests the arguments pick
 *
 * Their own tests are the test files whose paths start with a named file's
 * path less its extension, so `src/core/tasks/taskService.ts` is measured
 * from `taskService.test.ts` and `taskService.*.test.ts` beside it. Any
 * argument after `--` goes to Vitest as written, in place of those filters,
 * such as `--project unit src/core/orchestrator`.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Vitest arguments that measure the named files, from the tests `rest` picks or their own. */
export function coverageArguments(files: string[], rest: string[] | undefined): string[] {
  const own = files.map((file) => file.replace(/\.[^./]+$/, ""));
  return [
    "run",
    "--coverage.enabled",
    "--coverage.provider=v8",
    "--coverage.reporter=text",
    ...files.map((file) => `--coverage.include=${file}`),
    ...(rest ?? own),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const split = args.indexOf("--");
  const files = split < 0 ? args : args.slice(0, split);
  const rest = split < 0 ? undefined : args.slice(split + 1);
  if (!files.length) {
    console.error("Name the files to measure: pnpm coverage <file>... [-- <vitest args>]");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const run = spawnSync(resolve(root, "node_modules/.bin/vitest"), coverageArguments(files, rest), {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
}
