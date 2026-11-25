import type { ProjectTagView } from "@shared/tags";
import type { ProjectView } from "@shared/tasks";
import { useEffect, useState } from "react";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * A project's tags as the project list carries them (docs/task-tags.md),
 * read again whenever they change, here or by the first mate. Empty while
 * unread, for no project, and for a core too old to carry tags.
 */
export function useProjectTags(projectId: string | null | undefined): readonly ProjectTagView[] {
  const [projects, setProjects] = useState<readonly ProjectView[]>([]);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "projects.list",
        {},
        {
          onValue: (value) => setProjects(value as ProjectView[]),
          onError: () => {},
        },
      ),
    [],
  );
  if (!projectId) return [];
  return projects.find((project) => project.id === projectId)?.tags ?? [];
}
