/** INF-1936 review: failed evidence or diagnostic teardown must not replace the
 * native outcome or prevent the remaining diagnostics from finishing.
 * Required setup and resource teardown still fail through their normal owners.
 */
export async function keepPhoneDiagnostic(name: string, keep: () => unknown, report = console.log): Promise<void> {
  try { await keep(); }
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
