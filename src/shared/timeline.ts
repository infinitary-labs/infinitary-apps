import { z } from "zod";

/**
 * One task's durable entries in one reading shape (INF-1296 piece 1,
 * docs/task-record.md "The unified timeline"): when, who, a short summary
 * and an exact reference to the record that holds the entry. The owners
 * keep their records - task events, card evidence and threads, a
 * crewmate's kept session - and the reader (`TaskTimeline`) only reads
 * them; a timeline entry is never written, and it grants nothing.
 *
 * A reader of a newer `schemaVersion` treats an entry by that version's
 * rules; each content kind carries its own `version` the same way.
 */
export const TIMELINE_SCHEMA_VERSION = 1;

/**
 * Who did it, as the owner recorded it. `frame` is a card body's own
 * script, never proof the captain did anything.
 */
export const TIMELINE_ACTORS = [
  "captain",
  "firstmate",
  "crewmate",
  "supervisor",
  "host",
  "frame",
] as const;
export const timelineActorSchema = z.object({ kind: z.enum(TIMELINE_ACTORS) });
export type TimelineActor = z.infer<typeof timelineActorSchema>;

/**
 * The exact record an entry reads, by its owner: a task event by its id
 * (the task that wrote it may be another task the event concerns), a card
 * observation by its id with the offer, interaction and thread message it
 * names, a card's thread line by its message id, or one action in a
 * crewmate's kept session by the file's name and the action's place in it.
 */
export const timelineSourceRefSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("task-event"),
    taskId: z.string(),
    eventId: z.number().int(),
  }),
  z.object({
    source: z.literal("card-observation"),
    cardId: z.string(),
    lifecycleId: z.string(),
    observationId: z.string(),
    offerId: z.string().nullable(),
    interactionId: z.string().nullable(),
    messageId: z.number().int().nullable(),
  }),
  z.object({
    source: z.literal("card-message"),
    cardId: z.string(),
    messageId: z.number().int(),
  }),
  z.object({
    source: z.literal("session-observation"),
    observationId: z.string(),
    conversation: z.string(),
  }),
  z.object({
    source: z.literal("session-action"),
    file: z.string(),
    index: z.number().int(),
  }),
]);
export type TimelineSourceRef = z.infer<typeof timelineSourceRefSchema>;
export type TimelineSource = TimelineSourceRef["source"];

/**
 * What an entry is. Every task event kind, card observation kind and a
 * session's action maps to exactly one (`TaskTimeline`'s adapters own the
 * mapping, and a new kind fails the build until it has one).
 */
export const TIMELINE_CONTENT_KINDS = [
  // Task events.
  "filing",
  "ask",
  "answer",
  "brief",
  "dispatch",
  "steer",
  "progress",
  "report",
  "failure",
  "card-raised",
  "card-choice",
  "status",
  "link",
  "move",
  "change",
  "check",
  "merge",
  "triage",
  "note",
  "compacted",
  "interruption",
  "decision",
  "escalation",
  "review",
  "cap-reset",
  "reply",
  // Card evidence and threads; a choice reads as `card-choice` too.
  "card-offer",
  "card-availability",
  "card-message",
  "card-exit",
  "effect-result",
  "card-seen",
  // A crewmate's kept session.
  "session-action",
  "session-observation",
] as const;
export type TimelineContentKind = (typeof TIMELINE_CONTENT_KINDS)[number];

export const timelineContentSchema = z.object({
  kind: z.enum(TIMELINE_CONTENT_KINDS),
  version: z.literal(1),
  ref: timelineSourceRefSchema,
});
export type TimelineContent = z.infer<typeof timelineContentSchema>;

/**
 * An explicit link to another entry, as its owner recorded it: a card's
 * thread line, choice or close `reply` to the offer it was under, an offer
 * `revision` of the one it replaced, an effect's `cause` the interaction
 * that asked for it. `concern` names the other task an event concerns and
 * how it stands to this one. None is guessed from words or nearby times,
 * and none is a task dependency: no link changes readiness.
 */
export const timelineLinkSchema = z.discriminatedUnion("rel", [
  z.object({ rel: z.enum(["reply", "revision", "cause"]), to: z.string() }),
  z.object({ rel: z.literal("concern"), taskId: z.string(), relation: z.string() }),
]);
export type TimelineLink = z.infer<typeof timelineLinkSchema>;

export const timelineEntrySchema = z.object({
  schemaVersion: z.literal(TIMELINE_SCHEMA_VERSION),
  /** Stable across restart: derived from the source's own identity, never from words. */
  id: z.string(),
  /** The task whose timeline it is on. */
  taskId: z.string(),
  /** When it happened, as recorded; null when the source holds no time. */
  at: z.number().nullable(),
  actor: timelineActorSchema.nullable(),
  /** The same short line wherever the entry appears; the content opens whole from its source. */
  summary: z.string(),
  content: timelineContentSchema,
  links: z.array(timelineLinkSchema),
  /**
   * Bookkeeping or evidence a view may fold (Activity's folded and
   * evidence places, a card's availability or seen mark, a crewmate's
   * actions); it stays on the timeline either way.
   */
  quiet: z.boolean(),
  /** Other entries' ids the owner recorded as the same occurrence, folded into this one. */
  aliases: z.array(z.string()),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/** A read-only plain reading with exact retained details, not a live card or action to run. */
export const timelineReadingSchema = z.object({
  entry: timelineEntrySchema,
  actorLabel: z.string(),
  /** A folded Activity parent, for presentation only, never a claimed cause. */
  activityRowId: z.number().int().optional(),
  text: z.string().nullable(),
  /** Exact retained raw text, disclosed beneath the plain reading when present. */
  details: z.string().optional(),
});
export type TimelineReading = z.infer<typeof timelineReadingSchema>;
