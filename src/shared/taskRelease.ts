import { z } from "zod";

/** An agent's evidenced attribution, never inferred from merge time or version ordering. */
export const firstReleaseSchema = z
  .object({
    version: z.string().trim().min(1),
    url: z.string().url(),
    evidence: z.string().trim().min(1),
  })
  .strict();
export type FirstRelease = z.infer<typeof firstReleaseSchema>;

/** All named tasks have this verified earliest release; the caller supplies source membership proof. */
export const firstReleaseReportSchema = firstReleaseSchema.extend({
  tasks: z.array(z.string().trim().min(1)).min(1),
  /** Compare-and-replace a previous attribution, after verifying a correction. */
  corrects: z.string().trim().min(1).optional(),
});
export type FirstReleaseReport = z.infer<typeof firstReleaseReportSchema>;
