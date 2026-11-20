import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CONNECTION_MAX_FRAME_BYTES } from "@shared/connection";
import {
  carriedPluginEntries,
  type EnabledClaudePlugins,
  insidePlugin,
  PLUGIN_MANIFEST,
  PLUGIN_SET_ROOT,
} from "../claude/claudePlugins";
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
const NEVER_SENT: ReadonlySet<string> = new Set([".git"]);
/** A plugin's own packages are how it was installed, not what its skills say. */
const NEVER_SENT_FROM_PLUGINS: ReadonlySet<string> = new Set([".git", "node_modules"]);

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
 * its own packages, say) is never read whole. With `within`, a plugin's
 * folder, an entry whose link leads outside it is left out, and a folder
 * is skipped only inside itself, so two paths to one folder both list it.
 */
function list(
  dir: string,
  base: string,
  out: Listed[],
  budget: number,
  seen: Set<string> = new Set(),
  skip: ReadonlySet<string> = NEVER_SENT,
  prefix = "",
  within?: string,
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
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (within !== undefined && !insidePlugin(within, path)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const inside = list(path, base, out, budget - bytes, seen, skip, prefix, within);
      if (inside === undefined) return undefined;
      bytes += inside;
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > budget) return undefined;
      out.push({
        path: prefix + posix(relative(base, path)),
        abs: path,
        exec: (stat.mode & 0o111) !== 0,
        stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`,
        size: stat.size,
      });
    }
  }
  // In a plugin, only a folder's own ancestors make a loop.
  if (within !== undefined) seen.delete(real);
  return bytes;
}

/**
 * A plugin's files that travel, by their paths under the set's plugin folder
 * for its id (`PLUGIN_SET_ROOT`), whatever version the home has: its
 * manifest, and every top-level entry but the parts that never reach a
 * crewmate (`carriedPluginEntries`). Undefined past `budget`.
 */
function listPlugin(
  plugin: { id: string; root: string },
  out: Listed[],
  budget: number,
  prefix = `${PLUGIN_SET_ROOT}/${plugin.id}/`,
): number | undefined {
  const own = Array.from(new Set([PLUGIN_MANIFEST, ...carriedPluginEntries(plugin.root)]));
  const listed: Listed[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of own) {
    const path = join(plugin.root, entry);
    if (!insidePlugin(plugin.root, path)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const inside = list(
        path,
        plugin.root,
        listed,
        budget - bytes,
        seen,
        NEVER_SENT_FROM_PLUGINS,
        prefix,
        plugin.root,
      );
      if (inside === undefined) return undefined;
      bytes += inside;
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > budget) return undefined;
      listed.push({
        path: prefix + posix(entry),
        abs: path,
        exec: (stat.mode & 0o111) !== 0,
        stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`,
        size: stat.size,
      });
    }
  }
  out.push(...listed);
  return bytes;
}

/**
 * A plugin's files a crewmate may read, by their paths inside it: the same
 * files the set carries, each inside the plugin's own folder, whatever its
 * links say (`stagePluginTrees`).
 */
export function pluginFiles(plugin: { id: string; root: string }): { path: string; abs: string }[] {
  const out: Listed[] = [];
  listPlugin(plugin, out, Number.POSITIVE_INFINITY, "");
  return out.map(({ path, abs }) => ({ path, abs }));
}

/**
 * The set as the reader would pick it from a home folder, listed and not yet
 * read: the instruction file's text, which the reader reads anyway, each
 * skill's files, then, with `plugins`, each turned-on plugin's files; a
 * skill or plugin that would take the set past its budget is left out whole
 * and named in `left`, so a large plugin never crowds out the person's own
 * skill folders.
 */
function listSet(
  home: string,
  enabled: EnabledClaudePlugins | undefined,
): {
  instructions: PersonalFile | undefined;
  listed: Listed[];
  left: string[];
} {
  const read = personalResources(home, new Set(), { enabled });
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
  for (const plugin of read.plugins) {
    const size = listPlugin(plugin, listed, PERSONAL_SET_BUDGET_BYTES - bytes);
    if (size === undefined) left.push(plugin.id);
    else bytes += size;
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
 * `enabled` is the plugin setting the home read (`claudePlugins.ts`); without
 * it, the set carries no plugin.
 */
export function personalSetVersion(
  home: string,
  digests: PersonalDigests,
  enabled: EnabledClaudePlugins | undefined,
): { version: string; files: number; left: string[] } {
  const { instructions, listed, left } = listSet(home, enabled);
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
  // The set without plugins is a part of the set with them: it keeps their files' digests.
  if (enabled) for (const abs of digests.keys()) if (!kept.has(abs)) digests.delete(abs);
  return { version: fingerprintOf(entries), files: entries.length, left };
}

/**
 * The home's set now, read whole from this user's home folder, as the reader
 * would pick it with no project's skills beside it: what the home sends,
 * with plugins only to a computer that keeps them (`personal-plugins`).
 */
export function personalSetFiles(
  home: string,
  enabled: EnabledClaudePlugins | undefined,
): {
  files: PersonalFile[];
  left: string[];
} {
  const { instructions, listed, left } = listSet(home, enabled);
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
