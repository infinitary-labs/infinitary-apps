import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { PERSONAL_ID_PATTERN } from "@shared/personal/manifest";
import type { PanelSourceFile } from "../plugins/pluginLint";
import { requireConventional } from "../workspace/conventional";
import { APP_GIT_IDENTITY, git } from "../workspace/git";

/**
 * The personal workspace as a LIVE build site (talk-to-personalize Step 4,
 * the personal workspace's own kind; docs/personal-panels.md "The build
 * loop").
 * A crewmate on a live task edits `userData/fleet/personal/` in place: no
 * worktree, no branch, no PR. The host does the bookkeeping git would
 * otherwise get from a settle, and this module is that bookkeeping:
 *
 * - which extensions a turn touched (`changedExtensionIds`): the
 *   uncommitted paths, by their first segment, so a stamp or a lint knows
 *   what the crewmate is working on without the crewmate saying so;
 * - the provenance stamp (`stampOrigin`): `manifest.json` `origin.taskId`
 *   names the task that built (or last revised) the extension, which is
 *   what lights the running dot while that task is active and what the
 *   record links back from;
 * - the commit at the end of a turn (`commitWorkspace`), under the app's
 *   identity with the crewmate's report as the message, only when the
 *   tree changed - the crewmate never has to commit and a turn that changed
 *   nothing leaves no empty commit;
 * - the extensions as the last commit holds them (`committedTrees`,
 *   `writeCommittedTree`), which is what the rails draw while a crewmate
 *   builds (docs/personal-panels.md, "Built apart");
 * A removal is Step 1's `PersonalExtensions.remove`: one commit, so "put it
 * back" is a revert, never a rewrite.
 *
 * Every function takes the workspace directory: nothing here holds state,
 * and a test drives it over a temp repo.
 */

/**
 * One porcelain line: `XY path` (X or Y may be a space) or `XY old -> new`.
 * The git runner trims its output, so the FIRST line of a tracked edit
 * arrives as `M path` rather than ` M path`: the status columns are read
 * by pattern, never by offset.
 */
const PORCELAIN_LINE = /^([ MADRCU?!]{1,2}) (.+)$/;

/**
 * The workspace-relative paths git reports as changed, staged or not, untracked included.
 * A live task's reconcile reads this while the host commits the turn, so the
 * read never takes git's optional index lock: a read holding it makes the
 * turn's `git add` or `git commit` fail on `index.lock: File exists`
 * (`commitWorkspace`).
 */
export async function changedPaths(workspaceDir: string): Promise<string[]> {
  const out = await git(workspaceDir, [
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .flatMap((line) => {
      const match = line.match(PORCELAIN_LINE);
      if (!match?.[2]) return [];
      // A rename names its new path last.
      const path = match[2];
      const arrow = path.indexOf(" -> ");
      return [arrow >= 0 ? path.slice(arrow + 4) : path];
    })
    .map((path) => (path.startsWith('"') ? path.slice(1, -1) : path));
}

/**
 * Top-level folders that hold records, never an extension: `lessons/` keeps a
 * learner's files (`.claude/skills/lessons`), which a panel build never stamps or lints.
 */
const RECORD_FOLDERS: ReadonlySet<string> = new Set([".claude", "lessons"]);

/** The extension ids among the changed paths: a first segment that is a valid id. */
export async function changedExtensionIds(workspaceDir: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const path of await changedPaths(workspaceDir)) {
    const head = path.split(/[\\/]/)[0] ?? "";
    if (PERSONAL_ID_PATTERN.test(head) && !RECORD_FOLDERS.has(head)) ids.add(head);
  }
  return [...ids].sort();
}

/**
 * Writes `origin.taskId` into the extension's `manifest.json`, creating the
 * file when there is none. A manifest that is not JSON is left alone - the
 * compiler already reports it against the extension with the path named,
 * and a stamp must never paper over a crewmate's broken file. Answers
 * whether anything was written.
 */
export async function stampOrigin(
  workspaceDir: string,
  extensionId: string,
  taskId: string,
): Promise<boolean> {
  const dir = join(workspaceDir, extensionId);
  try {
    if (!(await stat(dir)).isDirectory()) return false;
  } catch {
    return false;
  }
  const path = join(dir, "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    manifest = raw as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const origin =
    typeof manifest.origin === "object" && manifest.origin !== null
      ? (manifest.origin as Record<string, unknown>)
      : {};
  if (origin.taskId === taskId) return false;
  manifest.origin = { ...origin, taskId };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return true;
}

/** The task an extension's working `manifest.json` names (`origin.taskId`), or null. */
export async function readStamp(workspaceDir: string, extensionId: string): Promise<string | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(workspaceDir, extensionId, "manifest.json"), "utf8"),
    ) as { origin?: { taskId?: unknown } } | null;
    const taskId = raw?.origin?.taskId;
    return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
  } catch {
    return null;
  }
}

/**
 * The tree each extension directory has in the last commit, by id: empty
 * for a workspace with no commit yet, and without a new extension. Reads
 * objects only, never the index, so it never meets the turn's commit.
 */
export async function committedTrees(workspaceDir: string): Promise<Map<string, string>> {
  const trees = new Map<string, string>();
  let listing: string;
  try {
    listing = await git(workspaceDir, ["ls-tree", "-z", "HEAD"], { trim: false });
  } catch {
    return trees;
  }
  for (const entry of listing.split("\0")) {
    const match = /^040000 tree ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
    if (match?.[1] && match[2] && PERSONAL_ID_PATTERN.test(match[2])) trees.set(match[2], match[1]);
  }
  return trees;
}

/** The files a compile or a manifest read can reach: text sources, by their extension. */
const COMMITTED_SOURCE = /\.(tsx?|jsx?|mjs|css|json)$/;

/**
 * Writes one committed tree's source files under `targetDir`, byte for byte
 * as the commit holds them, so a compile of the copy is the same version as
 * a compile of the same files in place (the compiler hashes the sources,
 * never where they sit). A file no compile reads - a picture, a link - is
 * left out rather than decoded as text.
 */
export async function writeCommittedTree(
  workspaceDir: string,
  tree: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const listing = await git(workspaceDir, ["ls-tree", "-r", "-z", tree], { trim: false });
  for (const entry of listing.split("\0")) {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const [, mode, blob, path] = match;
    if (mode === "120000" || !COMMITTED_SOURCE.test(path)) continue;
    const target = join(targetDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await git(workspaceDir, ["cat-file", "blob", blob], { trim: false }));
  }
}

export type WorkspaceCommit = {
  committed: boolean;
  /** The new HEAD when a commit was made. */
  sha?: string;
  /** The paths the commit carried, workspace-relative. */
  paths: string[];
};

/**
 * Stages everything and commits under the app's identity when the index
 * differs from HEAD. A typed first sentence stays the subject; an untyped
 * report gets a chore prefix. The rest rides as the body, so the report
 * stays whole in the history.
 */
export async function commitWorkspace(
  workspaceDir: string,
  message: string,
  options: { only?: string[] } = {},
): Promise<WorkspaceCommit> {
  const paths = options.only && options.only.length > 0 ? options.only : undefined;
  await git(workspaceDir, ["add", "-A", "--", ...(paths ?? ["."])]);
  const staged = await git(workspaceDir, ["diff", "--cached", "--name-only"]);
  const changed = staged
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (changed.length === 0) return { committed: false, paths: [] };
  const { subject, body } = splitMessage(message);
  const typedSubject = /^((feat|fix|chore|test|refactor|docs|perf)(\([a-z0-9./-]+\))?!?: )/.test(
    subject,
  )
    ? subject
    : `chore: ${subject.slice(0, 65)}`;
  requireConventional(typedSubject);
  await git(workspaceDir, [
    ...APP_GIT_IDENTITY,
    "commit",
    "-m",
    typedSubject,
    ...(body ? ["-m", body] : []),
    ...(paths ? ["--only", "--", ...paths] : []),
  ]);
  const sha = await git(workspaceDir, ["rev-parse", "HEAD"]);
  return { committed: true, sha, paths: changed };
}

/**
 * The subject line git shows: the first sentence or line, bounded to 72
 * characters. A subject that had to be cut carries the WHOLE report as the
 * body, so nothing the crewmate said is lost to the bound.
 */
export function splitMessage(message: string): { subject: string; body: string } {
  const text = message.replace(/\r\n/g, "\n").trim();
  const firstLine = text.split("\n")[0] ?? "";
  const sentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? firstLine;
  const truncated = sentence.length > 72;
  const subject = (truncated ? `${sentence.slice(0, 69).trimEnd()}...` : sentence).trim();
  const rest = truncated ? text : text.slice(text.indexOf(sentence) + sentence.length).trim();
  return { subject: subject || "Update the personal workspace", body: rest };
}

/** Every lintable source of one extension: `.ts`, `.tsx`, `.json`, recursive, relative to the extension. */
export async function extensionSources(
  workspaceDir: string,
  extensionId: string,
): Promise<PanelSourceFile[]> {
  const root = join(workspaceDir, extensionId);
  const files: PanelSourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(path);
      } else if (entry.isFile() && /\.(tsx?|json|css)$/.test(entry.name)) {
        files.push({
          path: relative(root, path).split(sep).join("/"),
          text: await readFile(path, "utf8"),
        });
      }
    }
  };
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
