import { z } from "zod";
import { SERVED_LOCALE, servedNumber } from "./i18n/format.ts";
import { fencedListReminder, fencedSpans } from "./outsideData";

/**
 * Automation (docs/automation.md): the schedules Firstmate runs, as rules a
 * person can read, edit, pause and delete. The shapes the core answers and
 * Settings → Automation sends; the saved record is `ScheduleRecord`.
 */

const hourSchema = z.number().int().min(0).max(23);
const minuteSchema = z.number().int().min(0).max(59);
/** An IANA time zone name, such as America/Los_Angeles; the core checks it is one. */
const timeZoneSchema = z.string().min(1).max(64);

export const automationEventFilterSchema = z.record(z.string(), z.string());

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
  /**
   * When something happens (docs/automation.md, "Events"): each time one of
   * the events an integration declares arrives. The app looks at that
   * integration's declared cadence on its one tick.
   */
  z.strictObject({
    kind: z.literal("event"),
    /** The integration's id (src/shared/integrations.ts). */
    integration: z.string().min(1).max(48),
    /** One of the events its kind declares, by name. */
    event: z.string().min(1).max(48),
    /** Only fields the integration event declares; omitted means its defaults. */
    filter: automationEventFilterSchema.optional(),
    /**
     * What the rule waits for, in words (docs/automation.md, "The event
     * screen"): with the event screen on, an event the decision model reads
     * as plainly not this skips the first mate. Absent, nothing is screened.
     */
    waitsFor: z.string().min(1).optional(),
  }),
]);
export type AutomationSpec = z.infer<typeof automationSpecSchema>;

/**
 * `draft` is saved but never runs until the captain turns it on after a
 * review; `completed` is a one-time rule that ran, listed until its
 * delivery settles.
 */
export const automationStateSchema = z.enum(["draft", "enabled", "paused", "completed"]);
export type AutomationState = z.infer<typeof automationStateSchema>;

/**
 * The most a rule's notes may hold, in characters (docs/automation.md, "A
 * rule's notes"): about 1,200 words, the captain's choice. A longer page is
 * refused, never cut.
 */
export const RULE_NOTES_MAX_CHARS = 8000;

export function ruleNotesTooLong(length: number): string {
  return `These notes are ${servedNumber(length)} characters; a rule's notes hold at most ${servedNumber(RULE_NOTES_MAX_CHARS)}. Remove or shorten lines that no longer help, then save them again.`;
}

/**
 * One version of a rule's notes: what its runs learned, written by a
 * crewmate a run started (`task` names its task) or by the captain. An
 * empty text is a cleared page. `revision` is the rule's revision it was
 * saved under.
 */
export const automationNotesSchema = z.strictObject({
  version: z.number().int(),
  text: z.string(),
  at: z.number(),
  revision: z.number().int(),
  by: z.enum(["crewmate", "captain"]),
  task: z.strictObject({ id: z.string(), key: z.string(), title: z.string() }).optional(),
});
export type AutomationNotes = z.infer<typeof automationNotesSchema>;

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
  /**
   * What an event rule listens for, in its integration's own words ("An
   * item arrives in Stand-in"); absent on a schedule, or while its
   * integration is not connected.
   */
  when: z.string().optional(),
  /**
   * Why an event rule waits though its integration's id is connected: that
   * id stands for another connection now, or the rule was saved before the
   * app could tell (docs/automation.md, "Events"). Saving it with
   * `reconnect` picks what is connected now.
   */
  stopped: z.string().optional(),
  /**
   * A turned-on event rule whose every look failed for an hour
   * (docs/automation.md, "When every look fails"): when the first failed look
   * was, and what the newest answered, in the integration's own words. It
   * keeps looking, and this goes once a look answers.
   */
  failing: z.strictObject({ since: z.number(), reason: z.string() }).optional(),
  /**
   * The runbook wake that brought the rule (docs/automation.md, "The
   * heartbeat"): it comes and goes with that runbook's switch, and nobody
   * edits or deletes it; Pause and Resume still work.
   */
  brought: z.literal("heartbeat").optional(),
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
  /** How many events an event rule's run carries; absent on a scheduled run. */
  events: z.number().int().optional(),
  /**
   * How many of those events the event screen kept from the first mate, as
   * plainly not what the rule waits for; the run is then `cancelled` with
   * no reason (docs/automation.md, "The event screen").
   */
  screened: z.number().int().optional(),
  prompt: z.string(),
  delivery: automationDeliverySchema,
  /** When it was handled or cancelled; null while it waits, or for a run recorded before. */
  settledAt: z.number().nullable(),
  cancelReason: automationCancelReasonSchema.optional(),
  /** The tasks the turn that handled it touched, as they are now. */
  tasks: z.array(z.strictObject({ id: z.string(), key: z.string(), title: z.string() })),
  /** The cards that turn showed; `open` while the card is still up. */
  cards: z.array(z.strictObject({ id: z.string(), title: z.string(), open: z.boolean() })),
  /**
   * What the run found: the closing words of the first mate's turn that
   * handled it. Absent while it waits, when it was cancelled, when that turn
   * ended without words, and on a run handled before runs kept them.
   */
  found: z.string().optional(),
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
  /**
   * The person picked the event rule's integration again: it listens to
   * what that id stands for now, even when the id stands for another
   * connection than the one it was saved for.
   */
  reconnect: z.boolean().optional(),
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
  { id: "events", label: "Events", token: "{{events}}" },
] as const;

/** The details a rule of this kind fills: an event rule's events, a schedule's time. */
export function scheduleDetailsFor(
  kind: AutomationSpec["kind"],
): (typeof SCHEDULE_DETAILS)[number][] {
  return SCHEDULE_DETAILS.filter((detail) =>
    kind === "event" ? detail.id !== "missed" : detail.id !== "events",
  );
}

/**
 * The placeholders a saved prompt may hold, in the words the first mate's
 * automation-edit line says them: from the list above, so it never names
 * one the app does not fill.
 */
export function scheduleDetailsWords(): string {
  const tokens = (kind: AutomationSpec["kind"]): string[] =>
    scheduleDetailsFor(kind).map((detail) => detail.token);
  const schedule = tokens("daily");
  const event = tokens("event");
  const both = schedule.filter((token) => event.includes(token));
  const only = (list: string[]) => list.filter((token) => !both.includes(token)).join(", ");
  return `A prompt may hold ${both.join(", ")}, ${only(schedule)} or (event rule) ${only(event)}.`;
}

/** One event an integration told, as a run carries it: its id there and its typed summary. */
export type AutomationEventItem = {
  id: string;
  summary: string;
  /**
   * The event screen kept it from the first mate, as plainly not what the
   * rule waits for (docs/automation.md, "The event screen"). It stays on the
   * run so it is never looked at again, and the history can show it.
   */
  screened?: true;
};

/**
 * The events as `{{events}}` fills them: one line each, its summary and its
 * id. A summary of words anyone can write arrives fenced as data from
 * outside (`@shared/outsideData`), and the list ends with one line saying
 * so for each label its lines hold (INF-951).
 */
export function eventsWords(items: readonly AutomationEventItem[]): string {
  const labels = new Set(
    items.flatMap((item) => fencedSpans(item.summary).map((span) => span.label)),
  );
  return [
    ...items.map((item) => `- ${item.summary} (id ${item.id})`),
    ...[...labels].map(fencedListReminder),
  ].join("\n");
}

/** The planned moment as a prompt says it: "Sunday, October 11, 2026 at 7:00 AM PDT". */
export function scheduledTimeWords(at: number, timeZone: string): string {
  return new Date(at).toLocaleString(SERVED_LOCALE, {
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

/**
 * The saved prompt with its schedule details filled in for one run. An
 * event rule's run carries its events: where the prompt has no `{{events}}`
 * they follow it, so the first mate always reads what arrived.
 */
export function fillScheduleDetails(
  prompt: string,
  run: { plannedAt: number; timeZone: string; missed: number; events?: string },
): string {
  const values: Record<(typeof SCHEDULE_DETAILS)[number]["id"], string> = {
    time: scheduledTimeWords(run.plannedAt, run.timeZone),
    zone: run.timeZone,
    missed: String(run.missed),
    events: run.events ?? "none",
  };
  const events = SCHEDULE_DETAILS.find((detail) => detail.id === "events")?.token ?? "";
  const placed =
    run.events !== undefined && !prompt.includes(events) ? `${prompt}\n\n${events}` : prompt;
  return SCHEDULE_DETAILS.reduce(
    (text, detail) => text.split(detail.token).join(values[detail.id]),
    placed,
  );
}
