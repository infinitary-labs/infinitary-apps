import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { removeAll } from "../removeWhole";
import { clearManagedOriginPush, git } from "../workspace/git";

/**
 * What a reset undoes in a project that lives outside the data folder
 * (docs/reset.md, "Your projects"): the push address it set on origin and
 * the links to working copies inside the folder. Discarding each open task
 * already released its own remote and branch; every branch, commit and file
 * of the person's stays, and so does each task's saved work under
 * `refs/infinitary/`, which another run of the app on the same project may
 * also hold.
 */
export async function undoProjectSettings(repo: string, dataDir: string): Promise<void> {
  await clearManagedOriginPush(repo);
  const common = resolve(
    repo,
    await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  for (const link of worktreeLinksInside(common, dataDir)) removeAll(link);
}

/**
 * The repository's links to working copies that live inside the data folder:
 * git keeps one folder per working copy under its common directory, whose
 * `gitdir` file names where the copy is. Removing the link is what `git
 * worktree prune` would do once the folder is gone; the folder is still there
 * now, and every other working copy keeps its link.
 */
function worktreeLinksInside(commonDir: string, dataDir: string): string[] {
  const linksDir = join(commonDir, "worktrees");
  let names: string[];
  try {
    names = readdirSync(linksDir);
  } catch {
    return [];
  }
  const inside = real(dataDir);
  return names
    .map((name) => join(linksDir, name))
    .filter((link) => {
      let gitdir: string;
      try {
        gitdir = readFileSync(join(link, "gitdir"), "utf8").trim();
      } catch {
        return false;
      }
      const copy = real(resolve(link, gitdir));
      return copy !== inside && within(inside, copy);
    });
}

/** True when `path` is `folder` or lies inside it. */
export function within(folder: string, path: string): boolean {
  const from = relative(folder, path);
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
}

/** The path with its links resolved, or as given when it does not exist. */
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
