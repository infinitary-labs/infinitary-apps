/** Shared words for the installer, its consent card and the journeys reading them. */
export function runbookConsentTitle(name: string): string {
  return `Add ${name}?`;
}
export function runbookAddedLine(name: string, author: string, replacement?: string): string {
  return `added "${name}", a runbook by ${author}${replacement ? `; ${replacement} off` : ""}`;
}
export function runbookRemovedLine(name: string, author: string): string {
  return `removed "${name}", a runbook by ${author}`;
}
