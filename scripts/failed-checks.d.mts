/** The workflows whose runs on an outside pull request the note reads, by their `name:`. */
export const WORKFLOWS: readonly string[];
/** Whether a job finished failed. */
export function failed(job: { status?: string; conclusion?: string | null }): boolean;
/** The check a job runs: its innermost name level without the trigger. */
export function checkOf(name: string): string;
/** Splits failed jobs into those to name and those whose check also failed on main. */
export function leaveOutMain<J extends { name: string }>(
  jobs: readonly J[],
  mainJobs: readonly { name: string; status?: string; conclusion?: string | null }[],
): { named: J[]; onMain: J[] };
/** The note for one version, each job with a log link built from its numeric ids, then any left out because main fails them too. */
export function failedComment(note: {
  server: string;
  owner: string;
  repo: string;
  sha: string;
  jobs: readonly { id: number; run_id: number; name: string }[];
  /** Failed jobs left out because their check also fails on main, named without a link. */
  onMain?: readonly { name: string }[];
  /** Whether main's newest run has any failed job, which adds a line saying so. */
  mainFailing?: boolean;
  /** Whether this note put the label on, kept in the comment's mark; true when omitted. */
  labeled?: boolean;
}): string;
/** The note once nothing at that version is left for the pull request to fix: every failed check passes, or also fails on main. */
export function clearedComment(note: {
  sha: string;
  /** Failed checks that also fail on main; any leaves the pull request waiting on main. */
  onMain?: readonly { name: string }[];
  labeled?: boolean;
}): string;
/** Runs the note for one event and says what it decided; a hand-started run is a dry run. */
export function noteFailedChecks(script: {
  github: unknown;
  context: unknown;
  core: { setFailed(why: string): void; summary: { addRaw(text: string): unknown; write(): Promise<unknown> } };
  pullNumber?: string;
}): Promise<string>;
