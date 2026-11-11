import { z } from "zod";

/** Task identifiers accepted by a computer that runs work. */
export const placedTaskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A commit as git names it in full. */
export const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** An exact commit of another task on this computer, never that task's uncommitted files. */
export const workingCopyBaseSchema = z.object({
  task: placedTaskIdSchema,
  headSha: commitSchema,
  /** The last base assigned to this copy; refuse to replace any other commits. */
  previousHead: commitSchema.optional(),
});
export type WorkingCopyBase = z.infer<typeof workingCopyBaseSchema>;
