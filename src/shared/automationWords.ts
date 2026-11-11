import type { AutomationRule, AutomationSpec, AutomationState } from "./automation";
import { formatDate, formatDateTime, formatTime } from "./i18n/format.ts";

/**
 * What an automation rule says wherever it shows (docs/automation.md):
 * Settings → Automation and the Automation panel read one set of words, so
 * a rule reads the same in both. Plain words for someone who has never
 * opened a terminal; times in the person's own locale.
 */

export const AUTOMATION_STATE_WORDS: Record<AutomationState, string> = {
  draft: "Draft",
  enabled: "Running",
  paused: "Paused",
  completed: "Done",
};

export const AUTOMATION_STATE_TONES: Record<AutomationState, "ok" | "idle" | "ring"> = {
  draft: "ring",
  enabled: "ok",
  paused: "idle",
  completed: "ring",
};

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS_PLURAL = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

/** The zone this computer's clock follows now. */
function hereZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A time of day in the person's locale: "7:00 AM". */
export function automationClockWords(hour: number, minute: number): string {
  return formatTime(new Date(2000, 0, 1, hour, minute), {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Chosen weekdays: "Sundays", "Mon, Wed, Fri", "Weekdays", "Weekends". */
export function automationDaysWords(days: readonly number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return "Every day";
  if (set.join() === "1,2,3,4,5") return "Weekdays";
  if (set.join() === "0,6") return "Weekends";
  if (set.length === 1) return WEEKDAYS_PLURAL[set[0] ?? 0] ?? "";
  return set.map((day) => WEEKDAYS_SHORT[day] ?? "").join(", ");
}

/** An IANA zone as a person reads it: "Los Angeles (America)". */
export function automationZoneWords(zone: string): string {
  const parts = zone.split("/");
  if (parts.length < 2) return zone.replaceAll("_", " ");
  const city = (parts.at(-1) ?? zone).replaceAll("_", " ");
  return `${city} (${parts.slice(0, -1).join("/").replaceAll("_", " ")})`;
}

/** A moment, in a rule's own zone when it keeps one other than this computer's. */
export function automationDateWords(ms: number, timeZone?: string): string {
  const elsewhere = timeZone !== undefined && timeZone !== hereZone();
  return formatDateTime(ms, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(elsewhere ? { timeZone, timeZoneName: "short" } : {}),
  });
}

/** The zone a rule's times are read in, when it keeps one. */
export function automationZoneOf(spec: AutomationSpec): string | undefined {
  return spec.kind === "daily" || spec.kind === "weekly" ? spec.timeZone : undefined;
}

/**
 * What an event rule listens for, from its integration's own words for the
 * event: "A message arrives" in Gmail reads "When a message arrives in Gmail".
 */
export function automationEventWords(label: string, integration: string): string {
  return `When ${label.charAt(0).toLowerCase()}${label.slice(1)} in ${integration}`;
}

/** An event rule whose integration is not connected now. */
export const AUTOMATION_EVENT_UNKNOWN =
  "When something happens in an integration not connected now";

/**
 * A schedule in a few words: "Every hour", "Sundays at 7:00 AM", "Once, Sun,
 * Oct 11, 7:00 AM"; an event rule's `when`, the core's words for it.
 */
export function automationWhenWords(spec: AutomationSpec, when?: string): string {
  switch (spec.kind) {
    case "event":
      return when ?? AUTOMATION_EVENT_UNKNOWN;
    case "every":
      return spec.minutes % 60 === 0
        ? spec.minutes === 60
          ? "Every hour"
          : `Every ${spec.minutes / 60} hours`
        : `Every ${spec.minutes} minutes`;
    case "daily":
      return `Every day at ${automationClockWords(spec.hour, spec.minute)}`;
    case "weekly":
      return `${automationDaysWords(spec.days)} at ${automationClockWords(spec.hour, spec.minute)}`;
    case "once":
      return `Once, ${automationDateWords(spec.at)}`;
  }
}

/** A rule's list title: its name, else the start of its prompt. */
export function automationRuleTitle(rule: Pick<AutomationRule, "name" | "prompt">): string {
  return rule.name || rule.prompt.slice(0, 48);
}

/** What a rule's row says at its end: the next run, or why there is none. */
export function automationNextWords(
  rule: Pick<AutomationRule, "state" | "nextFire" | "spec">,
): string {
  if (rule.state === "enabled" && rule.nextFire !== null) {
    return automationDateWords(rule.nextFire, automationZoneOf(rule.spec));
  }
  return AUTOMATION_STATE_WORDS[rule.state];
}

/**
 * A rule's next run where room is short, on this computer's clock: the time
 * later today ("9:52 PM"), the weekday and time within the week ahead ("Sun
 * 7:00 AM"), the date beyond ("Oct 25"); its state when it has no next run.
 */
export function automationNextShort(
  rule: Pick<AutomationRule, "state" | "nextFire">,
  now: number = Date.now(),
): string {
  if (rule.state !== "enabled" || rule.nextFire === null) return AUTOMATION_STATE_WORDS[rule.state];
  const ahead = rule.nextFire - now;
  const at = new Date(rule.nextFire);
  if (at.toDateString() === new Date(now).toDateString()) {
    return formatTime(at, { hour: "numeric", minute: "2-digit" });
  }
  if (ahead < 6 * 24 * 60 * 60 * 1000) {
    return formatDateTime(at, { weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  return formatDate(at, { month: "short", day: "numeric" });
}

/** "1 automation", "3 automations". */
export function automationCount(count: number): string {
  return `${count} ${count === 1 ? "automation" : "automations"}`;
}
