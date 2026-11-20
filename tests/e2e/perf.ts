import { expect, test } from "@playwright/test";
import { GRADES_BUDGETS } from "../helpers/budgets";

/**
 * Durations, and the one place they are graded (captain's B1, "one clock,
 * budgets measured", 2026-09-24).
 *
 * A timing CLAIM in an end-to-end spec is an order or a count read off the
 * page's own clock: the app did X after Y, a paint built only the new row.
 * A duration against a fixed budget is a different thing - a measurement of
 * this machine - and on a host running several suites at once it grades the
 * load, not the app (a four-line paint read 195 ms there). So every run
 * prints and annotates each duration, and only a perf run grades it: the
 * spec files holding a test tagged PERF_TAG, run whole on a quiet host with
 * INFINITARY_PERF_BUDGETS=1, which is `verify.yml`'s on-demand `perf` input.
 * The Biome plugin `tests/lint/e2e-no-ms-budgets.grit` refuses a
 * `toBeLessThan(X_MS)` anywhere else in tests/e2e.
 */

/** The tag a test carries when it measures a budgeted duration. */
export const PERF_TAG = "@perf";

/** Whether this run grades the budgets: a perf run, on a quiet host. */
export { GRADES_BUDGETS };

const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0;
const max = (values: number[]) => Math.max(...values);

/**
 * Report `values` (milliseconds) under `name` - printed, and annotated on
 * the test's report - and, on a perf run, hold their maximum under
 * `budgetMs`. The hold is soft: a test that measures several durations
 * grades every one of them in one run, and fails at its end if any missed.
 */
export function measured(name: string, values: number[], budgetMs: number): void {
  const line = `n=${values.length} p95=${p95(values).toFixed(2)}ms max=${max(values).toFixed(2)}ms budget=${budgetMs}ms`;
  test.info().annotations.push({ type: name, description: line });
  console.log(`[perf] ${name} ${line}`);
  if (GRADES_BUDGETS) {
    expect.soft(max(values), `${name} against its ${budgetMs} ms budget`).toBeLessThan(budgetMs);
  }
}

/**
 * `measured` for a bar with more than one bound (INF-2078's plan, the
 * latency check): report `values` under `name`, in `unit`, and on a perf
 * run hold their 95th percentile under `bar.p95` and their maximum under
 * `bar.max`, each a soft hold as `measured`'s is.
 */
export function graded(
  name: string,
  values: number[],
  bar: { p95?: number; max?: number },
  unit = "ms",
): void {
  const bounds = [
    ...(bar.p95 === undefined ? [] : [`p95<${bar.p95}`]),
    ...(bar.max === undefined ? [] : [`max<${bar.max}`]),
  ].join(" ");
  const line = `n=${values.length} p95=${p95(values).toFixed(2)}${unit} max=${max(values).toFixed(2)}${unit} bar=${bounds}`;
  test.info().annotations.push({ type: name, description: line });
  console.log(`[perf] ${name} ${line}`);
  if (!GRADES_BUDGETS) return;
  if (bar.p95 !== undefined)
    expect
      .soft(p95(values), `${name} p95 against its ${bar.p95} ${unit} bar`)
      .toBeLessThan(bar.p95);
  if (bar.max !== undefined)
    expect
      .soft(max(values), `${name} max against its ${bar.max} ${unit} bar`)
      .toBeLessThan(bar.max);
}
