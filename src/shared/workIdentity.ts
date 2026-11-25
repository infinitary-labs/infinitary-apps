import { z } from "zod";

/** Task identifiers accepted by a computer that runs work. */
export const placedTaskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** The computer's own id for one callback, the same each time it asks again. */
export const workCallIdSchema = z.string().min(1).max(128);

/** A work request's arguments: the task it asks for, its call's id and its own fields. */
export function asked<T extends z.ZodRawShape>(shape: T) {
  return z.tuple([z.object({ task: placedTaskIdSchema, callId: workCallIdSchema, ...shape })]);
}
export const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** An exact commit of another task on this computer, never that task's uncommitted files. */
export const workingCopyBaseSchema = z.object({
  task: placedTaskIdSchema,
  headSha: commitSchema,
  /** The last base assigned to this copy; refuse to replace any other commits. */
  previousHead: commitSchema.optional(),
});
export type WorkingCopyBase = z.infer<typeof workingCopyBaseSchema>;
