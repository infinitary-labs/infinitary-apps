// The cores a check may use (docs/testing.md, "Each Mac job's kind and size").
//
// The Mac mini's placement service gives each job a size and names its cores
// in RUNNER_UP_CORES. A virtual Mac is made that size, but a job on the real
// Mac shares its processor with the jobs beside it, and macOS cannot hold a
// group of programs to a share, so the job's own test workers keep to it.
// With no size named, a job counts the whole machine, as before.
//
//   node scripts/job-cores.ts    prints the cores

import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

/** The job's cores: its named size, or `fallback` where none is named. */
export function jobCores(
  env: NodeJS.ProcessEnv = process.env,
  fallback: number = availableParallelism(),
): number {
  const cores = Number(env.RUNNER_UP_CORES);
  return Number.isInteger(cores) && cores > 0 ? cores : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(jobCores());
}
