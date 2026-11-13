import { randomUUID } from "node:crypto";
import type { ForgeSignInState } from "@shared/forges";
import { GOOGLE_DATA_KEPT, INTEGRATION_KIND_NAMES } from "@shared/integrations";
import { httpSecretBroker } from "../../../secrets/httpBroker";
import { type IntegrationBinding, IntegrationOutcomeUnknown } from "../../binding";
import { type IntegrationKeys, REDACTED } from "../../secrets";
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
import { MovedGoogleKeys } from "./movedKeys";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  issuedFrom,
  type LoopbackSignInOptions,
  signInOnLoopback,
} from "./signIn";
import { GoogleSignInStore } from "./store";

/**
 * Google as an integration (docs/integrations.md, "Google"): one row that
 * signs in once, in the person's own browser, for every permission Gmail
 * and Calendar need (the captain's q8 on INF-775), as Infinitary's own
 * Google client (q4). Its lasting key lives in Secrets, as a hidden entry
 * used only through the renewal broker below (INF-785): each renewal is a
 * brokered use, and the captain's one saved decision on the first covers
 * every later one. The access key a renewal gives lives only in the app's
 * memory and goes on each request to Gmail and Calendar, and on removal to
 * tell Google to forget the sign-in. A renewal the captain did not allow,
 * or let run out, is not asked again until the captain checks the row, signs in
 * again or the app starts again. The row has no key fields, since nothing
 * about it is pasted.
 *
 * Health is the forge sign-in's words: `needs_reauth` only from proof - Google
 * refused the lasting key, or a request was refused again after a real
 * renewal - and `unavailable` when Google could not be reached or failed.
 * When Gmail asks the app to slow down and says for how long (Retry-After),
 * every request waits that long, and a rule's look tries again on its next
 * minute.
 */

const GOOGLE_ID = "google";

/**
 * The label Gmail and Calendar answers and event summaries reach every
 * agent under (INF-951): anyone can write a message or an invitation, so
 * its words sit between marks they could not forge, as data from outside
 * (docs/integrations.md, "Data from outside").
 */
export const GOOGLE_DATA_FENCE = "google-data";
/** The renewal broker's id, registered once with Secrets. */
const GOOGLE_BROKER = "google-sign-in";
/** The words Secrets shows for the lasting key and for its broker. */
const KEY_LABEL = "Google sign-in";

const NO_SECRETS =
  "Google keeps its sign-in in Secrets, which this computer does not offer. Google is not available here.";
const SECRETS_LOCKED =
  "Google waits for Secrets, which is locked or cannot open now. Unlock it in Settings -> Secrets.";
const NOT_ALLOWED =
  "Infinitary was not allowed to use the Google sign-in. Press Check in Settings -> Integrations to be asked again.";
const SIGN_IN_AGAIN = "Google is signed out. Sign in again in Settings -> Integrations.";
const RATE_LIMITED = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export type GoogleIntegrationOptions = {
  /** The integrations folder, where `google.json` lives. */
  root: string;
  /** Secrets, where the lasting key is kept (`IntegrationKeys`). */
  keys: IntegrationKeys;
  client: GoogleClient;
  endpoints: GoogleEndpoints;
  /** Opens Google's consent page in the person's browser (`LoopbackSignInOptions.open`). */
  open: LoopbackSignInOptions["open"];
  now: () => number;
  /** The row changed on its own (its health), so Settings reads it again. */
  changed: () => void;
  /** Every request to Google: the sign-in's, Gmail's, Calendar's and each renewal's inside Secrets. */
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

export function googleIntegration(
  options: GoogleIntegrationOptions,
): IntegrationBinding & { moveKeys: () => Promise<void> } {
  const store = new GoogleSignInStore(options.root);
  const moved = new MovedGoogleKeys(options.root);
  const fetchImpl = options.fetch ?? fetch;
  const gmailRoot = `${options.endpoints.gmail.replace(/\/+$/, "")}/gmail/v1/users/me`;
  const calendarRoot = `${options.endpoints.calendar.replace(/\/+$/, "")}/calendar/v3`;
  const client = {
    client_id: options.client.id,
    ...(options.client.secret ? { client_secret: options.client.secret } : {}),
  };
  let renewing: Promise<void> | undefined;
  let moving: Promise<string> | undefined;
  /** The access key, in memory only: a start renews it once. */
  let access: { token: string; expiresAt: number } | undefined;
  /** Why a renewal is not asked again (the captain did not allow it), until a check or sign-in. */
  let held: string | undefined;
  let registered = false;
  /** Keys of sign-ins just removed, renewed once more only to revoke them at Google. */
  const forgetting = new Set<string>();
  /** Until when Gmail asked the app to wait, on the app's clock. */
  let waitUntil = 0;

  const setHealth = (health: ForgeSignInState) => {
    const record = store.read();
    if (!record || record.health === health) return;
    store.write({ ...record, health });
    options.changed();
  };
  const timeout = () => AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS);

  /**
   * The renewal broker: the lasting key in the form's refresh_token field,
   * sent to Google's token address and nowhere else. Every bit it sends but
   * the key is the same each time, so one saved decision covers every
   * renewal of this sign-in; another sign-in keeps its key under another
   * reference and is asked again.
   */
  const register = () => {
    if (registered) return;
    registered = true;
    options.keys.registerBroker(
      httpSecretBroker({
        id: GOOGLE_BROKER,
        label: KEY_LABEL,
        resolve: (input) => {
          const ref =
            input && typeof input === "object" && !Array.isArray(input) ? input.ref : undefined;
          // Only the key the current sign-in names; never a reference a caller made up.
          if (typeof ref !== "string" || (ref !== store.read()?.key && !forgetting.has(ref)))
            return undefined;
          return {
            url: options.endpoints.token,
            method: "POST",
            headers: { accept: "application/json" },
            form: { ...client, grant_type: "refresh_token" },
            credentials: { refresh: { ref, delivery: { kind: "form", name: "refresh_token" } } },
            operation: "Renew the Google sign-in so Gmail and Calendar keep working",
            read: false,
            result: "A new Gmail and Calendar access key, kept only in the app's memory",
          };
        },
        send: (url, init) => fetchImpl(url, { ...init, signal: timeout() }),
      }),
    );
  };

  /**
   * The lasting key's reference. A sign-in an earlier version kept in its
   * own file moves once: the reference is written first, then the key goes
   * into Secrets, then the file goes, so an interrupted move repeats onto
   * the same entry and never leaves a second one.
   */
  const lastingKey = (): Promise<string> => {
    moving ??= (async () => {
      let record = store.read();
      if (!record) throw new Error(SIGN_IN_AGAIN);
      if (moved.present()) {
        const value = moved.lastingKey();
        if (value) {
          if (!options.keys.shown()) throw new Error(NO_SECRETS);
          const ref = record.key ?? (await options.keys.reference(KEY_LABEL));
          if (!ref) throw new Error(SECRETS_LOCKED);
          if (!record.key) {
            record = { ...record, key: ref };
            store.write(record);
          }
          const kept = await options.keys.keepHidden({
            ref,
            label: KEY_LABEL,
            value: Buffer.from(value, "utf8"),
          });
          if (kept !== ref) throw new Error(SECRETS_LOCKED);
        }
        try {
          moved.remove();
        } catch {
          // Tried again on the next use.
        }
      }
      if (!record.key) {
        setHealth("needs_reauth");
        throw new Error(SIGN_IN_AGAIN);
      }
      return record.key;
    })().finally(() => {
      moving = undefined;
    });
    return moving;
  };

  /** Trade the lasting key for a new access key, inside Secrets; one renewal at a time. */
  const renew = (): Promise<void> => {
    renewing ??= (async () => {
      if (held) throw new Error(held);
      const ref = await lastingKey();
      register();
      const used = await options.keys.use({
        id: randomUUID(),
        reason: "Infinitary renews your Google sign-in so Gmail and Calendar keep working.",
        broker: GOOGLE_BROKER,
        input: { ref },
      });
      if (used.state === "denied" || used.state === "expired" || used.state === "cancelled") {
        held = NOT_ALLOWED;
        setHealth("unavailable");
        throw new Error(NOT_ALLOWED);
      }
      if (used.state === "unavailable") {
        setHealth("unavailable");
        throw new Error(options.keys.shown() ? SECRETS_LOCKED : NO_SECRETS);
      }
      const response = used.state === "completed" ? used.result : undefined;
      if (!(response instanceof Response)) {
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
      access = { token: issued.accessToken, expiresAt: issued.expiresAt };
      // Google may hand a new lasting key: it replaces the old one in place, under its reference.
      if (issued.refreshToken)
        await options.keys.keepHidden({
          ref,
          label: KEY_LABEL,
          value: Buffer.from(issued.refreshToken, "utf8"),
        });
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
    const token = access?.token;
    if (!token) throw new Error(SIGN_IN_AGAIN);
    try {
      return await fetchImpl(`${root}${path}`, {
        method: init?.method ?? "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init?.json !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        signal: timeout(),
      });
    } catch {
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
      if (!access || access.expiresAt - options.now() < GOOGLE_REQUEST_TIMEOUT_MS) await renew();
      let response = await send(root, label, path, init);
      if (response.status === 401) {
        access = undefined;
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

  /** Tell Google to forget the sign-in, as far as it can be reached; an access key revokes its lasting key too. */
  const revoke = async (token: string | undefined) => {
    if (!token) return;
    try {
      await fetchImpl(options.endpoints.revoke, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: timeout(),
      });
    } catch {
      // Unreachable: the sign-in is forgotten here regardless.
    }
  };

  /**
   * Forget a sign-in: here at once, then at Google and in Secrets. With no
   * access key in memory, a renewal makes one to revoke with - under the
   * saved decision that covers renewals, or asking once when there is none.
   */
  const forgetSignIn = (
    record: { key?: string } | undefined,
    token: string | undefined,
    renewToRevoke = true,
  ) => {
    store.remove();
    access = undefined;
    held = undefined;
    waitUntil = 0;
    const earlier = moved.present() ? moved.lastingKey() : undefined;
    return (async () => {
      let bearer = token ?? earlier;
      if (!bearer && record?.key && renewToRevoke) {
        register();
        forgetting.add(record.key);
        const used = await options.keys
          .use({
            id: randomUUID(),
            reason: "Infinitary tells Google to forget the Google sign-in you removed.",
            broker: GOOGLE_BROKER,
            input: { ref: record.key },
          })
          .catch(() => undefined);
        const response = used?.result instanceof Response ? used.result : undefined;
        const body = response?.ok
          ? ((await response.json().catch(() => ({}))) as Record<string, unknown>)
          : {};
        bearer = issuedFrom(body, options.now())?.accessToken;
        forgetting.delete(record.key);
      }
      await revoke(bearer);
      if (record?.key) await options.keys.forgetHidden(record.key);
      try {
        moved.remove();
      } catch {
        // Its folder could not be removed; nothing reads it again.
      }
    })();
  };

  return {
    /**
     * The one move at start: a sign-in an earlier version kept in its own
     * file goes into Secrets now, rather than at its first renewal. Locked
     * Secrets leaves the file for the next use; nothing reads it meanwhile.
     */
    moveKeys: async () => {
      if (!moved.present()) return;
      if (!store.read()) {
        // No sign-in to move it to: the earlier file only goes.
        try {
          moved.remove();
        } catch {
          // Nothing reads it again.
        }
        return;
      }
      await lastingKey().catch(() => {});
    },
    kind: "google",
    // One Google sign-in: its name stays its own while signed out (INF-946).
    identity: { id: GOOGLE_ID, name: INTEGRATION_KIND_NAMES.google },
    fence: GOOGLE_DATA_FENCE,
    kept: GOOGLE_DATA_KEPT,
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
      const earlier = store.read();
      // A new sign-in keeps its key under a fresh reference, so the captain is asked again.
      const key = await options.keys.keepHidden({
        label: KEY_LABEL,
        value: Buffer.from(issued.refreshToken, "utf8"),
      });
      const forget = async (words: string): Promise<never> => {
        await revoke(issued.accessToken);
        if (key) await options.keys.forgetHidden(key);
        // A failed sign-in leaves none, as a replaced key always did; nothing is renewed to revoke it.
        await forgetSignIn(earlier, undefined, false);
        options.changed();
        throw new Error(words);
      };
      // A computer without Secrets, or with it locked, keeps no sign-in: Google forgets it too.
      if (!key) return forget(options.keys.shown() ? SECRETS_LOCKED : NO_SECRETS);
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
        const response = await fetchImpl(`${gmailRoot}/profile`, {
          redirect: "error",
          headers: { accept: "application/json", authorization: `Bearer ${issued.accessToken}` },
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
      held = undefined;
      access = { token: issued.accessToken, expiresAt: issued.expiresAt };
      store.write({
        account,
        scopes: issued.scopes,
        expiresAt: issued.expiresAt,
        health: "ok",
        signedInAt: options.now(),
        key,
      });
      // The sign-in this one replaces: its key goes, and an earlier version's file with it.
      if (earlier?.key && earlier.key !== key) await options.keys.forgetHidden(earlier.key);
      try {
        moved.remove();
      } catch {
        // Nothing reads it again.
      }
      return GOOGLE_ID;
    },
    check: async () => {
      if (!store.read()) return;
      // Checking is the captain's own ask: a renewal they did not allow is asked again.
      held = undefined;
      try {
        await gmail("/profile");
      } catch {
        // The health it found is kept; the row shows it.
      }
    },
    remove: async () => {
      const token = access?.token;
      const forgotten = forgetSignIn(store.read(), token);
      // With an access key in memory, Google is told before Settings answers;
      // a renewal to make one may wait on the captain, so it follows instead.
      if (token) await forgotten;
      else void forgotten;
    },
    redact: (text) => (access ? text.split(access.token).join(REDACTED) : text),
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
