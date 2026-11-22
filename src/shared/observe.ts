import { z } from "zod";
import { cardMessageSchema } from "./cards";
import { usageSchema } from "./events";
import { backendIdSchema } from "./providers";

/**
 * Dev-observe IPC shapes. The gate lives in main; these schemas only
 * describe what crosses the preload once Observe is enabled
 * (docs/dev-observe.md).
 */

export const FIRSTMATE_SESSION_ID = "firstmate";
export const NO_SESSION_YET = "No session yet. It opens on the first turn.";
/** The main Firstmate and one task's worker on whichever backend served it.
 * Retired supervision transcripts are historical evidence, not sessions here. */
export const observeSessionKindSchema = z.enum(["orchestrator", "crewmate"]);
export type ObserveSessionKind = z.infer<typeof observeSessionKindSchema>;

export const observeSessionStatusSchema = z.enum([
  "streaming",
  "idle",
  "done",
  "failed",
  "cancelled",
  "interrupted",
  "none",
]);
export type ObserveSessionStatus = z.infer<typeof observeSessionStatusSchema>;

const observeRecordedUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number().optional(),
  records: z.number(),
  reported: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  priced: z.number(),
});
export const observeUsageModelSchema = observeRecordedUsageSchema.extend({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  attribution: z.enum(["served", "requested", "historical"]),
});
export type ObserveUsageModel = z.infer<typeof observeUsageModelSchema>;

export const observeUsageTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number().optional(),
  /** Legacy record count, NOT a count of conversation turns. Kept for older clients. */
  turns: z.number(),
  /** Additive coverage facts; old clients keep their existing shape. */
  records: z.number().optional(),
  reported: observeRecordedUsageSchema.shape.reported.optional(),
  priced: z.number().optional(),
  models: z.array(observeUsageModelSchema).optional(),
});
export type ObserveUsageTotals = z.infer<typeof observeUsageTotalsSchema>;

/**
 * How a crewmate's work was routed (intelligence-bucket routing S5). The
 * tier is COMPUTED from the work's shape, so "which model is this running
 * on" is only half the answer - the other half is which row of the captain's
 * table asked for that slot, and whether the ladder could serve it. Observe
 * is the one dev-only surface that renders it; no user-facing surface
 * mentions a tier, a rule, or a classifier.
 */
export const observeRoutingSchema = z.object({
  /** The slot the policy asked for (`tasks.difficulty`). */
  tier: z.string().nullable(),
  /** The slot the ladder actually served, null when none was recorded. */
  served: z.string().nullable(),
  /** The policy row that answered (R0-R10); null on a row routed before it. */
  rule: z.string().nullable(),
  /** What the host took the work to be, and how that kind was established. */
  kind: z.string().nullable(),
  kindSource: z.string().nullable(),
  /** The delivery rigor the host derived (delivery rigor phase 3), null before it. */
  rigor: z.string().nullable(),
  /**
   * What the host derived the task DELIVERS - `answer` or `change`
   * (crew-posture rationalization Task B); null on a row shaped before the
   * axis existed.
   */
  deliverable: z.string().nullable(),
  /**
   * The review's latest verdict and its risk (`pass · risk low`) - on the
   * builder whose change was read, and on the review task that returned it.
   */
  review: z.string().nullable(),
  /** On a review task: the title of the builder it reviews. */
  reviewOf: z.string().nullable(),
});
export type ObserveRouting = z.infer<typeof observeRoutingSchema>;

export const observeSessionSummarySchema = z.object({
  id: z.string(),
  kind: observeSessionKindSchema,
  title: z.string(),
  taskId: z.string(),
  repo: z.string().nullable(),
  model: z.string().nullable(),
  status: observeSessionStatusSchema,
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  usage: observeUsageTotalsSchema.nullable(),
  error: z.string().nullable(),
  authFailure: z.boolean(),
  /**
   * The backend that serves this session's transcript. The main session's
   * is the seat that wrote its file (Pi, or Claude since W1); a crewmate's
   * is the backend of the account it ran on, or null when that account is
   * no longer registered.
   */
  backend: backendIdSchema.nullable(),
  /**
   * Why no transcript can be shown, in plain words, or null when one was
   * read (even if it holds no turns yet). The detail pane renders it in
   * place of the turns, so "nothing to show" is never a blank pane.
   */
  transcriptNote: z.string().nullable(),
  /**
   * The routing facts (S5), on a crewmate whose row carries a work shape.
   * Null on the main session - it is not routed by the policy -
   * and on a crewmate commissioned before the shape existed.
   */
  routing: observeRoutingSchema.nullable(),
});
export type ObserveSessionSummary = z.infer<typeof observeSessionSummarySchema>;

export const observeTurnKindSchema = z.enum([
  "context",
  "user",
  "op",
  "assistant",
  "tool",
  "usage",
  "error",
  "compaction",
]);
export type ObserveTurnKind = z.infer<typeof observeTurnKindSchema>;

export const observeTurnSchema = z.object({
  id: z.string(),
  at: z.number(),
  kind: observeTurnKindSchema,
  text: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  usage: usageSchema.optional(),
  model: z.string().optional(),
});
export type ObserveTurn = z.infer<typeof observeTurnSchema>;

export const observeCardThreadSchema = z.object({
  cardId: z.string(),
  title: z.string(),
  messages: z.array(cardMessageSchema),
});
export type ObserveCardThread = z.infer<typeof observeCardThreadSchema>;

export const observeSessionDetailSchema = observeSessionSummarySchema.extend({
  turns: z.array(observeTurnSchema),
  /** Open cards on this session that have a thread, oldest message first. */
  threads: z.array(observeCardThreadSchema).default([]),
});
export type ObserveSessionDetail = z.infer<typeof observeSessionDetailSchema>;

/**
 * A session's in-flight turn, held by the core between the stream and the
 * file: assistant text as it arrives, and tool calls with their outcome.
 * Cleared when the turn ends, which is when the transcript file has it.
 */
export const observeLiveToolSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  isError: z.boolean().optional(),
});
export type ObserveLiveTool = z.infer<typeof observeLiveToolSchema>;

export const observeLiveSchema = z.object({
  id: z.string(),
  text: z.string(),
  tools: z.array(observeLiveToolSchema),
});
export type ObserveLive = z.infer<typeof observeLiveSchema>;
