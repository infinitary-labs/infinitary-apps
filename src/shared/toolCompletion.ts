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
    }),
  ]),
});
export type ToolObservation = z.infer<typeof toolObservationSchema>;
export type RepetitionNotice = {
  identity: string;
  toolName: string;
  count: number;
  first: { source: string; callId: string; at: number };
  latest: { source: string; callId: string; at: number };
};
