import type { CoreServices } from "../coreServices";

/**
 * `inf:projects:rename` (INF-4220): name a project of several repositories,
 * and have the board read its projects again, so the project pill and a
 * task record's Project fact take the new name. The catalog's `project-name`
 * line writes its feed line and operation.
 */
export function renameProject(
  services: Pick<CoreServices, "repos" | "tasks">,
  projectId: string,
  name: string,
): { id: string; name: string; was: string } {
  const renamed = services.repos.renameProject(projectId, name);
  services.tasks.invalidatePresentation();
  return renamed;
}
