import { z } from "zod";

/**
 * When a put-off choice comes back (INF-3846 piece 3, docs/card-authoring.md
 * "Not until"): a task's close, whatever closed it (`task` is its id), a time
 * (`at`, epoch milliseconds), any event something connected tells (as an
 * Automation event rule names it), or the captain's word, which only the
 * captain or the first mate on their words brings back. Each but the word
 * waits through an Automation rule; each is a typed fact the host holds and
 * it reads no words.
 */
export const putOffUntilSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("close"), task: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("date"), at: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("event"),
    integration: z.string().min(1).max(48),
    event: z.string().min(1).max(48),
    filter: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ kind: z.literal("word") }),
]);
export type PutOffUntil = z.infer<typeof putOffUntilSchema>;

/**
 * A put-off the host keeps on a closed card's row (`cards.put_off_json`):
 * which choice the captain clicked, when, what brings the same card back,
 * the Automation rule waiting for it (absent for the captain's word) and
 * the task it belongs to.
 * Cleared when the card is raised again or its task closes.
 */
export const keptPutOffSchema = z.object({
  action: z.string().min(1),
  until: putOffUntilSchema,
  at: z.number().int().nonnegative(),
  rule: z.string().min(1).optional(),
  /**
   * The task it belongs to, kept when the captain clicked: the card's own
   * task, else the decision or host-card row the click left open. Absent
   * for a card with neither.
   */
  task: z.string().min(1).optional(),
});
export type KeptPutOff = z.infer<typeof keptPutOffSchema>;
