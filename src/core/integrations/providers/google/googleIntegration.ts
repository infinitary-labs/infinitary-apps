import type { ForgeSignInState } from "@shared/forges";
import { INTEGRATION_KIND_NAMES } from "@shared/integrations";
import { type IntegrationBinding, IntegrationOutcomeUnknown } from "../../binding";
import { type IntegrationSecrets, MissingSecret } from "../../secrets";
import {
  CALENDAR_ACTIONS,
  CALENDAR_CHANGED_EVENT,
  type CalendarRequest,
  lookForCalendar,
  runCalendarAction,
} from "./calendar";
import { GMAIL_SCOPE, GOOGLE_SCOPES, type GoogleClient, type GoogleEndpoints } from "./client";
import {
  GMAIL_ACTIONS,
  GMAIL_MESSAGE_EVENT,
  type GmailRequest,
  lookForMail,
  runGmailAction,
} from "./gmail";
import { GOOGLE_REQUEST_TIMEOUT_MS, issuedFrom, signInOnLoopback } from "./signIn";
import { GoogleSignInStore } from "./store";

/**
 * Google as an integration (docs/integrations.md, "Google"): one row that
 * signs in once, in the person's own browser, for every permission Gmail
 * and Calendar need (the captain's q8 on INF-775), as Infinitary's own
 * Google client (q4). Its two keys live in the integration's key store
 * under the slots below and are used only through it: the access key on
 * each request to Gmail, the lasting one to renew it and, on removal, to
 * tell Google to forget the sign-in. The row has no key fields, since
 * nothing about it is pasted.
 *
 * Health is the forge sign-in's words: `needs_reauth` only from proof - Google
 * refused the lasting key, or a request was refused again after a real
 * renewal - and `unavailable` when Google could not be reached or failed.
 * When Gmail asks the app to slow down and says for how long (Retry-After),
 * every request waits that long, and a rule's look tries again on its next
 * minute.
 */

const GOOGLE_ID = "google";
const ACCESS = "access_token";
const REFRESH = "refresh_token";

const SIGN_IN_AGAIN = "Google is signed out. Sign in again in Settings -> Integrations.";
const RATE_LIMITED = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export type GoogleIntegrationOptions = {
  /** The integrations folder, where `google.json` lives. */
  root: string;
  secrets: IntegrationSecrets;
  client: GoogleClient;
  endpoints: GoogleEndpoints;
  /** Opens Google's consent page in the person's browser. */
  open: (url: string) => Promise<void>;
  now: () => number;
  /** The row changed on its own (its health), so Settings reads it again. */
  changed: () => void;
  /** The sign-in's own requests, before any key is kept. */
  fetch?: typeof fetch;
};

type Answer = { status: number; body: Record<string, unknown> };

/** Google's error words: `{ error: { message, errors: [{ reason }] } }`, or a token answer's. */
function errorOf(body: Record<string, unknown>): { message?: string; reasons: string[] } {
  const error = body.error;
  if (typeof error === "string")
    return {
      reasons: [error],
      ...(typeof body.error_description === "string" ? { message: body.error_description } : {}),
    };
  if (!error || typeof error !== "object") return { reasons: [] };
  const { message, errors } = error as { message?: unknown; errors?: { reason?: unknown }[] };
  return {
    ...(typeof message === "string" ? { message } : {}),
    reasons: (errors ?? []).flatMap((entry) =>
      typeof entry.reason === "string" ? [entry.reason] : [],
    ),
  };
}

/** Retry-After in milliseconds: seconds, or a date. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function googleIntegration(options: GoogleIntegrationOptions): IntegrationBinding {
  const store = new GoogleSignInStore(options.root);
  const gmailRoot = `${options.endpoints.gmail.replace(/\/+$/, "")}/gmail/v1/users/me`;
  const calendarRoot = `${options.endpoints.calendar.replace(/\/+$/, "")}/calendar/v3`;
  const client = {
    client_id: options.client.id,
    ...(options.client.secret ? { client_secret: options.client.secret } : {}),
  };
  let renewing: Promise<void> | undefined;
  /** Until when Gmail asked the app to wait, on the app's clock. */
  let waitUntil = 0;

  const setHealth = (health: ForgeSignInState) => {
    const record = store.read();
    if (!record || record.health === health) return;
    store.write({ ...record, health });
    options.changed();
  };
  const timeout = () => AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS);

  /** Trade the lasting key for a new access key; one renewal at a time. */
  const renew = (): Promise<void> => {
    renewing ??= (async () => {
      let response: Response;
      try {
        response = await options.secrets.request(GOOGLE_ID, REFRESH, options.endpoints.token, {
          method: "POST",
          redirect: "error",
          headers: { accept: "application/json" },
          field: "refresh_token",
          form: { ...client, grant_type: "refresh_token" },
          signal: timeout(),
        });
      } catch (error) {
        if (error instanceof MissingSecret) {
          setHealth("needs_reauth");
          throw new Error(SIGN_IN_AGAIN);
        }
        setHealth("unavailable");
        throw new Error("Could not reach Google to renew the sign-in.");
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const issued = response.ok ? issuedFrom(body, options.now()) : undefined;
      if (!issued) {
        // Google refused the lasting key itself: signed out there, or revoked.
        if (errorOf(body).reasons.includes("invalid_grant")) {
          setHealth("needs_reauth");
          throw new Error(SIGN_IN_AGAIN);
        }
        setHealth("unavailable");
        throw new Error(`Google did not renew the sign-in (status ${response.status}).`);
      }
      options.secrets.put(GOOGLE_ID, ACCESS, issued.accessToken);
      if (issued.refreshToken) options.secrets.put(GOOGLE_ID, REFRESH, issued.refreshToken);
      const record = store.read();
      if (record) store.write({ ...record, expiresAt: issued.expiresAt });
    })().finally(() => {
      renewing = undefined;
    });
    return renewing;
  };

  const send = async (
    root: string,
    label: string,
    path: string,
    init?: Parameters<CalendarRequest>[1],
  ): Promise<Response> => {
    try {
      return await options.secrets.request(GOOGLE_ID, ACCESS, `${root}${path}`, {
        method: init?.method ?? "GET",
        redirect: "error",
        header: "authorization",
        prefix: "Bearer ",
        headers: {
          accept: "application/json",
          ...(init?.json !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        signal: timeout(),
      });
    } catch (error) {
      if (error instanceof MissingSecret) {
        setHealth("needs_reauth");
        throw new Error(SIGN_IN_AGAIN);
      }
      setHealth("unavailable");
      // A change that left may have reached Google: what came of it is not known.
      if (!init?.read && (init?.method ?? "GET") !== "GET")
        throw new IntegrationOutcomeUnknown(`${label} did not answer.`);
      throw new Error(`Could not reach ${label}.`);
    }
  };

  const api =
    (root: string, label: string, allowsGone = false): CalendarRequest =>
    async (path, init) => {
      const wait = Math.ceil((waitUntil - options.now()) / 1000);
      if (wait > 0) throw new Error(`${label} asked the app to wait ${wait} more seconds.`);
      const record = store.read();
      if (!record) throw new Error(SIGN_IN_AGAIN);
      if (record.expiresAt - options.now() < GOOGLE_REQUEST_TIMEOUT_MS) await renew();
      let response = await send(root, label, path, init);
      if (response.status === 401) {
        await renew();
        response = await send(root, label, path, init);
        if (response.status === 401) {
          setHealth("needs_reauth");
          throw new Error(SIGN_IN_AGAIN);
        }
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok || response.status === 404 || (allowsGone && response.status === 410)) {
        setHealth("ok");
        return { status: response.status, body } satisfies Answer;
      }
      const error = errorOf(body);
      if (response.status === 429 || error.reasons.some((reason) => RATE_LIMITED.has(reason))) {
        const after = retryAfter(response.headers.get("retry-after"), options.now());
        if (after !== undefined) waitUntil = options.now() + after;
        throw new Error(
          `${label} asked the app to slow down${after !== undefined ? ` for ${Math.ceil(after / 1000)} seconds` : ""}.`,
        );
      }
      const said = `(status ${response.status})${error.message ? `: ${error.message}` : "."}`;
      if (response.status < 500) {
        setHealth("ok");
        throw new Error(`${label} refused ${said}`);
      }
      setHealth("unavailable");
      // Google failed while it held a change: whether the change happened is not known.
      if (!init?.read && (init?.method ?? "GET") !== "GET")
        throw new IntegrationOutcomeUnknown(`${label} failed ${said}`);
      throw new Error(`${label} failed ${said}`);
    };

  const gmail: GmailRequest = api(gmailRoot, "Gmail");
  const calendar = api(calendarRoot, "Google Calendar", true);

  /** Tell Google to forget the sign-in, as far as it can be reached. */
  const revoke = async () => {
    try {
      await options.secrets.request(GOOGLE_ID, REFRESH, options.endpoints.revoke, {
        method: "POST",
        redirect: "error",
        field: "token",
        form: {},
        signal: timeout(),
      });
    } catch {
      // Unreachable, or no key kept: the sign-in is forgotten here regardless.
    }
  };

  return {
    kind: "google",
    // One Google sign-in: its name stays its own while signed out (INF-946).
    identity: { id: GOOGLE_ID, name: INTEGRATION_KIND_NAMES.google },
    connections: () => {
      const record = store.read();
      if (!record) return [];
      return [
        {
          id: GOOGLE_ID,
          account: record.account,
          health: record.health,
          actions: [...GMAIL_ACTIONS, ...CALENDAR_ACTIONS],
          events: [GMAIL_MESSAGE_EVENT, CALENDAR_CHANGED_EVENT],
        },
      ];
    },
    signIn: async (signal) => {
      const issued = await signInOnLoopback({
        client: options.client,
        endpoints: options.endpoints,
        scopes: GOOGLE_SCOPES,
        open: options.open,
        signal,
        now: options.now,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      options.secrets.put(GOOGLE_ID, ACCESS, issued.accessToken);
      options.secrets.put(GOOGLE_ID, REFRESH, issued.refreshToken);
      const forget = async (words: string): Promise<never> => {
        await revoke();
        options.secrets.forget(GOOGLE_ID);
        store.remove();
        options.changed();
        throw new Error(words);
      };
      if (!issued.scopes.includes(GMAIL_SCOPE))
        return forget(
          "Google did not grant the Gmail permission. Sign in again and leave every box checked.",
        );
      if (!GOOGLE_SCOPES.every((scope) => issued.scopes.includes(scope)))
        return forget(
          "Google did not grant every Gmail and Calendar permission. Sign in again and leave every box checked.",
        );
      let profile: Answer | undefined;
      try {
        const response = await options.secrets.request(GOOGLE_ID, ACCESS, `${gmailRoot}/profile`, {
          redirect: "error",
          header: "authorization",
          prefix: "Bearer ",
          headers: { accept: "application/json" },
          signal: AbortSignal.any([signal, timeout()]),
        });
        profile = {
          status: response.status,
          body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
        };
      } catch {
        profile = undefined;
      }
      const account = profile?.status === 200 ? profile.body.emailAddress : undefined;
      if (typeof account !== "string" || !account)
        return forget(
          `Signed in, but Gmail did not say whose account it is${
            profile ? ` (${errorOf(profile.body).message ?? `status ${profile.status}`})` : ""
          }. Try again.`,
        );
      waitUntil = 0;
      store.write({
        account,
        scopes: issued.scopes,
        expiresAt: issued.expiresAt,
        health: "ok",
        signedInAt: options.now(),
      });
      return GOOGLE_ID;
    },
    check: async () => {
      if (!store.read()) return;
      try {
        await gmail("/profile");
      } catch {
        // The health it found is kept; the row shows it.
      }
    },
    remove: async () => {
      await revoke();
      store.remove();
      waitUntil = 0;
    },
    call: (_id, action, input) =>
      CALENDAR_ACTIONS.some((spec) => spec.name === action)
        ? runCalendarAction(calendar, action, input)
        : runGmailAction(gmail, action, input),
    look: async (_id, event, cursor, filter) => {
      const record = store.read();
      if (!record) throw new Error(SIGN_IN_AGAIN);
      return event === CALENDAR_CHANGED_EVENT.name
        ? lookForCalendar(calendar, record.account, cursor, filter)
        : lookForMail(gmail, record.account, cursor);
    },
  };
}
