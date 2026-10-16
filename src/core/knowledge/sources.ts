import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { FileOrigin } from "../storage/knowledgeStore";

/**
 * Evidence from a working copy (docs/knowledge.md, "Evidence"): the host
 * reads a cited file inside the crewmate's own working copy and keeps the
 * excerpt, its digest and where it came from. It reads text and nothing
 * else - it follows no link out of the working copy, executes nothing and
 * fetches nothing - and it never writes the file.
 */

/** The most text one source keeps. */
export const SOURCE_TEXT_MAX_BYTES = 32 * 1024;
/** The largest file the host reads to cite or check. */
export const SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** What git says about a file in a working copy: its commit, and whether it differs from it. */
export type GitFacts = (
  root: string,
  path: string,
) => Promise<{ commit: string | null; dirty: boolean }>;

/** What a fresh look at a cited source found. */
export type SourceCheck = {
  state: "unchanged" | "changed" | "missing" | "unknown" | "kept";
  detail: string;
};

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A cited path, relative to its working copy, or the reason it cannot be cited. */
function inside(root: string, path: string): { real: string; rel: string } | string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0")) return "Give the file's path inside your working copy.";
  if (isAbsolute(trimmed))
    return "Give the path relative to your working copy, not an absolute path.";
  const rel = normalize(trimmed);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return "That path is outside your working copy.";
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) return "Files inside .git cannot be cited.";
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return "Your working copy cannot be read just now.";
  }
  const target = resolve(realRoot, rel);
  let real: string;
  try {
    if (lstatSync(target).isSymbolicLink()) return `${rel} is a link; cite the file itself.`;
    real = realpathSync(target);
  } catch {
    return `${rel} does not exist in your working copy.`;
  }
  // A linked folder on the way would land elsewhere: only the plain path counts.
  if (real !== target || !(real === realRoot || real.startsWith(`${realRoot}${sep}`))) {
    return `${rel} goes through a link; cite the file at its own path.`;
  }
  return { real, rel: relative(realRoot, real) };
}

function readText(path: string): string | undefined {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > SOURCE_FILE_MAX_BYTES) return undefined;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
}

/**
 * Keep an excerpt of a file in `root`, lines `startLine`..`endLine`
 * (1-based, inclusive; the whole file when neither is given). Returns the
 * kept text and its origin, or the reason it was refused.
 */
export async function captureFile(input: {
  root: string;
  project: string;
  path: string;
  startLine?: number;
  endLine?: number;
  gitFacts: GitFacts;
}): Promise<{ text: string; origin: FileOrigin } | { refused: string }> {
  const place = inside(input.root, input.path);
  if (typeof place === "string") return { refused: place };
  let whole: string | undefined;
  try {
    whole = readText(place.real);
  } catch {
    return { refused: `${place.rel} cannot be read.` };
  }
  if (whole === undefined) {
    return {
      refused: `${place.rel} is not a text file under ${SOURCE_FILE_MAX_BYTES / 1024 / 1024} MB, so it cannot be cited.`,
    };
  }
  const lines = whole.split("\n");
  const count = whole.endsWith("\n") ? lines.length - 1 : lines.length;
  const start = input.startLine ?? 1;
  const end = input.endLine ?? (input.startLine === undefined ? count : start);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { refused: "Give start_line and end_line as line numbers, start first." };
  }
  if (start > count) return { refused: `${place.rel} has only ${count} lines.` };
  const last = Math.min(end, count);
  const text = lines.slice(start - 1, last).join("\n");
  if (Buffer.byteLength(text) > SOURCE_TEXT_MAX_BYTES) {
    return {
      refused: `Lines ${start}-${last} of ${place.rel} are over ${SOURCE_TEXT_MAX_BYTES / 1024} KB; cite fewer lines.`,
    };
  }
  let facts: { commit: string | null; dirty: boolean };
  try {
    facts = await input.gitFacts(input.root, place.rel);
  } catch {
    facts = { commit: null, dirty: true };
  }
  return {
    text,
    origin: {
      kind: "file",
      project: input.project,
      path: place.rel,
      startLine: start,
      endLine: last,
      commit: facts.commit,
      dirty: facts.dirty,
      fileDigest: sha256(whole),
    },
  };
}

/**
 * Whether a cited file still reads as it did, in the working copy `root`
 * the reader works in: unchanged, changed, missing, or unknown when there is
 * no working copy to read. It reads the same path the source names, under
 * the same rules as a citation, and says nothing about whether the finding
 * is still true.
 */
export function checkFile(origin: FileOrigin, root: string | undefined): SourceCheck {
  const at = origin.commit
    ? ` (kept at commit ${origin.commit.slice(0, 10)}${origin.dirty ? " with uncommitted changes" : ""})`
    : "";
  if (!root) return { state: "unknown", detail: `no working copy of this project to compare${at}` };
  const place = inside(root, origin.path);
  if (typeof place === "string") return { state: "missing", detail: `${origin.path} is gone${at}` };
  let whole: string | undefined;
  try {
    whole = readText(place.real);
  } catch {
    return { state: "unknown", detail: `${origin.path} could not be read${at}` };
  }
  if (whole === undefined)
    return { state: "unknown", detail: `${origin.path} is no longer readable text${at}` };
  if (sha256(whole) === origin.fileDigest) {
    return { state: "unchanged", detail: `${origin.path} is unchanged since it was kept` };
  }
  return {
    state: "changed",
    detail: `${origin.path} has changed since it was kept${at}; recheck before relying on it`,
  };
}
