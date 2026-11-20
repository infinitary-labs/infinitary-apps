// The cores and memory a check may use (docs/testing.md, "Each Mac job's kind and size").
//
// The Mac mini's placement service gives each job a size and names its cores
// in RUNNER_UP_CORES. A virtual Mac is made that size, but a job on the real
// Mac shares its processor with the jobs beside it, and macOS cannot hold a
// group of programs to a share, so the job's own test workers keep to it.
// With no size named, a job counts the whole machine, as before.
//
//   node scripts/job-cores.ts    prints the cores

import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

/** The job's cores: its named size, or `fallback` where none is named. */
export function jobCores(
  env: NodeJS.ProcessEnv = process.env,
  fallback: number = availableParallelism(),
): number {
  const cores = Number(env.RUNNER_UP_CORES);
  return Number.isInteger(cores) && cores > 0 ? cores : fallback;
}

/** The computer's memory, or the smaller limit a Linux control group holds this process to. */
export function jobMemory(): number {
  const limit = process.constrainedMemory();
  return limit > 0 ? Math.min(limit, totalmem()) : totalmem();
}

/**
 * The memory each process of an in-memory test run is given. A worker keeps
 * what each file it ran leaves behind (`isolate: false`), so it grows with the
 * files it runs: three workers running a third of those cohorts on a Mac
 * peaked at 6.5 GiB together with Vitest's own process, the largest worker at
 * 2.3 GiB and Vitest's process at 1.4 GiB, so four shares hold them.
 */
export const TEST_PROCESS_MEMORY_BYTES = 2 * 1024 ** 3;

/**
 * How many workers the in-memory cohorts (`pure`, `unit`, `unit-isolated`)
 * start: one per core but one, and at least two, as long as the computer's
 * memory holds each and Vitest's own process at `TEST_PROCESS_MEMORY_BYTES`;
 * always one. INF-5103: by cores alone a branch check started ten on a compute
 * Mac's Linux guest, which has 11 cores and 9 GB with no swap, and a worker
 * died in the middle of a file, leaving its scratch folders behind. The same
 * files with ten workers peaked at 11.2 GiB on a Mac.
 */
export function inMemoryWorkers({ cores, memoryBytes }: { cores: number; memoryBytes: number }): number {
  const byMemory = Math.floor(memoryBytes / TEST_PROCESS_MEMORY_BYTES) - 1;
  return Math.max(1, Math.min(Math.max(2, cores - 1), byMemory));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(jobCores());
}
