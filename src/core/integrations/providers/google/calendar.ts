import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  IntegrationActionSpec,
  IntegrationAnswer,
  IntegrationEventSpec,
  IntegrationLook,
} from "../../binding";

/** INF-775 piece 6: Calendar on the same Google row and sign-in as Gmail. */
export type CalendarRequest = (
  path: string,
  init?: { method?: "GET" | "POST" | "PATCH"; json?: unknown; read?: boolean },
) => Promise<{ status: number; body: Record<string, unknown> }>;

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
      "List the calendars this Google account can reach, with their ids, names, time zones and access roles. page continues next_page.",
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
      "Read busy intervals for calendars between from and to (RFC 3339 instants with offsets). No events change and no invitation is sent. Google allows up to 50 calendars per request; omitted calendars means primary. Per-calendar errors remain in the answer.",
    input: z
      .strictObject({
        calendars: z.array(calendarId).min(1).max(50).optional(),
        from: instant,
        to: instant,
      })
      .refine((v) => Date.parse(v.to) > Date.parse(v.from), { message: "to must follow from" }),
  },
  {
    name: "create_event",
    label: "Create a calendar event",
    effect: "changes",
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
    "An event is created, updated or cancelled in the selected calendar (primary by default). The summary carries its title and times, never its description. A lost sync token re-baselines without replaying old events.",
  every: 1,
  filters: [{ name: "calendar", label: "Calendar", defaultValue: "primary" }],
};

const encoded = encodeURIComponent;
const eventPath = (calendar = "primary") => `/calendars/${encoded(calendar)}/events`;
const answer = (value: unknown): IntegrationAnswer => ({ text: JSON.stringify(value) });

export async function runCalendarAction(
  request: CalendarRequest,
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
    calendars?: string[];
    event: unknown;
    changes: unknown;
    send_updates?: string;
  };
  if (action === "list_calendars") {
    const params = new URLSearchParams();
    if (v.page) params.set("pageToken", v.page);
    const { body } = await request(`/users/me/calendarList?${params}`);
    return answer({
      calendars: body.items ?? [],
      ...(body.nextPageToken ? { next_page: body.nextPageToken } : {}),
    });
  }
  if (action === "free_busy") {
    const { body } = await request("/freeBusy", {
      method: "POST",
      read: true,
      json: {
        timeMin: v.from,
        timeMax: v.to,
        items: (v.calendars ?? ["primary"]).map((id) => ({ id })),
      },
    });
    return answer(body);
  }
  const base = eventPath(v.calendar);
  if (action === "list_events") {
    const params = new URLSearchParams({
      maxResults: String(v.max),
      singleEvents: "true",
      orderBy: "startTime",
    });
    for (const [key, value] of [
      ["timeMin", v.from],
      ["timeMax", v.to],
      ["q", v.query],
      ["pageToken", v.page],
    ])
      if (value) params.set(key as string, value);
    const { body, status } = await request(`${base}?${params}`);
    if (status === 404) return { text: "No such calendar.", refused: "invalid" };
    return answer({
      events: body.items ?? [],
      time_zone: body.timeZone,
      ...(body.nextPageToken ? { next_page: body.nextPageToken } : {}),
    });
  }
  const path = action === "create_event" ? base : `${base}/${encoded(v.id)}`;
  const response =
    action === "read_event"
      ? await request(path)
      : await request(`${path}?sendUpdates=${v.send_updates ?? "none"}`, {
          method: action === "create_event" ? "POST" : "PATCH",
          json: action === "create_event" ? v.event : v.changes,
        });
  if (response.status === 404 || response.status === 410)
    return { text: "No such calendar event.", refused: "invalid" };
  return answer(response.body);
}

type Event = {
  id?: string;
  etag?: string;
  updated?: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};
/** A revision id, not just the event id: later edits of the same event must fire again. */
function item(calendar: string, event: Event) {
  const revision = event.etag ?? event.updated ?? JSON.stringify(event);
  const id = createHash("sha256")
    .update(JSON.stringify([calendar, event.id, revision]))
    .digest("hex");
  const time = (value: Event["start"]) => value?.dateTime ?? value?.date ?? "unknown time";
  return {
    id,
    summary: `${event.status === "cancelled" ? "Cancelled" : "Changed"}: ${event.summary ?? "(untitled event)"} [${event.id}] in ${calendar}${event.status === "cancelled" ? "" : `: ${time(event.start)} to ${time(event.end)}`}`,
  };
}

/** Sync uses no time range or query: Google forbids those with syncToken. */
export async function lookForCalendar(
  request: CalendarRequest,
  account: string,
  cursor: string | null,
  filter?: Record<string, string>,
): Promise<IntegrationLook> {
  const calendar = calendarId.parse(filter?.calendar || "primary");
  let token: string | undefined;
  let resynced = false;
  if (cursor !== null) {
    try {
      const saved = JSON.parse(cursor) as { account?: string; calendar?: string; token?: string };
      if (
        saved.account === account &&
        saved.calendar === calendar &&
        typeof saved.token === "string" &&
        saved.token
      )
        token = saved.token;
      else resynced = true;
    } catch {
      resynced = true;
    }
  }
  const read = async (from?: string) => {
    const items: Event[] = [];
    let page: string | undefined;
    let next: string | undefined;
    do {
      const params = new URLSearchParams({ showDeleted: "true", maxResults: "2500" });
      if (from) params.set("syncToken", from);
      if (page) params.set("pageToken", page);
      const response = await request(`${eventPath(calendar)}?${params}`);
      if (response.status === 410) return undefined;
      if (response.status === 404) throw new Error("The selected calendar was not found.");
      items.push(...((response.body.items ?? []) as Event[]));
      page =
        typeof response.body.nextPageToken === "string" ? response.body.nextPageToken : undefined;
      next =
        typeof response.body.nextSyncToken === "string" ? response.body.nextSyncToken : undefined;
    } while (page);
    if (!next)
      throw new Error("Google Calendar did not return a sync token; the cursor has not advanced.");
    return { items, next };
  };
  let result = await read(token);
  if (!result) {
    token = undefined;
    resynced = true;
    result = await read();
  }
  if (!result) throw new Error("Google Calendar could not resync.");
  return {
    cursor: JSON.stringify({ account, calendar, token: result.next }),
    items: token ? result.items.filter((e) => e.id).map((e) => item(calendar, e)) : [],
    ...(resynced ? { resynced: true } : {}),
  };
}
