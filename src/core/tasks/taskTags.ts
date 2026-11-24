import { said, saidLine } from "@shared/i18n/said";
import {
  type ProjectTagChange,
  type ProjectTagChangeResult,
  sameTagName,
  type TagSetter,
} from "@shared/tags";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskWriter } from "./taskWriter";

/**
 * Tags on tasks and a project's own tags (docs/task-tags.md), written for
 * `TaskService`, the one writer of `task_tags`: each change to a task's
 * tags writes one quiet line on its timeline, with no feed line.
 */

/** A tag change refused, in words Settings and the first mate both show. */
export class TaskTagRefusal extends Error {}

const ACTOR: Record<TagSetter, TaskEventActor> = {
  captain: "captain",
  firstmate: "firstmate",
  decision: "host",
};

/** One timeline line for tags a setter added or took off a task. */
function tagLine(by: TagSetter, added: boolean, names: readonly string[]) {
  const tags = names.join(", ");
  if (by === "captain")
    return saidLine(said(added ? "taskTagsAddedByYou" : "taskTagsRemovedByYou", { tags }));
  if (by === "firstmate")
    return saidLine(
      said(added ? "taskTagsAddedByFirstMate" : "taskTagsRemovedByFirstMate", { tags }),
    );
  return saidLine(said(added ? "taskTagsAddedByDecision" : "taskTagsRemovedByDecision", { tags }));
}

export type TagsSet = { added: string[]; removed: string[] };

/**
 * Turn tags on or off on one task. Each tag must be its project's own. The
 * decision model never changes a tag a person or the first mate set or
 * removed; theirs is kept for good, off rows included, so a tag removed by
 * hand stays removed. A tag already in the asked state is left as it is.
 */
export function setTaskTags(
  writer: TaskWriter,
  taskId: string,
  wanted: readonly { tagId: string; on: boolean }[],
  by: TagSetter,
): TagsSet {
  return writer.write((): TagsSet => {
    const record = writer.mustGet(taskId);
    const rows = writer.store.tags.rowsOf(taskId);
    const at = writer.now();
    const added: string[] = [];
    const removed: string[] = [];
    for (const { tagId, on } of wanted) {
      const tag = writer.projects.tags.get(tagId);
      if (!tag || tag.projectId !== record.projectId)
        // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
        throw new TaskTagRefusal(`${record.key} has no tag ${tagId} in its project.`);
      const row = rows.get(tagId);
      if (by === "decision" && row && row.by !== "decision") continue;
      if ((row?.on ?? false) === on) continue;
      writer.store.tags.set({
        taskId,
        tagId,
        on,
        by,
        revision: by === "decision" ? tag.revision : null,
        at,
      });
      (on ? added : removed).push(tag.name);
    }
    if (added.length + removed.length === 0) return { added, removed };
    writer.patch(taskId, { updatedAt: at });
    for (const [names, on] of [
      [added, true],
      [removed, false],
    ] as const) {
      if (names.length === 0) continue;
      const line = tagLine(by, on, names);
      writer.addEvent({
        taskId,
        at,
        actor: ACTOR[by],
        kind: "note",
        text: line.text,
        data: { said: line.said, tags: { [on ? "added" : "removed"]: names, by }, news: false },
        feed: false,
      });
    }
    return { added, removed };
  })();
}

/**
 * The tag ids a task's project knows by these names, ignoring case, or a
 * refusal naming the project's tags: the first mate's tools name tags by name.
 */
export function tagIdsByName(
  writer: TaskWriter,
  taskId: string,
  names: readonly string[],
): string[] {
  const record = writer.mustGet(taskId);
  const tags = writer.projects.tags.of(record.projectId);
  const unknown: string[] = [];
  const ids = names.flatMap((name) => {
    const tag = tags.find((candidate) => sameTagName(candidate.name, name));
    if (!tag) unknown.push(name);
    return tag ? [tag.id] : [];
  });
  if (unknown.length > 0)
    throw new TaskTagRefusal(
      tags.length === 0
        ? // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
          `${record.key}'s project has no tags; Settings or app_change project-tags adds them.`
        : // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
          `${record.key}'s project has no tag ${unknown.join(", ")}. Its tags: ${tags.map((tag) => tag.name).join(", ")}.`,
    );
  return ids;
}

/** A task's tags become exactly these by hand, as Edit tags or update_task sets them. */
export function replaceTaskTags(
  writer: TaskWriter,
  taskId: string,
  tagIds: readonly string[],
  by: Exclude<TagSetter, "decision">,
): TagsSet {
  const wanted = new Set(tagIds);
  const current = [...writer.store.tags.rowsOf(taskId).values()]
    .filter((row) => row.on)
    .map((row) => row.tagId);
  return setTaskTags(
    writer,
    taskId,
    [
      ...[...wanted].map((tagId) => ({ tagId, on: true })),
      ...current.filter((tagId) => !wanted.has(tagId)).map((tagId) => ({ tagId, on: false })),
    ],
    by,
  );
}

/**
 * Add, edit or remove one of a project's tags, in one write. A rename keeps
 * the tag on its tasks and redraws them; a removal takes it off every task
 * first, with one quiet line on each that carried it.
 */
export function changeProjectTags(
  writer: TaskWriter,
  change: ProjectTagChange,
): Omit<ProjectTagChangeResult, "tags"> {
  return writer.write((): Omit<ProjectTagChangeResult, "tags"> => {
    const at = writer.now();
    const tags = writer.projects.tags;
    if (change.op === "add") {
      const project = writer.projects.get(change.projectId);
      // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
      if (!project) throw new TaskTagRefusal(`There is no project ${change.projectId}.`);
      if (project.archivedAt !== null)
        // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
        throw new TaskTagRefusal(`${project.name} was removed, so it takes no tags.`);
      const tag = tags.add(project.id, change.name, change.description, at);
      return { projectId: project.id, done: { op: "add", name: tag.name } };
    }
    const tag = tags.get(change.tagId);
    // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
    if (!tag) throw new TaskTagRefusal(`There is no tag ${change.tagId}.`);
    if (change.op === "edit") {
      const edited = tags.edit(tag, change, at);
      if (edited.name !== tag.name)
        for (const taskId of writer.store.tags.carrying(tag.id))
          writer.patch(taskId, { updatedAt: at });
      return {
        projectId: tag.projectId,
        done: {
          op: "edit",
          name: edited.name,
          ...(edited.name !== tag.name ? { was: tag.name } : {}),
          described: edited.revision !== tag.revision,
        },
      };
    }
    const carrying = writer.store.tags.carrying(tag.id);
    const line = saidLine(said("taskTagsTagRemoved", { tag: tag.name }));
    for (const taskId of carrying) {
      writer.patch(taskId, { updatedAt: at });
      writer.addEvent({
        taskId,
        at,
        actor: "host",
        kind: "note",
        text: line.text,
        data: { said: line.said, tags: { removed: [tag.name], by: "project" }, news: false },
        feed: false,
      });
    }
    writer.store.tags.deleteTag(tag.id);
    tags.remove(tag.id);
    return {
      projectId: tag.projectId,
      done: { op: "remove", name: tag.name, tasks: carrying.length },
    };
  })();
}
