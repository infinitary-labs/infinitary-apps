import type {
  AutomationCancelReason,
  AutomationDelivery,
  AutomationRule,
  AutomationRun,
  AutomationSave,
  AutomationSpec,
} from "@shared/automation";
import { automationClockWords, automationDateWords } from "@shared/automationWords";

/**
 * The form conversions and the sheet's own words of Settings → Automation
 * (docs/automation.md). What a rule says in a list is shared with the
 * Automation panel (`@shared/automationWords`).
 */

export const AUTOMATION_MIN_MINUTES = 15;

export type RuleForm = {
  id?: string;
  name: string;
  kind: AutomationSpec["kind"];
  minutes: string;
  time: string;
  /** A weekly rule's weekdays, 0 for Sunday. */
  days: number[];
  /** An IANA zone; empty for a daily rule made before time zones, which follows this computer's clock. */
  timeZone: string;
  at: string;
  /** An event rule's event, as `integration/event`; empty for none picked. */
  event: string;
  filter: Record<string, string>;
  prompt: string;
  /** Empty for none. */
  projectId: string;
  /**
   * A stopped event rule (`AutomationRule.stopped`): saving it listens to
   * the integration picked in the sheet, the person's own choice.
   */
  reconnect: boolean;
};

/** The zone this computer's clock follows now: a new rule's default. */
export function hereZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Every zone the platform knows, for the Time zone list. */
export function knownZones(): string[] {
  return Intl.supportedValuesOf("timeZone");
}

export function blankForm(): RuleForm {
  return {
    name: "",
    kind: "daily",
    minutes: "60",
    time: "09:00",
    days: [1],
    timeZone: hereZone(),
    at: "",
    event: "",
    filter: {},
    prompt: "",
    projectId: "",
    reconnect: false,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A local date-time as a `datetime-local` field holds it. */
function localInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formOf(rule: AutomationRule): RuleForm {
  const blank = blankForm();
  const spec = rule.spec;
  const calendar = spec.kind === "daily" || spec.kind === "weekly";
  return {
    id: rule.id,
    name: rule.name ?? "",
    kind: spec.kind,
    minutes: spec.kind === "every" ? String(spec.minutes) : blank.minutes,
    time: calendar ? `${pad(spec.hour)}:${pad(spec.minute)}` : blank.time,
    days: spec.kind === "weekly" ? spec.days : blank.days,
    // A daily rule without a zone keeps following this computer's clock until one is picked.
    timeZone: calendar ? (spec.timeZone ?? "") : blank.timeZone,
    at: spec.kind === "once" ? localInput(spec.at) : "",
    event: spec.kind === "event" ? `${spec.integration}/${spec.event}` : "",
    filter: spec.kind === "event" ? (spec.filter ?? {}) : {},
    prompt: rule.prompt,
    projectId: rule.projectId ?? "",
    reconnect: rule.stopped !== undefined,
  };
}

/** The schedule the form describes, or why it does not describe one yet. */
export function specOf(form: RuleForm): AutomationSpec | string {
  if (form.kind === "event") {
    const at = form.event.lastIndexOf("/");
    if (at < 0) return "Pick what happens.";
    return {
      kind: "event",
      integration: form.event.slice(0, at),
      event: form.event.slice(at + 1),
      ...(Object.keys(form.filter).length ? { filter: form.filter } : {}),
    };
  }
  if (form.kind === "every") {
    const minutes = Number.parseInt(form.minutes, 10);
    if (!Number.isFinite(minutes) || minutes < AUTOMATION_MIN_MINUTES) {
      return `Repeats run at most every ${AUTOMATION_MIN_MINUTES} minutes.`;
    }
    return { kind: "every", minutes };
  }
  if (form.kind === "daily" || form.kind === "weekly") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(form.time);
    if (!match) return "Pick a time of day.";
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (form.kind === "daily") {
      return { kind: "daily", hour, minute, ...(form.timeZone ? { timeZone: form.timeZone } : {}) };
    }
    if (form.days.length === 0) return "Pick at least one day.";
    return { kind: "weekly", days: form.days, hour, minute, timeZone: form.timeZone || hereZone() };
  }
  const at = new Date(form.at).getTime();
  if (!form.at || Number.isNaN(at)) return "Pick a date and time.";
  return { kind: "once", at };
}

/** The save the form describes; `enable` is the review's Turn on. */
export function saveOf(form: RuleForm, enable = false): AutomationSave | string {
  const spec = specOf(form);
  if (typeof spec === "string") return spec;
  if (!form.prompt.trim()) return "Write what to tell your first mate.";
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    spec,
    prompt: form.prompt.trim(),
    ...(form.projectId ? { projectId: form.projectId } : {}),
    ...(enable ? { enable: true } : {}),
    ...(form.reconnect && spec.kind === "event" ? { reconnect: true } : {}),
  };
}

export function runWords(run: AutomationRun): string {
  if (run.events !== undefined)
    return `${run.events} ${run.events === 1 ? "event" : "events"}, sent ${automationDateWords(run.firedAt)}`;
  const extra =
    run.missed > 0
      ? `, catching up ${run.missed} missed ${run.missed === 1 ? "run" : "runs"}`
      : run.catchUp
        ? ", catching up after the app was closed"
        : "";
  return `Planned ${automationDateWords(run.plannedAt)}, sent ${automationDateWords(run.firedAt)}${extra}`;
}

/** Where a delivery stands, in a word (docs/automation.md, "Deliveries"). */
export const DELIVERY_WORDS: Record<AutomationDelivery, string> = {
  waiting: "Waiting",
  retrying: "Retrying",
  handled: "Handled",
  cancelled: "Cancelled",
  sent: "Sent",
};

export const DELIVERY_TONES: Record<AutomationDelivery, "ok" | "busy" | "warn" | "idle" | "ring"> =
  {
    waiting: "busy",
    retrying: "warn",
    handled: "ok",
    cancelled: "idle",
    sent: "ring",
  };

/** What a delivery's state means, beside it. */
export function deliveryNote(run: AutomationRun): string | null {
  switch (run.delivery) {
    case "waiting":
      return "Your first mate has not handled it yet.";
    case "retrying":
      return "Your first mate could not take it yet. It is being tried again.";
    case "handled":
      return run.settledAt === null ? null : `Your first mate handled it ${handledWhen(run)}.`;
    case "cancelled":
      return run.cancelReason
        ? CANCEL_WORDS[run.cancelReason]
        : "Taken back before your first mate read it.";
    case "sent":
      return null;
  }
}

/** When a delivery was handled: the time on the day it was sent, the date otherwise. */
function handledWhen(run: AutomationRun): string {
  const at = new Date(run.settledAt ?? run.firedAt);
  return at.toDateString() === new Date(run.firedAt).toDateString()
    ? `at ${automationClockWords(at.getHours(), at.getMinutes())}`
    : `on ${automationDateWords(at.getTime())}`;
}

/** Why a delivery was taken back before Firstmate read it. */
export const CANCEL_WORDS: Record<AutomationCancelReason, string> = {
  edited: "Taken back before your first mate read it, because the automation was changed.",
  paused: "Taken back before your first mate read it, because the automation was paused.",
  cleared: "Your first mate's conversation was cleared before it read this.",
};

/** The review before a rule is turned on: what it sends, and where. */
export const REVIEW_SENDS =
  "This prompt and its schedule details go to your AI subscription and stay in your first mate's conversation. Nothing else gets new access.";

/** The review's word on what an event rule sends, in place of `REVIEW_SENDS`. */
export const REVIEW_SENDS_EVENTS =
  "This prompt and a short summary of each event go to your AI subscription and stay in your first mate's conversation. Nothing else gets new access.";

/** An event rule's preview: what it does in place of its next dates. */
export function eventPreviewWords(when: string, every: number | undefined): string {
  return `${when}, your first mate gets this prompt with the events. ${lookWords(every)} Nothing is sent.`;
}

/** How often the app looks at an event: "Infinitary looks every minute." */
export function lookWords(every: number | undefined): string {
  if (every === undefined) return "";
  return `Infinitary looks every ${every === 1 ? "minute" : `${every} minutes`}.`;
}

/** What the preview fills `{{events}}` with, before any event arrived. */
export const EVENTS_PREVIEW = "- (a summary of each event that arrived)";

/** The review's word on a time Firstmate is not open for. */
export function reviewMissedWords(spec: AutomationSpec, where: string | null): string {
  const there = where ? ` on ${where}` : "";
  if (spec.kind === "event")
    return `If Infinitary is closed${there} or the computer is asleep, what arrived meanwhile is sent once when it returns.`;
  return spec.kind === "once"
    ? `If Infinitary is closed${there} at that time, it runs once Infinitary opens.`
    : `If Infinitary is closed${there} or the computer is asleep, the runs it missed happen once when it returns, with how many it missed.`;
}

/** The weekday toggles, Monday first as a week reads. */
export const WEEKDAY_TOGGLES = [
  { day: 1, label: "Mon", name: "Monday" },
  { day: 2, label: "Tue", name: "Tuesday" },
  { day: 3, label: "Wed", name: "Wednesday" },
  { day: 4, label: "Thu", name: "Thursday" },
  { day: 5, label: "Fri", name: "Friday" },
  { day: 6, label: "Sat", name: "Saturday" },
  { day: 0, label: "Sun", name: "Sunday" },
] as const;

export const SUBMITTED_NOTE =
  "Your first mate gets this prompt when the time comes. The prompt and time reach your AI subscription and stay in your first mate's conversation.";
export const SUBMITTED_NOTE_EVENTS =
  "Your first mate gets this prompt each time new events arrive, with a short summary of each. They reach your AI subscription and stay in your first mate's conversation.";

/**
 * The time zone's note. `where` names the computer Firstmate lives on when
 * this one controls it, since the automation runs there.
 */
export function zoneNote(where: string | null): string {
  return where
    ? `Runs at this time in the zone you pick. Automation runs on ${where}, only while Infinitary is open there and it is awake; a run missed meanwhile happens once when it returns.`
    : "Runs at this time in the zone you pick, wherever this computer is. Automation runs only while Infinitary is open and the computer is awake; a run missed meanwhile happens once when it returns.";
}

/** A daily rule made before time zones, which follows the clock where Firstmate lives. */
export function localTimeNote(where: string | null): string {
  return where
    ? `This automation follows the clock on ${where}, so it moves when that computer travels. Pick a time zone to keep it fixed.`
    : "This automation follows this computer's clock, so it moves when you travel. Pick a time zone to keep it fixed.";
}

/** The Time zone list's entry for a rule that keeps none. */
export function localClockWords(where: string | null): string {
  return where ? `The clock on ${where}` : "This computer's clock";
}

/** What a draft says at the top of its sheet. */
export const DRAFT_NOTE = "A draft never runs. Choose Enable to check it and turn it on.";
/** A stopped event rule's When, at the top of its sheet. */
export const STOPPED_WHEN = "Waiting for its integration to be picked again";
/** What saving a stopped event rule does, after why it stopped: it listens to what is picked. */
export const STOPPED_NOTE = "Saving it listens to the one picked under When.";
export const DETAIL_NOTE = "Each detail is filled in when the prompt is sent.";
