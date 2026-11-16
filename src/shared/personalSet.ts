import { z } from "zod";

/**
 * One version of the home's personal instructions and skills
 * (docs/personal-resources.md, "One set, kept on each computer"): its
 * fingerprint, since when the home has had it, and how many files it holds.
 */
export const personalVersionSchema = z.object({
  version: z.string().regex(/^[0-9a-f]{64}$/),
  since: z.number(),
  files: z.number().int().nonnegative(),
});
export type PersonalVersion = z.infer<typeof personalVersionSchema>;

/**
 * The version a task's newest conversation read, and the computer it read
 * it on: `home` for the computer where the first mate lives, which each
 * window words in its own language and names from a view (docs/i18n.md,
 * "Saved facts"), or another computer by its name.
 */
export const personalReadSchema = z.union([
  personalVersionSchema.extend({ home: z.literal(true) }),
  personalVersionSchema.extend({ computer: z.string().min(1).max(256) }),
]);
export type PersonalRead = z.infer<typeof personalReadSchema>;

/** The timeline note's data field that says which version a conversation read. */
export const PERSONAL_READ_FIELD = "personal";

/** The newest version a task's timeline says its conversation read, if any. */
export function personalReadOf(
  timeline: readonly { data?: Record<string, unknown> | null }[],
): PersonalRead | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const parsed = personalReadSchema.safeParse(timeline[index]?.data?.[PERSONAL_READ_FIELD]);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
