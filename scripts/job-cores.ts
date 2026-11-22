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
 * 2.3 GiB and Vitest's process at 1.4 GiB, so four shares hold them. An
 * integration worker's share holds the programs its file starts as well
 * (`integrationWorkers`).
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
  return Math.max(1, Math.min(Math.max(2, cores - 1), workersMemoryHolds(memoryBytes)));
}

/**
 * How many workers the integration cohort, and the probes beside it, start:
 * one per core up to eight on a Mac, four elsewhere, as long as the computer's
 * memory holds each and Vitest's own process at `TEST_PROCESS_MEMORY_BYTES`;
 * always one. An integration worker's share holds the programs its file
 * starts as well as the worker: the file that runs the quick check held 2.3 GB
 * with its programs. INF-5632: four on a Linux place with 2 cores and 8 GB
 * with no swap left as little as 278 MiB free beside Vitest's own 1.4 GiB, and
 * a SIGKILL ended Vitest's process alone in a branch check's reach run there,
 * most likely the kernel's out-of-memory killer.
 */
export function integrationWorkers({
  platform,
  cores,
  memoryBytes,
}: {
  platform: NodeJS.Platform;
  cores: number;
  memoryBytes: number;
}): number {
  const byCores = platform === "darwin" ? Math.min(8, cores) : 4;
  return Math.max(1, Math.min(byCores, workersMemoryHolds(memoryBytes)));
}

/** The workers the computer's memory holds beside Vitest's own process, a share each. */
function workersMemoryHolds(memoryBytes: number): number {
  return Math.floor(memoryBytes / TEST_PROCESS_MEMORY_BYTES) - 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(jobCores());
}
