export const REMIND_DAYS: number;
export const CLOSE_DAYS: number;
/** The one reminder an item waiting on its author gets. */
export function reminderComment(item: { user: { login: string }; pull_request?: unknown }): string;
/** The note an item gets as it closes. */
export function closeComment(item: { user: { login: string }; pull_request?: unknown }): string;
/** When an item started waiting, from its timeline, as milliseconds; null when the label's addition is not found. */
export function waitingSince(item: { user?: { id: number } }, timeline: readonly unknown[]): number | null;
/** Runs once and returns the items it reminded and closed. */
export function tick(script: {
  github: unknown;
  context: unknown;
  core: { info(text: string): void };
  now?: () => Date;
}): Promise<{ reminded: number[]; closed: number[] }>;
