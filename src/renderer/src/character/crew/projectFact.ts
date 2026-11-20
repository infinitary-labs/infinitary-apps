import * as m from "@shared/i18n/messages.generated";
import type { ProjectView } from "@shared/tasks";

/**
 * A task's Project fact (INF-4220): its project's name, and the repository
 * it works in beside it when the project holds more than one. Before the
 * board answers, the repository's name, as the fact read before.
 */
export function projectFact(
  project: Pick<ProjectView, "name" | "repos"> | undefined,
  repository: string | undefined,
): string {
  if (!project) return repository ?? "";
  if (repository && (project.repos?.length ?? 0) > 1)
    return m.cardRecordProjectRepository({ project: project.name, repository });
  return project.name;
}
