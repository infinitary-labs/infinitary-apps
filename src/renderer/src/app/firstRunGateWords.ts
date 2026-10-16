/**
 * The first-launch gate's words (docs/first-launch.md), in a plain module a
 * spec can load, so it reads them from here rather than typing them.
 */

export const GATE_TITLE = "Connect a subscription to begin";

/**
 * While the gate asks for the fresh check of the custom connection the
 * Firstmate was chosen on (`FreshCheck`), it names that connection instead.
 */
export function freshCheckTitle(label: string): string {
  return `Check ${label} again to begin`;
}

/** What the fresh check covers and what it may cost, before anything is sent. */
export function freshCheckLine(check: { label: string; models: readonly string[] }): string {
  const need =
    check.models.length === 1 ? "its model needs" : `its ${check.models.length} models need`;
  return `Your first mate answers from ${check.label}, and ${need} one fresh check. Checking may use billable tokens and sends only test text, never your work.`;
}

/** On a Mac that controls another's Firstmate, the check happens there. */
export function freshCheckThere(mac: string): string {
  return `Check it on ${mac}, where your first mate lives.`;
}

export const FRESH_CHECK_ACTION = "Check again";
export const FRESH_CHECK_PENDING = "Checking...";

/** A model the fresh check stopped at, with the server's reason in safe words. */
export function freshCheckFailure(model: string, reason: string): string {
  return `${model}: ${reason}`;
}
