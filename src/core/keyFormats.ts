/**
 * Key formats a service issues, each recognizable by its own prefix or
 * frame: the one owner both the diagnostics redaction
 * (`observe/redact.ts`) and a signed-in task browser
 * (docs/task-browser.md, "A signed-in page") read. An explicit list, never
 * a completeness claim: a key in a format not here is not found, and adding
 * a format is a decision of its own each time (docs/secrets.md).
 *
 * Each pattern is global, for `String.replace`; never call `test` on one,
 * which keeps its place between calls.
 */
export const KEY_FORMATS = {
  anthropic: /\bsk-ant-[A-Za-z0-9_-]+/g,
  openai: /\bsk-[A-Za-z0-9_-]{10,}/g,
  xai: /\bxai-[A-Za-z0-9_-]+/g,
  // GitHub's sign-in shapes: the app's own OAuth sign-in (gho_), a user's
  // app sign-in (ghu_), a server's (ghs_), a refresh (ghr_), a personal one.
  github: /\bgh[opusr]_[A-Za-z0-9]+/g,
  githubPat: /\bgithub_pat_[A-Za-z0-9_]+/g,
  gitlab: /\bglpat-[A-Za-z0-9_-]+/g,
  privateKey: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  awsKeyId: /\bAKIA[0-9A-Z]{16}\b/g,
  slack: /\bxox[abprs]-[A-Za-z0-9-]+/g,
} as const;

/** What a key a signed-in task browser hides reads as, in place. */
export const KEY_HIDDEN = "[key hidden]";

/** The text with every key in a known format replaced by `KEY_HIDDEN`, the rest as it was. */
export function hideKeys(text: string): string {
  let out = text;
  for (const pattern of Object.values(KEY_FORMATS)) out = out.replace(pattern, KEY_HIDDEN);
  return out;
}
