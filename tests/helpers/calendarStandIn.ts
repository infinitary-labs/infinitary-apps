import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

/** INF-786: Calendar v3's documented Event, CalendarList and sync answers.
 * All data stays in the isolated Google stand-in, never a real account.
 * Shape source: developers.google.com/workspace/calendar/api/v3/reference.
 */
export type CalendarEvent = {
  id: string;
  etag: string;
  updated: string;
  status: string;
  summary?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  [key: string]: unknown;
};
export const STUDIO_CALENDAR = "ortiz-studio@group.calendar.google.com";
export const SHOOT_EVENT = {
  summary: "October shoot planning",
  description: "Confirm the shot list with Lena.",
  start: { dateTime: "2026-10-26T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-26T11:00:00-07:00", timeZone: "America/Los_Angeles" },
  attendees: [{ email: "lena@ortiz-studio.com" }],
};
/**
 * The permissions Google accepts for each method that `calendar.events`
 * does not cover, from the method's Authorization section in the reference
 * above (read 2026-10-22); a key granted none of them answers 403.
 */
const ACCEPTED: Record<string, string[]> = {
  "/users/me/calendarList": [
    "calendar.readonly",
    "calendar",
    "calendar.calendarlist",
    "calendar.calendarlist.readonly",
  ],
  "/freeBusy": ["calendar.readonly", "calendar", "calendar.events.freebusy", "calendar.freebusy"],
};
const INSUFFICIENT = {
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    errors: [
      { message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" },
    ],
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        domain: "googleapis.com",
        metadata: { service: "calendar-json.googleapis.com", method: "calendar.v3" },
      },
    ],
  },
};
export function calendarStandIn() {
  const calendars = new Map<string, Map<string, CalendarEvent>>([
    ["primary", new Map()],
    [STUDIO_CALENDAR, new Map()],
  ]);
  const history: { calendar: string; event: CalendarEvent; revision: number }[] = [];
  let revision = 0;
  let keptFrom = 0;
  const knobs = { pageSize: 2500, afterTaking: [] as ("drop" | 500)[], limited: [] as string[] };
  const change = (calendar: string, value: Partial<CalendarEvent>): CalendarEvent => {
    const events = calendars.get(calendar);
    if (!events) throw new Error("No such stand-in calendar");
    const id = value.id ?? randomUUID().replaceAll("-", "");
    revision += 1;
    const event = {
      ...events.get(id),
      ...value,
      id,
      status: value.status ?? "confirmed",
      etag: `"${revision}"`,
      updated: new Date(Date.UTC(2026, 9, 22, 16, 0, revision)).toISOString(),
    };
    events.set(id, event);
    history.push({ calendar, event, revision });
    return event;
  };
  const json = (res: ServerResponse, code: number, value: unknown, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(value));
  };
  const error = (res: ServerResponse, code: number, reason: string) =>
    json(res, code, { error: { code, message: reason, errors: [{ domain: "calendar", reason }] } });
  return {
    knobs,
    change,
    forget: () => {
      revision += 1;
      keptFrom = revision;
    },
    /** `granted`: the permissions the request's key carries. */
    handle(res: ServerResponse, url: URL, method: string, body: string, granted: string[] = []) {
      const limited = knobs.limited.shift();
      if (limited !== undefined)
        return json(
          res,
          429,
          { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } },
          { "retry-after": limited },
        );
      const path = url.pathname.slice("/calendar/v3".length);
      const accepted = ACCEPTED[path];
      if (
        accepted &&
        !accepted.some((scope) => granted.includes(`https://www.googleapis.com/auth/${scope}`))
      )
        return json(res, 403, INSUFFICIENT);
      if (path === "/users/me/calendarList")
        return json(res, 200, {
          kind: "calendar#calendarList",
          items: [...calendars.keys()].map((id) => ({
            kind: "calendar#calendarListEntry",
            id,
            summary: id === "primary" ? "Ada Park" : "Ortiz Studio",
            timeZone: "America/Los_Angeles",
            accessRole: "owner",
            primary: id === "primary",
          })),
        });
      if (path === "/freeBusy") {
        const input = JSON.parse(body) as {
          timeMin: string;
          timeMax: string;
          items: { id: string }[];
        };
        return json(res, 200, {
          kind: "calendar#freeBusy",
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          calendars: Object.fromEntries(
            input.items.map(({ id }) => [
              id,
              calendars.has(id)
                ? {
                    busy: [...(calendars.get(id)?.values() ?? [])]
                      .filter((e) => e.status !== "cancelled" && e.start?.dateTime)
                      .map((e) => ({ start: e.start?.dateTime, end: e.end?.dateTime })),
                  }
                : { errors: [{ domain: "global", reason: "notFound" }] },
            ]),
          ),
        });
      }
      const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
      if (!match) return error(res, 404, "notFound");
      const calendar = decodeURIComponent(match[1] ?? "");
      const id = match[2] ? decodeURIComponent(match[2]) : undefined;
      const events = calendars.get(calendar);
      if (!events) return error(res, 404, "notFound");
      if (method === "GET" && id)
        return events.has(id) ? json(res, 200, events.get(id)) : error(res, 404, "notFound");
      if (method === "GET") {
        const sync = url.searchParams.get("syncToken");
        const from = sync ? Number(sync.replace("sync-", "")) : undefined;
        if (from !== undefined && (from < keptFrom || !Number.isFinite(from)))
          return error(res, 410, "fullSyncRequired");
        const items =
          from === undefined
            ? [...events.values()]
            : history
                .filter((h) => h.calendar === calendar && h.revision > from)
                .map((h) => h.event);
        const offset = Number(url.searchParams.get("pageToken") ?? 0);
        const size = Math.min(knobs.pageSize, Number(url.searchParams.get("maxResults") ?? 2500));
        return json(res, 200, {
          kind: "calendar#events",
          timeZone: "America/Los_Angeles",
          items: items.slice(offset, offset + size),
          ...(offset + size < items.length
            ? { nextPageToken: String(offset + size) }
            : { nextSyncToken: `sync-${revision}` }),
        });
      }
      if (method === "PATCH" && (!id || !events.has(id))) return error(res, 404, "notFound");
      if (method === "POST" || method === "PATCH") {
        const event = change(calendar, { ...JSON.parse(body), ...(id ? { id } : {}) });
        const after = knobs.afterTaking.shift();
        if (after === "drop") return res.destroy();
        if (after === 500) return error(res, 500, "backendError");
        return json(res, 200, event);
      }
      return error(res, 405, "methodNotAllowed");
    },
  };
}
