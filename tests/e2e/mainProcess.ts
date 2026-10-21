import type { ElectronApplication } from "@playwright/test";

const COLLECTED = "Resulting promise was garbage collected";

/**
 * Runs a read in the app's main process, again each time Playwright reports
 * "Resulting promise was garbage collected", until it is answered.
 * Playwright awaits main-process evaluations through V8's inspector, which
 * holds the awaited promise weakly, so a garbage collection while the main
 * process is busy (the launch's work, the model catalog rebuilding) can free
 * it before it settles. The read has run by then and its answer is lost, so
 * only a read that gives the same answer when run again belongs here - a
 * step with a side effect is split so each part is one.
 *
 * Every lost answer waits for a collection in the main process, so the reads
 * keep pace with its work and the first one after the work drains is
 * answered, however long a slow first launch keeps it busy: hosted Linux
 * lost twenty in a row (journeys run 39464859977). A main process whose work
 * never drains fails at this read when the caller's own timeout runs out.
 */
export async function readInMain<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(COLLECTED)) throw error;
    }
  }
}

/**
 * Returns once the main process has answered `rounds` evaluations in a row
 * without losing one to a long turn: its launch-time work (model catalog
 * rebuilds, first-run reconcile) has drained and a spec's first evaluation
 * is safe. A lost answer restarts the count.
 */
export async function mainProcessSettled(app: ElectronApplication, rounds = 5): Promise<void> {
  let answered = 0;
  for (let attempt = 0; answered < rounds && attempt < 200; attempt++) {
    try {
      await app.evaluate(() => true);
      answered++;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(COLLECTED)) throw error;
      answered = 0;
    }
  }
}
