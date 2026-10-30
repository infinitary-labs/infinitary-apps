import { z } from "zod";

/** Identity only: a path on the home is never a path on a work computer. */
export const sourceIdentitySchema = z.object({
  computer: z.string(),
  version: z.string().nullable(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  mutable: z.boolean(),
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;
