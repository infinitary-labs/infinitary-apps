/**
 * Whether this run grades durations against their budgets (captain's B1,
 * "one clock, budgets measured", 2026-09-24; INF-857, the captain's choice:
 * "Grade durations only on a quiet run, as journeys already do").
 *
 * A duration measured on a host running other work grades the load, not the
 * code, so only a run on a quiet host with INFINITARY_PERF_BUDGETS=1 holds a
 * test to its budget: `verify.yml`'s on-demand `perf` input. On every other
 * run a test waits for its work with no clock, and the job's own time limit
 * stops a stuck one. The e2e budgets read this through `tests/e2e/perf.ts`;
 * vitest's test and hook limits read the same variable in the one-line patch
 * of `@vitest/runner` (`patches/`), and its waits through `waitWindow.ts`.
 */
export const GRADES_BUDGETS = process.env.INFINITARY_PERF_BUDGETS === "1";
