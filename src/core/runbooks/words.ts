/** Shared words for the installer, its consent card and the journeys reading them. */
export function runbookConsentTitle(name: string): string {
  return `Add ${name}?`;
}
/** The add card's line before the panels a runbook shows while it is on. */
export const RUNBOOK_PANELS_WORDS =
  "While it is on, it also shows these panels on your rail. Adding it agrees to them too.";
export function runbookAddedLine(name: string, author: string, replacement?: string): string {
  return `added "${name}", a runbook by ${author}${replacement ? `; ${replacement} off` : ""}`;
}
export function runbookRemovedLine(name: string, author: string): string {
  return `removed "${name}", a runbook by ${author}`;
}
