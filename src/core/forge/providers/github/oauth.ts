import { settingFrom } from "@shared/envSettings";
import { GITHUB_ENTERPRISE, serverHostName } from "@shared/forges";

/**
 * The app's own GitHub sign-in (git integration PR 1.2, `docs/forge.md`):
 * GitHub's OAuth device flow for the Infinitary OAuth App, which the
 * infinitary-labs organization owns. The device flow needs no client
 * secret, so the only thing the app carries is the client id, which GitHub
 * treats as public.
 *
 * The flow: ask GitHub for a code (`requestDeviceCode`), show the person
 * the code and GitHub's page, and ask GitHub every `interval` seconds
 * whether the person has entered it (`pollForToken`). GitHub answers
 * `authorization_pending` until they do, `slow_down` when asked too often
 * (the interval grows by five seconds), `expired_token` when the code ran
 * out, and `access_denied` when the person said no.
 *
 * An OAuth App registered since GitHub's 2026-08-14 change issues
 * short-lived sign-ins by default, in the device flow too: the access
 * token lives eight hours, and the answer carries a refresh token (six
 * months without use) that buys the next pair - `refreshSignIn`, with no
 * client secret for a device-flow sign-in. A refresh token works once;
 * using it retires the access token it was issued with.
 *
 * `INFINITARY_GITHUB_OAUTH_URL` points the flow at a local stub in dev and e2e
 * only, gated exactly like the API override (`githubApiBaseUrl`), so a
 * packaged app can only ever sign in at github.com.
 */

/**
 * The Infinitary OAuth App's client id: a public identifier. Every released
 * version sends it, so it never changes - renaming the app and moving it to
 * infinitary-labs kept it (INF-875).
 */
export const GITHUB_OAUTH_CLIENT_ID = "Ov23li7sdJT3pjNDf3E7";

/**
 * What the sign-in may do: read and write the person's repositories and
 * their checks (`repo`), change a workflow file when a change carries one
 * (`workflow`), and see the organizations a listed project belongs to
 * (`read:org`).
 */
export const GITHUB_OAUTH_SCOPES = "repo workflow read:org";

export const GITHUB_OAUTH_URL = "https://github.com";

const REQUEST_TIMEOUT_MS = 30_000;
/** GitHub's own default when a response names no interval. */
const DEFAULT_INTERVAL_S = 5;
/** What GitHub asks a `slow_down` to add to the interval. */
const SLOW_DOWN_S = 5;

export function githubOAuthBaseUrl(options: {
  packaged: boolean;
  env?: NodeJS.ProcessEnv;
}): string {
  const override = settingFrom(options.env ?? process.env, "GITHUB_OAUTH_URL")?.trim();
  return !options.packaged && override ? override.replace(/\/+$/, "") : GITHUB_OAUTH_URL;
}

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInS: number;
  intervalS: number;
};

/**
 * A sign-in as GitHub hands it over. A short-lived one also carries its
 * lifetime and the refresh token that renews it; a long-lived one neither.
 */
export type IssuedSignIn = {
  token: string;
  scopes: string[];
  refreshToken?: string;
  expiresInS?: number;
  refreshExpiresInS?: number;
};

export type DeviceFlowResult =
  | ({ outcome: "signed-in" } & IssuedSignIn)
  | { outcome: "expired" }
  | { outcome: "denied" }
  | { outcome: "cancelled" };

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

type FlowOptions = {
  baseUrl?: string;
  clientId?: string;
  fetch?: typeof fetch;
};

async function postForm(
  options: FlowOptions,
  path: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? GITHUB_OAUTH_URL).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetcher(`${base}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new DeviceFlowError(`could not reach GitHub: ${message}`);
  }
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DeviceFlowError(`GitHub answered ${response.status} with something unreadable`);
  }
  // The token endpoint answers its pending/denied/expired states as 200s
  // with an `error`; anything that is neither a body nor such an answer
  // is a failure of the request itself.
  if (!response.ok && typeof body.error !== "string") {
    throw new DeviceFlowError(`GitHub answered ${response.status} to ${path}`);
  }
  return body;
}

/** Step one: a code for the person to enter on GitHub's page. */
export async function requestDeviceCode(options: FlowOptions = {}): Promise<DeviceCode> {
  const body = await postForm(options, "/login/device/code", {
    client_id: options.clientId ?? GITHUB_OAUTH_CLIENT_ID,
    scope: GITHUB_OAUTH_SCOPES,
  });
  if (typeof body.error === "string") {
    throw new DeviceFlowError(`GitHub refused the sign-in: ${body.error}`);
  }
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  const verificationUri = body.verification_uri;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new DeviceFlowError("GitHub's answer named no code");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInS: typeof body.expires_in === "number" ? body.expires_in : 900,
    intervalS: typeof body.interval === "number" ? body.interval : DEFAULT_INTERVAL_S,
  };
}

export type PollOptions = FlowOptions & {
  /** Wait between asks; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Aborted when the person cancels, or the app quits. */
  signal?: AbortSignal;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Step two: ask GitHub whether the person has entered the code, at the
 * interval GitHub asked for, until it answers with a sign-in, says no, or
 * the code runs out. Never throws for any of those; a failure to reach
 * GitHub at all does throw, and the caller says so.
 */
export async function pollForToken(
  code: DeviceCode,
  options: PollOptions = {},
): Promise<DeviceFlowResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal));
  const expiresAt = now() + code.expiresInS * 1000;
  let intervalS = code.intervalS;
  for (;;) {
    await sleep(intervalS * 1000);
    if (options.signal?.aborted) return { outcome: "cancelled" };
    if (now() >= expiresAt) return { outcome: "expired" };
    const body = await postForm(options, "/login/oauth/access_token", {
      client_id: options.clientId ?? GITHUB_OAUTH_CLIENT_ID,
      device_code: code.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (options.signal?.aborted) return { outcome: "cancelled" };
    const issued = issuedSignIn(body);
    if (issued) return { outcome: "signed-in", ...issued };
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalS = typeof body.interval === "number" ? body.interval : intervalS + SLOW_DOWN_S;
        continue;
      case "expired_token":
        return { outcome: "expired" };
      case "access_denied":
        return { outcome: "denied" };
      default:
        throw new DeviceFlowError(
          `GitHub ended the sign-in: ${typeof body.error === "string" ? body.error : "no answer"}`,
        );
    }
  }
}

/** The sign-in in a token answer - the access token, and a short-lived one's lifetime and refresh token. */
function issuedSignIn(body: Record<string, unknown>): IssuedSignIn | undefined {
  if (typeof body.access_token !== "string" || !body.access_token) return undefined;
  const scopes = typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter(Boolean) : [];
  const seconds = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
  const expiresInS = seconds(body.expires_in);
  const refreshExpiresInS = seconds(body.refresh_token_expires_in);
  return {
    token: body.access_token,
    scopes,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresInS !== undefined ? { expiresInS } : {}),
    ...(refreshExpiresInS !== undefined ? { refreshExpiresInS } : {}),
  };
}

/**
 * A short-lived sign-in renewed with its refresh token: GitHub answers a
 * new pair (`renewed`), refuses the refresh token (`refused` - spent,
 * lapsed or revoked: the proof a new sign-in is needed), or could not be
 * asked (`unavailable` - retried, never a sign-out).
 */
export type SignInRenewal =
  | ({ outcome: "renewed" } & IssuedSignIn)
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable"; reason: string };

export async function refreshSignIn(
  refreshToken: string,
  options: FlowOptions = {},
): Promise<SignInRenewal> {
  let body: Record<string, unknown>;
  try {
    body = await postForm(options, "/login/oauth/access_token", {
      client_id: options.clientId ?? GITHUB_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  } catch (caught) {
    return {
      outcome: "unavailable",
      reason: caught instanceof Error ? caught.message : String(caught),
    };
  }
  const issued = issuedSignIn(body);
  if (issued) return { outcome: "renewed", ...issued };
  if (typeof body.error === "string") return { outcome: "refused", reason: body.error };
  return { outcome: "unavailable", reason: "GitHub's answer named no sign-in" };
}

/**
 * Who a sign-in is, as GitHub answers `GET /user`: the one health read. A
 * 401 is GitHub refusing the sign-in (the proof `needs_reauth` needs); a
 * 403 on a spent allowance, a 5xx, and an unreachable host are
 * `unavailable` - retried, never a sign-out. `status` is GitHub's HTTP
 * status wherever it answered at all, for the sign-in's health log.
 */
export type GitHubUserReading =
  | { state: "ok"; login: string; status: number; scopes?: string[] }
  | { state: "rejected"; status: number }
  | { state: "unavailable"; reason: string; status?: number };

export async function readGitHubUser(
  token: string,
  options: { apiBaseUrl: string; fetch?: typeof fetch },
): Promise<GitHubUserReading> {
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${options.apiBaseUrl.replace(/\/+$/, "")}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { state: "unavailable", reason: `unreachable: ${message}` };
  }
  const status = response.status;
  if (status === 401) return { state: "rejected", status };
  if (!response.ok) {
    const spent = response.headers.get("x-ratelimit-remaining") === "0";
    return {
      state: "unavailable",
      reason: spent ? `${status}, the hourly allowance is spent` : `${status}`,
      status,
    };
  }
  try {
    const user = (await response.json()) as { login?: unknown };
    if (typeof user.login === "string" && user.login) {
      // A classic key names what it may do; a fine-grained one names nothing.
      const scopes = response.headers.get("x-oauth-scopes");
      return {
        state: "ok",
        login: user.login,
        status,
        ...(scopes !== null
          ? {
              scopes: scopes
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean),
            }
          : {}),
      };
    }
  } catch {
    // fall through: an unreadable answer is not proof of anything
  }
  return { state: "unavailable", reason: "unreadable answer", status };
}

/**
 * GitHub on the person's own server - GitHub Enterprise - as the seam's
 * sign-in service asks it (`docs/forge.md`, "Hosts on your own server"):
 * the app's OAuth App lives on github.com alone, so such a host has no
 * code to show. The person makes a key on the host's own page and pastes
 * it in Settings; the service asks the host who it is (`GET /user` on the
 * host's API, `apiBaseFor`) before it keeps it, and the same read is its
 * health from then on. Git gives the host the same user name as on
 * github.com, and nothing renews the key.
 */
export function createGitHubServer(options: {
  apiBaseFor: (host: string) => string;
  fetch?: typeof fetch;
}) {
  return {
    ...GITHUB_ENTERPRISE,
    kind: "github" as const,
    gitUser: GITHUB_GIT_USER,
    signIn: (host: string) => ({
      host,
      name: serverHostName(host, GITHUB_ENTERPRISE),
      server: GITHUB_ENTERPRISE,
      whoAmI: (token: string) =>
        readGitHubUser(token, {
          apiBaseUrl: options.apiBaseFor(host),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
    }),
  };
}

/** The user name git gives a GitHub host with the app's sign-in as its password. */
export const GITHUB_GIT_USER = "x-access-token";

/**
 * The GitHub sign-in as the seam's sign-in service asks it (`../../signIns.ts`):
 * start the device flow, wait for the person, read who a sign-in is, and
 * renew a short-lived one.
 */
export function createGitHubSignIn(options: {
  oauthBaseUrl: string;
  apiBaseUrl: string;
  fetch?: typeof fetch;
  /** Tests pass an instant wait; the app waits the interval GitHub asked for. */
  sleep?: (ms: number) => Promise<void>;
}) {
  const flow = {
    baseUrl: options.oauthBaseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  return {
    host: "github.com",
    name: "GitHub",
    start: () => requestDeviceCode(flow),
    wait: (code: DeviceCode, signal: AbortSignal) =>
      pollForToken(code, { ...flow, signal, ...(options.sleep ? { sleep: options.sleep } : {}) }),
    whoAmI: async (token: string) => {
      const reading = await readGitHubUser(token, {
        apiBaseUrl: options.apiBaseUrl,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return reading;
    },
    renew: (refreshToken: string) => refreshSignIn(refreshToken, flow),
  };
}
