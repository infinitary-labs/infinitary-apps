export const NEEDS_TRIAGE: string;
export const WAITING: string;
export const ACCEPTED: string;
/** The commit statuses main's branch rule requires of an outside pull request. */
export const REQUIRED: readonly string[];
/** Sets "waiting on author" on an outside pull request from its required statuses and says what it decided. */
export function syncWaiting(script: {
  github: unknown;
  context: unknown;
  pullNumber?: string;
}): Promise<string>;
