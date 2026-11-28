/**
 * A stand-in Google for the Google integration's tests (INF-784): Google's
 * sign-in for an installed app (the consent page, the token endpoint with
 * PKCE, renewal and revocation), Gmail's profile, which the sign-in reads
 * the account from, an attached file's bytes from Gmail's own API, and
 * Google's Gmail, Calendar, Drive, Docs and Sheets MCP servers
 * (`googleMcpStandIn.ts`, `driveMcpStandIn.ts`, `docsSheetsMcpStandIn.ts`),
 * on this computer, answering in the shapes Google
 * documents (the OAuth 2.0 guide for installed apps, Gmail's API reference,
 * and the MCP servers' own tool lists) and Google's error shape
 * `{ error: { code, message, errors: [{ reason }], status } }`.
 *
 * The test drives the person's side: `consent` decides what they grant on
 * the consent page, `deliver` puts a message in their inbox, and the knobs
 * below reproduce what Google does on its own - an access key that lapses,
 * a sign-in revoked elsewhere, a client not marked for an AI-powered agent,
 * an MCP service turned off, a call Google asks the person about first,
 * and a request answered 429 with Retry-After.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { calendarStandIn } from "./calendarStandIn";
import { docsMcpServer, sheetsMcpServer } from "./docsSheetsMcpStandIn";
import { driveMcpServer, type StandInDriveFile } from "./driveMcpStandIn";
import {
  attachmentIdOf,
  calendarMcpServer,
  type GoogleMcpService,
  type GoogleMcpWorld,
  gmailMcpServer,
  type Outgoing,
  type StandInMail,
} from "./googleMcpStandIn";

export type { StandInDriveFile } from "./driveMcpStandIn";
export type { Outgoing, StandInMail } from "./googleMcpStandIn";

export const STAND_IN_CLIENT_ID = "1084716423951-k2v7o3lq.apps.googleusercontent.com";
export const STAND_IN_CLIENT_SECRET = "GOCSPX-stand-in-desktop-secret";
/** A person's own Desktop app client, made in their own Google Cloud project. */
export const OWN_CLIENT_ID = "582093176224-p8d0vq3hr5k1n6e2.apps.googleusercontent.com";
export const OWN_CLIENT_SECRET = "GOCSPX-own-desktop-secret-7Qd2";
/** The person's Google Cloud project, as Google names it in an address. */
export const STAND_IN_PROJECT = "582093176224";

export const STAND_IN_ACCOUNT = "ada.park@gmail.com";

export type Arriving = {
  from: string;
  subject: string;
  /** Absent, the message is HTML alone, as many newsletters are. */
  text?: string;
  html?: string;
  /** Its one attachment: `bytes` are its content, zeros of `size` without them. */
  attachment?: { name: string; type: string; size: number; bytes?: Buffer };
  /** Labels besides INBOX and UNREAD. */
  labels?: string[];
  /** When Gmail received it, in milliseconds; absent, now, and a second after the last delivery at least. */
  at?: number;
  /** The conversation it joins; absent, it starts its own. */
  threadId?: string;
};

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/drive",
];

/** The Google services the stand-in serves an MCP server for. */
type StandInService = GoogleMcpService | "drive" | "docs" | "sheets";

const MCP_PATHS: Record<string, StandInService> = {
  "/gmailmcp/mcp/v1": "gmail",
  "/calendarmcp/mcp/v1": "calendar",
  "/drivemcp/mcp/v1": "drive",
  "/docsmcp/mcp/v1": "docs",
  "/sheetsmcp/mcp/v1": "sheets",
};

const SERVICE_NAMES: Record<StandInService, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
  docs: "Docs",
  sheets: "Sheets",
};

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

/**
 * Google's refusal once a service's daily requests ran out, with no Retry-After.
 * Google's Gmail MCP quota page names no body for it, so this is Google Cloud's
 * own quota error (cloud.google.com/apis/design/errors, RESOURCE_EXHAUSTED with an
 * ErrorInfo naming the limit), for the 5,000 requests a day of the Standard Tier.
 */
function dailyLimitReached(service: StandInService) {
  const name = `${service}mcp.googleapis.com`;
  return {
    error: {
      code: 429,
      message: `Quota exceeded for quota metric 'Requests' and limit 'Requests per day' of service '${name}' for consumer 'project_number:${STAND_IN_PROJECT}'.`,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
          domain: "googleapis.com",
          metadata: {
            service: name,
            consumer: `projects/${STAND_IN_PROJECT}`,
            quota_metric: `${name}/requests`,
            quota_limit: "RequestsPerDayPerProject",
            quota_limit_value: "5000",
          },
        },
      ],
    },
  };
}

/**
 * One 429 the stand-in answers: a string is its Retry-After in seconds; an
 * object answers Google Cloud's daily-limit body when `daily`, and a 429 with
 * no Retry-After otherwise, to `service`'s next request or any service's.
 */
export type StandInLimit = string | { daily?: true; service?: StandInService };

/**
 * Google's refusal of a tool call to an MCP service the person's project has
 * not turned on, as Google's Calendar server gave it live: status 403 with a
 * finished tool result whose only words name the page that turns it on.
 */
function serviceDisabled(service: StandInService, id: unknown) {
  const name = `${service}mcp.googleapis.com`;
  const activationUrl = `https://console.developers.google.com/apis/api/${name}/overview?project=${STAND_IN_PROJECT}`;
  return {
    id,
    jsonrpc: "2.0",
    result: {
      content: [
        {
          text: `${SERVICE_NAMES[service]} MCP API has not been used in project ${STAND_IN_PROJECT} before or it is disabled. Enable it by visiting ${activationUrl} then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`,
          type: "text",
        },
      ],
      isError: true,
      resultType: "complete",
    },
  };
}

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

/** One request Google received: an MCP tool call names its tool and arguments. */
export type Seen = {
  method: string;
  path: string;
  authorization?: string;
  body: string;
  service?: StandInService;
  /** The JSON-RPC method of an MCP request. */
  rpc?: string;
  tool?: string;
  args?: Record<string, unknown>;
};

export async function startGoogleStandIn() {
  const seen: Seen[] = [];
  /** Every token request, with its form. */
  const tokens: Record<string, string>[] = [];
  const revoked: string[] = [];
  const drafts: Outgoing[] = [];
  const sent: Outgoing[] = [];
  const mail = new Map<string, StandInMail>();
  let delivered = 0;
  const codes = new Map<
    string,
    { challenge: string; redirect: string; scopes: string[]; client: string }
  >();
  const live = new Map<string, string>(); // access key -> refresh key
  const grants = new Map<string, string[]>(); // refresh key -> scopes
  const grantedTo = new Map<string, string>(); // refresh key -> the client it was issued to
  /** Changes the MCP servers took: a draft, a send, a label change or an event written. */
  let taken = 0;
  const knobs = {
    /** What the person does on the consent page. */
    consent: { grant: [...SCOPES], deny: false },
    /** The next requests answered 429 (`StandInLimit`). */
    limited: [] as StandInLimit[],
    /**
     * What Google does after each of the next calls that changed something:
     * the connection drops before it answers, or it answers 500.
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
    /**
     * The client is not marked "Use this client for an AI-powered agent":
     * Google's MCP servers answer every key 401, fresh or not.
     */
    agentRefused: false,
    /** MCP services the person's Google Cloud project has not turned on. */
    off: new Set<StandInService>(),
    /** Tools Google asks the person about before it runs them, by name. */
    confirm: new Set<string>(),
    /** Gmail's list offers no `send_message`. */
    withoutSend: false,
    /** Google answers at most this many conversations or events a page, fewer than asked. */
    pageSize: undefined as number | undefined,
    /** Calendar lists a cancelled event with its status, as its event schema allows. */
    listsCancelled: false,
    /** The stand-in's clock, for Calendar's default window and an event's `updated`. */
    now: () => Date.now(),
  };
  /** The first 429 waiting for `service`'s next request, taken off the list. */
  const takeLimit = (service: StandInService): StandInLimit | undefined => {
    const at = knobs.limited.findIndex(
      (limit) => typeof limit === "string" || !limit.service || limit.service === service,
    );
    return at < 0 ? undefined : knobs.limited.splice(at, 1)[0];
  };
  const limited = (response: ServerResponse, service: StandInService, limit: StandInLimit) => {
    if (typeof limit === "string")
      return json(
        response,
        429,
        googleError(429, "Quota exceeded.", "rateLimitExceeded", "RESOURCE_EXHAUSTED"),
        { "retry-after": limit },
      );
    return json(
      response,
      429,
      limit.daily
        ? dailyLimitReached(service)
        : googleError(429, "Quota exceeded.", "rateLimitExceeded", "RESOURCE_EXHAUSTED"),
    );
  };
  const calendar = calendarStandIn(() => knobs.now());
  /** The person's Drive, by file id. */
  const files = new Map<string, StandInDriveFile>();
  const answers: GoogleMcpWorld["answers"] = [];

  const issue = (refresh: string) => {
    const access = `ya29.a0AfB_${randomBytes(24).toString("base64url")}`;
    live.set(access, refresh);
    return access;
  };

  const world = (granted: string[]): GoogleMcpWorld => ({
    mail,
    drafts,
    sent,
    calendars: calendar.calendars,
    change: calendar.change,
    granted: () => granted,
    now: () => knobs.now(),
    knobs,
    answers,
    took: () => {
      taken += 1;
    },
  });
  const handlers = {
    gmail: createMcpHandler((context) => gmailMcpServer(world(context.authInfo?.scopes ?? [])), {
      legacy: "reject",
    }),
    calendar: createMcpHandler(
      (context) => calendarMcpServer(world(context.authInfo?.scopes ?? [])),
      { legacy: "reject" },
    ),
    drive: createMcpHandler(
      (context) =>
        driveMcpServer({
          files,
          granted: () => context.authInfo?.scopes ?? [],
          owner: () => knobs.account,
        }),
      { legacy: "reject" },
    ),
    docs: createMcpHandler(
      (context) => docsMcpServer({ files, granted: () => context.authInfo?.scopes ?? [] }),
      { legacy: "reject" },
    ),
    sheets: createMcpHandler(
      (context) => sheetsMcpServer({ files, granted: () => context.authInfo?.scopes ?? [] }),
      { legacy: "reject" },
    ),
  };

  const mcp = async (
    service: StandInService,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: string,
  ) => {
    const rpc = (() => {
      try {
        return JSON.parse(body) as {
          id?: unknown;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
      } catch {
        return undefined;
      }
    })();
    seen.push({
      method: request.method ?? "",
      path: url.pathname,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body,
      service,
      ...(rpc?.method ? { rpc: rpc.method } : {}),
      ...(rpc?.method === "tools/call"
        ? { tool: rpc.params?.name, args: rpc.params?.arguments ?? {} }
        : {}),
    });
    const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const refresh = live.get(bearer);
    if (!refresh || knobs.agentRefused)
      return json(response, 401, UNAUTHENTICATED, {
        "www-authenticate": 'Bearer error="invalid_token"',
      });
    // Google's server still answers the handshake and its list with the service off.
    if (knobs.off.has(service) && rpc?.method === "tools/call")
      return json(response, 403, serviceDisabled(service, rpc.id));
    const limit = takeLimit(service);
    if (limit !== undefined) return limited(response, service, limit);
    const before = taken;
    const answer = await handlers[service].fetch(
      new Request(`http://127.0.0.1${request.url ?? "/"}`, {
        method: request.method ?? "POST",
        headers: Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
        ) as [string, string][],
        ...(body ? { body } : {}),
      }),
      {
        authInfo: {
          token: bearer,
          clientId: grantedTo.get(refresh) ?? "",
          scopes: grants.get(refresh) ?? [],
        },
      },
    );
    if (taken > before) {
      const after = knobs.afterTaking.shift();
      if (after === "drop") {
        response.socket?.destroy();
        return;
      }
      if (after === 500)
        return json(response, 500, googleError(500, "Backend Error", "backendError", "INTERNAL"));
    }
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (!answer.body) {
      response.end();
      return;
    }
    Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream).pipe(response);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await read(request);
    const service = MCP_PATHS[url.pathname];
    if (service) return mcp(service, request, response, url, body);
    if (url.pathname === "/gmail/v1/users/me/profile") {
      seen.push({
        method: request.method ?? "",
        path: "/profile",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body,
      });
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!live.has(bearer)) return json(response, 401, UNAUTHENTICATED);
      return json(response, 200, {
        emailAddress: knobs.account,
        messagesTotal: mail.size,
        threadsTotal: new Set([...mail.values()].map((entry) => entry.threadId)).size,
        historyId: "4812331",
      });
    }
    const attachment = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(
      url.pathname,
    );
    if (attachment) {
      seen.push({
        method: request.method ?? "",
        path: url.pathname.replace("/gmail/v1/users/me", ""),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body,
      });
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!live.has(bearer)) return json(response, 401, UNAUTHENTICATED);
      const limit = takeLimit("gmail");
      if (limit !== undefined) return limited(response, "gmail", limit);
      const [, messageId, attachmentId] = attachment;
      const file = mail.get(messageId ?? "")?.attachment;
      if (!file || attachmentId !== attachmentIdOf(messageId ?? ""))
        return json(response, 404, NOT_FOUND);
      return json(response, 200, {
        size: file.bytes.length,
        data: file.bytes.toString("base64url"),
      });
    }
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
    /** The tool calls Google's MCP servers received, by service. */
    calls: (service?: StandInService) =>
      seen.filter(
        (entry): entry is Seen & { tool: string; args: Record<string, unknown> } =>
          entry.tool !== undefined && (service === undefined || entry.service === service),
      ),
    tokens,
    revoked,
    drafts,
    sent,
    mail,
    /** The person's Drive: a test puts files in it by id. */
    files,
    /** Each answer the person gave Google's question, by tool. */
    answers,
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
      const id = hexId();
      delivered = arriving.at ?? Math.max(knobs.now(), delivered + 1000);
      const attachment = arriving.attachment;
      mail.set(id, {
        id,
        threadId: arriving.threadId ?? id,
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX", ...(arriving.labels ?? [])],
        from: arriving.from,
        to: `Ada Park <${STAND_IN_ACCOUNT}>`,
        subject: arriving.subject,
        internalDate: delivered,
        ...(arriving.text !== undefined ? { text: arriving.text } : {}),
        ...(arriving.html !== undefined ? { html: arriving.html } : {}),
        ...(attachment
          ? {
              attachment: {
                name: attachment.name,
                type: attachment.type,
                bytes: attachment.bytes ?? Buffer.alloc(attachment.size),
              },
            }
          : {}),
      });
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
    close: () =>
      new Promise<void>((resolve) => {
        void Promise.all([
          handlers.gmail.close(),
          handlers.calendar.close(),
          handlers.drive.close(),
          handlers.docs.close(),
          handlers.sheets.close(),
        ]).finally(() => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }),
  };
}

export type GoogleStandIn = Awaited<ReturnType<typeof startGoogleStandIn>>;
