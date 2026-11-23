import type { RepoMoveResult, RepoMoveTarget } from "@shared/repos";
import type { CoreServices } from "../coreServices";
import type { ProjectRecord } from "../storage/projectStore";
import {
  moveFingerprint,
  moveImpact,
  type RepositoryMove,
  STALE_MOVE_CARD,
} from "../workspace/repositoryMove";

type MoveServices = Pick<CoreServices, "repos" | "tasks" | "scheduler">;

function impactOf(services: Pick<MoveServices, "tasks" | "scheduler">, move: RepositoryMove) {
  return moveImpact(move, {
    tasksJoining: (joining) => services.tasks.tasksJoining(joining),
    automationsAbout: (projectId) =>
      services.scheduler.rules().filter((rule) => rule.projectId === projectId).length,
  });
}

/**
 * `inf:repos:move` (INF-5005, docs/fleet.md "Moving a repository to another
 * project"): repositories join another project in one write. Each keeps its
 * id, name, folder, settings and cost limit; its tasks join with their keys
 * kept; a project it empties is archived with its key reserved, and every
 * automation about that project becomes about the one it joined. It runs
 * on the captain's click or words only, so the timeline names the captain.
 * The catalog's `project-move` line writes its feed line and operation.
 * `expected`, a move card's `moveFingerprint`, is compared with the move and
 * what it takes along in the same synchronous run as the write.
 */
export function moveRepositories(
  services: MoveServices,
  repoIds: readonly string[],
  target: RepoMoveTarget,
  expected?: string,
): RepoMoveResult {
  const move = services.repos.planMove(repoIds, target);
  if (expected !== undefined && moveFingerprint(move, impactOf(services, move)) !== expected)
    throw new Error(STALE_MOVE_CARD);
  let joined: ProjectRecord | undefined;
  const tasks = services.tasks.joinWithRepositories(
    {
      sources: move.sources.map((source) => ({ projectId: source.id, whole: source.empties })),
      repos: move.repos,
    },
    "captain",
    () => {
      const project = services.repos.applyMove(move);
      for (const source of move.sources)
        if (source.empties) services.scheduler.moveProject(source.id, project.id);
      joined = project;
      return project;
    },
  );
  if (!joined) throw new Error("The move did not finish.");
  return {
    project: { id: joined.id, key: joined.key, name: joined.name },
    repos: move.repos.map(({ id, name }) => ({ id, name })),
    tasks,
  };
}
