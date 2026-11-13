/**
 * The move of the language catalogs from one file per language
 * (`src/shared/i18n/messages/<tag>.json`) to one folder per language of area
 * files, and the way a change written before the move is brought up to date
 * (docs/i18n.md, "Bringing a change from before the move up to date").
 *
 *   node scripts/move-catalogs.ts           folds each messages/<tag>.json into its language's folder and removes it
 *   node scripts/move-catalogs.ts resolve   in a rebase or merge stopped on the move, carries the change's
 *                                           catalog edits into the area files, removes the compiled files the
 *                                           project no longer keeps, merges the glossaries' terms, rebuilds the
 *                                           phone's files and stages all of it
 *
 * A change from before the move edits files the move removed, so bringing it
 * up to date stops once for each of its commits that touched them; `resolve`
 * at each stop does the rest, and names any file it leaves to a person, such
 * as `scripts/raw-words.ts`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_PANEL_PREFIXES,
  byName,
  CATALOG_DIR,
  COMPILED_PATH,
  GLOSSARY_DIR,
  joinCatalogFiles,
  panelMessagesPath,
  readCatalogFiles,
  sortedGlossary,
  writeCatalogLayout,
} from "./generate-messages.ts";

type Messages = Record<string, unknown>;

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

/** A file's text at one stage of a stopped merge: 1 the common base, 2 ours, 3 theirs; undefined where that side has none. */
function staged(root: string, path: string, stage: 1 | 2 | 3): string | undefined {
  try {
    return git(root, ["show", `:${stage}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Whether the stop is a rebase's, where the change being replayed is theirs; in a merge into the change it is ours. */
function rebasing(root: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((name) =>
    existsSync(join(root, git(root, ["rev-parse", "--git-path", name]).trim())),
  );
}

/** One language's messages now, read from its folder. */
function currentMessages(root: string, tag: string): Messages {
  const { files } = readCatalogFiles(root);
  return joinCatalogFiles({ [tag]: files[tag] ?? {} }).catalogs[tag] ?? {};
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies what a change did to one language's catalog, from `base` to
 * `changed`, to the messages in its folder: a message it added or changed
 * takes the change's words, one it removed goes. Answers the names whose
 * words had changed in the folder too, which keep the change's words.
 */
export function carryChange(messages: Messages, base: Messages, changed: Messages): string[] {
  const overlaps: string[] = [];
  for (const [id, value] of Object.entries(changed)) {
    if (id in base && same(base[id], value)) continue;
    if (id in messages && id in base && !same(messages[id], base[id]) && !same(messages[id], value)) overlaps.push(id);
    messages[id] = value;
  }
  for (const id of Object.keys(base)) if (!(id in changed)) delete messages[id];
  return overlaps;
}

const parsed = (text: string | undefined): Messages => (text ? (JSON.parse(text) as Messages) : {});

/** A language's file from before the move, by its tag: `messages/<tag>.json`. */
const flatTag = (path: string) => new RegExp(`^${CATALOG_DIR}/([^/]+)\\.json$`).exec(path)?.[1];

/** The rows of a glossary's Terms table, and the rest of its text. */
function glossaryParts(text: string): { rows: string[]; rest: string } {
  const lines = text.split("\n");
  const rows = lines.filter((line, at) => line.startsWith("|") && at > 1 && lines.slice(0, at).some((l) => /^\|\s*-/.test(l)));
  return { rows, rest: lines.filter((line) => !rows.includes(line)).join("\n") };
}

/**
 * Merges a glossary both sides changed: the up-to-date side's terms, with the
 * terms the change added and without the ones it removed, in name order.
 * Undefined when the change also edited the words around the table, which a
 * person merges.
 */
export function mergedGlossary(base: string, upToDate: string, changed: string): string | undefined {
  const was = glossaryParts(base);
  const now = glossaryParts(changed);
  if (was.rest !== now.rest) return undefined;
  const added = now.rows.filter((row) => !was.rows.includes(row));
  const removed = new Set(was.rows.filter((row) => !now.rows.includes(row)));
  const lines = upToDate.split("\n");
  const kept = lines.filter((line) => !removed.has(line));
  const header = kept.findIndex((line, at) => line.startsWith("|") && /^\|\s*-/.test(kept[at + 1] ?? ""));
  if (header === -1) return undefined;
  let end = header + 2;
  while (end < kept.length && kept[end]?.startsWith("|")) end++;
  const fresh = added.filter((row) => !kept.includes(row));
  return sortedGlossary([...kept.slice(0, end), ...fresh, ...kept.slice(end)].join("\n"));
}

/** Runs the compiler in the working copy: it lays the catalogs out and rebuilds every compiled file. */
function compile(root: string): string {
  const run = spawnSync(process.execPath, ["scripts/generate-messages.ts"], { cwd: root, encoding: "utf8" });
  return run.status === 0 ? "" : `${run.stdout}${run.stderr}`;
}

const compiledPaths = () => [COMPILED_PATH, ...Object.keys(APP_PANEL_PREFIXES).map(panelMessagesPath)];

/** Folds every `messages/<tag>.json` in the working copy into its language's folder, then removes it. */
export function moveCatalogs(root = "."): string[] {
  const moved: string[] = [];
  for (const name of readdirSync(join(root, CATALOG_DIR)).sort(byName)) {
    const path = `${CATALOG_DIR}/${name}`;
    const tag = flatTag(path);
    if (!tag) continue;
    const messages = currentMessages(root, tag);
    Object.assign(messages, parsed(readFileSync(join(root, path), "utf8")));
    writeCatalogLayout(root, tag, messages);
    rmSync(join(root, path));
    moved.push(path);
  }
  return moved;
}

/**
 * Brings a stopped rebase or merge across the move: what each conflicted
 * `messages/<tag>.json` changed reaches its language's folder, a compiled
 * file the project no longer keeps leaves the commit, a glossary both sides
 * changed keeps both sides' terms, and the phone's files are rebuilt. Answers
 * what it did and what is left for a person.
 */
export function resolveMove(root = "."): { carried: string[]; overlaps: string[]; left: string[]; problems: string } {
  const replaying = rebasing(root);
  const conflicted = git(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  const carried: string[] = [];
  const overlaps: string[] = [];
  const handled = new Set<string>();
  for (const path of conflicted) {
    const tag = flatTag(path);
    if (!tag) continue;
    const ours = staged(root, path, 2);
    const theirs = staged(root, path, 3);
    // The move removed the file, so the side that still has it is the change.
    const changed = ours !== undefined && theirs !== undefined ? (replaying ? theirs : ours) : (ours ?? theirs);
    const messages = currentMessages(root, tag);
    overlaps.push(...carryChange(messages, parsed(staged(root, path, 1)), parsed(changed)).map((id) => `${tag}: ${id}`));
    writeCatalogLayout(root, tag, messages);
    git(root, ["rm", "--quiet", "--force", "--", path]);
    carried.push(path);
    handled.add(path);
  }
  // A language the change added before the move has no conflict: fold it in whole.
  for (const path of moveCatalogs(root)) {
    git(root, ["rm", "--quiet", "--force", "--cached", "--ignore-unmatch", "--", path]);
    carried.push(path);
  }
  for (const path of compiledPaths()) {
    if (!conflicted.includes(path)) continue;
    git(root, ["rm", "--quiet", "--force", "--cached", "--", path]);
    handled.add(path);
  }
  for (const path of conflicted) {
    if (!path.startsWith(`${GLOSSARY_DIR}/`)) continue;
    const base = staged(root, path, 1);
    const ours = staged(root, path, 2);
    const theirs = staged(root, path, 3);
    if (base === undefined || ours === undefined || theirs === undefined) continue;
    const merged = replaying ? mergedGlossary(base, ours, theirs) : mergedGlossary(base, theirs, ours);
    if (merged === undefined) continue;
    writeFileSync(join(root, path), merged);
    git(root, ["add", "--", path]);
    handled.add(path);
  }
  const problems = compile(root);
  // The phone's files are rebuilt from the catalogs, so a clash in them is settled by the rebuild.
  const rebuilt = git(root, ["ls-files", "--modified", "--others", "--exclude-standard", "--", "ios", CATALOG_DIR])
    .split("\n")
    .filter(Boolean);
  const unmerged = git(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  const phoneClashes = unmerged.filter((path) => path.startsWith("ios/"));
  const toStage = [...new Set([...rebuilt, ...phoneClashes])];
  if (!problems && toStage.length) git(root, ["add", "-A", "--", ...toStage]);
  const left = git(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  return { carried, overlaps, left, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "resolve") {
    const { carried, overlaps, left, problems } = resolveMove();
    for (const path of carried) console.log(`carried ${path} into its language's folder`);
    for (const name of overlaps)
      console.log(`kept the change's words for ${name}, which the up-to-date catalog changed too; check them`);
    if (problems) {
      console.error(`the compiler found problems; fix them, run node scripts/move-catalogs.ts resolve again:\n${problems}`);
      process.exitCode = 1;
    }
    if (left.length) {
      console.error(`resolve these by hand, then continue:\n${left.join("\n")}`);
      process.exitCode = 1;
    } else if (!problems) console.log("nothing is left to resolve; continue the rebase or the merge");
  } else {
    const moved = moveCatalogs();
    for (const path of moved) console.log(`moved ${path} into its language's folder`);
    const problems = compile(".");
    if (problems) {
      console.error(problems);
      process.exitCode = 1;
    }
  }
}
