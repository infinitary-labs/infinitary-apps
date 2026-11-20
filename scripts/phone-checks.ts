import { PHONE_COMMAND_BUDGET_MS, withinPhoneDeadline } from "./phone-deadlines.ts";

/** INF-1936 review: failed evidence or diagnostic teardown must not replace the
 * native outcome or prevent the remaining diagnostics from finishing.
 * Required setup and resource teardown still fail through their normal owners.
 */
export async function keepPhoneDiagnostic(name: string, keep: () => unknown, report = console.log,
  budget = PHONE_COMMAND_BUDGET_MS): Promise<void> {
  // INF-5387 piece 1: a close that hangs, as one on a frozen simulator can, is left at its deadline and the rest go on;
  // the gate ends its processes at its own end.
  try { await withinPhoneDeadline(name, budget, Promise.resolve().then(keep), async () => "the check went on without it"); }
  catch (error) { report(`${name} could not be kept: ${String(error)}`); }
}

/** INF-2176: requested output must finish after a passing check; if the check
 * already failed, keep that failure and report any finalization error instead.
 */
export async function finishPhoneCheck<T>(check: Promise<T>, finish: () => unknown): Promise<T> {
  let passed = false;
  try {
    const result = await check;
    passed = true;
    return result;
  } finally {
    if (passed) await finish();
    else await keepPhoneDiagnostic("Phone check finalization", finish);
  }
}

// INF-663 (captain: "will that discover all the test failures across all journeys, or will
// it only discover the first one that failed?"): the native gate's checks before its
// simulator tests each report their own failure, and a failed one no longer hides the rest.

/** Runs every check, in order, and answers each failure's message; an interruption still stops at once. */
export async function runEveryCheck(
  checks: readonly (() => Promise<unknown>)[],
  interrupted: () => boolean,
): Promise<string[]> {
  const failures: string[] = [];
  for (const check of checks) {
    try {
      await check();
    } catch (error) {
      if (interrupted()) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

/** Observe rejection now, but propagate it when the owner joins before cleanup. */
export function joinPhoneObserver(work: Promise<void>): () => Promise<void> {
  void work.catch(() => {});
  return () => work;
}
