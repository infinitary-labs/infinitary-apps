/**
 * Google's Gmail and Calendar MCP servers, as the Google stand-in serves
 * them (`googleStandIn.ts`): each tool the Google row calls, by Google's own
 * name, input fields and answer shapes, as `tools/list` on
 * gmailmcp.googleapis.com and calendarmcp.googleapis.com gave them (their
 * `inputSchema` and `outputSchema`), over the SDK's 2026-07-28 server.
 * Every answer carries `structuredContent`, as Google's do.
 *
 * Only what Google's lists and descriptions state is modelled: search lists
 * up to 50 conversations a page, each with up to five of its messages; a
 * message's addresses are plain, with display names beside them; Calendar
 * lists at most 250 events a page, from now to seven days ahead when no
 * time is given; a tool Google asks the person about first answers
 * `input_required` with Google's own `approval_choice` form, and
 * `DENY_ONCE`, a decline or a cancel answers `UserDeniedAction` as an
 * error. What `MINIMAL` holds is not documented: the stand-in gives every
 * field but the bodies.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  type CallToolResult,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export type GoogleMcpService = "gmail" | "calendar";

/** One message in the stand-in's mailbox, as its headers and parts say it. */
export type StandInMail = {
  id: string;
  threadId: string;
  labelIds: string[];
  /** The From header: Lena Ortiz <lena@ortiz-studio.com>. */
  from: string;
  to: string;
  cc?: string;
  subject: string;
  /** When Gmail received it, in milliseconds. */
  internalDate: number;
  text?: string;
  html?: string;
  attachment?: { name: string; type: string; bytes: Buffer };
};

/** What Gmail took for a draft or a send, as its MCP tool received it. */
export type Outgoing = {
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  replyToMessageId?: string;
  threadId: string;
};

export type CalendarEvent = {
  id: string;
  updated: string;
  status: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: { email: string; responseStatus?: string }[];
  [key: string]: unknown;
};

export const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
  { id: "Label_3", name: "Receipts", type: "user" },
  { id: "Label_7", name: "Travel", type: "user" },
];

/** Google's choices for a call it asks the person about, with the words Google gives each. */
export const APPROVAL_CHOICES = [
  ["ALLOW_ONCE", "Allow once"],
  ["ALLOW_AUDIENCE_ALWAYS", "Always allow sending to these recipients"],
  ["ALLOW_TOOL_ALWAYS", "Always allow this tool"],
  ["DENY_ONCE", "Deny"],
] as const;

const APPROVAL_SCHEMA = {
  type: "object" as const,
  properties: {
    approval_choice: {
      type: "string" as const,
      title: "Approval",
      enum: APPROVAL_CHOICES.map(([value]) => value),
      enumNames: APPROVAL_CHOICES.map(([, label]) => label),
    },
  },
  required: ["approval_choice"],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const THREADS_A_PAGE = 50;
const EVENTS_A_PAGE = 250;

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
const refused = (words: string): CallToolResult => ({
  content: [{ type: "text", text: words }],
  isError: true,
});

/** Name <address> and a bare address alike, from a header that may list several. */
export function addressesOf(header: string | undefined): { name?: string; email: string }[] {
  if (!header) return [];
  return header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).flatMap((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const angle = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
    if (!angle) return [{ email: trimmed }];
    const name = (angle[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
    return [{ ...(name ? { name } : {}), email: (angle[2] ?? "").trim() }];
  });
}

const rfc3339 = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A header's words, as RFC 2047 encodes them outside ASCII. */
function headerWords(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * The whole message as RFC 2822, base64url as Gmail's API gives `raw`:
 * multipart/mixed with its words in a multipart/alternative first ("0", its
 * text "0.0" and HTML "0.1") and its attachment second ("1"), Gmail's own
 * part numbers.
 */
export function rawOf(mail: StandInMail): string {
  const mixed = `mixed-${mail.id}`;
  const alternative = `alternative-${mail.id}`;
  const lines = [
    `Delivered-To: ${addressesOf(mail.to)[0]?.email ?? ""}`,
    "MIME-Version: 1.0",
    `Date: ${new Date(mail.internalDate).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <CAF${mail.id}@mail.gmail.com>`,
    `Subject: ${headerWords(mail.subject)}`,
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
    ...(mail.text !== undefined
      ? [
          `--${alternative}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          mail.text,
        ]
      : []),
    ...(mail.html !== undefined
      ? [
          `--${alternative}`,
          'Content-Type: text/html; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          mail.html,
        ]
      : []),
    `--${alternative}--`,
    ...(mail.attachment
      ? [
          `--${mixed}`,
          `Content-Type: ${mail.attachment.type}; name="${mail.attachment.name}"`,
          `Content-Disposition: attachment; filename="${mail.attachment.name}"`,
          "Content-Transfer-Encoding: base64",
          "",
          ...(mail.attachment.bytes.toString("base64").match(/.{1,76}/g) ?? [""]),
        ]
      : []),
    `--${mixed}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

type Format = "MINIMAL" | "PLAIN_TEXT" | "FULL_CONTENT" | "METADATA_ONLY" | "RAW";

/** One message in Gmail's MCP shape, by its format. */
function messageOf(mail: StandInMail, format: Format = "PLAIN_TEXT") {
  const ids = { id: mail.id, threadId: mail.threadId, labelIds: [...mail.labelIds] };
  if (format === "RAW") return { ...ids, raw: rawOf(mail) };
  const from = addressesOf(mail.from);
  const to = addressesOf(mail.to);
  const cc = addressesOf(mail.cc);
  const named = [...from, ...to, ...cc].filter((entry) => entry.name);
  const words = mail.text ?? "";
  return {
    ...ids,
    sender: from[0]?.email,
    toRecipients: to.map((entry) => entry.email),
    ...(cc.length ? { ccRecipients: cc.map((entry) => entry.email) } : {}),
    ...(named.length
      ? {
          addressDisplayNames: named.map((entry) => ({
            displayName: entry.name,
            emailAddress: entry.email,
          })),
        }
      : {}),
    subject: mail.subject,
    date: rfc3339(mail.internalDate),
    internalDate: String(mail.internalDate),
    snippet: words.replace(/\s+/g, " ").slice(0, 100),
    sizeEstimate: 4_096 + Buffer.byteLength(words || mail.html || ""),
    viewUrl: `https://mail.google.com/mail/u/0/#all/${mail.id}`,
    ...(format === "PLAIN_TEXT" || format === "FULL_CONTENT"
      ? { ...(mail.text !== undefined ? { plaintextBody: mail.text } : {}) }
      : {}),
    ...(format === "FULL_CONTENT" && mail.html !== undefined ? { htmlBody: mail.html } : {}),
    ...(format === "FULL_CONTENT" && mail.attachment
      ? {
          attachments: [
            {
              filename: mail.attachment.name,
              mimeType: mail.attachment.type,
              partId: "1",
              id: `ANGjdJ_${mail.id}`,
            },
          ],
        }
      : {}),
  };
}

/** Whether a message matches Gmail's search words, as far as the stand-in reads them. */
function matches(mail: StandInMail, query: string | undefined): boolean {
  for (const term of (query ?? "").toLowerCase().split(/\s+/).filter(Boolean)) {
    const [, field, value = ""] = /^([a-z]+):(.*)$/.exec(term) ?? [];
    if (field === "in" || field === "label") {
      const label = LABELS.find((entry) => entry.name.toLowerCase() === value);
      if (!mail.labelIds.includes(label?.id ?? value.toUpperCase())) return false;
    } else if (field === "is" && value === "unread") {
      if (!mail.labelIds.includes("UNREAD")) return false;
    } else if (field === "from") {
      if (!mail.from.toLowerCase().includes(value)) return false;
    } else if (field === "after" || field === "before") {
      const [year, month, day] = value.split("/").map(Number);
      const at = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
      if (field === "after" ? mail.internalDate < at : mail.internalDate >= at) return false;
    } else {
      const words = `${mail.from} ${mail.to} ${mail.subject} ${mail.text ?? ""}`.toLowerCase();
      if (!words.includes(term)) return false;
    }
  }
  return true;
}

/** What one service's MCP server reaches of the stand-in Google. */
export type GoogleMcpWorld = {
  mail: Map<string, StandInMail>;
  drafts: Outgoing[];
  sent: Outgoing[];
  calendars: Map<string, Map<string, CalendarEvent>>;
  change: (calendar: string, value: Partial<CalendarEvent>) => CalendarEvent;
  /** The permissions the request's key was granted. */
  granted: () => string[];
  /** The stand-in's clock, for Calendar's default window. */
  now: () => number;
  knobs: {
    /** Tools Google asks the person about before it runs them, by name. */
    confirm: Set<string>;
    /** Gmail's list offers no `send_message`, as for an account Google does not let send. */
    withoutSend: boolean;
    /** Google answers at most this many conversations or events a page, fewer than asked. */
    pageSize?: number;
    /**
     * Calendar lists a cancelled event with `status: "cancelled"`, as its
     * event schema allows; Google's REST listing does so for a cancelled
     * instance of a recurring event. Off, a cancelled event is not listed.
     */
    listsCancelled: boolean;
  };
  /** Each answer the person gave Google's question, by tool. */
  answers: { tool: string; choice: string; state: string | undefined }[];
  /** A tool changed something: a draft, a send, a label change or an event written. */
  took: () => void;
};

const plain = z.string().refine((value) => !/[<>\s]/.test(value), {
  message: "Each string MUST be a valid plain email address",
});
const outgoingInput = {
  to: z.array(plain).optional(),
  cc: z.array(plain).optional(),
  bcc: z.array(plain).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  replyToMessageId: z.string().optional(),
};

/**
 * Google's question before a tool it asks about runs: undefined once the
 * person allowed it, else the answer that stops the call - Google's form,
 * or its refusal after a no.
 */
function approval(
  world: GoogleMcpWorld,
  tool: string,
  context: { mcpReq: { inputResponses?: Record<string, unknown>; requestState: () => unknown } },
  message: string,
): CallToolResult | undefined {
  if (!world.knobs.confirm.has(tool)) return undefined;
  const response = inputResponse(context.mcpReq.inputResponses, "approval");
  if (response.kind === "missing")
    return inputRequired({
      inputRequests: {
        approval: inputRequired.elicit({ mode: "form", message, requestedSchema: APPROVAL_SCHEMA }),
      },
      requestState: `approval-${tool}-${randomBytes(6).toString("hex")}`,
    }) as unknown as CallToolResult;
  const state = context.mcpReq.requestState();
  const choice =
    response.kind === "elicit" && response.action === "accept"
      ? String(response.content?.approval_choice ?? "DENY_ONCE")
      : "DENY_ONCE";
  world.answers.push({ tool, choice, state: typeof state === "string" ? state : undefined });
  if (choice === "DENY_ONCE") return refused("UserDeniedAction: The user denied this action.");
  if (choice === "ALLOW_TOOL_ALWAYS") world.knobs.confirm.delete(tool);
  return undefined;
}

/** Gmail's MCP server, one per request, over the stand-in's mailbox. */
export function gmailMcpServer(world: GoogleMcpWorld): McpServer {
  const server = new McpServer({ name: "gmailmcp", version: "ESF" });
  const find = (id: string) => world.mail.get(id);
  const format = z
    .enum(["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY", "PLAIN_TEXT"])
    .optional();
  server.registerTool(
    "list_labels",
    { inputSchema: z.strictObject({}), annotations: { readOnlyHint: true } },
    async () =>
      text({
        labels: LABELS.map((label) => ({
          labelId: label.id,
          name: label.name,
          labelType: label.type === "system" ? "SYSTEM" : "USER",
        })),
      }),
  );
  server.registerTool(
    "search_threads",
    {
      inputSchema: z.strictObject({
        query: z.string().optional(),
        pageSize: z.number().int().min(1).max(THREADS_A_PAGE).optional(),
        pageToken: z.string().optional(),
        includeTrash: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, pageSize, pageToken }) => {
      const threads = new Map<string, StandInMail[]>();
      for (const mail of [...world.mail.values()].sort((a, b) => a.internalDate - b.internalDate))
        threads.set(mail.threadId, [...(threads.get(mail.threadId) ?? []), mail]);
      const found = [...threads.entries()]
        .filter(([, messages]) => messages.some((mail) => matches(mail, query)))
        .sort(
          ([, a], [, b]) =>
            Math.max(...b.map((mail) => mail.internalDate)) -
            Math.max(...a.map((mail) => mail.internalDate)),
        );
      const from = Number(pageToken ?? 0);
      const size = Math.min(pageSize ?? 20, world.knobs.pageSize ?? THREADS_A_PAGE);
      const page = found.slice(from, from + size);
      return text({
        ...(page.length
          ? {
              threads: page.map(([id, messages]) => ({
                id,
                messageCount: messages.length,
                messages: messages.slice(0, 5).map((mail) => messageOf(mail, "MINIMAL")),
              })),
            }
          : {}),
        ...(from + size < found.length ? { nextPageToken: String(from + size) } : {}),
        resultCountEstimate: String(found.length),
      });
    },
  );
  server.registerTool(
    "get_message",
    {
      inputSchema: z.strictObject({
        messageId: z.string(),
        messageFormat: z
          .enum([
            "MESSAGE_FORMAT_UNSPECIFIED",
            "MINIMAL",
            "FULL_CONTENT",
            "METADATA_ONLY",
            "PLAIN_TEXT",
            "RAW",
          ])
          .optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ messageId, messageFormat }) => {
      const mail = find(messageId);
      if (!mail) return refused("Requested entity was not found.");
      return text(messageOf(mail, (messageFormat ?? "PLAIN_TEXT") as Format));
    },
  );
  server.registerTool(
    "get_thread",
    {
      inputSchema: z.strictObject({ threadId: z.string(), messageFormat: format }),
      annotations: { readOnlyHint: true },
    },
    async ({ threadId, messageFormat }) => {
      const messages = [...world.mail.values()]
        .filter((mail) => mail.threadId === threadId)
        .sort((a, b) => a.internalDate - b.internalDate);
      if (messages.length === 0) return refused("Requested entity was not found.");
      return text({
        id: threadId,
        messageCount: messages.length,
        messages: messages.map((mail) =>
          messageOf(mail, (messageFormat ?? "PLAIN_TEXT") as Format),
        ),
      });
    },
  );
  server.registerTool(
    "update_message_labels",
    {
      inputSchema: z.strictObject({
        messageId: z.string(),
        addLabelIds: z.array(z.string()).optional(),
        removeLabelIds: z.array(z.string()).optional(),
      }),
    },
    async ({ messageId, addLabelIds, removeLabelIds }, context) => {
      const mail = find(messageId);
      if (!mail) return refused("Requested entity was not found.");
      for (const id of [...(addLabelIds ?? []), ...(removeLabelIds ?? [])])
        if (!LABELS.some((label) => label.id === id)) return refused(`Invalid label: ${id}`);
      const stop = approval(
        world,
        "update_message_labels",
        context,
        "Change this message's labels?",
      );
      if (stop) return stop;
      mail.labelIds = [
        ...mail.labelIds.filter((id) => !removeLabelIds?.includes(id)),
        ...(addLabelIds ?? []).filter((id) => !mail.labelIds.includes(id)),
      ];
      world.took();
      return text({ messageId, labelIds: mail.labelIds });
    },
  );
  const outgoing = (input: z.infer<z.ZodObject<typeof outgoingInput>>): Outgoing => {
    const original = input.replyToMessageId ? find(input.replyToMessageId) : undefined;
    return {
      to: input.to ?? [],
      ...(input.cc ? { cc: input.cc } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      body: input.body ?? "",
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      threadId: original?.threadId ?? randomBytes(8).toString("hex"),
    };
  };
  const recipients = (input: { to?: string[]; cc?: string[] }) =>
    [...(input.to ?? []), ...(input.cc ?? [])].join(", ");
  server.registerTool(
    "create_draft",
    { inputSchema: z.strictObject(outgoingInput) },
    async (input, context) => {
      if (input.replyToMessageId && !find(input.replyToMessageId))
        return refused("Requested entity was not found.");
      const stop = approval(
        world,
        "create_draft",
        context,
        `**Create a draft** to ${recipients(input)}?`,
      );
      if (stop) return stop;
      const draft = outgoing(input);
      world.drafts.push(draft);
      world.took();
      const messageId = randomBytes(8).toString("hex");
      return text({
        id: `r-${randomBytes(9).readBigUInt64BE()}`,
        messageId,
        threadId: draft.threadId,
        labelIds: ["DRAFT"],
        toRecipients: draft.to,
        ...(draft.subject !== undefined ? { subject: draft.subject } : {}),
        viewUrl: `https://mail.google.com/mail/u/0/#drafts/${messageId}`,
      });
    },
  );
  if (!world.knobs.withoutSend)
    server.registerTool(
      "send_message",
      {
        inputSchema: z.strictObject({
          ...outgoingInput,
          draftId: z.string().optional(),
          replyThreadId: z.string().optional(),
        }),
      },
      async (input, context) => {
        if (input.replyToMessageId && !find(input.replyToMessageId))
          return refused("Requested entity was not found.");
        if (!input.to?.length) return refused("At least one recipient in `to` is required.");
        const stop = approval(
          world,
          "send_message",
          context,
          `**Send an email** to ${recipients(input)}?\n\nSubject: ${input.subject ?? ""}`,
        );
        if (stop) return stop;
        const message = outgoing(input);
        world.sent.push(message);
        world.took();
        const id = randomBytes(8).toString("hex");
        return text({
          id,
          threadId: message.threadId,
          viewUrl: `https://mail.google.com/mail/u/0/#sent/${id}`,
        });
      },
    );
  return server;
}

/**
 * The permissions Google's Calendar reference names for the reads that
 * `calendar.events` does not cover; a key granted none of them is refused.
 */
const ACCEPTED: Record<string, string[]> = {
  list_calendars: [
    "calendar.readonly",
    "calendar",
    "calendar.calendarlist",
    "calendar.calendarlist.readonly",
  ],
  suggest_time: ["calendar.readonly", "calendar", "calendar.events.freebusy", "calendar.freebusy"],
};

/** An instant Calendar takes: with its offset, or local with none, read here as UTC. */
function instant(value: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
}

function startOf(event: CalendarEvent): number {
  const at = event.start?.dateTime ?? event.start?.date;
  return at ? instant(at) : Number.NaN;
}

function endOf(event: CalendarEvent): number {
  const at = event.end?.dateTime ?? event.end?.date;
  return at ? instant(at) : startOf(event);
}

/** A moment as Calendar's MCP server takes it, in Calendar's own shape. */
function momentOf(value: string, allDay: boolean, zone: string | undefined) {
  if (allDay) return { date: value.slice(0, 10) };
  return { dateTime: value, ...(zone ? { timeZone: zone } : {}) };
}

/** Calendar's MCP server, one per request, over the stand-in's calendars. */
export function calendarMcpServer(world: GoogleMcpWorld): McpServer {
  const server = new McpServer({ name: "calendarmcp", version: "ESF" });
  const scoped = (tool: string): CallToolResult | undefined => {
    const accepted = ACCEPTED[tool];
    if (!accepted) return undefined;
    const granted = world.granted();
    return accepted.some((scope) => granted.includes(`https://www.googleapis.com/auth/${scope}`))
      ? undefined
      : refused("Request had insufficient authentication scopes.");
  };
  const events = (id: string | undefined) => world.calendars.get(id ?? "primary");
  server.registerTool(
    "list_calendars",
    {
      inputSchema: z.strictObject({
        pageSize: z.number().int().optional(),
        pageToken: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async () =>
      scoped("list_calendars") ??
      text({
        calendars: [...world.calendars.keys()].map((id) => ({
          id,
          summary: id === "primary" ? "Ada Park" : "Ortiz Studio",
          timeZone: "America/Los_Angeles",
          accessRole: "owner",
          primary: id === "primary",
        })),
      }),
  );
  server.registerTool(
    "list_events",
    {
      inputSchema: z.strictObject({
        calendarId: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        fullText: z.string().optional(),
        orderBy: z.enum(["default", "startTime", "startTimeDesc", "lastModified"]).optional(),
        pageSize: z.number().int().min(1).max(EVENTS_A_PAGE).optional(),
        pageToken: z.string().optional(),
        timeZone: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ calendarId, startTime, endTime, fullText, orderBy, pageSize, pageToken }) => {
      const held = events(calendarId);
      if (!held) return refused("Requested entity was not found.");
      const from = startTime ? instant(startTime) : world.now();
      const to = endTime ? instant(endTime) : from + 7 * DAY_MS;
      const words = (fullText ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const listed = [...held.values()]
        .filter((event) => world.knobs.listsCancelled || event.status !== "cancelled")
        .filter((event) => endOf(event) > from && startOf(event) < to)
        .filter((event) => {
          const said =
            `${event.summary ?? ""} ${event.description ?? ""} ${event.location ?? ""}`.toLowerCase();
          return words.every((word) => said.includes(word));
        })
        .sort((a, b) =>
          orderBy === "lastModified"
            ? Date.parse(a.updated) - Date.parse(b.updated)
            : orderBy === "startTimeDesc"
              ? startOf(b) - startOf(a)
              : startOf(a) - startOf(b),
        );
      const offset = Number(pageToken ?? 0);
      const size = Math.min(pageSize ?? 100, world.knobs.pageSize ?? EVENTS_A_PAGE);
      return text({
        summary: calendarId ?? "primary",
        timeZone: "America/Los_Angeles",
        events: listed.slice(offset, offset + size),
        ...(offset + size < listed.length ? { nextPageToken: String(offset + size) } : {}),
      });
    },
  );
  server.registerTool(
    "get_event",
    {
      inputSchema: z.strictObject({ calendarId: z.string().optional(), eventId: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ calendarId, eventId }) => {
      const event = events(calendarId)?.get(eventId);
      return event ? text(event) : refused("Requested entity was not found.");
    },
  );
  server.registerTool(
    "suggest_time",
    {
      inputSchema: z.strictObject({
        attendeeEmails: z.array(z.string()),
        startTime: z.string(),
        endTime: z.string(),
        durationMinutes: z.number().int().optional(),
        timeZone: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ startTime, endTime, durationMinutes }) => {
      const stop = scoped("suggest_time");
      if (stop) return stop;
      const length = (durationMinutes ?? 30) * 60_000;
      const busy = [...world.calendars.values()]
        .flatMap((held) => [...held.values()])
        .filter((event) => event.status !== "cancelled" && event.start?.dateTime)
        .map((event) => [startOf(event), endOf(event)] as const)
        .sort((a, b) => a[0] - b[0]);
      const slots: { start: { dateTime: string }; end: { dateTime: string } }[] = [];
      let at = instant(startTime);
      const until = instant(endTime);
      for (const [start, end] of [...busy, [until, until] as const]) {
        if (slots.length === 5 || at >= until) break;
        const free = Math.min(start, until);
        if (free - at >= length)
          slots.push({
            start: { dateTime: new Date(at).toISOString() },
            end: { dateTime: new Date(free).toISOString() },
          });
        at = Math.max(at, end);
      }
      return text({ timeSlots: slots });
    },
  );
  const writable = {
    calendarId: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    allDay: z.boolean().optional(),
    timeZone: z.string().optional(),
    notificationLevel: z.enum(["NOTIFICATION_LEVEL_UNSPECIFIED", "NONE", "EXTERNAL_ONLY", "ALL"]),
  };
  const timesOf = (input: {
    startTime?: string;
    endTime?: string;
    allDay?: boolean;
    timeZone?: string;
  }) =>
    input.startTime && input.endTime
      ? {
          start: momentOf(input.startTime, input.allDay === true, input.timeZone),
          end: momentOf(input.endTime, input.allDay === true, input.timeZone),
        }
      : {};
  server.registerTool(
    "create_event",
    {
      inputSchema: z.strictObject({
        ...writable,
        summary: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        attendees: z.array(z.strictObject({ email: plain })).optional(),
      }),
    },
    async (input, context) => {
      if (!events(input.calendarId)) return refused("Requested entity was not found.");
      const stop = approval(
        world,
        "create_event",
        context,
        `**Create an event** “${input.summary}”?`,
      );
      if (stop) return stop;
      const { calendarId, startTime, endTime, allDay, timeZone, notificationLevel, ...words } =
        input;
      const event = world.change(calendarId ?? "primary", {
        ...words,
        ...timesOf({ startTime, endTime, allDay, timeZone }),
      });
      world.took();
      return text(event);
    },
  );
  server.registerTool(
    "update_event",
    {
      inputSchema: z.strictObject({
        ...writable,
        eventId: z.string(),
        addedAttendees: z.array(z.strictObject({ email: plain })).optional(),
        removedAttendeeEmails: z.array(plain).optional(),
      }),
    },
    async (input, context) => {
      const held = events(input.calendarId);
      const current = held?.get(input.eventId);
      if (!current) return refused("Requested entity was not found.");
      const stop = approval(
        world,
        "update_event",
        context,
        `**Update the event** “${current.summary}”?`,
      );
      if (stop) return stop;
      const {
        calendarId,
        eventId,
        startTime,
        endTime,
        allDay,
        timeZone,
        notificationLevel,
        addedAttendees,
        removedAttendeeEmails,
        ...words
      } = input;
      const removed = new Set((removedAttendeeEmails ?? []).map((email) => email.toLowerCase()));
      const attendees =
        addedAttendees || removedAttendeeEmails
          ? [
              ...(current.attendees ?? []).filter(
                (guest) => !removed.has(guest.email.toLowerCase()),
              ),
              ...(addedAttendees ?? []),
            ]
          : undefined;
      const event = world.change(calendarId ?? "primary", {
        ...words,
        ...timesOf({ startTime, endTime, allDay, timeZone }),
        ...(attendees ? { attendees } : {}),
        id: eventId,
      });
      world.took();
      return text(event);
    },
  );
  return server;
}

/** A new message id or event id, as Google writes them. */
export const newId = () => randomUUID().replaceAll("-", "").slice(0, 16);
