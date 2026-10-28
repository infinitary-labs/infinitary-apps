import { setTimeout as sleep } from "node:timers/promises";
import { settingFrom } from "@shared/envSettings";
import type { ForgeStartProblem } from "@shared/forges";
import {
  type ForgeDeviceCode,
  type ForgeDeviceResult,
  type ForgeIssued,
  type ForgeRenewal,
  ForgeStartError,
} from "../../signIns";

/** GitLab 17.9+: the device authorization grant, with a public application and no secret. */
const SCOPES = ["api", "write_repository"];
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 16 * 1024;

type Options = { baseUrl: string; applicationId: string; fetch?: typeof fetch };
type Answer = { status: number; body: Record<string, unknown> };

/** An answer that arrived but is not GitLab's OAuth JSON, such as a plain-text 404 page. */
class UnreadableAnswer extends Error {
  constructor(
    readonly status: number,
    reason: string,
  ) {
    super(reason);
  }
}

/** OAuth error codes GitLab answers a device request with; any other code is logged as `other`. */
const START_ERRORS: Record<string, ForgeStartProblem> = {
  access_denied: "not-allowed",
  unauthorized_client: "not-allowed",
  invalid_client: "client",
  invalid_scope: "scope",
};

/** Why GitLab would not start the sign-in, from its status and OAuth error code alone. */
function startRefusal({ status, body }: Answer): ForgeStartError {
  const code =
    typeof body.error === "string" && Object.hasOwn(START_ERRORS, body.error)
      ? body.error
      : undefined;
  const problem: ForgeStartProblem =
    status === 404
      ? "not-found"
      : status >= 500
        ? "unreachable"
        : code
          ? (START_ERRORS[code] ?? "answer")
          : "answer";
  return new ForgeStartError(
    problem,
    `HTTP ${status}${body.error === undefined ? "" : `, ${code ?? "other"}`}`,
  );
}

export function gitlabOAuthBaseFor(
  host: string,
  options: { packaged: boolean; env?: NodeJS.ProcessEnv },
): string {
  const override = settingFrom(options.env ?? process.env, "GITLAB_OAUTH_URL")?.trim();
  return !options.packaged && override ? override.replace(/\/+$/, "") : `https://${host}`;
}

/** Bounded, same-host requests. Neither server response text nor sign-in material enters errors. */
async function post(
  options: Options,
  path: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<Answer> {
  const response = await (options.fetch ?? fetch)(`${options.baseUrl}${path}`, {
    method: "POST",
    redirect: "error",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: options.applicationId, ...fields }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new UnreadableAnswer(response.status, "GitLab supplied no sign-in answer");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new UnreadableAnswer(response.status, "GitLab supplied an oversized sign-in answer");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UnreadableAnswer(response.status, "GitLab supplied an unreadable sign-in answer");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new UnreadableAnswer(response.status, "GitLab supplied an unreadable sign-in answer");
  return { status: response.status, body: body as Record<string, unknown> };
}

function positive(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function issued({ status, body }: Answer): ForgeIssued | undefined {
  if (status !== 200 || typeof body.access_token !== "string" || !body.access_token) return;
  if (String(body.token_type).toLowerCase() !== "bearer") return;
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : SCOPES;
  if (!SCOPES.every((scope) => scopes.includes(scope))) return;
  if (!positive(body.expires_in, 365 * 24 * 60 * 60)) return;
  return {
    token: body.access_token,
    scopes,
    expiresInS: body.expires_in,
    ...(typeof body.refresh_token === "string" && body.refresh_token
      ? { refreshToken: body.refresh_token }
      : {}),
  };
}

export function gitlabBrowserSignIn(options: Options) {
  return {
    applicationId: options.applicationId,
    start: async (signal?: AbortSignal): Promise<ForgeDeviceCode> => {
      let answer: Answer;
      try {
        answer = await post(
          options,
          "/oauth/authorize_device",
          { scope: SCOPES.join(" ") },
          signal,
        );
      } catch (caught) {
        if (!(caught instanceof UnreadableAnswer))
          throw new ForgeStartError("unreachable", "GitLab could not be reached");
        throw new ForgeStartError(
          caught.status === 404 ? "not-found" : caught.status >= 500 ? "unreachable" : "answer",
          `HTTP ${caught.status}, not GitLab's sign-in answer`,
        );
      }
      if (answer.status !== 200) throw startRefusal(answer);
      const { body } = answer;
      if (
        typeof body.device_code !== "string" ||
        !body.device_code ||
        body.device_code.length > 2048 ||
        typeof body.user_code !== "string" ||
        !body.user_code ||
        body.user_code.length > 32 ||
        typeof body.verification_uri !== "string" ||
        !URL.canParse(body.verification_uri) ||
        !positive(body.expires_in, 3600) ||
        (body.interval !== undefined && !positive(body.interval, 300))
      )
        throw new ForgeStartError("answer", "invalid device authorization answer");
      const page = new URL(body.verification_uri);
      // A named server may not send the person or the code to an unrelated site.
      if (page.origin !== new URL(options.baseUrl).origin || page.username || page.password)
        throw new ForgeStartError("answer", "unexpected verification page");
      return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: page.href,
        expiresInS: body.expires_in,
        intervalS: typeof body.interval === "number" ? body.interval : 5,
      };
    },
    wait: async (code: ForgeDeviceCode, signal: AbortSignal): Promise<ForgeDeviceResult> => {
      const expiresAt = Date.now() + code.expiresInS * 1000;
      let interval = code.intervalS;
      try {
        for (;;) {
          await sleep(Math.min(interval * 1000, Math.max(0, expiresAt - Date.now())), undefined, {
            signal,
          });
          if (Date.now() >= expiresAt) return { outcome: "expired" };
          const answer = await post(
            options,
            "/oauth/token",
            {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: code.deviceCode,
            },
            signal,
          );
          if (signal.aborted) return { outcome: "cancelled" };
          const token = issued(answer);
          if (token) return { outcome: "signed-in", ...token };
          if (answer.status !== 400 && answer.status !== 200)
            throw new Error("GitLab could not finish browser sign-in");
          switch (answer.body.error) {
            case "authorization_pending":
              break;
            case "slow_down":
              interval += 5;
              break;
            case "expired_token":
              return { outcome: "expired" };
            case "access_denied":
              return { outcome: "denied" };
            default:
              throw new Error("GitLab could not finish browser sign-in");
          }
        }
      } catch {
        if (signal.aborted) return { outcome: "cancelled" };
        throw new Error("GitLab could not finish browser sign-in");
      }
    },
    renew: async (refreshToken: string): Promise<ForgeRenewal> => {
      try {
        const answer = await post(options, "/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });
        const token = issued(answer);
        if (token) return { outcome: "renewed", ...token };
        if (
          [400, 401].includes(answer.status) &&
          ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"].includes(
            String(answer.body.error),
          )
        )
          return { outcome: "refused", reason: "GitLab refused the renewal" };
      } catch {
        // Network failures, rate limits and unreadable answers never prove sign-out.
      }
      return { outcome: "unavailable", reason: "GitLab could not renew the sign-in" };
    },
  };
}
