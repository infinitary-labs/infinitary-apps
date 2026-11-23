import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { removeAll } from "../removeWhole";
import { clearManagedOriginPush, git, releaseTaskRemote, taskRemoteName } from "../workspace/git";

/**
 * What a reset undoes in a project that lives outside the data folder
 * (docs/reset.md, "Your projects"): only the settings Infinitary wrote into
 * it - its task remotes, the push address it set on origin, its config keys,
 * the links to working copies inside the folder and its kept references.
 * Every branch, commit and file of the person's stays.
 */
export async function undoProjectSettings(repo: string, dataDir: string): Promise<void> {
  await clearManagedOriginPush(repo);
  const remotes = (await git(repo, ["remote"])).split("\n").filter(Boolean);
  const ownRemote = taskRemoteName("");
  for (const remote of remotes)
    if (remote.startsWith(ownRemote)) await releaseTaskRemote(repo, remote.slice(ownRemote.length));
  const taskKeys = await git(repo, [
    "config",
    "--local",
    "--name-only",
    "--get-regexp",
    "^branch\\..*\\.infinitarytask$",
  ]).catch(() => "");
  for (const key of taskKeys.split("\n").filter(Boolean))
    await git(repo, ["config", "--local", "--unset-all", key]).catch(() => "");
  const refs = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/infinitary/"]);
  for (const ref of refs.split("\n").filter(Boolean)) await git(repo, ["update-ref", "-d", ref]);
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
      const from = relative(inside, real(resolve(link, gitdir)));
      return from !== "" && !from.startsWith("..") && !isAbsolute(from);
    });
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
