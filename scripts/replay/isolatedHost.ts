/** Shared model-free host wiring for replay and developer evaluations. */
import { join } from "node:path";
import { CrewSupervisor } from "../../src/core/orchestrator/crewSupervisor.ts";
import type { CrewSupervisorOptions } from "../../src/core/orchestrator/crewSupervisorOptions.ts";
import {
  FirstmateAgent,
  type FirstmateAgentOptions,
} from "../../src/core/orchestrator/firstmateAgent.ts";
import type { AppPaths } from "../../src/core/paths.ts";
import { Runbooks } from "../../src/core/runbooks/runbooks.ts";
import type { WorkspaceService } from "../../src/core/workspace/workspaceService.ts";
import { REPO_ROOT } from "../moduleRunner.ts";

/** The app bundle's runbooks folder, the root services.ts reads from the self-source location. */
const BUNDLED_RUNBOOKS = join(REPO_ROOT, "resources", "runbooks");

export function isolatedWorkspace(paths: AppPaths, allowReplayMerge = false): WorkspaceService {
  return {
    createTaskWorktree: async (taskId: string) => ({
      taskId,
      cwd: allowReplayMerge ? join(paths.worktreesDir, taskId) : paths.defaultWorkspaceDir,
      branch: `fm/task-${taskId}`,
      repoDir: paths.defaultWorkspaceDir,
    }),
    removeTaskWorktree: async () => {},
    retireTaskWorktree: async () => ({ outcome: "removed" as const, kept: null }),
    listWorktreeDirs: () => [] as string[],
    workspaceAt: async () => null,
    removeEmptyWorktreeDir: async () => false,
    landTaskWork: async () => {
      if (!allowReplayMerge) throw new Error("Merge is disconnected in evaluations");
      return { mode: "fast-forward" as const };
    },
    taskWorkStatus: async () => ({ dirty: false, unlandedCommits: 0 }),
    ensureDefaultRepo: async () => paths.defaultWorkspaceDir,
    installDependencies: async () => ({ outcome: "skipped" as const }),
    listTaskBranches: async () => [] as { branch: string; taskId: string }[],
  } as unknown as WorkspaceService;
}

export function wireIsolatedHost(
  crew: CrewSupervisorOptions,
  seat: Omit<FirstmateAgentOptions, "supervisor">,
): { supervisor: CrewSupervisor; firstmate: FirstmateAgent } {
  // The guidance the app serves: the bundled runbooks under this host's own switches,
  // never the built-in copy a first mate or crew without runbooks falls back to.
  const runbooks = new Runbooks(BUNDLED_RUNBOOKS, seat.settings);
  const supervisor = new CrewSupervisor({ ...crew, runbooks });
  // The answer-delivery check only observes here: a replayed or evaluated turn
  // is never given a retry or a notice it did not record.
  return {
    supervisor,
    firstmate: new FirstmateAgent({ ...seat, runbooks, answerDelivery: "observe", supervisor }),
  };
}
