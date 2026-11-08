import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CrewCore } from "./crewCore";

/**
 * Leftover task branches (INF-3060 finding 6; docs/task-record.md, fleet
 * hygiene): an `fm/task-*` branch no live task explains. Boot once wrote
 * them as a feed line at every start, with nothing to click. Now boot
 * retires them the way a closed task's branch goes: whatever each holds
 * that never landed is saved on its task's hidden kept ref, then the branch
 * is deleted (captain: "we should not bother users with things that the
 * crew can take care of and doesn't really need user judgment"). Nothing is
 * said about a branch that went; answers each one that stays, with why.
 */
export async function retireLeftoverBranches(core: CrewCore): Promise<string[]> {
  const repoDirs = new Map<string, string>();
  if (existsSync(join(core.options.paths.defaultWorkspaceDir, ".git")))
    repoDirs.set(core.options.paths.defaultWorkspaceDir, "default workspace");
  for (const repo of core.options.repos.list()) repoDirs.set(repo.path, repo.name);
  const kept: string[] = [];
  for (const [repoDir, repoName] of repoDirs) {
    for (const { branch, taskId } of await core.options.workspace.listTaskBranches(repoDir)) {
      const record = core.options.tasks.get(taskId);
      if (record && (record.status === "active" || record.workspaceState === "present")) continue;
      const outcome = await core.options.workspace.retireTaskBranch(repoDir, branch, taskId);
      if (outcome.outcome === "kept") kept.push(`${branch} in ${repoName} (${outcome.reason})`);
    }
  }
  return kept;
}
