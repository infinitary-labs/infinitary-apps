import type { ActionLine } from "./actions";
import { type ProjectTagChangeResult, projectTagChangeSchema } from "./tags";
import type { ProjectView } from "./tasks";

/**
 * The catalog line for a project's tags (docs/task-tags.md): the same
 * request Settings' Tags group sends, on the captain's ask. The first mate
 * reads each project's tags in its current value and sets a task's tags
 * with create_task and update_task.
 */
export const tagLines = {
  "project-tags": {
    area: "projects",
    tier: "asked",
    change: "inf:projects:tags",
    current: "inf:projects:list",
    value: projectTagChangeSchema,
    line: "Add, edit or remove a project's tags when asked. add: projectId, name (unique in it, any case), description (which tasks qualify); edit: tagId, new name or description, kept on its tasks; remove: tagId, off every task.",
    toRequest: (v) => [v],
    readValue: (c) => ({
      projects: (c as ProjectView[])
        .filter((project) => !project.archived)
        .map(({ id, key, name, tags }) => ({
          id,
          key,
          name,
          tags: (tags ?? []).map((tag) => ({
            id: tag.id,
            name: tag.name,
            description: tag.description,
            tasks: tag.tasks,
          })),
        })),
    }),
    trailOf: (_args, result) => (result as ProjectTagChangeResult).done,
    done: (v) => {
      const name = v.name as string;
      // i18n-exempt: an operation's saved title, written in English like every catalog line's done
      if (v.op === "add") return `Added the tag ${name}`;
      // i18n-exempt: an operation's saved title, written in English like every catalog line's done
      if (v.op === "remove") return `Removed the tag ${name} from ${String(v.tasks ?? 0)} tasks`;
      if (v.was) return `Renamed the tag ${v.was as string} to ${name}`; // i18n-exempt: an operation's saved title
      // i18n-exempt: an operation's saved title, written in English like every catalog line's done
      return `Changed which tasks qualify for the tag ${name}`;
    },
  },
} as const satisfies Record<string, ActionLine>;
