import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  IntegrationActionSpec,
  IntegrationAnswer,
  IntegrationEventSpec,
  IntegrationLook,
} from "../../binding";
import { calendarScope } from "../../scopes";
import type { GoogleTool } from "./mcp";

/**
 * Calendar on the same Google row and sign-in as Gmail (INF-775 piece 6),
 * through Google Calendar's MCP server: the binding hands every call
 * through a `GoogleTool`, as Gmail's.
 */

const calendarId = z
  .string()
  .min(1)
  .refine((v) => v !== "." && v !== "..", "a calendar id, not a relative path");
const eventId = z.string().regex(/^[A-Za-z0-9_-]+$/, "an event id from list_events");
const instant = z.iso.datetime({ offset: true });
const moment = z.union([
  z.strictObject({ date: z.iso.date() }),
  z.strictObject({ dateTime: instant, timeZone: z.string().min(1).optional() }),
]);
const details = {
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  start: moment,
  end: moment,
  attendees: z.array(z.strictObject({ email: z.email() })).optional(),
};
const changes = z.strictObject(details);
function ordered(value: { start?: z.infer<typeof moment>; end?: z.infer<typeof moment> }) {
  if (!value.start || !value.end) return true;
  if ("date" in value.start !== "date" in value.end) return false;
  const start = "date" in value.start ? value.start.date : value.start.dateTime;
  const end = "date" in value.end ? value.end.date : value.end.dateTime;
  return Date.parse(end) > Date.parse(start);
}
const destination = { calendar: calendarId.optional() };
const notifications = z.enum(["none", "all", "externalOnly"]).optional();
export const CALENDAR_ACTIONS: readonly IntegrationActionSpec[] = [
  {
    name: "list_calendars",
    label: "List calendars",
    effect: "reads",
    description:
      "List the calendars this Google account can reach, with their ids, names, time zones and descriptions. page continues next_page.",
    input: z.strictObject({ page: z.string().min(1).optional() }),
  },
  {
    name: "list_events",
    label: "List calendar events",
    effect: "reads",
    description:
      "List events in calendar (an id from list_calendars; primary when omitted). from and to are RFC 3339 instants with offsets; query searches Google's event text. Recurring events expand into occurrences. max is up to Google's 2500; page continues next_page.",
    input: z
      .strictObject({
        ...destination,
        from: instant.optional(),
        to: instant.optional(),
        query: z.string().optional(),
        max: z.number().int().min(1).max(2500),
        page: z.string().min(1).optional(),
      })
      .refine((v) => !v.from || !v.to || Date.parse(v.to) > Date.parse(v.from), {
        message: "to must follow from",
      }),
  },
  {
    name: "read_event",
    label: "Read a calendar event",
    effect: "reads",
    description:
      "Read one event by its id and calendar (primary when omitted), including its times, attendees and recurrence.",
    input: z.strictObject({ ...destination, id: eventId }),
  },
  {
    name: "free_busy",
    label: "Read calendar availability",
    effect: "reads",
    description:
      "Suggest free times between from and to (RFC 3339 instants with offsets) when everyone in people is free: email addresses, up to 50, the captain's own when omitted. Each free time lasts at least minutes (30 when omitted). No events change and no invitation is sent. The answer lists up to five free times, each with its start and end.",
    input: z
      .strictObject({
        people: z.array(z.email()).min(1).max(50).optional(),
        from: instant,
        to: instant,
        minutes: z.number().int().min(5).max(1440).optional(),
      })
      .refine((v) => Date.parse(v.to) > Date.parse(v.from), { message: "to must follow from" }),
  },
  {
    name: "create_event",
    label: "Create a calendar event",
    effect: "changes",
    scope: calendarScope,
    description:
      "Create an event in calendar (primary when omitted). event has summary, start and end, optional description, location and attendees. Use date for all-day events (end is exclusive), or dateTime with an explicit offset and optional IANA timeZone. send_updates is none by default, all to notify guests, or externalOnly. Its approval state controls whether the host asks before writing or notifying anyone.",
    input: z.strictObject({
      ...destination,
      event: changes.refine(ordered, {
        message: "end must follow start, with matching date or dateTime fields",
      }),
      send_updates: notifications,
    }),
  },
  {
    name: "update_event",
    label: "Update a calendar event",
    effect: "changes",
    scope: calendarScope,
    description:
      "Patch an event by id and calendar (primary when omitted). changes contains only fields to replace; omitted fields stay unchanged, attendees replaces the full guest list. Supply start and end together. send_updates has the same meaning as create_event. Its approval state controls whether the host asks. Does not delete events.",
    input: z.strictObject({
      ...destination,
      id: eventId,
      changes: changes
        .partial()
        .refine(
          (v) => Object.keys(v).length > 0 && Boolean(v.start) === Boolean(v.end) && ordered(v),
          { message: "name a change; start and end must come together and end must follow start" },
        ),
      send_updates: notifications,
    }),
  },
];

export const CALENDAR_CHANGED_EVENT: IntegrationEventSpec = {
  name: "event_changed",
  label: "A calendar event changes",
  description:
    "An event is created or updated in the selected calendar (primary by default), for events from a day ago to a year ahead. A cancelled event does not fire. The summary carries its title and times, never its description.",
  // Each look reads every page of that year, since Calendar's MCP server lists no changes
  // alone: looking each five minutes keeps a calendar of 800 events there to 1,152
  // requests a day, inside Google's free 5,000 for Calendar.
  every: 5,
  filters: [{ name: "calendar", label: "Calendar", defaultValue: "primary" }],
};

type Moment = z.infer<typeof moment>;
type Details = {
  summary?: string;
  description?: string;
  location?: string;
  start?: Moment;
  end?: Moment;
  attendees?: { email: string }[];
};
const NOTIFICATIONS = { none: "NONE", all: "ALL", externalOnly: "EXTERNAL_ONLY" } as const;

/** A moment as Calendar's MCP server takes it: a date as an all-day midnight, a time as given. */
function timeOf(value: Moment): string {
  return "date" in value ? `${value.date}T00:00:00` : value.dateTime;
}

/** The times, all-day mark and time zone of a start and end given together. */
function timesOf(start: Moment, end: Moment): Record<string, unknown> {
  const zone =
    ("timeZone" in start ? start.timeZone : undefined) ??
    ("timeZone" in end ? end.timeZone : undefined);
  return {
    startTime: timeOf(start),
    endTime: timeOf(end),
    allDay: "date" in start,
    ...(zone ? { timeZone: zone } : {}),
  };
}

const answer = (value: unknown): IntegrationAnswer => ({ text: JSON.stringify(value) });
/** Google lists at most this many events a page. */
const EVENTS_A_PAGE = 250;
const momentOf = (value: unknown) => {
  const given = value as { dateTime?: string; date?: string } | undefined;
  return given?.dateTime ?? given?.date;
};

export async function runCalendarAction(
  calendar: GoogleTool,
  account: string,
  action: string,
  input: unknown,
): Promise<IntegrationAnswer> {
  const v = input as {
    calendar?: string;
    id: string;
    page?: string;
    max: number;
    query?: string;
    from: string;
    to: string;
    people?: string[];
    minutes?: number;
    event: Details;
    changes: Details;
    send_updates?: keyof typeof NOTIFICATIONS;
  };
  const where = v.calendar ? { calendarId: v.calendar } : {};
  const notify = { notificationLevel: NOTIFICATIONS[v.send_updates ?? "none"] };
  switch (action) {
    case "list_calendars": {
      const body = await calendar("list_calendars", v.page ? { pageToken: v.page } : {});
      return answer({
        calendars: body.calendars ?? [],
        ...(body.nextPageToken ? { next_page: body.nextPageToken } : {}),
      });
    }
    case "free_busy": {
      const body = await calendar("suggest_time", {
        attendeeEmails: v.people ?? [account],
        startTime: v.from,
        endTime: v.to,
        ...(v.minutes ? { durationMinutes: v.minutes } : {}),
      });
      const slots = (body.timeSlots as { start?: unknown; end?: unknown }[] | undefined) ?? [];
      return answer({
        free: slots.map((slot) => ({ start: momentOf(slot.start), end: momentOf(slot.end) })),
      });
    }
    case "list_events": {
      const events: unknown[] = [];
      let page = v.page;
      let first: Record<string, unknown> | undefined;
      do {
        const body = await calendar("list_events", {
          ...where,
          ...(v.from ? { startTime: v.from } : {}),
          ...(v.to ? { endTime: v.to } : {}),
          ...(v.query ? { fullText: v.query } : {}),
          orderBy: "startTime",
          pageSize: Math.min(v.max - events.length, EVENTS_A_PAGE),
          ...(page ? { pageToken: page } : {}),
        });
        first ??= body;
        events.push(...((body.events as unknown[] | undefined) ?? []));
        page = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
      } while (page && events.length < v.max);
      return answer({
        events,
        time_zone: first?.timeZone,
        ...(page ? { next_page: page } : {}),
      });
    }
    case "read_event":
      return answer(await calendar("get_event", { ...where, eventId: v.id }));
    case "create_event": {
      const { start, end, attendees, ...words } = v.event;
      return answer(
        await calendar(
          "create_event",
          {
            ...where,
            ...words,
            ...(start && end ? timesOf(start, end) : {}),
            ...(attendees ? { attendees: attendees.map(({ email }) => ({ email })) } : {}),
            ...notify,
          },
          true,
        ),
      );
    }
    case "update_event": {
      const { start, end, attendees, ...words } = v.changes;
      let guests: Record<string, unknown> = {};
      if (attendees) {
        // The new list replaces the old: Google takes it as who joins and who leaves.
        const current = await calendar("get_event", { ...where, eventId: v.id });
        const had = ((current.attendees as { email?: string }[] | undefined) ?? []).flatMap(
          (guest) => (guest.email ? [guest.email] : []),
        );
        const lower = (list: readonly string[]) =>
          new Set(list.map((email) => email.toLowerCase()));
        const before = lower(had);
        const after = lower(attendees.map((guest) => guest.email));
        const added = attendees.filter((guest) => !before.has(guest.email.toLowerCase()));
        const removed = had.filter((email) => !after.has(email.toLowerCase()));
        guests = {
          ...(added.length > 0 ? { addedAttendees: added.map(({ email }) => ({ email })) } : {}),
          ...(removed.length > 0 ? { removedAttendeeEmails: removed } : {}),
        };
      }
      return answer(
        await calendar(
          "update_event",
          {
            ...where,
            eventId: v.id,
            ...words,
            ...(start && end ? timesOf(start, end) : {}),
            ...guests,
            ...notify,
          },
          true,
        ),
      );
    }
    default:
      return { text: `Google Calendar has no action ${action}.`, refused: "invalid" };
  }
}

type Event = {
  id?: string;
  updated?: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};
/** A revision id, not just the event id: later edits of the same event must fire again. */
function item(calendar: string, event: Event) {
  const id = createHash("sha256")
    .update(JSON.stringify([calendar, event.id, event.updated ?? JSON.stringify(event)]))
    .digest("hex");
  const time = (value: Event["start"]) => value?.dateTime ?? value?.date ?? "unknown time";
  return {
    id,
    summary: `Changed: ${event.summary ?? "(untitled event)"} [${event.id}] in ${calendar}: ${time(event.start)} to ${time(event.end)}`,
  };
}

/**
 * Where a look for changed events stands: events changed after `since`
 * count, except the revisions `seen` names, which already fired, each with
 * when it changed.
 */
type CalendarCursor = {
  account: string;
  calendar: string;
  since: number;
  seen: [string, number][];
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** The events a look reads: from a day ago to a year ahead. */
const LOOK_BEHIND_MS = DAY_MS;
const LOOK_AHEAD_MS = 366 * DAY_MS;
/** How many pages of events one look reads at most. */
const CALENDAR_PAGES = 20;
const SEEN_KEPT = 200;

/** An instant as Google takes it, with its offset written out. */
function instantOf(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function calendarCursor(
  text: string,
  account: string,
  calendar: string,
): CalendarCursor | undefined {
  try {
    const saved = JSON.parse(text) as Partial<CalendarCursor>;
    if (
      saved.account !== account ||
      saved.calendar !== calendar ||
      typeof saved.since !== "number" ||
      !Number.isFinite(saved.since) ||
      !Array.isArray(saved.seen)
    )
      return undefined;
    return {
      account,
      calendar,
      since: saved.since,
      seen: saved.seen.filter(
        (entry): entry is [string, number] =>
          Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number",
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Look for changed events from a cursor (`IntegrationBinding.look`): the
 * selected calendar's events from a day ago to a year ahead, in the order
 * they last changed, and each one changed since the cursor. A cancelled
 * event does not fire, and an event outside those days is not read. The
 * cursor names the account and calendar, so either changing, or a cursor
 * from before the move to Calendar's MCP server, starts again from now.
 */
export async function lookForCalendar(
  request: GoogleTool,
  account: string,
  cursor: string | null,
  now: () => number,
  filter?: Record<string, string>,
): Promise<IntegrationLook> {
  const calendar = calendarId.parse(filter?.calendar || "primary");
  const saved = cursor === null ? undefined : calendarCursor(cursor, account, calendar);
  const at = now();
  const events: Event[] = [];
  let page: string | undefined;
  let pages = 0;
  do {
    const body = await request("list_events", {
      calendarId: calendar,
      startTime: instantOf(at - LOOK_BEHIND_MS),
      endTime: instantOf(at + LOOK_AHEAD_MS),
      orderBy: "lastModified",
      pageSize: EVENTS_A_PAGE,
      ...(page ? { pageToken: page } : {}),
    });
    events.push(...((body.events as Event[] | undefined) ?? []));
    page = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    pages += 1;
  } while (page && pages < CALENDAR_PAGES);
  const changed = events.flatMap((event) => {
    const when = Date.parse(event.updated ?? "");
    return event.id && !Number.isNaN(when) ? [{ event, when, item: item(calendar, event) }] : [];
  });
  if (!saved) {
    // A first look, or one that starts again: what is there now is where later changes count from.
    const since =
      changed.length > 0 ? Math.min(Math.max(...changed.map((entry) => entry.when)), at) : at;
    return {
      cursor: JSON.stringify({
        account,
        calendar,
        since,
        seen: changed
          .filter((entry) => entry.when >= since)
          .map((entry): [string, number] => [entry.item.id, entry.when])
          .slice(-SEEN_KEPT),
      } satisfies CalendarCursor),
      items: [],
      ...(cursor !== null ? { resynced: true } : {}),
    };
  }
  const seen = new Set(saved.seen.map(([id]) => id));
  const fresh = changed
    .filter((entry) => entry.when >= saved.since && !seen.has(entry.item.id))
    .sort((a, b) => a.when - b.when);
  const latest = Math.max(saved.since, ...fresh.map((entry) => entry.when));
  const since = Math.max(saved.since, Math.min(latest, at));
  const kept = [
    ...saved.seen,
    ...fresh.map((entry): [string, number] => [entry.item.id, entry.when]),
  ]
    .filter(([, when]) => when >= since)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEN_KEPT);
  return {
    cursor: JSON.stringify({ account, calendar, since, seen: kept } satisfies CalendarCursor),
    items: fresh.filter((entry) => entry.event.status !== "cancelled").map((entry) => entry.item),
    ...(page ? { resynced: true } : {}),
  };
}
