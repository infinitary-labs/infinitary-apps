import { randomUUID } from "node:crypto";
import type { ForgeSignInState } from "@shared/forges";
import * as m from "@shared/i18n/messages.generated";
import {
  GOOGLE_CLIENTS_PAGE,
  GOOGLE_DATA_KEPT,
  googleMcpEnablePage,
  INTEGRATION_KIND_NAMES,
  type IntegrationClientView,
} from "@shared/integrations";
import { httpSecretBroker } from "../../../secrets/httpBroker";
import type { IntegrationAnswer, IntegrationBinding } from "../../binding";
import { type IntegrationKeys, REDACTED } from "../../secrets";
import {
  CALENDAR_ACTIONS,
  CALENDAR_CHANGED_EVENT,
  lookForCalendar,
  runCalendarAction,
} from "./calendar";
import {
  DRIVE_SCOPE,
  GMAIL_SCOPE,
  GOOGLE_REQUIRED_SCOPES,
  GOOGLE_SCOPES,
  type GoogleClient,
  type GoogleEndpoints,
} from "./client";
import { readGoogleClientFile } from "./clientFile";
import { DRIVE_ACTIONS, runDriveAction } from "./drive";
import {
  GMAIL_ACTIONS,
  GMAIL_MESSAGE_EVENT,
  type GmailFiles,
  lookForMail,
  runGmailAction,
} from "./gmail";
import {
  GoogleAsksToConfirm,
  type GoogleHeard,
  type GoogleService,
  GoogleToolRefused,
  googleMcp,
} from "./mcp";
import { MovedGoogleKeys } from "./movedKeys";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  type GoogleTokenExchange,
  issuedFrom,
  type LoopbackSignInOptions,
  signInOnLoopback,
} from "./signIn";
import { type GoogleClientRecord, GoogleClientStore, GoogleSignInStore } from "./store";

/**
 * Google as an integration (docs/integrations.md, "Google"): one row that
 * signs in once, in the person's own browser, for every permission Gmail,
 * Calendar and Drive need (the captain's q8 on INF-775), as the person's own
 * Google client, kept from the file Google gives for it (INF-5549's plan,
 * pieces 2 and 3). A new sign-in takes only an own client, unless the run
 * names a client of its own for development or tests (`googleSetup`); a
 * sign-in made with Infinitary's retired client has no client to renew it,
 * so it reads as needing a sign-in, which asks for an own client first.
 * The own client's secret is a
 * second hidden Secrets entry the same broker adds to the code exchange and
 * every renewal, so it never reaches this code either. Its lasting key
 * lives in Secrets, as a hidden entry used only through the renewal broker
 * below (INF-785): each renewal is a brokered use, and the captain's one
 * saved decision on the first covers every later one. The access key a renewal gives lives only in the app's
 * memory and goes on each request to Gmail's, Calendar's and Drive's MCP servers
 * (`./mcp`), to Gmail's own API for an attached file (`GmailFiles`), and
 * on removal to tell Google to forget the sign-in. A renewal the captain did not allow,
 * or let run out, is not asked again until the captain checks the row, signs in
 * again or the app starts again. The row has no key fields, since nothing
 * about it is pasted.
 *
 * Health is the forge sign-in's words: `needs_reauth` only from proof - Google
 * refused the lasting key or the person's own client, or the sign-in was
 * made with a client the person no longer keeps - and `unavailable` when
 * Google could not be reached or failed. A key refused again just after a
 * real renewal is not the sign-in's fault: Google asks an AI-powered agent
 * to use a client marked for one, so that refusal is read as the missing
 * mark, the sign-in stays and the row says what to tick (`client().mcp`), as
 * it does for a service whose MCP server is off.
 * When Google asks the app to slow down and says for how long (Retry-After),
 * every request waits that long, and a rule's look tries again on its next
 * minute.
 */

const GOOGLE_ID = "google";

/**
 * The label Gmail, Calendar and Drive answers and event summaries reach every
 * agent under (INF-951): anyone can write a message, an invitation or a shared file, so
 * its words sit between marks they could not forge, as data from outside
 * (docs/integrations.md, "Data from outside").
 */
export const GOOGLE_DATA_FENCE = "google-data";
/** The renewal broker's id, registered once with Secrets. */
const GOOGLE_BROKER = "google-sign-in";
/** The words Secrets shows for the lasting key and for its broker. */
const KEY_LABEL = "Google sign-in";
/** The words Secrets shows for the person's own client's secret. */
// i18n-exempt: the Secrets entry's name, kept with the entry, as the sign-in's is
const CLIENT_LABEL = "Google client";
/** Google's token answers that refuse the client itself, rather than the sign-in. */
const CLIENT_REFUSALS = ["invalid_client", "deleted_client"] as const;

const NO_SECRETS =
  "Google keeps its sign-in in Secrets, which this computer does not offer. Google is not available here.";
const SECRETS_LOCKED =
  "Google waits for Secrets, which is locked or cannot open now. Unlock it in Settings -> Secrets.";
const SIGN_IN_AGAIN = "Google is signed out. Sign in again in Settings -> Integrations.";
/** A Drive call on a sign-in without Drive's permission: nothing reaches Google. */
const WITHOUT_DRIVE =
  "Not run: Drive, Docs and Sheets were not added to the captain's Google sign-in, so nothing reached Google. The captain chooses Sign in again on the Google row in Settings -> Integrations and leaves the Drive box ticked; Gmail and Calendar keep working meanwhile.";

export type GoogleIntegrationOptions = {
  /** The integrations folder, where `google.json` lives. */
  root: string;
  /** Secrets, where the lasting key is kept (`IntegrationKeys`). */
  keys: IntegrationKeys;
  /**
   * The run's own client, named only by a development run: it takes a new
   * sign-in while the person keeps no client of their own, and renews one
   * made with it. Absent, a sign-in made with Infinitary's retired client
   * cannot renew.
   */
  client?: GoogleClient;
  endpoints: GoogleEndpoints;
  /** Opens Google's consent page in the person's browser (`LoopbackSignInOptions.open`). */
  open: LoopbackSignInOptions["open"];
  now: () => number;
  /** The row changed on its own (its health), so Settings reads it again. */
  changed: () => void;
  /** Every request to Google: the sign-in's, Gmail's, Calendar's and each renewal's inside Secrets. */
  fetch?: typeof fetch;
  /** The app's version, which the MCP clients name to Google. */
  version?: string;
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

/** The person's own Desktop app client, as they give it: its id and its secret. */
export type GoogleOwnClient = { id: string; secret: Buffer };

/** Which client a renewal speaks as: the person's own, or the run's when none. */
type RenewingClient = { own?: GoogleClientRecord };

export function googleIntegration(options: GoogleIntegrationOptions): IntegrationBinding & {
  moveKeys: () => Promise<void>;
  client: NonNullable<IntegrationBinding["client"]>;
  /**
   * Keep the person's own client: its secret in Secrets, its id and that
   * secret's reference in the client record. The next sign-in uses it; a
   * sign-in made with another client stops renewing.
   */
  keepClient: (client: GoogleOwnClient) => Promise<void>;
} {
  const store = new GoogleSignInStore(options.root);
  const clients = new GoogleClientStore(options.root);
  const moved = new MovedGoogleKeys(options.root);
  const fetchImpl = options.fetch ?? fetch;
  const gmailRoot = `${options.endpoints.gmail.replace(/\/+$/, "")}/gmail/v1/users/me`;
  const runClient = options.client
    ? {
        client_id: options.client.id,
        ...(options.client.secret ? { client_secret: options.client.secret } : {}),
      }
    : undefined;
  let renewing: Promise<void> | undefined;
  let moving: Promise<string> | undefined;
  /** The access key, in memory only: a start renews it once. */
  let access: { token: string; expiresAt: number } | undefined;
  let registered = false;
  /**
   * Keys of sign-ins just removed, renewed once more only to revoke them at
   * Google, with the client they were made with.
   */
  const forgetting = new Map<string, RenewingClient>();
  /** Code exchanges of sign-ins in progress with the person's own client, by a one-use id. */
  const exchanges = new Map<string, { own: GoogleClientRecord; form: Record<string, string> }>();
  /** Until when Google asked the app to wait, on the app's clock. */
  let waitUntil = 0;
  /** What Google's MCP servers last refused, by service, in memory only: the next answer clears it. */
  const refusals = new Map<
    GoogleService,
    Exclude<GoogleHeard, { kind: "answered" | "unavailable" }>
  >();
  /**
   * The access key Google refused just after renewing it: renewing again
   * cannot help until the captain marks the client, so a request with it
   * stops there, until the key ends or the captain checks the row.
   */
  let agentRefused: string | undefined;

  const setHealth = (health: ForgeSignInState) => {
    const record = store.read();
    if (!record || record.health === health) return;
    store.write({ ...record, health });
    options.changed();
  };
  const timeout = () => AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS);

  /**
   * The client the current sign-in renews as: undefined when it was made
   * with a client the person no longer keeps, which can never renew it.
   */
  const renewingClient = (record: { client?: string }): RenewingClient | undefined => {
    if (!record.client) return runClient ? {} : undefined;
    const own = clients.read();
    return own?.id === record.client ? { own } : undefined;
  };

  /**
   * When the lasting key ends, kept only for a sign-in made with the
   * person's own client: a sign-in made with the run's own then stays
   * readable to an older build, whose strict schema knows no such field.
   */
  const endOf = (own: GoogleClientRecord | undefined, endsAt: number | undefined) =>
    own && endsAt !== undefined ? { endsAt } : {};

  /** The person's own client's secret, added by Secrets to the form's client_secret field. */
  const clientSecret = (own: GoogleClientRecord) => ({
    client: { ref: own.secret, delivery: { kind: "form" as const, name: "client_secret" } },
  });

  /**
   * Google refused the person's own client itself: kept on its record, so a
   * client gone reads apart from a sign-in Google ended.
   */
  const clientRefused = (own: GoogleClientRecord | undefined, body: Record<string, unknown>) => {
    const error = CLIENT_REFUSALS.find((reason) => errorOf(body).reasons.includes(reason));
    if (!own || !error) return undefined;
    const current = clients.read();
    if (current?.id === own.id && current.secret === own.secret)
      clients.write({ ...current, refused: { error, at: options.now() } });
    return error;
  };

  /**
   * The renewal broker: the lasting key in the form's refresh_token field,
   * sent to Google's token address and nowhere else. Signing in to Google
   * in the app is the consent, so it declares the app's own sign-in and
   * Secrets runs each renewal, and the revoke at sign-out, without asking
   * (docs/secrets.md, "App sign-ins").
   */
  const register = () => {
    if (registered) return;
    registered = true;
    options.keys.registerBroker(
      httpSecretBroker({
        id: GOOGLE_BROKER,
        label: KEY_LABEL,
        signIn: true,
        resolve: (input) => {
          const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
          // Only a code exchange this binding began, by its one-use id; never a form a caller made up.
          if (typeof given.exchange === "string") {
            const pending = exchanges.get(given.exchange);
            if (!pending) return undefined;
            return {
              url: options.endpoints.token,
              method: "POST",
              headers: { accept: "application/json" },
              form: pending.form,
              credentials: clientSecret(pending.own),
              operation: m.integrationsGoogleExchangeOperation(),
              read: false,
              result: m.integrationsGoogleExchangeResult(),
            };
          }
          const ref = given.ref;
          if (typeof ref !== "string") return undefined;
          // Only the key the current sign-in names; never a reference a caller made up.
          const record = store.read();
          const renewing =
            forgetting.get(ref) ?? (record?.key === ref ? renewingClient(record) : undefined);
          if (!renewing) return undefined;
          const { own } = renewing;
          return {
            url: options.endpoints.token,
            method: "POST",
            headers: { accept: "application/json" },
            form: {
              ...(own ? { client_id: own.id } : (runClient ?? {})),
              grant_type: "refresh_token",
            },
            credentials: {
              refresh: { ref, delivery: { kind: "form", name: "refresh_token" } },
              ...(own ? clientSecret(own) : {}),
            },
            operation: "Renew the Google sign-in so Gmail, Calendar and Drive keep working",
            read: false,
            result: "A new Google access key, kept only in the app's memory",
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
      const ref = await lastingKey();
      const signedIn = store.read();
      const renewingAs = signedIn ? renewingClient(signedIn) : undefined;
      if (!renewingAs) {
        // Made with a client the person no longer keeps: only a new sign-in serves.
        setHealth("needs_reauth");
        throw new Error(SIGN_IN_AGAIN);
      }
      register();
      const used = await options.keys.use({
        id: randomUUID(),
        reason: "Infinitary renews your Google sign-in so Gmail, Calendar and Drive keep working.",
        broker: GOOGLE_BROKER,
        input: { ref },
      });
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
        const refused = clientRefused(renewingAs.own, body);
        if (refused) {
          setHealth("needs_reauth");
          throw new Error(
            `Google no longer accepts your Google client (${refused}), so Google is signed out.`,
          );
        }
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
      if (record)
        store.write({
          ...record,
          expiresAt: issued.expiresAt,
          ...endOf(renewingAs.own, issued.endsAt),
        });
    })().finally(() => {
      renewing = undefined;
    });
    return renewing;
  };

  /** The access key in memory now, read after a renewal has set it. */
  const accessToken = (): string | undefined => access?.token;

  /** The access key for the next request, renewed first when it is about to end. */
  const key = async (label: string): Promise<string> => {
    const wait = Math.ceil((waitUntil - options.now()) / 1000);
    if (wait > 0) throw new Error(`${label} asked the app to wait ${wait} more seconds.`);
    if (!store.read()) throw new Error(SIGN_IN_AGAIN);
    if (!access || access.expiresAt - options.now() < GOOGLE_REQUEST_TIMEOUT_MS) await renew();
    const token = accessToken();
    if (!token) throw new Error(SIGN_IN_AGAIN);
    return token;
  };

  /** A key Google refused: a newer one when there is one, renewed unless renewing cannot help. */
  const renewed = async (refused: string): Promise<string | undefined> => {
    if (access && access.token !== refused) return access.token;
    if (agentRefused === refused) return undefined;
    access = undefined;
    await renew();
    return accessToken();
  };

  const heard = (service: GoogleService, said: GoogleHeard) => {
    if (said.kind === "unavailable") {
      setHealth("unavailable");
      return;
    }
    const before = JSON.stringify(refusals.get(service) ?? null);
    if (said.kind === "answered") {
      refusals.delete(service);
      agentRefused = undefined;
    } else {
      refusals.set(service, said);
      if (said.kind === "agent") agentRefused = access?.token;
    }
    // A refusal says nothing against the sign-in itself, which Google just took or renewed.
    setHealth("ok");
    if (JSON.stringify(refusals.get(service) ?? null) !== before) options.changed();
  };

  const mcpOf = (service: GoogleService, url: string, label: string) =>
    googleMcp({
      service,
      url,
      label,
      version: options.version ?? "0.0.0",
      fetch: fetchImpl,
      timeoutMs: GOOGLE_REQUEST_TIMEOUT_MS,
      key: () => key(label),
      renewed,
      slowed: (header) => {
        const after = retryAfter(header, options.now());
        if (after !== undefined) waitUntil = options.now() + after;
        return after;
      },
      heard,
    });
  // i18n-exempt: a product name
  const gmail = mcpOf("gmail", options.endpoints.gmailMcp, "Gmail");
  // i18n-exempt: a product name
  const calendar = mcpOf("calendar", options.endpoints.calendarMcp, "Google Calendar");
  // i18n-exempt: a product name
  const drive = mcpOf("drive", options.endpoints.driveMcp, "Google Drive");
  /** Whether the sign-in granted Drive's permission (the captain's answer 2a on INF-6447). */
  const hasDrive = (record: { scopes: readonly string[] } | undefined) =>
    record?.scopes.includes(DRIVE_SCOPE) === true;

  /**
   * One attached file from Gmail's own API, the one place that hands its
   * bytes (`GmailFiles`), with the same access key; a key Gmail refuses is
   * renewed once. Its refusal or failure is the call's alone: the row's
   * health follows Gmail's MCP server, which every other call reaches.
   */
  const gmailFiles: GmailFiles = {
    now: options.now,
    attachment: async (message, attachment) => {
      const fetchWith = async (token: string) => {
        try {
          return await fetchImpl(
            `${gmailRoot}/messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(attachment)}`,
            {
              redirect: "error",
              headers: { accept: "application/json", authorization: `Bearer ${token}` },
              signal: timeout(),
            },
          );
        } catch {
          throw new Error("Could not reach Gmail.");
        }
      };
      const token = await key("Gmail");
      let response = await fetchWith(token);
      if (response.status === 401) {
        const fresh = await renewed(token);
        if (fresh) response = await fetchWith(fresh);
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok && typeof body.data === "string") return Buffer.from(body.data, "base64url");
      if (response.status === 429) {
        const after = retryAfter(response.headers.get("retry-after"), options.now());
        if (after !== undefined) waitUntil = options.now() + after;
        throw new Error(
          `Gmail asked the app to slow down${after !== undefined ? ` for ${Math.ceil(after / 1000)} seconds` : ""}.`,
        );
      }
      // i18n-exempt: words served to the crew, which stay English
      const said = errorOf(body).message ?? `status ${response.status}`;
      // i18n-exempt: words served to the crew, which stay English
      if (response.ok || response.status < 500)
        throw new GoogleToolRefused(`Gmail refused the file: ${said}`);
      throw new Error(`Gmail failed (${said}).`);
    },
  };

  /** Let go of both MCP connections and what they were refused: the sign-in they spoke for is gone. */
  const letGo = async () => {
    refusals.clear();
    agentRefused = undefined;
    await Promise.all([gmail.close(), calendar.close(), drive.close()]);
  };

  /**
   * One harmless read from each MCP server the sign-in reaches, so the row
   * says what Google refuses before the crew or a rule meets it. Drive's
   * asks for no file's words and keeps nothing of its answer.
   */
  const probe = async () => {
    await Promise.allSettled([
      gmail.tools()("list_labels", {}),
      calendar.tools()("list_calendars", {}),
      ...(hasDrive(store.read())
        ? [drive.tools()("search_files", { pageSize: 1, excludeContentSnippets: true })]
        : []),
    ]);
  };

  /** What the row says of Google's MCP refusals: the client's mark first, since it stops both services. */
  const mcpFact = (): IntegrationClientView["mcp"] => {
    if ([...refusals.values()].some((refusal) => refusal.kind === "agent")) {
      // A client id starts with its project's number, which opens the client in its own project.
      const own = clients.read()?.id;
      const project = own ? /^(\d+)-/.exec(own)?.[1] : undefined;
      return {
        refused: "agent",
        link:
          own && project
            ? `${GOOGLE_CLIENTS_PAGE}/${encodeURIComponent(own)}?project=${project}`
            : GOOGLE_CLIENTS_PAGE,
      };
    }
    const off = (["gmail", "calendar", "drive"] as const).flatMap((service) => {
      const refusal = refusals.get(service);
      return refusal?.kind === "service" ? [{ service, link: refusal.link }] : [];
    });
    const [first] = off;
    if (!first) return undefined;
    const services = off.map((entry) => entry.service);
    // A view from before `off` names only Gmail and Calendar.
    const older = services.filter((service) => service !== "drive");
    const named = {
      ...(older.length > 0 ? { services: older as ("gmail" | "calendar")[] } : {}),
      off: services,
    };
    if (off.length === 1) return { refused: "service", ...named, link: first.link };
    // More than one off: one page turns them all on, in the project Google named.
    const project = new URL(first.link).searchParams.get("project") ?? undefined;
    return { refused: "service", ...named, link: googleMcpEnablePage(services, project) };
  };

  /** Google's question or refusal, as an answer the service carries. */
  const answered = async (run: () => Promise<IntegrationAnswer>): Promise<IntegrationAnswer> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GoogleAsksToConfirm) return { text: "", confirm: error.confirm };
      if (error instanceof GoogleToolRefused) return { text: error.message, refused: "refused" };
      throw error;
    }
  };

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
   * access key in memory, a renewal makes one to revoke with, under the
   * same sign-in consent as every renewal.
   */
  const forgetSignIn = (
    record: { key?: string; client?: string } | undefined,
    token: string | undefined,
    renewToRevoke = true,
    /** Removing the connection: the person's own client goes too, after the revoke. */
    withClient = false,
  ) => {
    const renewingAs = record ? renewingClient(record) : undefined;
    const own = withClient ? clients.read() : undefined;
    store.remove();
    if (withClient) clients.remove();
    access = undefined;
    waitUntil = 0;
    void letGo();
    const earlier = moved.present() ? moved.lastingKey() : undefined;
    return (async () => {
      let bearer = token ?? earlier;
      if (!bearer && record?.key && renewToRevoke && renewingAs) {
        register();
        forgetting.set(record.key, renewingAs);
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
      if (own) await options.keys.forgetHidden(own.secret);
      try {
        moved.remove();
      } catch {
        // Its folder could not be removed; nothing reads it again.
      }
    })();
  };

  /** The code exchange for the person's own client, run inside Secrets so its secret is added there. */
  const exchangeAs =
    (own: GoogleClientRecord): GoogleTokenExchange =>
    async (form, signal) => {
      if (signal.aborted) throw new Error("Could not reach Google to finish signing in.");
      register();
      const id = randomUUID();
      exchanges.set(id, { own, form });
      try {
        const used = await options.keys.use({
          id: randomUUID(),
          reason: m.integrationsGoogleExchangeReason(),
          broker: GOOGLE_BROKER,
          input: { exchange: id },
        });
        if (used.state === "unavailable")
          throw new Error(options.keys.shown() ? SECRETS_LOCKED : NO_SECRETS);
        const response = used.state === "completed" ? used.result : undefined;
        if (!(response instanceof Response))
          throw new Error("Could not reach Google to finish signing in.");
        // Cancelled while Google answered: the answer is dropped unread, as a direct exchange's
        // aborted fetch drops it. Revoking it would end every sign-in this account made with
        // this client at Google, the earlier one the person kept among them.
        if (signal.aborted) throw new Error("Could not reach Google to finish signing in.");
        if (!response.ok)
          clientRefused(
            own,
            (await response
              .clone()
              .json()
              .catch(() => ({}))) as Record<string, unknown>,
          );
        return response;
      } finally {
        exchanges.delete(id);
      }
    };

  const keep = async ({ id, secret }: GoogleOwnClient) => {
    if (!id.trim()) throw new Error("A Google client needs its client id.");
    if (!options.keys.shown()) throw new Error(NO_SECRETS);
    const earlier = clients.read();
    // The same client's new secret replaces the old in place; another client gets its own entry.
    const ref = await options.keys.keepHidden({
      ...(earlier?.id === id ? { ref: earlier.secret } : {}),
      label: CLIENT_LABEL,
      value: secret,
    });
    if (!ref) throw new Error(SECRETS_LOCKED);
    clients.write({ id, secret: ref });
    if (earlier && earlier.secret !== ref) await options.keys.forgetHidden(earlier.secret);
    // A sign-in made with the client just replaced can no longer renew: say so
    // now, as its next renewal would, so the row offers Sign in again.
    const signedIn = store.read();
    if (signedIn && !renewingClient(signedIn)) setHealth("needs_reauth");
    options.changed();
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
    saved: () => store.present(),
    connections: () => {
      const record = store.read();
      if (!record) return [];
      return [
        {
          id: GOOGLE_ID,
          account: record.account,
          // A sign-in made with Infinitary's retired client has nothing to renew it.
          health: !record.client && !runClient ? "needs_reauth" : record.health,
          actions: [
            ...GMAIL_ACTIONS,
            ...CALENDAR_ACTIONS,
            ...(hasDrive(record)
              ? DRIVE_ACTIONS
              : DRIVE_ACTIONS.map((spec) => ({ ...spec, unavailable: WITHOUT_DRIVE }))),
          ],
          events: [GMAIL_MESSAGE_EVENT, CALENDAR_CHANGED_EVENT],
        },
      ];
    },
    client: () => {
      const own = clients.read();
      const record = store.read();
      const mcp = mcpFact();
      return {
        kept: own !== undefined,
        ...(own?.refused ? { refused: own.refused.error } : {}),
        ...(record?.endsAt !== undefined ? { endsAt: record.endsAt } : {}),
        ...(options.client ? { runClient: true as const } : {}),
        ...(record && mcp ? { mcp } : {}),
        ...(record && !hasDrive(record) ? { withoutDrive: true as const } : {}),
      };
    },
    keepClientFile: async (text) => {
      const { id, secret } = readGoogleClientFile(text);
      await keep({ id, secret: Buffer.from(secret, "utf8") });
    },
    keepClient: (client) => keep(client),
    signIn: async (signal) => {
      const own = clients.read();
      const signAs = own ? { id: own.id } : options.client;
      if (!signAs) throw new Error(m.integrationsGoogleSetUpFirst());
      const issued = await signInOnLoopback({
        client: signAs,
        endpoints: options.endpoints,
        scopes: GOOGLE_SCOPES,
        open: options.open,
        signal,
        now: options.now,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(own ? { exchange: exchangeAs(own) } : {}),
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
      // Drive may stay unticked: the sign-in keeps Gmail and Calendar (the captain's answer 2a on INF-6447).
      if (!GOOGLE_REQUIRED_SCOPES.every((scope) => issued.scopes.includes(scope)))
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
      await letGo();
      access = { token: issued.accessToken, expiresAt: issued.expiresAt };
      store.write({
        account,
        scopes: issued.scopes,
        expiresAt: issued.expiresAt,
        health: "ok",
        signedInAt: options.now(),
        key,
        ...(own ? { client: own.id } : {}),
        ...endOf(own, issued.endsAt),
      });
      // Google took the client again, so an earlier refusal no longer stands.
      const current = clients.read();
      if (own && current?.id === own.id && current.refused) {
        const { refused: _cleared, ...kept } = current;
        clients.write(kept);
      }
      // The sign-in this one replaces: its key goes, and an earlier version's file with it.
      if (earlier?.key && earlier.key !== key) await options.keys.forgetHidden(earlier.key);
      try {
        moved.remove();
      } catch {
        // Nothing reads it again.
      }
      // Its answers reach the row on their own (`heard`); the sign-in is kept either way.
      void probe();
      return GOOGLE_ID;
    },
    check: async () => {
      if (!store.read()) return;
      // The captain may have marked the client since: a refused key is renewed once more.
      agentRefused = undefined;
      // The health and refusals it finds are kept; the row shows them.
      await probe();
    },
    remove: async () => {
      const token = access?.token;
      const forgotten = forgetSignIn(store.read(), token, true, true);
      // With an access key in memory, Google is told before Settings answers;
      // a renewal to make one may wait on the captain, so it follows instead.
      if (token) await forgotten;
      else void forgotten;
    },
    redact: (text) => (access ? text.split(access.token).join(REDACTED) : text),
    call: async (_id, action, input, _caller, confirmed) => {
      const record = store.read();
      if (!record) throw new Error(SIGN_IN_AGAIN);
      if (DRIVE_ACTIONS.some((spec) => spec.name === action)) {
        // A kept ask the captain clicks can outlive the sign-in it was asked under.
        if (!hasDrive(record)) return { text: WITHOUT_DRIVE, refused: "refused" };
        return answered(() => runDriveAction(drive.tools(confirmed), action, input));
      }
      return answered(() =>
        CALENDAR_ACTIONS.some((spec) => spec.name === action)
          ? runCalendarAction(calendar.tools(confirmed), record.account, action, input)
          : runGmailAction(gmail.tools(confirmed), action, input, gmailFiles),
      );
    },
    look: async (_id, event, cursor, filter) => {
      const record = store.read();
      if (!record) throw new Error(SIGN_IN_AGAIN);
      return event === CALENDAR_CHANGED_EVENT.name
        ? lookForCalendar(calendar.tools(), record.account, cursor, options.now, filter)
        : lookForMail(gmail.tools(), record.account, cursor, options.now, filter);
    },
    close: letGo,
  };
}
