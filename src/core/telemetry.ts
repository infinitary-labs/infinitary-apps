import { settingFrom } from "@shared/envSettings";
// The Diagnostics wire (decision D-12, revised 2026-09-22; `docs/sharing.md`
// is the one home). It carries only the events `src/shared/diagnostics.ts`
// declares - each with its declared enum/boolean/number fields, the app
// version and the anonymous install ID - to the self-hosted Umami instance
// Infinitary Labs, Inc. operates. The body is built in one place
// (`buildDiagnosticBody`), and the client re-checks every body against the
// same allowlist before it posts (`diagnosticBodyViolation`), so nothing
// outside the policy can leave even through a caller that builds its own.
//
// Source/dev/test builds have no destination unless a website id is
// explicitly supplied; release builds inject the host and website id at
// build time through electron.vite.config.ts (repository variables, not
// secrets). Pi's own telemetry stays off separately
// (enableInstallTelemetry: false).

import {
  DIAGNOSTIC_INSTALL_ID_PATTERN,
  type DiagnosticEvent,
  diagnosticDataViolation,
  isPhoneDiagnosticEvent,
} from "@shared/diagnostics";

const HARDCODED_FALLBACK_HOST = "https://diagnostics.getinfinitary.com";
const UMAMI_PATH = "/api/send";
const DEFAULT_HOSTNAME = "app";
const DEFAULT_TITLE = "Firstmate 3000";
const DEFAULT_APP = "firstmate-3000";
/**
 * A phone's events go under names of their own on the same site, so the
 * computer's series keeps its names (docs/sharing.md, "A phone's events").
 */
export const PHONE_DIAGNOSTIC_NAMES = {
  hostname: "ios",
  title: "Infinitary",
  app: "infinitary-ios",
} as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Every key a body's payload has: no more, no fewer. */
const PAYLOAD_KEYS = ["data", "hostname", "id", "name", "timestamp", "title", "url", "website"];

export type TelemetryEnv = Record<string, string | undefined>;

export type ResolveTelemetryConfigInput = {
  env: TelemetryEnv;
  buildHost: string;
  buildWebsiteID: string;
};

export type ResolvedTelemetryConfig = {
  enabled: boolean;
  host: string;
  websiteID: string;
};

/** What every body is built from besides the event: the endpoint's site key and the app version. */
export type DiagnosticsConfig = {
  /** The endpoint's routing key: the same for every install, so it tells no one apart. */
  websiteID: string;
  version: string;
  app?: string;
};

export type TelemetryClientConfig = DiagnosticsConfig & {
  enabled: boolean;
  host: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
};

/** The wire: it posts a body `buildDiagnosticBody` made, and refuses anything else. */
export interface TelemetryClient {
  /**
   * Resolves true only when the endpoint accepted it; never throws. A body
   * outside the policy (`diagnosticBodyViolation`) is refused unsent.
   */
  send(body: Record<string, unknown>): Promise<boolean>;
  close(timeoutMs?: number): Promise<void>;
}

export function resolveTelemetryConfig(
  input: ResolveTelemetryConfigInput,
): ResolvedTelemetryConfig {
  const optOut = String(settingFrom(input.env, "TELEMETRY") || "")
    .trim()
    .toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "off") {
    return { enabled: false, host: "", websiteID: "" };
  }

  const websiteID =
    String(settingFrom(input.env, "UMAMI_WEBSITE_ID") || "").trim() || input.buildWebsiteID.trim();
  if (!websiteID) {
    return { enabled: false, host: "", websiteID: "" };
  }

  const host =
    String(settingFrom(input.env, "UMAMI_HOST") || "").trim() ||
    input.buildHost.trim() ||
    HARDCODED_FALLBACK_HOST;
  return { enabled: true, host, websiteID };
}

// These references are replaced at build time by electron-vite's `define`,
// which replaces only these exact expressions: read through anything else -
// a setting reader, an index by name - they reach the packaged app's own
// environment at run time instead, and a release build has no destination.
// In source/dev/test they read as undefined and the build has no destination.
export function getBuildTimeUmamiHost(): string {
  return process.env.INFINITARY_BUILD_UMAMI_HOST || "";
}

export function getBuildTimeUmamiWebsiteID(): string {
  return process.env.INFINITARY_BUILD_UMAMI_WEBSITE_ID || "";
}

export function createTelemetryClient(config: TelemetryClientConfig): TelemetryClient {
  if (!config.enabled || !config.websiteID) {
    return new NoopTelemetryClient();
  }
  const endpoint = normalizeEndpoint(config.host);
  if (!endpoint) {
    return new NoopTelemetryClient();
  }
  return new HttpTelemetryClient(endpoint, config);
}

export type InitTelemetryInput = {
  app?: string;
  version: string;
  env?: TelemetryEnv;
  fetch?: typeof fetch;
};

export type AppTelemetry = {
  /** The wire client: a no-op where this build has no destination. */
  client: TelemetryClient;
  /** What every body is built from, for the viewer to build the same. */
  body: DiagnosticsConfig;
  /** Where the client sends, as a host the person can read; null = nowhere. */
  destination: string | null;
};

/**
 * The app's wire client, built once at boot from the build-time ids and the
 * environment and handed to the sharing service, which alone decides when
 * an event goes (`src/core/sharing/sharingService.ts`).
 */
export function createAppTelemetry(init: InitTelemetryInput): AppTelemetry {
  const resolved = resolveTelemetryConfig({
    env: init.env || process.env,
    buildHost: getBuildTimeUmamiHost(),
    buildWebsiteID: getBuildTimeUmamiWebsiteID(),
  });
  const app = init.app || DEFAULT_APP;
  const client = createTelemetryClient({
    enabled: resolved.enabled,
    host: resolved.host,
    websiteID: resolved.websiteID,
    app,
    version: init.version,
    ...(init.fetch ? { fetch: init.fetch } : {}),
  });
  const endpoint = resolved.enabled ? normalizeEndpoint(resolved.host) : null;
  return {
    client,
    body: { websiteID: resolved.websiteID, app, version: init.version },
    destination: endpoint ? new URL(endpoint).host : null,
  };
}

/** A body the policy refuses: never built, never posted. */
export class DiagnosticPolicyError extends Error {}

/**
 * The exact request body of one event - the ONE place a body is built, so
 * what the payload viewer shows is what the wire carries. The payload is
 * Umami's event shape: the endpoint's site key, fixed names (a phone's
 * event goes under `PHONE_DIAGNOSTIC_NAMES`), the event's
 * name and data (its declared fields plus the app version), the time it
 * happened to the second, and `id`, the anonymous install ID, which Umami
 * takes as the session's distinct identifier - so actives, the first-run
 * funnel and retention count per install. Throws `DiagnosticPolicyError`
 * for anything outside the allowlist rather than sending less or more.
 */
export function buildDiagnosticBody(
  config: DiagnosticsConfig,
  event: DiagnosticEvent,
  installId: string,
  atMs: number,
): Record<string, unknown> {
  const names = fixedNamesFor(event.name);
  const app = names.app ?? (config.app || DEFAULT_APP);
  const body = {
    type: "event",
    payload: {
      website: config.websiteID,
      hostname: names.hostname,
      title: names.title,
      url: `app://${app}/${event.name}`,
      name: event.name,
      data: { ...event.data, version: config.version },
      timestamp: Math.floor(atMs / 1000),
      id: installId,
    },
  };
  const violation = diagnosticBodyViolation(body);
  if (violation) throw new DiagnosticPolicyError(violation);
  return body;
}

/**
 * Why a request body may not leave - null when it may. The whole shape is
 * checked, not only the data: exactly the payload keys `buildDiagnosticBody`
 * writes, the fixed names, a declared event with allowlisted data
 * (`diagnosticDataViolation`), a whole-second timestamp and an install ID
 * that is a random UUID. The wire runs this on every body it is handed.
 */
export function diagnosticBodyViolation(body: unknown): string | null {
  if (!isPlainObject(body)) return "body is not an object";
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "payload,type" || body.type !== "event") {
    return "body is not one event";
  }
  const payload = body.payload;
  if (!isPlainObject(payload)) return "payload is not an object";
  if (Object.keys(payload).sort().join(",") !== PAYLOAD_KEYS.join(",")) {
    return `payload keys are not exactly ${PAYLOAD_KEYS.join(", ")}`;
  }
  if (typeof payload.website !== "string" || !payload.website) return "no site key";
  if (typeof payload.name !== "string") return "no event name";
  const names = fixedNamesFor(payload.name);
  if (payload.hostname !== names.hostname || payload.title !== names.title) {
    return "hostname and title are not the fixed names";
  }
  if (names.app && payload.url !== `app://${names.app}/${payload.name}`) {
    return "url is not the phone's event url";
  }
  if (typeof payload.url !== "string" || !/^app:\/\/[a-z0-9-]+\/[a-z0-9_]+$/.test(payload.url)) {
    return "url is not the app's event url";
  }
  if (!payload.url.endsWith(`/${payload.name}`)) return "url does not name the event";
  const dataViolation = diagnosticDataViolation(payload.name, payload.data);
  if (dataViolation) return dataViolation;
  if (typeof payload.timestamp !== "number" || !Number.isSafeInteger(payload.timestamp)) {
    return "timestamp is not whole seconds";
  }
  if (typeof payload.id !== "string" || !DIAGNOSTIC_INSTALL_ID_PATTERN.test(payload.id)) {
    return "id is not an anonymous install ID";
  }
  return null;
}

function fixedNamesFor(name: string): { hostname: string; title: string; app?: string } {
  if (isPhoneDiagnosticEvent(name)) return PHONE_DIAGNOSTIC_NAMES;
  return { hostname: DEFAULT_HOSTNAME, title: DEFAULT_TITLE };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class NoopTelemetryClient implements TelemetryClient {
  async send(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}
}

class HttpTelemetryClient implements TelemetryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly inFlight = new Set<Promise<boolean>>();
  private closed = false;

  constructor(
    private readonly endpoint: string,
    config: TelemetryClientConfig,
  ) {
    this.fetchImpl = config.fetch || fetch;
    this.timeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    // The app and its version only: the same string on every install of a build.
    this.userAgent = `${config.app || DEFAULT_APP}/${config.version} telemetry`;
  }

  send(body: Record<string, unknown>): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    // The allowlist holds at the wire itself, whoever built the body.
    if (diagnosticBodyViolation(body)) return Promise.resolve(false);
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      return Promise.resolve(false);
    }
    const request = this.fire(text);
    this.inFlight.add(request);
    void request.finally(() => this.inFlight.delete(request));
    return request;
  }

  async close(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    this.closed = true;
    if (this.inFlight.size === 0 || timeoutMs <= 0) return;
    const drained = Promise.allSettled(Array.from(this.inFlight)).then(() => undefined);
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  private async fire(body: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      try {
        await response.body?.cancel?.();
      } catch {
        // Best effort only.
      }
      return response.ok;
    } catch {
      // Diagnostics must never affect app behavior.
      return false;
    }
  }
}

function normalizeEndpoint(host: string): string | null {
  let url: URL;
  try {
    url = new URL(String(host || "").trim());
  } catch {
    return null;
  }
  if (!url.protocol || !url.host) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith(UMAMI_PATH) ? pathname : pathname + UMAMI_PATH;
  return url.toString();
}
