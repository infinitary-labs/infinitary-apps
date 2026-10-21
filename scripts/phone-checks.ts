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
