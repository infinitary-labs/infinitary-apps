import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeDisplayName } from "@shared/attachments";

/**
 * The shared message-length ceiling (captain decision, 2026-09-04, following
 * the 400-char crewmate-report truncation that hid outcomes from Firstmate):
 * every excerpt a crewmate report, supervision wake, or job output feeds
 * into an agent's context caps here. Text within the limit rides whole.
 * Text past it is never just cut - the full text is spilled to a file under
 * the overflow dir and the excerpt carries a pointer, so nothing an agent
 * needs to act correctly is silently dropped.
 */
export const MESSAGE_EXCERPT_LIMIT = 10_000;

let overflowDir: string | undefined;

/**
 * Wires the app-scoped spill directory (services.ts, at boot). Callers
 * before boot - tests, scripts - fall back to the OS temp dir, so
 * capWithOverflow never throws for lack of configuration.
 */
export function initOverflowDir(dir: string): void {
  overflowDir = dir;
}

function dirFor(): string {
  return overflowDir ?? join(tmpdir(), "infinitary-overflow");
}

/**
 * Cap `text` at `limit` characters (default MESSAGE_EXCERPT_LIMIT). Text at
 * or under the limit rides unchanged unless `force` requests a file anyway. Anything longer is spilled whole to
 * `<tag>-<id>.txt` under the overflow dir, and the returned excerpt carries
 * a pointer to that file instead of just dropping the remainder.
 *
 * `keep: "head"` (default) keeps the start, as a bare `.slice(0, limit)`
 * did. `keep: "tail"` keeps the end instead - for streamed output such as a
 * job's stdout/stderr, where the final lines (a test summary, an exit
 * message) matter more than the first.
 */
export function capWithOverflow(
  text: string,
  tag: string,
  opts: {
    limit?: number;
    keep?: "head" | "tail";
    force?: boolean;
    onFile?: (path: string) => void;
  } = {},
): string {
  const { limit = MESSAGE_EXCERPT_LIMIT, keep = "head" } = opts;
  if (text.length <= limit && !opts.force) return text;
  const dir = dirFor();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tag}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  opts.onFile?.(file);
  const omitted = Math.max(0, text.length - limit);
  return keep === "tail"
    ? `[truncated ${omitted} earlier characters; full text: ${file}]\n${text.slice(-limit).trimStart()}`
    : `${text.slice(0, limit).trimEnd()}\n[truncated ${omitted} more characters; full text: ${file}]`;
}

/**
 * A stable overflow path for a caller that spills incrementally (a job's
 * live stdout/stderr) instead of once at the end. `id` should be unique per
 * source (a job id) so repeated calls target the same file.
 */
export function overflowFilePath(tag: string, id: string): string {
  return join(dirFor(), `${tag}-${id}.txt`);
}

/** Append one more chunk to an overflow file, creating it (and its dir) on first write. */
export function appendOverflow(file: string, chunk: string): void {
  mkdirSync(dirFor(), { recursive: true });
  appendFileSync(file, chunk, "utf8");
}

/**
 * Materialize pasted and dropped text files only at send, including short
 * many-line pastes. A file that came with a name says it ahead of its
 * preview (the name is text, never markup); the preview is its first 2,000
 * characters and the pointer is the managed full copy.
 */
export type MessageFile = {
  kind: "text";
  name: string;
  path: string;
  bytes: number;
  sha256: string;
};

export function withPastedFiles(
  text: string,
  files: readonly { text: string; name?: string }[] = [],
  kept?: MessageFile[],
): string {
  return [
    text,
    ...files.map((file) => {
      const name = file.name ? safeDisplayName(file.name) : "";
      const spilled = capWithOverflow(file.text, "pasted-text", {
        limit: 2000,
        force: true,
        onFile: (path) =>
          kept?.push({
            kind: "text",
            name: name || "pasted-text.txt",
            path,
            bytes: Buffer.byteLength(file.text),
            sha256: createHash("sha256").update(file.text).digest("hex"),
          }),
      });
      return name ? `[attached file: ${name}]\n${spilled}` : spilled;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
