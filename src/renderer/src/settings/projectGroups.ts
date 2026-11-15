import type { RepoView } from "@shared/repos";
import type { ProjectView } from "@shared/tasks";

/** A project as Settings → Projects names it: its id, task key and name. */
export type GroupProject = Pick<ProjectView, "id" | "key" | "name">;

/**
 * One entry of Settings → Projects (INF-4220): a project of one repository
 * is that repository's row, as before; a project of several is one group
 * holding a row for each.
 */
export type ProjectEntry =
  | { kind: "one"; repo: RepoView; project: GroupProject | null }
  | { kind: "several"; project: GroupProject; repos: RepoView[] };

/** The repository names a project holds, from the board's project list. */
function namesOf(project: ProjectView): string[] {
  if (project.repos) return project.repos.map((repo) => repo.name);
  return project.repo ? [project.repo.name] : [];
}

/**
 * Settings → Projects' entries, in the repositories' own order: each
 * project of several sits where its first repository sits. A repository
 * whose project the list does not know yet keeps a row of its own.
 */
export function projectEntries(
  repos: readonly RepoView[],
  projects: readonly ProjectView[],
): ProjectEntry[] {
  const owner = new Map<string, ProjectView>();
  for (const project of projects) {
    if (project.archived) continue;
    for (const name of namesOf(project)) owner.set(name, project);
  }
  const entries: ProjectEntry[] = [];
  const groups = new Map<string, Extract<ProjectEntry, { kind: "several" }>>();
  for (const repo of repos) {
    const project = owner.get(repo.name);
    const held = project
      ? namesOf(project).filter((name) => repos.some((r) => r.name === name))
      : [];
    if (!project || held.length < 2) {
      entries.push({
        kind: "one",
        repo,
        project: project ? { id: project.id, key: project.key, name: project.name } : null,
      });
      continue;
    }
    const group = groups.get(project.id);
    if (group) {
      group.repos.push(repo);
      continue;
    }
    const entry = {
      kind: "several" as const,
      project: { id: project.id, key: project.key, name: project.name },
      repos: [repo],
    };
    groups.set(project.id, entry);
    entries.push(entry);
  }
  return entries;
}
