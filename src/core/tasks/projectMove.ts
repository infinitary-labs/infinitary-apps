import type { ProjectRecord, ProjectStore } from "../storage/projectStore";
import { TaskGraphRefusal } from "./taskGraph";
import { keyOrId } from "./taskWriter";

/**
 * The repository a task moved into another project works in (INF-4220): the
 * one the move names, else its own when the project holds it, else the
 * project's only one. A project with none (Scratch) gives none, and the task
 * keeps its own. A project of several that the move cannot place the task
 * in is refused, naming its repositories, so nothing is guessed.
 */
export function moveTargetRepository(
  project: Pick<ProjectRecord, "id" | "name">,
  projects: Pick<ProjectStore, "repositoriesOf">,
  task: { id: string; key: string; repoId: string | null },
  named?: string,
): string | null {
  const repositories = projects.repositoriesOf(project.id);
  const names = repositories.map((repository) => repository.name).join(", ");
  if (named !== undefined) {
    const wanted = named.trim().toLowerCase();
    const found = repositories.find(
      (repository) => repository.id === named.trim() || repository.name.toLowerCase() === wanted,
    );
    if (found) return found.id;
    throw new TaskGraphRefusal(
      repositories.length
        ? `Refused: ${project.name} holds no repository "${named}"; its repositories are ${names}.`
        : `Refused: ${project.name} holds no repository, so ${keyOrId(task)} keeps its own.`,
    );
  }
  if (repositories.length === 0) return null;
  if (task.repoId && repositories.some((repository) => repository.id === task.repoId))
    return task.repoId;
  if (repositories.length === 1) return repositories[0]?.id ?? null;
  throw new TaskGraphRefusal(
    `Refused: ${project.name} holds several repositories (${names}), so ${keyOrId(task)} cannot move there without one: name its repository.`,
  );
}
