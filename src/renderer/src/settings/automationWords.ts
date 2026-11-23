import type {
  AutomationCancelReason,
  AutomationDelivery,
  AutomationRule,
  AutomationRun,
  AutomationSave,
  AutomationSpec,
} from "@shared/automation";
import { fillScheduleDetails } from "@shared/automation";
import {
  automationClockWords,
  automationDateWords,
  automationWhenWords,
  automationZoneOf,
  automationZoneWords,
} from "@shared/automationWords";
import * as m from "@shared/i18n/messages.generated";

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
  /** What an event rule waits for, in words; empty for every event (docs/automation.md, "The event screen"). */
  waitsFor: string;
  prompt: string;
  /** Empty for none. */
  projectId: string;
  /**
   * A stopped event rule (`AutomationRule.stopped`): saving it listens to
   * the integration picked in the sheet, the person's own choice.
   */
  reconnect: boolean;
};

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
    waitsFor: "",
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
    waitsFor: spec.kind === "event" ? (spec.waitsFor ?? "") : "",
    prompt: rule.prompt,
    projectId: rule.projectId ?? "",
    reconnect: rule.stopped !== undefined,
  };
}

/** The schedule the form describes, or why it does not describe one yet. */
export function specOf(form: RuleForm): AutomationSpec | string {
  if (form.kind === "event") {
    const at = form.event.lastIndexOf("/");
    if (at < 0) return m.settingsAutomationPickEvent();
    return {
      kind: "event",
      integration: form.event.slice(0, at),
      event: form.event.slice(at + 1),
      ...(Object.keys(form.filter).length ? { filter: form.filter } : {}),
      ...(form.waitsFor.trim() ? { waitsFor: form.waitsFor.trim() } : {}),
    };
  }
  if (form.kind === "every") {
    const minutes = Number.parseInt(form.minutes, 10);
    if (!Number.isFinite(minutes) || minutes < AUTOMATION_MIN_MINUTES) {
      return m.settingsAutomationRepeatsAtMost({ minutes: String(AUTOMATION_MIN_MINUTES) });
    }
    return { kind: "every", minutes };
  }
  if (form.kind === "daily" || form.kind === "weekly") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(form.time);
    if (!match) return m.settingsAutomationPickTime();
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (form.kind === "daily") {
      return { kind: "daily", hour, minute, ...(form.timeZone ? { timeZone: form.timeZone } : {}) };
    }
    if (form.days.length === 0) return m.settingsAutomationPickDays();
    return { kind: "weekly", days: form.days, hour, minute, timeZone: form.timeZone || hereZone() };
  }
  const at = new Date(form.at).getTime();
  if (!form.at || Number.isNaN(at)) return m.settingsAutomationPickDateTime();
  return { kind: "once", at };
}

/** The save the form describes; `enable` is the review's Turn on. */
export function saveOf(form: RuleForm, enable = false): AutomationSave | string {
  const spec = specOf(form);
  if (typeof spec === "string") return spec;
  if (!form.prompt.trim()) return m.settingsAutomationWritePrompt();
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
  const sent = automationDateWords(run.firedAt);
  const skipped = run.screened ?? 0;
  if (run.events !== undefined && run.events === 0 && skipped > 0)
    return m.automationRunSkipped({ count: skipped, date: sent });
  if (run.events !== undefined) {
    const events = m.settingsAutomationRunEvents({ count: run.events, sent });
    return skipped > 0
      ? `${events}, ${m.automationRunAlsoSkipped({ count: String(skipped) })}`
      : events;
  }
  const planned = automationDateWords(run.plannedAt);
  if (run.missed > 0)
    return m.settingsAutomationRunCatchingUpMissed({ count: run.missed, planned, sent });
  if (run.catchUp) return m.settingsAutomationRunCatchingUp({ planned, sent });
  return m.settingsAutomationRunPlanned({ planned, sent });
}

/** Where a delivery stands, in a word (docs/automation.md, "Deliveries"). */
export const DELIVERY_WORDS: Record<AutomationDelivery, string> = {
  get waiting() {
    return m.settingsAutomationDeliveryWaiting();
  },
  get retrying() {
    return m.settingsAutomationDeliveryRetrying();
  },
  get handled() {
    return m.settingsAutomationDeliveryHandled();
  },
  get cancelled() {
    return m.settingsAutomationDeliveryCancelled();
  },
  get sent() {
    return m.settingsAutomationDeliverySent();
  },
};

export const DELIVERY_TONES: Record<AutomationDelivery, "ok" | "busy" | "warn" | "idle" | "ring"> =
  {
    waiting: "busy",
    retrying: "warn",
    handled: "ok",
    cancelled: "idle",
    sent: "ring",
  };

/** A look whose every new event was kept from the first mate, so nothing was sent (docs/automation.md, "The event screen"). */
function sentNothing(run: AutomationRun): boolean {
  return run.events === 0 && Boolean(run.screened);
}

/** A run's state in words: a look that sent nothing reads as skipped, never as its delivery. */
export function runStateWords(run: AutomationRun): string {
  return sentNothing(run) ? m.automationRunSkippedState() : DELIVERY_WORDS[run.delivery];
}

/** What a run's kept prompt is called: the events it skipped when it sent nothing. */
export function runPromptTitle(run: AutomationRun): string {
  return sentNothing(run) ? m.automationEventsSkipped() : m.settingsAutomationPromptAsSent();
}

export function deliveryNote(run: AutomationRun): string | null {
  switch (run.delivery) {
    case "waiting":
      return m.settingsAutomationNoteWaiting();
    case "retrying":
      return m.settingsAutomationNoteRetrying();
    case "handled":
      return run.settledAt === null ? null : handledNote(run);
    case "cancelled":
      if (run.cancelReason) return CANCEL_WORDS[run.cancelReason];
      return run.screened ? m.automationScreenedNote() : m.settingsAutomationNoteCancelled();
    case "sent":
      return null;
  }
}

/** When a delivery was handled: the time on the day it was sent, the date otherwise. */
function handledNote(run: AutomationRun): string {
  const at = new Date(run.settledAt ?? run.firedAt);
  return at.toDateString() === new Date(run.firedAt).toDateString()
    ? m.settingsAutomationNoteHandledAt({
        time: automationClockWords(at.getHours(), at.getMinutes()),
      })
    : m.settingsAutomationNoteHandledOn({ date: automationDateWords(at.getTime()) });
}

/** Why a delivery was taken back before Firstmate read it. */
export const CANCEL_WORDS: Record<AutomationCancelReason, string> = {
  get edited() {
    return m.settingsAutomationCancelEdited();
  },
  get paused() {
    return m.settingsAutomationCancelPaused();
  },
  get cleared() {
    return m.settingsAutomationCancelCleared();
  },
};

/** An event rule's preview: what it does in place of its next dates. */
export function eventPreviewWords(when: string, every: number | undefined): string {
  return every === undefined
    ? m.settingsAutomationEventPreviewNoLook({ when })
    : m.settingsAutomationEventPreview({ when, count: every });
}

/** The review's Runs for an event rule: each time events arrive, and how often the app looks. */
export function eventRunsWords(every: number | undefined): string {
  return every === undefined
    ? m.settingsAutomationRunsEachTime()
    : m.settingsAutomationRunsEachTimeLooks({ count: every });
}

/** The review's word on a time Firstmate is not open for. */
export function reviewMissedWords(spec: AutomationSpec, where: string | null): string {
  if (spec.kind === "event")
    return where
      ? m.settingsAutomationMissedEventThere({ where })
      : m.settingsAutomationMissedEvent();
  if (spec.kind === "once")
    return where
      ? m.settingsAutomationMissedOnceThere({ where })
      : m.settingsAutomationMissedOnce();
  return where
    ? m.settingsAutomationMissedRepeatsThere({ where })
    : m.settingsAutomationMissedRepeats();
}

/** The weekday toggles, Monday first as a week reads. */
export function weekdayToggles() {
  return [
    { day: 1, label: m.settingsAutomationMon(), name: m.settingsAutomationMonday() },
    { day: 2, label: m.settingsAutomationTue(), name: m.settingsAutomationTuesday() },
    { day: 3, label: m.settingsAutomationWed(), name: m.settingsAutomationWednesday() },
    { day: 4, label: m.settingsAutomationThu(), name: m.settingsAutomationThursday() },
    { day: 5, label: m.settingsAutomationFri(), name: m.settingsAutomationFriday() },
    { day: 6, label: m.settingsAutomationSat(), name: m.settingsAutomationSaturday() },
    { day: 0, label: m.settingsAutomationSun(), name: m.settingsAutomationSunday() },
  ] as const;
}

/**
 * The time zone's note. `where` names the computer Firstmate lives on when
 * this one controls it, since the automation runs there.
 */
export function zoneNote(where: string | null): string {
  return where ? m.settingsAutomationZoneNoteThere({ where }) : m.settingsAutomationZoneNote();
}

/** A daily rule made before time zones, which follows the clock where Firstmate lives. */
export function localTimeNote(where: string | null): string {
  return where
    ? m.settingsAutomationLocalTimeNoteThere({ where })
    : m.settingsAutomationLocalTimeNote();
}

/** The Time zone list's entry for a rule that keeps none. */
export function localClockWords(where: string | null): string {
  return where ? m.settingsAutomationClockThere({ where }) : m.settingsAutomationClockHere();
}

/** The sheet's fixed notes, worded when they are shown. */
export const AUTOMATION_SHEET_WORDS = {
  /** The review before a rule is turned on: what it sends, and where. */
  get reviewSends() {
    return m.settingsAutomationReviewSends();
  },
  /** The review's word on what an event rule sends, in place of `reviewSends`. */
  get reviewSendsEvents() {
    return m.settingsAutomationReviewSendsEvents();
  },
  /** What the preview fills `{{events}}` with, before any event arrived. */
  get eventsPreview() {
    return m.settingsAutomationEventsPreview();
  },
  get submittedNote() {
    return m.settingsAutomationSubmittedNote();
  },
  get submittedNoteEvents() {
    return m.settingsAutomationSubmittedNoteEvents();
  },
  /** What a draft says at the top of its sheet. */
  get draftNote() {
    return m.settingsAutomationDraftNote();
  },
  /** A stopped event rule's When, at the top of its sheet. */
  get stoppedWhen() {
    return m.settingsAutomationStoppedWhen();
  },
  /** What saving a stopped event rule does, after why it stopped: it listens to what is picked. */
  get stoppedNote() {
    return m.settingsAutomationStoppedNote();
  },
  get detailNote() {
    return m.settingsAutomationDetailNote();
  },
} as const;

/** What an event rule listens for, as its integration declares it: its words, cadence and filters. */
export type ListenedEvent = {
  /** "When an item arrives in Stand-in". */
  when: string;
  /** How often, in minutes, the app looks for it. */
  every: number;
  filters?: { name: string; label: string; defaultValue?: string }[];
};

/**
 * The prompt as it is sent the first time, for the preview and the review:
 * its schedule details filled in for the first of `dates`, or for now on an
 * event rule. With no date left it stays as written.
 */
export function previewPrompt(
  spec: AutomationSpec,
  prompt: string,
  dates: readonly number[],
  now: number,
): string {
  const first = spec.kind === "event" ? now : dates[0];
  if (first === undefined) return prompt.trim();
  return fillScheduleDetails(prompt.trim(), {
    plannedAt: first,
    timeZone: automationZoneOf(spec) ?? hereZone(),
    missed: 0,
    ...(spec.kind === "event" ? { events: AUTOMATION_SHEET_WORDS.eventsPreview } : {}),
  });
}

/**
 * One line of the review: its term, and its value in words; `prompt` marks
 * the exact prompt, and `lines` holds a value that is a list, one entry
 * each, for a reader that draws them one a line.
 */
export type ReviewFact = { term: string; value: string; lines?: string[]; prompt?: true };

/** A rule's project in words: its name, or that it has none or lost it. */
export function ruleProjectWords(
  projectId: string | undefined,
  projects: readonly { id: string; name: string }[],
): string {
  if (!projectId) return m.settingsAutomationNoProject();
  return projects.find((one) => one.id === projectId)?.name ?? m.settingsAutomationRemovedProject();
}

/**
 * Enable's review as its facts, in order (docs/automation.md, "Drafts"):
 * the schedule, its zone, an event rule's filters, the project, the next
 * dates, the exact prompt, what it sends and what happens to a missed time.
 * `where` names the computer the first mate lives on when another one
 * shows the review. The computer's review and the phone's page of a rule
 * both draw these.
 */
export function reviewFacts(
  review: {
    spec: AutomationSpec;
    dates: readonly number[];
    prompt: string;
    projectId?: string | undefined;
    listened?: ListenedEvent | undefined;
  },
  projects: readonly { id: string; name: string }[],
  where: string | null,
): ReviewFact[] {
  const { spec, listened } = review;
  const zone = automationZoneOf(spec);
  const next = review.dates.map((at) => automationDateWords(at, zone));
  return [
    { term: m.settingsAutomationWhen(), value: automationWhenWords(spec, listened?.when) },
    ...(spec.kind === "daily" || spec.kind === "weekly"
      ? [
          {
            term: m.settingsAutomationTimeZone(),
            value: zone ? automationZoneWords(zone) : localClockWords(where),
          },
        ]
      : []),
    ...(spec.kind === "event"
      ? (listened?.filters ?? []).map((field) => ({
          term: field.label,
          value:
            spec.filter?.[field.name] || field.defaultValue || m.settingsAutomationNotSpecified(),
        }))
      : []),
    ...(spec.kind === "event" && spec.waitsFor
      ? [{ term: m.automationWaitsFor(), value: `${spec.waitsFor}. ${m.automationWaitsForNote()}` }]
      : []),
    { term: m.settingsAutomationProject(), value: ruleProjectWords(review.projectId, projects) },
    spec.kind === "event"
      ? { term: m.settingsAutomationRuns(), value: eventRunsWords(listened?.every) }
      : {
          term: spec.kind === "once" ? m.settingsAutomationRuns() : m.settingsAutomationNextRuns(),
          value: next.length === 0 ? m.settingsAutomationPassed() : next.join(" · "),
          ...(next.length > 1 ? { lines: next } : {}),
        },
    { term: m.settingsAutomationFirstMateGets(), value: review.prompt, prompt: true },
    {
      term: m.settingsAutomationWhatItSends(),
      value:
        spec.kind === "event"
          ? AUTOMATION_SHEET_WORDS.reviewSendsEvents
          : AUTOMATION_SHEET_WORDS.reviewSends,
    },
    { term: m.settingsAutomationMissedTime(), value: reviewMissedWords(spec, where) },
  ];
}

/** Whether the review's Turn on can run the rule: an event rule always, a schedule with a time still to come. */
export function reviewCanTurnOn(spec: AutomationSpec, dates: readonly number[]): boolean {
  return spec.kind === "event" || dates.length > 0;
}
