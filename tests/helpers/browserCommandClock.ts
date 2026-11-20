import { startCommandLoadClock } from "./budgets";

/**
 * The browser project's command process on the load clock (INF-4644; INF-1083,
 * the captain's choice "a deadline counts only the time the test gets to run,
 * capped at 20 times its budget"). A browser test's click, fill or hover is a
 * Playwright action this process runs, and the page gives it the load time its
 * test has left (the patched `@vitest/runner`). Playwright keeps that limit here,
 * so this process counts it on a load clock of its own, read by the patched
 * `playwright-core`, rather than on the wall clock, where a busy computer ends
 * an action its test still has time for. A graded run keeps the wall clock.
 * The browser project lists this file among its global setups (vitest.config.ts).
 */
export default function setup(): () => void {
  return startCommandLoadClock();
}
