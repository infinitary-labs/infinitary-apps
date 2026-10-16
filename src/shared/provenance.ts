import { z } from "zod";
import { SERVED_ORIGINS } from "./servedFrame";
import { taskEventActorSchema } from "./tasks";

/**
 * Prospective provenance (R2 of the model-training plan): what the task
 * record captures AT a policy-step decision, so an offline reader joins by
 * id instead of reconstructing it. Two shapes ride existing task events -
 * no table, no service, one writer (`TaskService`):
 *
 * - a `decided` event, one per task a decision was about, all sharing the
 *   decision id as their `ref` and carrying `DecisionRecord` as `data`;
 * - the `data` of the `steered` and `interrupted` events the crew control
 *   plane writes (`SteerEventData`, `InterruptEventData`).
 *
 * Nothing here is a copy of served text: the exact text lives once, in the
 * producer's own Pi session, and the record points at that entry and
 * fingerprints it. The captain's words are never copied into a record.
 */

export const DECISION_RECORD_SCHEMA = 1;

export const servedSegmentKindSchema = z.enum(["context", "wake", "user"]);

/** The frame's finer sub-type (`ServedOrigin` in `src/shared/servedFrame.ts`). */
export const servedOriginSchema = z.enum(SERVED_ORIGINS);

/** One typed segment of a framed input (`src/shared/servedFrame.ts`). */
export const servedSegmentRecordSchema = z.object({
  kind: servedSegmentKindSchema,
  /**
   * Who a wake or user segment came from, as the host stamped it. Absent on
   * a context segment and on records captured before origins were stamped.
   */
  origin: servedOriginSchema.optional(),
  /** The body's length in UTF-16 code units, as served. */
  length: z.number(),
  /** The durable inbox row a wake or parked captain turn was delivered from. */
  inboxId: z.number().optional(),
  /** That row's ref (a task id, a card id, `captain-turn`), verbatim. */
  ref: z.string().optional(),
});
export type ServedSegmentRecord = z.infer<typeof servedSegmentRecordSchema>;

export const servedMessageRecordSchema = z.object({
  textSha256: z.string(),
  /** The session entry holding the exact text; null if it never reached the tree. */
  entryId: z.string().nullable(),
  /** The tip of the effective session prefix it was appended to. */
  parentEntryId: z.string().nullable(),
  /** The frame version, or null for an input served unframed. */
  frame: z.string().nullable(),
  segments: z.array(servedSegmentRecordSchema),
});
export type ServedMessageRecord = z.infer<typeof servedMessageRecordSchema>;

export const decisionRecordSchema = z.object({
  schema: z.literal(DECISION_RECORD_SCHEMA),
  /** Shared by every `decided` event of the decision (their `ref`). */
  decision: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  producer: z.object({
    /** The existing actor label: firstmate, supervisor, or host (a code-sorted repeat). */
    actor: taskEventActorSchema,
    role: z.enum(["firstmate", "supervision"]),
    model: z.object({ provider: z.string(), id: z.string() }).nullable(),
    accountId: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
  }),
  /** The contract in force when the decision was served - never normalized later. */
  contract: z.object({
    version: z.string(),
    promptSha: z.string().nullable(),
    toolsSha: z.string().nullable(),
  }),
  /** What opened the decision, from the frame's own segment kinds. */
  trigger: z.enum(["captain", "wake", "mixed"]),
  /** Null only for a decision no model was served (a host-sorted repeat). */
  served: z
    .object({
      sessionFile: z.string().nullable(),
      prompt: servedMessageRecordSchema.extend({
        prefix: z.object({ messageCount: z.number(), sha256: z.string() }).nullable(),
      }),
      /** Captain words steered into the running turn, in order. */
      steers: z.array(servedMessageRecordSchema),
    })
    .nullable(),
  disposition: z.object({
    outcome: z.enum(["clean", "failed", "unreported"]),
    /** The failure, redacted at capture. */
    error: z.string().nullable(),
    /** What happened to the inbox rows the decision consumed. */
    inbox: z.enum(["acked", "released", "reassigned", "none"]),
    asks: z.array(
      z.object({ id: z.string(), taskId: z.string().nullable(), via: z.string().nullable() }),
    ),
    /** Pi tool call ids - the exact join to arguments and results in the session. */
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), isError: z.boolean() })),
    cards: z.array(z.string()),
    /**
     * Every task the decision touched. The `steered` / `interrupted` events
     * it issued carry this decision id as their `ref`.
     */
    tasks: z.array(z.string()),
    verdict: z.enum(["routine", "captain"]).nullable(),
    /** The supervision_outcomes row, when the decision was a triage. */
    outcomeId: z.number().nullable(),
    /**
     * The firstmate-lane inbox row an escalation enqueued: the id the
     * Firstmate decision that consumes it lists on its wake segment.
     */
    handoffInboxId: z.number().nullable(),
  }),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/**
 * The captain's click on one of a task card's own buttons - Start, Continue,
 * Drop task - as the typed source of the history entry it writes (FI3-695).
 * Firstmate's next context block lists these beside his card choices.
 */
export const TASK_CARD_VIA = "task-card";

/**
 * The task card's Crewmate tab (docs/task-card-tabs.md, "Typing"): a line
 * the captain typed there, and his ⌃C or Stop there, as the typed source of
 * the steer or the interrupt it writes.
 */
export const CREWMATE_TAB_VIA = "crewmate-tab";

/**
 * How a steer reached the crew control plane. `thread` is the captain's
 * reply typed under a card (cards-as-threads phase 1) - the same path a
 * card click takes, distinguished so the record says which gesture it was.
 * `task-card` is the task card's Continue, told apart from the stall card's.
 * `crewmate-tab` is a line he typed in the task card's Crewmate tab.
 */
export const steerViaSchema = z.enum([
  "tool",
  "card",
  "supervision",
  "thread",
  TASK_CARD_VIA,
  CREWMATE_TAB_VIA,
]);

export const steerEventDataSchema = z.object({
  /** The delivery outcome the control plane returned. */
  outcome: z.string(),
  via: steerViaSchema,
  /** The decision that issued it, when one did. */
  decision: z.string().nullable(),
  /**
   * The panel the captain made this move from, by its title, when a panel
   * made it on his click or key (docs/ui-plugins.md, "A panel's cards").
   */
  panel: z.string().optional(),
  /** The card whose declared action became this steer. */
  cardId: z.string().nullable(),
  /** The durable inbox row carrying the message. */
  inboxId: z.number().nullable(),
  /**
   * Where the captain's own words sit in the event's text, when the steer
   * carries a reply the captain typed under a crewmate's card: the record's Activity
   * reads them, and the card's title by `cardId`, rather than the whole
   * message its crewmate was sent. A span, never a copy of the words.
   */
  words: z.object({ from: z.number(), to: z.number() }).optional(),
});
export type SteerEventData = z.infer<typeof steerEventDataSchema>;

export const interruptEventDataSchema = z.object({
  mode: z.enum(["interrupt", "cancel"]),
  /** What the request did to the task at that moment. */
  effect: z.enum([
    "requested",
    "aborted-turn",
    "abort-failed",
    "cancelled-idle",
    "cancelled-record",
    "no-turn",
    "already-done",
  ]),
  error: z.string().nullable(),
  via: z.enum(["tool", "shell", TASK_CARD_VIA, CREWMATE_TAB_VIA]),
  decision: z.string().nullable(),
  /**
   * The panel the captain made this move from, by its title, when a panel
   * made it on his click or key (docs/ui-plugins.md, "A panel's cards").
   */
  panel: z.string().optional(),
});
export type InterruptEventData = z.infer<typeof interruptEventDataSchema>;
