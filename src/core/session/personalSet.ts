import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { CONNECTION_MAX_FRAME_BYTES } from "@shared/connection";
import { personalResources } from "./personalResources";

/**
 * The home's personal instructions and skills as one set (docs/personal-resources.md,
 * "One set, kept on each computer"): the instruction file the reader picks and
 * every file of each skill it lists, by their paths under the home folder, so
 * a computer that runs work keeps the same set under a folder of its own and
 * the same reader picks the same files there.
 */
export type PersonalFile = { path: string; data: Buffer; exec: boolean };

export type { PersonalVersion } from "@shared/personalSet";

/**
 * The bytes of one set, which travels whole in one order: half a frame, so
 * the base64 it rides in and the order around it still fit.
 */
export const PERSONAL_SET_BUDGET_BYTES = CONNECTION_MAX_FRAME_BYTES / 2;

/** A skill's own git folder is how it was fetched, not what it says. */
const NEVER_SENT = new Set([".git"]);

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Paths in the set always use `/`, whatever the computer writes them with. */
const posix = (path: string) => path.split(sep).join("/");

/**
 * The set's fingerprint: the same files, by the same paths, the same bytes
 * and the same executable bit, give the same fingerprint on any computer.
 */
export function personalFingerprint(files: readonly PersonalFile[]): string {
  return fingerprintOf(files.map((file) => [file.path, sha(file.data), file.exec]));
}

function fingerprintOf(entries: [string, string, boolean][]): string {
  return sha(JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** A file of the set as it is listed, before anything reads it. */
type Listed = { path: string; abs: string; exec: boolean; stamp: string; size: number };

/**
 * Every regular file under a folder, following links, by its path from
 * `base`, listed by its size alone; once the listing passes `budget` bytes it
 * stops and answers `undefined`, so a skill too large to send (one holding
 * its own packages, say) is never read whole.
 */
function list(
  dir: string,
  base: string,
  out: Listed[],
  budget: number,
  seen: Set<string> = new Set(),
): number | undefined {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return 0;
  }
  // A link back up the tree is read once.
  if (seen.has(real)) return 0;
  seen.add(real);
  let bytes = 0;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return 0;
  }
  for (const name of names) {
    if (NEVER_SENT.has(name)) continue;
    const path = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const inside = list(path, base, out, budget - bytes, seen);
      if (inside === undefined) return undefined;
      bytes += inside;
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > budget) return undefined;
      out.push({
        path: posix(relative(base, path)),
        abs: path,
        exec: (stat.mode & 0o111) !== 0,
        stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`,
        size: stat.size,
      });
    }
  }
  return bytes;
}

/**
 * The set as the reader would pick it from a home folder, listed and not yet
 * read: the instruction file's text, which the reader reads anyway, and each
 * skill's files, a skill that would take the set past its budget left out
 * whole and named in `left`.
 */
function listSet(home: string): {
  instructions: PersonalFile | undefined;
  listed: Listed[];
  left: string[];
} {
  const read = personalResources(home);
  let bytes = 0;
  let instructions: PersonalFile | undefined;
  if (read.instructions) {
    const data = Buffer.from(read.instructions.content, "utf8");
    instructions = { path: posix(relative(home, read.instructions.path)), data, exec: false };
    bytes += data.length;
  }
  const listed: Listed[] = [];
  const left: string[] = [];
  for (const skill of read.skills) {
    const own: Listed[] = [];
    const size = list(skill.dir, home, own, PERSONAL_SET_BUDGET_BYTES - bytes);
    if (size === undefined) {
      left.push(skill.name);
      continue;
    }
    listed.push(...own);
    bytes += size;
  }
  return { instructions, listed, left };
}

/**
 * Each file's own fingerprint by what its listing saw (`Listed.stamp`), so
 * the home reads again only a file that changed since it last asked.
 */
export type PersonalDigests = Map<string, { stamp: string; sha: string }>;

/**
 * The home's set's fingerprint now, reading only the files whose listing
 * changed since `digests` saw them; `digests` keeps what it read for next time.
 */
export function personalSetVersion(
  home: string,
  digests: PersonalDigests,
): { version: string; files: number; left: string[] } {
  const { instructions, listed, left } = listSet(home);
  const entries: [string, string, boolean][] = [];
  if (instructions) entries.push([instructions.path, sha(instructions.data), false]);
  const kept = new Set<string>();
  for (const file of listed) {
    kept.add(file.abs);
    let known = digests.get(file.abs);
    if (known?.stamp !== file.stamp) {
      let data: Buffer;
      try {
        data = readFileSync(file.abs);
      } catch {
        continue;
      }
      known = { stamp: file.stamp, sha: sha(data) };
      digests.set(file.abs, known);
    }
    entries.push([file.path, known.sha, file.exec]);
  }
  for (const abs of digests.keys()) if (!kept.has(abs)) digests.delete(abs);
  return { version: fingerprintOf(entries), files: entries.length, left };
}

/**
 * The home's set now, read whole from this user's home folder, as the reader
 * would pick it with no project's skills beside it: what the home sends.
 */
export function personalSetFiles(home: string = homedir()): {
  files: PersonalFile[];
  left: string[];
} {
  const { instructions, listed, left } = listSet(home);
  const files: PersonalFile[] = instructions ? [instructions] : [];
  for (const file of listed) {
    try {
      files.push({ path: file.path, data: readFileSync(file.abs), exec: file.exec });
    } catch {}
  }
  return { files, left };
}

/** The fingerprint of a set as it is written under a folder: what a computer kept. */
export function personalFingerprintOf(root: string): string {
  const listed: Listed[] = [];
  list(root, root, listed, Number.POSITIVE_INFINITY);
  return personalFingerprint(
    listed.map((file) => ({ path: file.path, data: readFileSync(file.abs), exec: file.exec })),
  );
}
