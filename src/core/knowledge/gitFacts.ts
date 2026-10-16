import { git } from "../workspace/git";
import type { GitFacts } from "./sources";

/**
 * A cited file's commit and whether it differs from it, read with the app's
 * own git in the working copy. A working copy git cannot read has no commit
 * and counts as changed, so its evidence reads as branch-local, never clean.
 */
export const workingCopyFacts: GitFacts = async (root, path) => {
  let commit: string | null = null;
  try {
    commit = (await git(root, ["rev-parse", "--verify", "HEAD"])) || null;
  } catch {
    commit = null;
  }
  let dirty = true;
  try {
    dirty = (await git(root, ["status", "--porcelain", "--", path])).length > 0;
  } catch {
    dirty = true;
  }
  return { commit, dirty };
};
