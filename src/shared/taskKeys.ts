/**
 * Task keys as text writes them (FI3-594): `<PROJECT_KEY>-<seq>` (D6), a
 * project key of 2-4 capitals or digits (`PROJECT_KEY_PATTERN` in
 * src/core/tasks/projectKey.ts) and a sequence number. A key is a word of
 * its own: `FI3-594-plan`, `xFI3-594` and `fi3-594` name no task. Shape is
 * only a candidate - a card body links a key only once the host has found
 * a recorded task with exactly that key, so `F13-572` stays text where no
 * project F13 exists.
 */
export const TASK_KEY_IN_TEXT = "(?<![A-Za-z0-9_-])[A-Z0-9]{2,4}-[0-9]{1,9}(?![A-Za-z0-9_-])";

/** One key alone, as a bridge message carries it. */
export const TASK_KEY_EXACT = /^[A-Z0-9]{2,4}-[0-9]{1,9}$/;

/** The keys one body may link; past this, later keys stay text. */
export const TASK_KEYS_MAX = 64;

/** The distinct keys `text` writes, in order of first mention, at most TASK_KEYS_MAX. */
export function taskKeysIn(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(new RegExp(TASK_KEY_IN_TEXT, "g"))) {
    if (keys.includes(match[0])) continue;
    keys.push(match[0]);
    if (keys.length === TASK_KEYS_MAX) break;
  }
  return keys;
}

/** A stretch of words, or a key to draw as a link. */
export type TaskKeyPart = { text: string } | { key: string };

/**
 * `text` cut where it writes a key `linked` accepts (FI3-1271): the words
 * between stay as written, and every other key-shaped word stays in them.
 */
export function taskKeyParts(text: string, linked: (key: string) => boolean): TaskKeyPart[] {
  const parts: TaskKeyPart[] = [];
  let at = 0;
  for (const match of text.matchAll(new RegExp(TASK_KEY_IN_TEXT, "g"))) {
    if (!linked(match[0])) continue;
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ key: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
