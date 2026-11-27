/** The commit status the check sets. */
export const STATUS: string;
/** no-mistakes' signature line, which Infinitary's record carries. */
export const SIGNATURE: string;
/** The start of a v1 record. */
export const RECORD_PREFIX: string;
/** Why a description's record does not pass. */
export type Problem = "no record" | "unreadable" | "another version" | "steps incomplete" | "not careful";
/** The verdict on one description at one version. */
export type Verdict =
  | {
      ok: true;
      live: { verdict: string; live: number; total: number };
      /** The version the record names, when the maintainer's crew brought it up to date to the newest one. */
      updatedFrom?: string;
    }
  | { ok: false; problem: Problem; named?: string };
/** Reads a description's record at one version. */
export function readRecord(body: string | null | undefined, head: string): Verdict;
/** Every update a comment's crew-update marks name. */
export function readUpdates(body: string | null | undefined): { from: string; to: string }[];
/** The status line for a verdict, at most 140 characters. */
export function statusLine(verdict: Verdict): string;
/** The one comment a failing outside pull request gets, kept up to date. */
export function failureComment(
  verdict: Extract<Verdict, { ok: false }>,
  head: string,
  guideUrl: string,
): string;
/** What the comment says once a later version passes. */
export const PASSED_COMMENT: string;
/** Runs the check for one event and says what it decided. */
export function check(script: {
  github: unknown;
  context: unknown;
  core: {
    setFailed(why: string): void;
    summary: { addRaw(text: string): unknown; write(): Promise<unknown> };
  };
  pullNumber?: string;
}): Promise<string>;
