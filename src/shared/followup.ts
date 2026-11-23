import { z } from "zod";

/**
 * A crewmate's follow-up as its home receives it (`inf:work:followup`,
 * `docs/task-graph.md`): the row it files, the hold on the crewmate's own
 * task, the test it reports, and the project and repository a defect in
 * another project's files belongs to. It lives here, beside the order that
 * takes it, so `work.ts` stays under its size ceiling.
 */
export const followupInputSchema = z.object({
  title: z.string(),
  goal: z.string(),
  why: z.string(),
  blocksMe: z.boolean().optional(),
  testFailure: z.boolean().optional(),
  testPath: z.string().optional(),
  project: z.string().optional(),
  repository: z.string().optional(),
});
