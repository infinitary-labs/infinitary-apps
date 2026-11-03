import { commands } from "vitest/browser";

/**
 * What every browser test file starts from (docs/testing.md, "The browser
 * layer"): a page holding nothing an earlier file left. Each of the run's
 * browser sessions runs its files one after another in one page of one
 * origin, so the page's local and session storage, its cookies and its
 * emulated motion setting outlive the file that set them; this clears them,
 * as a launched app's fresh window profile starts empty. The browser project
 * runs it before each file (./freshPageSetup.ts).
 */
export async function freshPage(): Promise<void> {
  localStorage.clear();
  sessionStorage.clear();
  await commands.clearCookies();
  // The browser context's own setting, which a fresh page opens with.
  await commands.emulateReducedMotion("no-preference");
}
