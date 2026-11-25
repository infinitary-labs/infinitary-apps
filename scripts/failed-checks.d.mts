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
/** The note for one version, each job with a log link built from its numeric ids. */
export function failedComment(note: {
  server: string;
  owner: string;
  repo: string;
  sha: string;
  jobs: readonly { id: number; run_id: number; name: string }[];
}): string;
/** Runs the note for one event and says what it decided; a hand-started run is a dry run. */
export function noteFailedChecks(script: {
  github: unknown;
  context: unknown;
  core: { setFailed(why: string): void; summary: { addRaw(text: string): unknown; write(): Promise<unknown> } };
  pullNumber?: string;
}): Promise<string>;
