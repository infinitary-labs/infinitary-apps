import { z } from "zod";

/** Owner-only, ordered observations. No arguments, returned text or pictures cross this seam. */
export const toolObservationSchema = z.object({
  type: z.literal("tool_observation"),
  stream: z.string(),
  sequence: z.number().int().positive(),
  source: z.string(),
  at: z.number(),
  fact: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("guidance") }),
    z.object({
      kind: z.literal("completed"),
      callId: z.string(),
      toolName: z.string(),
      operation: z.string(),
      result: z.string(),
      /**
       * Whether the call's own result said it failed (`repetition-outcome.md`).
       * A work computer built before the change leaves it out.
       */
      failed: z.boolean().optional(),
    }),
  ]),
});
export type ToolObservation = z.infer<typeof toolObservationSchema>;
/**
 * Whether the repeated calls worked or failed. Their results are identical,
 * error flag included, so one outcome holds for every one of them; `unknown`
 * when the work computer did not say (built before `repetition-outcome.md`).
 */
export type RepetitionOutcome = "worked" | "failed" | "unknown";
export type RepetitionNotice = {
  identity: string;
  toolName: string;
  count: number;
  outcome: RepetitionOutcome;
  first: { source: string; callId: string; at: number };
  latest: { source: string; callId: string; at: number };
};
