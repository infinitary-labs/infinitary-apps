/**
 * The one patch both halves agree on: what a crewmate's worktree holds
 * against the task's base commit, as a binary git diff that `git apply`
 * replays on the task image's `/app` (which sits at that base commit).
 *
 * The bridge and the verifier runner take the same patch, so what a
 * crewmate tests in the container is exactly what the verifier grades.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./pool.ts";

/**
 * The worktree's whole working state against `base`: commits, staged and
 * unstaged edits, deletions and untracked files that are not ignored. The
 * worktree's own index is never touched; a copy of it takes the `add -A`.
 */
export function worktreePatch(worktree: string, base: string): Buffer {
  const cwd = resolve(worktree);
  const scratch = mkdtempSync(join(tmpdir(), "infinitary-bench-index-"));
  try {
    const index = join(scratch, "index");
    const own = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]).trim());
    if (existsSync(own)) copyFileSync(own, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (!existsSync(own)) git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "--all"], env);
    return gitBuffer(cwd, ["diff", "--cached", "--binary", "--no-color", base], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A committed ref's patch against `base` (a kept ref after a task closes). */
export function refPatch(repo: string, base: string, ref: string): Buffer {
  return gitBuffer(resolve(repo), ["diff", "--binary", "--no-color", base, ref]);
}

function gitBuffer(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Buffer {
  const result = spawnSync("git", args, { cwd, env: env ?? process.env, maxBuffer: 1024 ** 3 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}
