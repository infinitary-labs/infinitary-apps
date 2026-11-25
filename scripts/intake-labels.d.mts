export const NEEDS_TRIAGE: string;
export const WAITING: string;
export const ACCEPTED: string;
/** The commit statuses main's branch rule requires of an outside pull request. */
export const REQUIRED: readonly string[];
/** Takes a label off an item; one already off is no error. */
export function removeLabel(target: {
  github: unknown;
  owner: string;
  repo: string;
  number: number;
  name: string;
}): Promise<void>;
/** The state of each REQUIRED status on one commit, in REQUIRED's order; undefined until it writes one. */
export function requiredStates(target: {
  github: unknown;
  owner: string;
  repo: string;
  sha: string;
}): Promise<(string | undefined)[]>;
/** Sets "waiting on author" on an outside pull request from its required statuses and says what it decided. */
export function syncWaiting(script: {
  github: unknown;
  context: unknown;
  pullNumber?: string;
}): Promise<string>;
