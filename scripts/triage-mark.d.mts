/** What each disposition does: labels to add, and whether and why it closes. */
export const DISPOSITIONS: Readonly<
  Record<string, { add: readonly string[]; close?: "not_planned" | "completed"; pullOnly?: boolean }>
>;
/** The disposition a comment's mark names, or null for none or one not on the list. */
export function readMark(body: string | null | undefined): string | null;
/** Runs for one new comment and says what it decided. */
export function applyMark(script: {
  github: unknown;
  context: unknown;
  core: { info(text: string): void };
}): Promise<string>;
