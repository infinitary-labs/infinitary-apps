import { z } from "zod";
import { CONVERSE_TEXT_MAX_CHARS } from "./cards";

/**
 * Suggest tags (docs/task-tags.md, "Suggesting tags"): a project with no
 * tags offers to ask the first mate for some. The press sends the person's
 * words as their own message, and the home adds a typed note to the first
 * mate's turn because of the press, never because of the words.
 */

/** The press (`inf:projects:suggest-tags`): the project, and the words shown as the person's message. */
export const tagSuggestionRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  words: z.string().trim().min(1).max(CONVERSE_TEXT_MAX_CHARS),
});
export type TagSuggestionRequest = z.infer<typeof tagSuggestionRequestSchema>;

/**
 * Why the home sent nothing: no such project, a removed one, one that has
 * a tag already, or a home whose tagging has not started yet.
 */
export const tagSuggestionRefusalSchema = z.enum(["unknown", "removed", "tagged", "starting"]);
export type TagSuggestionRefusal = z.infer<typeof tagSuggestionRefusalSchema>;

export const tagSuggestionResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), refused: tagSuggestionRefusalSchema }),
]);
export type TagSuggestionResult = z.infer<typeof tagSuggestionResultSchema>;
