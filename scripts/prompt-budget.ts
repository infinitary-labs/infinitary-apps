import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prompt-budget check (docs/testing.md, "The prompt budget's two lines";
 * INF-2930). The fixed-context tests fail only past each budget's hard line;
 * this check holds the budget itself. It runs the
 * same budget tests with `PROMPT_BUDGET_LINE=budget`, prints every reading,
 * and exits with a failure naming each reading over its budget.
 *
 *   node scripts/prompt-budget.ts
 *
 * prompt-budget.yml runs it on each push to main that changes the app's
 * source, and by hand. No pull request, batch, main check or release reads
 * it: a red run files one trim task through an Automation rule.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The budget tests, by file and by the name of the test that reads the budget. */
export const BUDGET_TESTS = [
  "tests/crewmate-fixed-context.test.ts",
  "tests/firstmate-fixed-context.test.ts",
] as const;
export const BUDGET_TEST_NAME = "under its hard line";

/** What a red run tells the trim task it files. */
const TRIM_POINTER = [
  "A reading is over its budget. A trim brings each reading to its trimTarget above, 90% of the budget,",
  'by the order of work in docs/orchestrator-contract.md, "How a trim works".',
  "List every served sentence it removes or alters with: node scripts/served-sentences.ts",
].join("\n");

export function budgetArgs(): string[] {
  return [
    "exec",
    "vitest",
    "run",
    "--retry",
    "0",
    "--silent=false",
    "--reporter=verbose",
    "--testNamePattern",
    BUDGET_TEST_NAME,
    ...BUDGET_TESTS,
  ];
}

function main(): void {
  const run = spawnSync("pnpm", budgetArgs(), {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PROMPT_BUDGET_LINE: "budget" },
  });
  if (run.status !== 0) console.error(TRIM_POINTER);
  process.exit(run.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
