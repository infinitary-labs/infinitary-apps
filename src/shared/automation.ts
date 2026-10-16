import { z } from "zod";

/**
 * Automation (docs/automation.md): the schedules Firstmate runs, as rules a
 * person can read, edit, pause and delete. The shapes the core answers and
 * Settings → Automation sends; the saved record is `ScheduleRecord`.
 */

const hourSchema = z.number().int().min(0).max(23);
const minuteSchema = z.number().int().min(0).max(59);
/** An IANA time zone name, such as America/Los_Angeles; the core checks it is one. */
const timeZoneSchema = z.string().min(1).max(64);

export const automationSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("every"), minutes: z.number().int().min(1) }),
  z.strictObject({
    kind: z.literal("daily"),
    hour: hourSchema,
    minute: minuteSchema,
    /** Absent on a rule made before time zones: it follows this computer's clock. */
    timeZone: timeZoneSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("weekly"),
    /** The weekdays it runs on, 0 for Sunday through 6 for Saturday. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hour: hourSchema,
    minute: minuteSchema,
    timeZone: timeZoneSchema,
  }),
  z.strictObject({ kind: z.literal("once"), at: z.number().int() }),
]);
export type AutomationSpec = z.infer<typeof automationSpecSchema>;

/**
 * `draft` is saved but never runs until the captain turns it on after a
 * review; `completed` is a one-time rule that ran, listed until its
 * delivery settles.
 */
export const automationStateSchema = z.enum(["draft", "enabled", "paused", "completed"]);
export type AutomationState = z.infer<typeof automationStateSchema>;

export const automationRuleSchema = z.strictObject({
  id: z.string(),
  /** Absent when nobody named it. */
  name: z.string().optional(),
  state: automationStateSchema,
  spec: automationSpecSchema,
  prompt: z.string(),
  /** The project its prompt is about, when it has one. */
  projectId: z.string().optional(),
  revision: z.number().int(),
  /** The next run; null unless the rule is enabled. */
  nextFire: z.number().nullable(),
  /** When it last ran, or null if it never has. */
  lastFired: z.number().nullable(),
  /** Whether a captain request or edit stands behind the rule (its saved authority). */
  captainRequested: z.boolean(),
});
export type AutomationRule = z.infer<typeof automationRuleSchema>;

/**
 * Every rule, or why they cannot be read now with the rules last read: an
 * unreadable list is never an empty one, so nothing that shows the rules
 * takes them away on a failed read (docs/automation.md, "The Automation
 * panel").
 */
export const automationListSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("ready"), rules: z.array(automationRuleSchema) }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.string(),
    /** The rules as they were last read, since this app started; empty before any read. */
    rules: z.array(automationRuleSchema),
  }),
]);
export type AutomationList = z.infer<typeof automationListSchema>;

/** What a list that cannot be read says. */
export const AUTOMATION_UNREADABLE = "Your automations cannot be read right now.";

/**
 * Where one delivery stands (docs/automation.md, "Deliveries"): `waiting`
 * until Firstmate's turn handles it, `retrying` while its delivery is being
 * tried again, `handled` once a turn handled it, `cancelled` when it was
 * recalled before Firstmate read it. `sent` is a run recorded before
 * deliveries were followed.
 */
export const automationDeliverySchema = z.enum([
  "waiting",
  "retrying",
  "handled",
  "cancelled",
  "sent",
]);
export type AutomationDelivery = z.infer<typeof automationDeliverySchema>;

/** Why a delivery was recalled before Firstmate read it. */
export const automationCancelReasonSchema = z.enum(["edited", "paused", "cleared"]);
export type AutomationCancelReason = z.infer<typeof automationCancelReasonSchema>;

export const automationRunSchema = z.strictObject({
  id: z.number().int(),
  revision: z.number().int(),
  plannedAt: z.number(),
  firedAt: z.number(),
  catchUp: z.boolean(),
  /** Further occurrences folded into this run, by downtime or while it waited. */
  missed: z.number().int(),
  prompt: z.string(),
  delivery: automationDeliverySchema,
  /** When it was handled or cancelled; null while it waits, or for a run recorded before. */
  settledAt: z.number().nullable(),
  cancelReason: automationCancelReasonSchema.optional(),
  /** The tasks the turn that handled it touched, as they are now. */
  tasks: z.array(z.strictObject({ id: z.string(), key: z.string(), title: z.string() })),
  /** The cards that turn showed; `open` while the card is still up. */
  cards: z.array(z.strictObject({ id: z.string(), title: z.string(), open: z.boolean() })),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

/** The captain's save: a new rule without `id`, an edit with it. */
export const automationSaveSchema = z.strictObject({
  id: z.string().min(1).optional(),
  name: z.string().max(80),
  spec: automationSpecSchema,
  prompt: z.string().min(1),
  /** The project its prompt is about; absent for none. */
  projectId: z.string().min(1).optional(),
  /**
   * The review's Turn on: the rule runs once saved. Without it a new rule
   * is saved as a draft, and an existing one keeps its state.
   */
  enable: z.boolean().optional(),
});
export type AutomationSave = z.infer<typeof automationSaveSchema>;

export const automationPreviewSchema = z.strictObject({ dates: z.array(z.number()) });
export type AutomationPreview = z.infer<typeof automationPreviewSchema>;

/**
 * Schedule details a saved prompt may hold, filled in when it runs (Insert
 * schedule detail in Settings → Automation): each is a fixed placeholder
 * replaced by a plain value, never an expression.
 */
export const SCHEDULE_DETAILS = [
  { id: "time", label: "Scheduled time", token: "{{scheduled time}}" },
  { id: "zone", label: "Time zone", token: "{{time zone}}" },
  { id: "missed", label: "Missed runs", token: "{{missed runs}}" },
] as const;

/** The planned moment as a prompt says it: "Sunday, October 11, 2026 at 7:00 AM PDT". */
export function scheduledTimeWords(at: number, timeZone: string): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** The saved prompt with its schedule details filled in for one run. */
export function fillScheduleDetails(
  prompt: string,
  run: { plannedAt: number; timeZone: string; missed: number },
): string {
  const values: Record<(typeof SCHEDULE_DETAILS)[number]["id"], string> = {
    time: scheduledTimeWords(run.plannedAt, run.timeZone),
    zone: run.timeZone,
    missed: String(run.missed),
  };
  return SCHEDULE_DETAILS.reduce(
    (text, detail) => text.split(detail.token).join(values[detail.id]),
    prompt,
  );
}
