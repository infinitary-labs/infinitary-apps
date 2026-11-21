/** The commit status the check sets, which main's branch rule requires. */
export const STATUS: string;
/** The record issue's exact title. */
export const RECORD_TITLE: string;
/** The sentence an author ticks or replies with to accept. */
export const SENTENCE: string;
/** The account the workflow's token writes as, the only author of record entries. */
export const BOT: string;
/** The agreement's version, from its "Version N" line. */
export function agreementVersion(text: string): number;
/** Whether a reply is the sentence, and nothing else. */
export function isAcceptance(body: string | null | undefined): boolean;
/** Whether a description carries the template's box, ticked. */
export function hasTickedBox(body: string | null | undefined): boolean;
/** One record entry as the check writes and reads it. */
export type Entry = { login: string; id: number; pull: number; link: string; version: number; at: string };
/** The entries the bot wrote to the record, oldest first. */
export function readEntries(
  comments: readonly { user?: { login?: string; type?: string } | null; body?: string | null }[],
): Entry[];
/** One record entry's comment. */
export function entryComment(entry: Entry): string;
/** The one comment an outside pull request gets until its author accepts. */
export function askComment(agreementUrl: string): string;
/** Runs the check for one event and says what it decided. */
export function check(script: {
  github: unknown;
  context: unknown;
  core: { setFailed(why: string): void };
  agreement: string;
  now?: () => Date;
}): Promise<
  | "not a pull request"
  | "own branch"
  | "no record"
  | "accepted before"
  | "accepted now"
  | "no acceptance"
  | "asked"
>;
