import { z } from "zod";

/**
 * How long after the core accepted a message the captain may take it back
 * (docs/task-capture.md, "Taking back a message"): the captain's pick on
 * INF-6763's plan, one minute. It is not a setting.
 */
export const TAKE_BACK_WINDOW_MS = 60_000;

/** The ask a take back names, as `inf:conversation:take-back` receives it. */
export const takeBackRequestSchema = z.object({
  askId: z.string().min(1).max(128),
});
export type TakeBackRequest = z.infer<typeof takeBackRequestSchema>;

/**
 * Why a take back changed nothing: the message is not the captain's newest
 * to the first mate, it was sent longer ago than the window, it was taken
 * back already, or no message has that id.
 */
export const takeBackRefusalSchema = z.enum(["not-newest", "past-window", "taken-back", "unknown"]);
export type TakeBackRefusal = z.infer<typeof takeBackRefusalSchema>;

/**
 * How far the message had got when it was taken back: `withdrawn` before
 * the first mate read it, so nothing follows; `stopping` while a turn holds
 * it, which is told at once and refused every action for it; `undoing`
 * once no turn holds it, so the first mate is asked now to undo what it did.
 */
export const takeBackResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("withdrawn") }),
  z.object({ outcome: z.literal("stopping") }),
  z.object({ outcome: z.literal("undoing") }),
  z.object({ outcome: z.literal("refused"), reason: takeBackRefusalSchema }),
]);
export type TakeBackResult = z.infer<typeof takeBackResultSchema>;
