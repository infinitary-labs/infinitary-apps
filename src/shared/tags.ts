import { z } from "zod";

/**
 * Task tags (docs/task-tags.md): each project keeps its own list of tags, a
 * name and a description of which tasks qualify, and a task carries any of
 * its project's tags, each recording who set it. Tags help a person find
 * and group work; nothing in the app acts on a tag by itself.
 */

const tagName = z.string().trim().min(1);
const tagDescription = z.string().trim().min(1);

/** A tag as a project's view carries it: alphabetical in the list, with the open and closed tasks carrying it. */
export const projectTagViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Rises each time the description changes. */
  revision: z.number(),
  /** Tasks carrying it now, at any state. */
  tasks: z.number(),
});
export type ProjectTagView = z.infer<typeof projectTagViewSchema>;

/**
 * Who set a tag on a task: the decision model, a person (`captain`), or the
 * first mate. A tag a person or the first mate set or removed is theirs for
 * good: the decision model never changes it.
 */
export const tagSetterSchema = z.enum(["decision", "captain", "firstmate"]);
export type TagSetter = z.infer<typeof tagSetterSchema>;

/** A tag a task carries, as its view lists it, alphabetical. */
export const taskTagViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  by: tagSetterSchema,
});
export type TaskTagView = z.infer<typeof taskTagViewSchema>;

/**
 * One change to a project's tags (`inf:projects:tags`), Settings' and the
 * first mate's alike: add a tag, edit its name or description (a rename
 * keeps it on its tasks), or remove it, which takes it off every task.
 */
export const projectTagChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    projectId: z.string().min(1),
    name: tagName,
    description: tagDescription,
  }),
  z.strictObject({
    op: z.literal("edit"),
    tagId: z.string().min(1),
    name: tagName.optional(),
    description: tagDescription.optional(),
  }),
  z.strictObject({ op: z.literal("remove"), tagId: z.string().min(1) }),
]);
export type ProjectTagChange = z.infer<typeof projectTagChangeSchema>;

/** What a tag change answers: the project's tags after it, and what it did, by name. */
export const projectTagChangeResultSchema = z.object({
  projectId: z.string(),
  tags: z.array(projectTagViewSchema),
  done: z.object({
    op: z.enum(["add", "edit", "remove"]),
    name: z.string(),
    /** The name before a rename. */
    was: z.string().optional(),
    /** Whether an edit changed the description. */
    described: z.boolean().optional(),
    /** Tasks a removal took it off. */
    tasks: z.number().optional(),
  }),
});
export type ProjectTagChangeResult = z.infer<typeof projectTagChangeResultSchema>;

/** Names compare ignoring case, so `Bug` and `bug` are one tag. */
export function sameTagName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Tags list alphabetically everywhere, ignoring case. */
export function byTagName<T extends { name: string }>(a: T, b: T): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
