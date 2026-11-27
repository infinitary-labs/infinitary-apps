import { randomUUID } from "node:crypto";
import type { CalendarEvent } from "./googleMcpStandIn";

/**
 * INF-786: the stand-in Google's calendars, which its Calendar MCP server
 * (`googleMcpStandIn.ts`) reads and writes. All data stays in the isolated
 * Google stand-in, never a real account.
 */
export type { CalendarEvent } from "./googleMcpStandIn";
export const STUDIO_CALENDAR = "ortiz-studio@group.calendar.google.com";
export const SHOOT_EVENT = {
  summary: "October shoot planning",
  description: "Confirm the shot list with Lena.",
  start: { dateTime: "2026-10-26T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-26T11:00:00-07:00", timeZone: "America/Los_Angeles" },
  attendees: [{ email: "lena@ortiz-studio.com" }],
};

/**
 * SHOOT_EVENT an hour long from `at`, for a run on the real clock: Calendar
 * changes are read for events from a day back to a year ahead of the app's
 * clock, which a fixed date leaves behind.
 */
export function shootEventAt(at: number) {
  const time = (ms: number) => ({
    dateTime: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    timeZone: "UTC",
  });
  return { ...SHOOT_EVENT, start: time(at), end: time(at + 60 * 60 * 1000) };
}

/**
 * `now` is the stand-in's clock: each change is `updated` at it, a second
 * after the change before at least, so changes keep their order.
 */
export function calendarStandIn(now: () => number = Date.now) {
  const calendars = new Map<string, Map<string, CalendarEvent>>([
    ["primary", new Map()],
    [STUDIO_CALENDAR, new Map()],
  ]);
  let last = 0;
  const change = (calendar: string, value: Partial<CalendarEvent>): CalendarEvent => {
    const events = calendars.get(calendar);
    if (!events) throw new Error("No such stand-in calendar");
    const id = value.id ?? randomUUID().replaceAll("-", "");
    last = Math.max(now(), last + 1000);
    const event = {
      ...events.get(id),
      ...value,
      id,
      status: value.status ?? "confirmed",
      updated: new Date(last).toISOString(),
    };
    events.set(id, event);
    return event;
  };
  return { calendars, change };
}
