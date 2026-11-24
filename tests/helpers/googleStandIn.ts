/**
 * A stand-in Google for the Google integration's tests (INF-784): Google's
 * sign-in for an installed app (the consent page, the token endpoint with
 * PKCE, renewal and revocation) and the parts of Gmail's API the Google row
 * uses, on this computer, answering in the shapes Google documents for each
 * call (developers.google.com/gmail/api/reference/rest, and the OAuth 2.0
 * guide for installed apps): numeric history ids as strings, message ids as
 * hex, `payload` parts with base64url bodies, and Google's error shape
 * `{ error: { code, message, errors: [{ reason }], status } }`.
 *
 * The test drives the person's side: `consent` decides what they grant on
 * the consent page, `deliver` puts a message in their inbox, and the knobs
 * below reproduce what Google does on its own - an access key that lapses,
 * a sign-in revoked elsewhere, a history id Gmail no longer keeps, and a
 * request answered 429 with Retry-After.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { calendarStandIn } from "./calendarStandIn";

export const STAND_IN_CLIENT_ID = "1084716423951-k2v7o3lq.apps.googleusercontent.com";
export const STAND_IN_CLIENT_SECRET = "GOCSPX-stand-in-desktop-secret";
/** A person's own Desktop app client, made in their own Google Cloud project. */
export const OWN_CLIENT_ID = "582093176224-p8d0vq3hr5k1n6e2.apps.googleusercontent.com";
export const OWN_CLIENT_SECRET = "GOCSPX-own-desktop-secret-7Qd2";

export const STAND_IN_ACCOUNT = "ada.park@gmail.com";

type Header = { name: string; value: string };
type Part = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Header[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: Part[];
};
type Message = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  sizeEstimate: number;
  payload: Part;
};

export type Arriving = {
  from: string;
  subject: string;
  /** Absent, the message is HTML alone, as many newsletters are. */
  text?: string;
  html?: string;
  /**
   * Its one attachment: `bytes` are its content (zeros of `size` without
   * them), and `inline` carries them in the message itself, as Gmail does
   * for a small part, rather than behind its attachments address.
   */
  attachment?: { name: string; type: string; size: number; bytes?: Buffer; inline?: boolean };
  /** Labels besides INBOX and UNREAD. */
  labels?: string[];
};

/** What Gmail received for a draft or a send, decoded. */
export type Outgoing = { raw: string; text: string; threadId?: string };

const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
  { id: "Label_3", name: "Receipts", type: "user" },
  { id: "Label_7", name: "Travel", type: "user" },
];

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];

function googleError(code: number, message: string, reason: string, status: string) {
  return { error: { code, message, errors: [{ message, domain: "global", reason }], status } };
}

const UNAUTHENTICATED = googleError(
  401,
  "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
  "authError",
  "UNAUTHENTICATED",
);
const NOT_FOUND = googleError(404, "Requested entity was not found.", "notFound", "NOT_FOUND");

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const hexId = () => randomBytes(8).toString("hex").replace(/^0/, "1");

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=UTF-8", ...headers });
  response.end(JSON.stringify(body));
}

export async function startGoogleStandIn() {
  const seen: { method: string; path: string; authorization?: string; body: string }[] = [];
  /** Every token request, with its form. */
  const tokens: Record<string, string>[] = [];
  const revoked: string[] = [];
  const drafts: Outgoing[] = [];
  const sent: Outgoing[] = [];
  const messages = new Map<string, Message>();
  /** Each separately fetched attachment's content, by Gmail's id for it. */
  const attachments = new Map<string, Buffer>();
  /** Each change to the mailbox: the history id, and the message added to the inbox. */
  const history: { id: number; message: Message }[] = [];
  let historyId = 4_812_331;
  /** Gmail keeps history from this id on; an older start answers 404. */
  let keptFrom = historyId;
  const codes = new Map<
    string,
    { challenge: string; redirect: string; scopes: string[]; client: string }
  >();
  const live = new Map<string, string>(); // access key -> refresh key
  const grants = new Map<string, string[]>(); // refresh key -> scopes
  const grantedTo = new Map<string, string>(); // refresh key -> the client it was issued to
  const knobs = {
    /** What the person does on the consent page. */
    consent: { grant: [...SCOPES], deny: false },
    /** The next Gmail requests answered 429, with this Retry-After. */
    limited: [] as string[],
    /**
     * What Gmail does after it takes each of the next drafts or sends: the
     * connection drops before it answers, or it answers 500.
     */
    afterTaking: [] as ("drop" | 500)[],
    /** The Gmail address the person signs in as on the consent page. */
    account: STAND_IN_ACCOUNT,
    /** The clients Google knows, by id, with their secrets: Infinitary's and the person's own. */
    clients: new Map([
      [STAND_IN_CLIENT_ID, STAND_IN_CLIENT_SECRET],
      [OWN_CLIENT_ID, OWN_CLIENT_SECRET],
    ]),
    /** Clients their owner deleted in Google Cloud: Google answers `deleted_client`. */
    deleted: new Set<string>(),
    /**
     * Seconds a new sign-in's lasting key lasts, as Google says for a client
     * in Testing (`refresh_token_expires_in`); undefined, it names none.
     */
    lasts: 604_799 as number | undefined,
    /** Runs as each code exchange arrives, before Google answers it: what the person does meanwhile. */
    onExchange: undefined as (() => void) | undefined,
  };

  const issue = (refresh: string) => {
    const access = `ya29.a0AfB_${randomBytes(24).toString("base64url")}`;
    live.set(access, refresh);
    return access;
  };

  const metadataOf = (message: Message, names: string[]) => ({
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    snippet: message.snippet,
    historyId: message.historyId,
    internalDate: message.internalDate,
    sizeEstimate: message.sizeEstimate,
    payload: {
      partId: "",
      mimeType: message.payload.mimeType,
      filename: "",
      headers: message.payload.headers.filter((entry) =>
        names.some((name) => name.toLowerCase() === entry.name.toLowerCase()),
      ),
      body: { size: 0 },
    },
  });

  const gmail = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: string,
  ) => {
    const path = url.pathname.slice("/gmail/v1/users/me".length);
    seen.push({
      method: request.method ?? "",
      path: `${path}${url.search}`,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body,
    });
    const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!live.has(bearer)) return json(response, 401, UNAUTHENTICATED);
    const wait = knobs.limited.shift();
    if (wait !== undefined)
      return json(
        response,
        429,
        googleError(
          429,
          "Too many concurrent requests for user.",
          "rateLimitExceeded",
          "RESOURCE_EXHAUSTED",
        ),
        { "retry-after": wait },
      );
    const method = request.method ?? "GET";
    if (method === "GET" && path === "/profile")
      return json(response, 200, {
        emailAddress: knobs.account,
        messagesTotal: messages.size,
        threadsTotal: messages.size,
        historyId: String(historyId),
      });
    if (method === "GET" && path === "/labels") return json(response, 200, { labels: LABELS });
    if (method === "GET" && path === "/messages") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      const matching = [...messages.values()].reverse().filter((message) => {
        if (!q) return true;
        const words = message.payload.headers.map((entry) => entry.value).join(" ");
        return q
          .split(/\s+/)
          .every((term) =>
            `${words} ${message.snippet}`.toLowerCase().includes(term.replace(/^from:/, "")),
          );
      });
      const page = matching.slice(from, from + max);
      return json(response, 200, {
        ...(page.length ? { messages: page.map(({ id, threadId }) => ({ id, threadId })) } : {}),
        ...(from + max < matching.length ? { nextPageToken: String(from + max) } : {}),
        resultSizeEstimate: matching.length,
      });
    }
    const attached = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (method === "GET" && attached?.[1] && attached[2]) {
      const content = messages.has(attached[1]) ? attachments.get(attached[2]) : undefined;
      if (!content) return json(response, 404, NOT_FOUND);
      // users.messages.attachments.get answers a MessagePartBody.
      return json(response, 200, {
        attachmentId: attached[2],
        size: content.length,
        data: content.toString("base64url"),
      });
    }
    const one = /^\/messages\/([^/]+)(\/modify)?$/.exec(path);
    if (one?.[1] && one[1] !== "send") {
      const message = messages.get(one[1]);
      if (!message) return json(response, 404, NOT_FOUND);
      if (method === "GET") {
        const format = url.searchParams.get("format") ?? "full";
        return json(
          response,
          200,
          format === "metadata"
            ? metadataOf(message, url.searchParams.getAll("metadataHeaders"))
            : message,
        );
      }
      if (method === "POST" && one[2]) {
        const change = JSON.parse(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
        for (const id of [...(change.addLabelIds ?? []), ...(change.removeLabelIds ?? [])])
          if (!LABELS.some((label) => label.id === id))
            return json(
              response,
              400,
              googleError(400, `Invalid label: ${id}`, "invalidArgument", "INVALID_ARGUMENT"),
            );
        message.labelIds = [
          ...message.labelIds.filter((id) => !change.removeLabelIds?.includes(id)),
          ...(change.addLabelIds ?? []).filter((id) => !message.labelIds.includes(id)),
        ];
        historyId += 1;
        return json(response, 200, {
          id: message.id,
          threadId: message.threadId,
          labelIds: message.labelIds,
        });
      }
    }
    if (method === "POST" && (path === "/drafts" || path === "/messages/send")) {
      const parsed = JSON.parse(body) as {
        raw?: string;
        threadId?: string;
        message?: { raw?: string; threadId?: string };
      };
      const outgoing = parsed.message ?? parsed;
      const raw = outgoing.raw ?? "";
      const id = hexId();
      const threadId = outgoing.threadId ?? id;
      const entry = {
        raw,
        text: Buffer.from(raw, "base64url").toString("utf8"),
        ...(outgoing.threadId ? { threadId: outgoing.threadId } : {}),
      };
      historyId += 1;
      (path === "/drafts" ? drafts : sent).push(entry);
      const after = knobs.afterTaking.shift();
      if (after === "drop") {
        response.socket?.destroy();
        return;
      }
      if (after === 500)
        return json(response, 500, googleError(500, "Backend Error", "backendError", "INTERNAL"));
      if (path === "/drafts") {
        return json(response, 200, {
          id: `r-${randomBytes(9).readBigUInt64BE()}`,
          message: { id, threadId, labelIds: ["DRAFT"] },
        });
      }
      return json(response, 200, { id, threadId, labelIds: ["SENT"] });
    }
    if (method === "GET" && path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (!Number.isInteger(start) || start < keptFrom) return json(response, 404, NOT_FOUND);
      const label = url.searchParams.get("labelId");
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      const records = history.filter(
        (entry) => entry.id > start && (!label || entry.message.labelIds.includes(label)),
      );
      const page = records.slice(from, from + max);
      return json(response, 200, {
        ...(page.length
          ? {
              history: page.map((entry) => ({
                id: String(entry.id),
                messages: [{ id: entry.message.id, threadId: entry.message.threadId }],
                messagesAdded: [
                  {
                    message: {
                      id: entry.message.id,
                      threadId: entry.message.threadId,
                      labelIds: entry.message.labelIds,
                    },
                  },
                ],
              })),
            }
          : {}),
        ...(from + max < records.length ? { nextPageToken: String(from + max) } : {}),
        historyId: String(historyId),
      });
    }
    return json(response, 404, NOT_FOUND);
  };

  const calendar = calendarStandIn();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await read(request);
    if (url.pathname.startsWith("/calendar/v3/")) {
      seen.push({
        method: request.method ?? "",
        path: `${url.pathname}${url.search}`,
        body,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      });
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const refresh = live.get(bearer);
      if (!refresh) return json(response, 401, UNAUTHENTICATED);
      return calendar.handle(response, url, request.method ?? "GET", body, grants.get(refresh));
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/")) return gmail(request, response, url, body);
    if (request.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
      const params = url.searchParams;
      const redirect = params.get("redirect_uri") ?? "";
      if (
        !knobs.clients.has(params.get("client_id") ?? "") ||
        params.get("response_type") !== "code" ||
        params.get("code_challenge_method") !== "S256" ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(redirect)
      ) {
        response.writeHead(400, { "content-type": "text/html" });
        response.end("<p>Error 400: invalid_request</p>");
        return;
      }
      const back = new URL(redirect);
      back.searchParams.set("state", params.get("state") ?? "");
      if (knobs.consent.deny) back.searchParams.set("error", "access_denied");
      else {
        const asked = (params.get("scope") ?? "").split(" ");
        const scopes = asked.filter((scope) => knobs.consent.grant.includes(scope));
        const code = `4/0AanRRrt${randomBytes(18).toString("base64url")}`;
        codes.set(code, {
          challenge: params.get("code_challenge") ?? "",
          redirect,
          scopes,
          client: params.get("client_id") ?? "",
        });
        back.searchParams.set("code", code);
        back.searchParams.set("scope", scopes.join(" "));
      }
      response.writeHead(302, { location: back.href });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(body));
      tokens.push(form);
      if (knobs.deleted.has(form.client_id ?? ""))
        return json(response, 401, {
          error: "deleted_client",
          error_description: "The OAuth client was deleted.",
        });
      if (!form.client_id || knobs.clients.get(form.client_id) !== form.client_secret)
        return json(response, 401, {
          error: "invalid_client",
          error_description: "The OAuth client was not found.",
        });
      if (form.grant_type === "authorization_code") {
        knobs.onExchange?.();
        const issued = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        const challenge = createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (
          !issued ||
          issued.challenge !== challenge ||
          issued.redirect !== form.redirect_uri ||
          issued.client !== form.client_id
        )
          return json(response, 400, { error: "invalid_grant", error_description: "Bad Request" });
        const refresh = `1//0g${randomBytes(30).toString("base64url")}`;
        grants.set(refresh, issued.scopes);
        grantedTo.set(refresh, issued.client);
        return json(response, 200, {
          access_token: issue(refresh),
          expires_in: 3599,
          refresh_token: refresh,
          scope: issued.scopes.join(" "),
          token_type: "Bearer",
          ...(knobs.lasts !== undefined ? { refresh_token_expires_in: knobs.lasts } : {}),
        });
      }
      if (form.grant_type === "refresh_token") {
        const scopes = grants.get(form.refresh_token ?? "");
        if (!scopes)
          return json(response, 400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          });
        // A lasting key renews only as the client Google issued it to.
        if (grantedTo.get(form.refresh_token ?? "") !== form.client_id)
          return json(response, 401, {
            error: "unauthorized_client",
            error_description: "Unauthorized",
          });
        return json(response, 200, {
          access_token: issue(form.refresh_token ?? ""),
          expires_in: 3599,
          scope: scopes.join(" "),
          token_type: "Bearer",
        });
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      const token = new URLSearchParams(body).get("token") ?? "";
      revoked.push(token);
      const refresh = live.get(token) ?? token;
      if (!grants.delete(refresh)) return json(response, 400, { error: "invalid_token" });
      for (const [access, owner] of live) if (owner === refresh) live.delete(access);
      return json(response, 200, {});
    }
    return json(response, 404, NOT_FOUND);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    calendar,
    seen,
    tokens,
    revoked,
    drafts,
    sent,
    knobs,
    /**
     * A sign-in an earlier version or run made as this client, granting these
     * permissions: its keys, as that version kept them.
     */
    grantEarlier(scopes: string[], client = STAND_IN_CLIENT_ID) {
      const refresh = `1//0g${randomBytes(30).toString("base64url")}`;
      grants.set(refresh, scopes);
      grantedTo.set(refresh, client);
      return { access: issue(refresh), refresh };
    },
    /** The keys Google issued and has not revoked; a test asserts none reaches a reader. */
    issued: () => [...live.keys(), ...grants.keys()],
    /** A message arrives in the inbox; answers its id. */
    deliver(arriving: Arriving): string {
      const attachmentPart = (attachment: NonNullable<Arriving["attachment"]>): Part => {
        const content = attachment.bytes ?? Buffer.alloc(attachment.size);
        const headers = [
          { name: "Content-Type", value: `${attachment.type}; name="${attachment.name}"` },
          { name: "Content-Disposition", value: `attachment; filename="${attachment.name}"` },
          { name: "Content-Transfer-Encoding", value: "base64" },
        ];
        if (attachment.inline)
          return {
            partId: "1",
            mimeType: attachment.type,
            filename: attachment.name,
            headers,
            body: { size: content.length, data: content.toString("base64url") },
          };
        const attachmentId = `ANGjdJ_${hexId()}`;
        attachments.set(attachmentId, content);
        return {
          partId: "1",
          mimeType: attachment.type,
          filename: attachment.name,
          headers,
          body: { size: content.length, attachmentId },
        };
      };
      const id = hexId();
      historyId += 1;
      const date = new Date(Date.UTC(2026, 9, 21, 16, 4, messages.size)).toUTCString();
      const headers: Header[] = [
        { name: "Delivered-To", value: STAND_IN_ACCOUNT },
        { name: "MIME-Version", value: "1.0" },
        { name: "Date", value: date.replace("GMT", "+0000") },
        { name: "Message-ID", value: `<CAF${id}@mail.gmail.com>` },
        { name: "Subject", value: arriving.subject },
        { name: "From", value: arriving.from },
        { name: "To", value: `Ada Park <${STAND_IN_ACCOUNT}>` },
        { name: "Content-Type", value: 'multipart/mixed; boundary="000000000000a1b2"' },
      ];
      const text: Part | undefined =
        arriving.text !== undefined
          ? {
              partId: "0.0",
              mimeType: "text/plain",
              filename: "",
              headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
              body: { size: Buffer.byteLength(arriving.text), data: b64(arriving.text) },
            }
          : undefined;
      const html: Part | undefined = arriving.html
        ? {
            partId: "0.1",
            mimeType: "text/html",
            filename: "",
            headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }],
            body: { size: Buffer.byteLength(arriving.html), data: b64(arriving.html) },
          }
        : undefined;
      const parts: Part[] = [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          filename: "",
          headers: [],
          body: { size: 0 },
          parts: [text, html].filter((part): part is Part => part !== undefined),
        },
        ...(arriving.attachment ? [attachmentPart(arriving.attachment)] : []),
      ];
      const message: Message = {
        id,
        threadId: id,
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX", ...(arriving.labels ?? [])],
        snippet: (arriving.text ?? "").replace(/\s+/g, " ").slice(0, 100),
        historyId: String(historyId),
        internalDate: String(Date.parse(date)),
        sizeEstimate: 4_096 + Buffer.byteLength(arriving.text ?? arriving.html ?? ""),
        payload: {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers,
          body: { size: 0 },
          parts,
        },
      };
      messages.set(id, message);
      history.push({ id: historyId, message });
      return id;
    },
    /** The access keys Google issued lapse, as an hour passing would. */
    lapse() {
      live.clear();
    },
    /** The person removes the app's access from their Google account. */
    revokeElsewhere() {
      grants.clear();
      live.clear();
    },
    /** Gmail stops keeping the history recorded so far, as it does after about a week. */
    forgetHistory() {
      keptFrom = historyId + 1;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type GoogleStandIn = Awaited<ReturnType<typeof startGoogleStandIn>>;
