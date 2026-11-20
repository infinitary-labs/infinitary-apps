import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The full lint, `pnpm check`: every step it names runs, one after another,
 * even after one fails, and the end names each step that failed (INF-5379's
 * plan, piece 3). As an `&&` chain it stopped at the first failure, so a
 * file-size refusal hid the eighteen lints after it, and each repair of a
 * held batch found only the next failure on its next round.
 *
 * The steps stay in package.json, as this script's arguments, each one
 * separated from the next by a lone `,`, so the quick check
 * (`scripts/check-changed.ts`) and the plain-Node import lint
 * (`scripts/node-imports.ts`) read the same commands there:
 *
 *   node scripts/check.ts node scripts/holds.ts , biome check . , ...
 */
export const STEP_SEPARATOR = ",";

/** The commands this script is given, each as its program and arguments. */
export function checkSteps(args: readonly string[]): string[][] {
  const steps: string[][] = [[]];
  for (const arg of args) {
    if (arg === STEP_SEPARATOR) steps.push([]);
    else steps.at(-1)?.push(arg);
  }
  return steps.filter((step) => step.length > 0);
}

/** The commands `pnpm check` runs, read from its package.json line. */
export function checkCommands(check: string): string[][] {
  return check
    .split("&&")
    .flatMap((command) => {
      const words = command.trim().split(/\s+/);
      return words[0] === "node" && words[1] === "scripts/check.ts"
        ? checkSteps(words.slice(2))
        : [words];
    })
    .filter((words) => words.length > 0 && words[0] !== "");
}

/** Runs every step in order and answers the ones that failed. */
export function runSteps(
  steps: readonly string[][],
  run: (step: readonly string[]) => boolean = (step) => {
    const [program = "", ...args] = step;
    const result = spawnSync(program, args, { stdio: "inherit" });
    if (result.error) console.error(`${step.join(" ")}: ${result.error.message}`);
    return result.status === 0;
  },
): string[][] {
  return steps.filter((step) => !run(step));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const steps = checkSteps(process.argv.slice(2));
  const failed = runSteps(steps);
  if (failed.length) {
    console.error(`\npnpm check: ${failed.length} of ${steps.length} steps failed:`);
    for (const step of failed) console.error(`  ${step.join(" ")}`);
    process.exitCode = 1;
  } else console.log(`pnpm check: all ${steps.length} steps passed`);
}
