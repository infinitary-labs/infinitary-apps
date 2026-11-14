import { git } from "./git";

/**
 * Which branches are the app's own task branches (docs/architecture.md, "A
 * task's branch"). A task's branch is whatever name its record holds; the
 * repository says which task a branch belongs to with a per-branch git
 * setting, `branch.<name>.infinitaryTask=<task id>`, which git moves with a
 * renamed branch and removes with a deleted one. A branch named
 * `fm/task-<id>` from before the mark existed is still the task's.
 */

/** The name every task branch had before the name came from the task: `fm/task-<id>`. */
export const TASK_BRANCH_PREFIX = "fm/task-";

/** The per-branch git setting that names the task a branch belongs to. */
const MARK = "infinitaryTask";

/** The branch a task gets when its record names none. */
export function defaultTaskBranch(taskId: string): string {
  return `${TASK_BRANCH_PREFIX}${taskId}`;
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

/** Every mark in the repository's settings, by branch. */
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
