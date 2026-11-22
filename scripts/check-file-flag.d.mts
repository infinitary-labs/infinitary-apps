/** The label an outside pull request that edits check files gets. */
export const LABEL: string;
/** The check files: folders at the project's top, file names at any depth, and the top-level packaging settings. */
export const CHECK_FILES: { folders: readonly string[]; names: readonly string[]; top: RegExp };
/** Whether one path is a check file. */
export function isCheckFile(path: string): boolean;
/** The check files among a pull request's changed files, a renamed file by its old name too, sorted. */
export function checkFilesIn(
  files: readonly { filename: string; previous_filename?: string }[],
): string[];
/** The one comment a flagged pull request gets, kept up to date. */
export function flagComment(paths: readonly string[]): string;
/** Runs the flag for one event and says what it decided. */
export function flag(script: {
  github: unknown;
  context: unknown;
  core: { setFailed(why: string): void; summary: { addRaw(text: string): unknown; write(): Promise<unknown> } };
  pullNumber?: string;
}): Promise<string>;
