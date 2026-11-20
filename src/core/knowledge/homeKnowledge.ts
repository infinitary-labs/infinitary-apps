import type { FmEvent } from "@shared/events";
import type { AppPaths } from "../paths";
import type { CardResolution } from "../storage/cardStore";
import type { AppDatabase } from "../storage/db";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { KnowledgeService } from "./knowledgeService";

/**
 * Home wiring for the captain's knowledge (docs/knowledge.md, "Where it is
 * kept"): the one service over the collection, reading projects, task
 * reports and the captain's closing choices, then the active directions
 * carried before any agent starts ("Carrying the active directions").
 */
export function startHomeKnowledge({
  db,
  paths,
  repos,
  tasks,
  closingResolutionOf,
  broadcastEvent,
  now,
}: {
  db: AppDatabase;
  paths: AppPaths;
  repos: RepoRegistry;
  tasks: TaskService;
  /** The newest card the captain resolved on a task; the crew is built later. */
  closingResolutionOf: (taskId: string) => CardResolution | undefined;
  broadcastEvent: (event: FmEvent) => void;
  now: () => number;
}): KnowledgeService {
  const knowledge = new KnowledgeService({
    dir: paths.knowledgeDir,
    projects: {
      get: (id) => repos.get(id),
      list: () => repos.list(),
      together: (id) => {
        const project = tasks.projects.forRepo(id);
        return project ? tasks.projects.repositoriesOf(project.id).map((repo) => repo.id) : [id];
      },
    },
    tasks: {
      resolve: (ref) => {
        const record = tasks.resolve(ref);
        return record ? { id: record.id, key: record.key, repoId: record.repoId } : undefined;
      },
      reports: (taskId) =>
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === "report")
          .map((event) => ({ id: event.id, text: event.text })),
    },
    approvals: {
      of: (ref) => {
        const record = tasks.resolve(ref);
        const resolution = record && closingResolutionOf(record.id);
        return record && resolution
          ? {
              key: record.key,
              title: resolution.card.title,
              body: resolution.card.body,
              action: resolution.action,
              resolvedAt: resolution.resolvedAt,
            }
          : undefined;
      },
    },
    announce: (text) => broadcastEvent({ type: "firstmate_note", text }),
    now,
    // The browser reads again after a write commits and after the purge.
    changed: () => broadcastEvent({ type: "knowledge_changed" }),
  });
  // Startup stops if any active direction cannot be carried; no old runtime fallback.
  knowledge.directions.carry(db);
  return knowledge;
}
