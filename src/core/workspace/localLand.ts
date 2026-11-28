import { existsSync, realpathSync } from "node:fs";
import { git } from "./git";

/**
 * Lands `head` on the branch `into` of `repoDir` while the folder has
 * another branch checked out (INF-7250's finding 4), never touching the
 * folder's files: a fast-forward or a merge commit written with
 * `merge-tree` and `commit-tree`, and the branch moves only from `target`,
 * the commit read (`update-ref` with its old value), never forced. `check`
 * runs before each write, as the in-folder merge runs it. A conflict throws
 * the same words the in-folder merge does and moves nothing.
 */
export async function landBesideFolder(input: {
  repoDir: string;
  branch: string;
  into: string;
  target: string;
  head: string;
  message: string;
  check: () => void;
}): Promise<"fast-forward" | "merge"> {
  const { repoDir, branch, into, target, head } = input;
  // Moving a branch another working copy has checked out would leave that
  // copy's files behind its branch.
  const holder = await checkedOutAt(repoDir, into);
  if (holder)
    throw new Error(
      `${into} is checked out in another working copy (${holder}); switch that copy to another branch first.`,
    );
  const ref = `refs/heads/${into}`;
  // i18n-exempt: the reflog's line, read only through git.
  const reason = `infinitary: merge ${branch}`;
  input.check();
  if (await isAncestor(repoDir, target, head)) {
    await git(repoDir, ["update-ref", "-m", reason, ref, head, target]);
    return "fast-forward";
  }
  input.check();
  let tree: string;
  try {
    tree = await git(repoDir, ["merge-tree", "--write-tree", "--name-only", target, head]);
  } catch (caught) {
    const failure = caught as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1) throw caught;
    // On a conflict merge-tree prints the tree, then each conflicted path.
    const paths = [
      ...new Set(
        String(failure.stdout ?? "")
          .split("\n")
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
    throw new Error(
      `Merging ${branch} into ${into} hit a conflict; resolve it manually.${paths.length ? ` CONFLICT in ${paths.join(", ")}` : ""}`,
    );
  }
  const commit = await git(repoDir, [
    "commit-tree",
    tree.split("\n")[0] ?? "",
    "-p",
    target,
    "-p",
    head,
    "-m",
    input.message,
  ]);
  await git(repoDir, ["update-ref", "-m", reason, ref, commit, target]);
  return "merge";
}

/**
 * The folder of another working copy of `repo` that has `branch` checked
 * out, or undefined when none does. `repo`'s own folder never counts.
 */
async function checkedOutAt(repo: string, branch: string): Promise<string | undefined> {
  const list = await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
  const own = realpathSync(repo);
  const held = `refs/heads/${branch}`;
  for (const entry of list.split("\n\n")) {
    const lines = entry.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || !lines.some((line) => line.startsWith("branch ") && line.slice(7) === held))
      continue;
    if (existsSync(path) && realpathSync(path) === own) continue;
    return path;
  }
  return undefined;
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).then(
    () => true,
    () => false,
  );
}
