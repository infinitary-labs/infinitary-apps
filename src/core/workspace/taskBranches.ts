import { BATCH_BRANCH_PREFIX } from "@shared/batches";
import { git } from "./git";

/**
 * A task's branch (docs/architecture.md, "A task's branch"): how a new one
 * is named, and which branches are the app's own task branches.
 *
 * A new task's branch is the name the first mate wrote from the naming
 * runbook's words, or `inf/` and a slug of its title when it wrote none,
 * followed by a short code from the task's id (`nameTaskBranch`). The name
 * is chosen once, when the task's working copy is first made, and the
 * record keeps it from then on.
 *
 * The repository says which task a branch belongs to with a per-branch git
 * setting, `branch.<name>.infinitaryTask=<task id>`, which git moves with a
 * renamed branch and removes with a deleted one. A branch named
 * `fm/task-<id>` from before the mark existed is still the task's.
 */

/** The name every task branch had before the name came from the task: `fm/task-<id>`. */
export const TASK_BRANCH_PREFIX = "fm/task-";

/** The per-branch git setting that names the task a branch belongs to. */
const MARK = "infinitaryTask";

/**
 * The branch a working copy is made on when no name reaches it: a computer
 * that runs work built before names were sent, and a task started before.
 */
export function defaultTaskBranch(taskId: string): string {
  return `${TASK_BRANCH_PREFIX}${taskId}`;
}

/** Where a task's branch starts when the first mate wrote no name: the built-in naming runbook's words. */
export const TITLE_BRANCH_PREFIX = "inf/";

/** A title slug's longest length, in characters, cut at a hyphen (the captain's plan). */
const SLUG_MAX = 48;

/** How many characters of the task's id its branch's code starts with. */
const CODE_START = 4;

/**
 * A title's words as a branch slug: Latin letters (accents dropped) and
 * digits, lowercased, joined by hyphens, cut at a hyphen to `SLUG_MAX`
 * characters. An apostrophe joins its word ("runbook's" is "runbooks").
 * Empty when the text has neither.
 */
export function branchSlug(text: string): string {
  const words =
    text
      .normalize("NFKD")
      .replace(/\p{M}+|['’]/gu, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let slug = "";
  for (const word of words) {
    const longer = slug ? `${slug}-${word}` : word;
    if (longer.length > SLUG_MAX) return slug || word.slice(0, SLUG_MAX);
    slug = longer;
  }
  return slug;
}

/**
 * Why git would refuse `name` as a branch, in words, or undefined when it
 * takes it: the rules of `git check-ref-format --branch`.
 */
function gitRefusal(name: string): string | undefined {
  if (!name) return "is empty";
  if (name === "HEAD") return "is HEAD";
  if (name.startsWith("-")) return "starts with a hyphen";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git refuses control characters.
  if (/[\x00-\x20\x7f]/.test(name)) return "has a space or a control character";
  if (/[~^:?*[\\]/.test(name)) return "has one of ~ ^ : ? * [ \\";
  if (name.includes("..")) return "has two dots in a row";
  if (name.includes("@{")) return "has @{";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//"))
    return "starts or ends with a slash, or has two in a row";
  if (name.endsWith(".")) return "ends with a dot";
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")))
    return "has a part that starts with a dot or ends with .lock";
  return undefined;
}

/**
 * Why a branch name the first mate wrote is refused, in words, or
 * undefined when it is taken as written: a name git refuses, or one under
 * the app's own batch branches. The app never rewrites a name to fit.
 */
export function branchNameRefusal(name: string): string | undefined {
  const refused = gitRefusal(name);
  if (refused) return `The branch name "${name}" ${refused}; git takes no such branch name.`;
  if (name.startsWith(BATCH_BRANCH_PREFIX))
    return `The branch name "${name}" starts with ${BATCH_BRANCH_PREFIX}, which the app keeps for its batches.`;
  return undefined;
}

/** The name a task's branch starts with: the first mate's, or `inf/` and its title's slug, else its key's. */
export function taskBranchStem(task: {
  id: string;
  key: string;
  title: string;
  written?: string;
}): string {
  const written = task.written?.trim();
  if (written) return written;
  return `${TITLE_BRANCH_PREFIX}${branchSlug(task.title) || branchSlug(task.key) || task.id}`;
}

/** What a new task's branch is named from: its stem, and the names other tasks of its project saved. */
export type TaskBranchStem = {
  stem: string;
  savedByAnother: (branch: string) => boolean;
};

/**
 * A new task's branch (docs/architecture.md, "A task's branch"): `stem`
 * and a hyphen, then the first characters of the task's id, one more for
 * as long as that name is taken - among the project's branches and
 * remote-tracking branches in `repoDir`, or as another task's saved branch
 * (`savedByAnother`). A branch the repository already marks as this
 * task's, left by a start that did not finish, is the name chosen then.
 * Throws in words when a branch blocks every such name, or all are taken.
 */
export async function nameTaskBranch(
  input: { taskId: string; repoDir: string | undefined } & TaskBranchStem,
): Promise<string> {
  const { taskId, stem, repoDir } = input;
  const mine = repoDir ? await markedTaskBranch(repoDir, taskId) : undefined;
  if (mine) return mine;
  const refs = repoDir
    ? await git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
        .then((out) => out.split("\n"))
        .catch(() => [])
    : [];
  const names = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
    // A remote-tracking branch's name follows its remote's: refs/remotes/<remote>/<name>.
    const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
    if (remote?.[1]) names.add(remote[1]);
  }
  for (let length = CODE_START; length <= Math.max(CODE_START, taskId.length); length++) {
    const name = `${stem}-${taskId.slice(0, length)}`;
    // Git keeps no branch beside branches under a folder of its name.
    const blocker = [...names].find((other) => name.startsWith(`${other}/`));
    if (blocker)
      throw new Error(
        `The branch ${blocker} blocks ${name}, because git cannot keep a branch and branches under it of one name. Rename ${blocker}, or give this task another branch name.`,
      );
    const taken =
      names.has(name) ||
      [...names].some((other) => other.startsWith(`${name}/`)) ||
      input.savedByAnother(name);
    if (!taken) return name;
  }
  throw new Error(
    `Every branch name from ${stem} for this task is taken in this project. Give this task another branch name.`,
  );
}

/**
 * The branch `repoDir` already marks as the task's: the name a start that
 * did not finish, or whose answer was lost, chose then. Undefined when none.
 */
export async function markedTaskBranch(
  repoDir: string,
  taskId: string,
): Promise<string | undefined> {
  return (await taskBranches(repoDir)).find((entry) => entry.taskId === taskId)?.branch;
}

/** Marks `branch` as the task's, so cleanup tells it apart from the person's own branches. */
export async function markTaskBranch(
  repoDir: string,
  branch: string,
  taskId: string,
): Promise<void> {
  await git(repoDir, ["config", `branch.${branch}.${MARK}`, taskId]);
}

/**
 * Every task branch the repository holds, with the task it belongs to:
 * each marked branch, and each `fm/task-<id>` branch by its name. A mark
 * whose branch is gone is not one. Empty when the folder is no repository.
 */
export async function taskBranches(repoDir: string): Promise<{ branch: string; taskId: string }[]> {
  let heads: string;
  try {
    heads = await git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  } catch {
    return [];
  }
  const found = new Map<string, string>();
  const existing = new Set<string>();
  for (const ref of heads.split("\n")) {
    const branch = ref.trim().slice("refs/heads/".length);
    if (!branch) continue;
    existing.add(branch);
    if (branch.startsWith(TASK_BRANCH_PREFIX))
      found.set(branch, branch.slice(TASK_BRANCH_PREFIX.length));
  }
  for (const [branch, taskId] of await marks(repoDir))
    if (existing.has(branch)) found.set(branch, taskId);
  return [...found].map(([branch, taskId]) => ({ branch, taskId }));
}

/** The task a branch belongs to, by its mark or its `fm/task-<id>` name; null for any other. */
export async function taskOfBranch(repoDir: string, branch: string): Promise<string | null> {
  const marked = await git(repoDir, ["config", "--get", `branch.${branch}.${MARK}`]).catch(
    () => "",
  );
  if (marked) return marked;
  return branch.startsWith(TASK_BRANCH_PREFIX) ? branch.slice(TASK_BRANCH_PREFIX.length) : null;
}

/** The branch the repository holds for a task: its marked branch, or `fm/task-<id>`. */
export async function branchOfTask(repoDir: string, taskId: string): Promise<string> {
  const found = (await taskBranches(repoDir)).find((entry) => entry.taskId === taskId);
  return found?.branch ?? defaultTaskBranch(taskId);
}

async function marks(repoDir: string): Promise<Map<string, string>> {
  const out = await git(
    repoDir,
    ["config", "--null", "--get-regexp", `^branch\\..*\\.${MARK.toLowerCase()}$`],
    { trim: false },
  ).catch(() => "");
  const found = new Map<string, string>();
  const suffix = `.${MARK.toLowerCase()}`;
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    if (!key.startsWith("branch.") || !key.endsWith(suffix) || !value) continue;
    found.set(key.slice("branch.".length, -suffix.length), value);
  }
  return found;
}
