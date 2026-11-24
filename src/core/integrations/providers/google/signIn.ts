import { createHash, randomBytes } from "node:crypto";
import { cutText } from "@shared/textCut";
import type { SignInReturnTo } from "../../../signInReturns";
import { listenOnLoopback } from "../../loopback";
import type { GoogleClient, GoogleEndpoints } from "./client";

/**
 * Google's sign-in for an installed app (docs/integrations.md, "Google"):
 * Google's device flow does not reach Gmail or Calendar, so the app opens
 * Google's consent page in the person's own browser and takes the code the
 * browser brings back to this computer's loopback address (`../../loopback`).
 * PKCE (S256) ties the code to this sign-in, and the state ties the
 * browser's answer to this page.
 */

/** What Google issued: kept by the binding in the integration's key store, never shown. */
export type GoogleIssued = {
  accessToken: string;
  refreshToken: string;
  /** When the access token runs out, on the app's clock. */
  expiresAt: number;
  /** The permissions the person granted: they may uncheck some on Google's page. */
  scopes: string[];
};

export type LoopbackSignInOptions = {
  client: GoogleClient;
  endpoints: GoogleEndpoints;
  scopes: readonly string[];
  /**
   * Opens the consent page in the person's browser, saying the port the
   * browser comes back to and when the sign-in stops waiting.
   */
  open: (url: string, to: SignInReturnTo) => Promise<void>;
  signal: AbortSignal;
  now: () => number;
  fetch?: typeof fetch;
};

export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** Sign in on the loopback address and answer what Google issued; throws words otherwise. */
export async function signInOnLoopback(options: LoopbackSignInOptions): Promise<GoogleIssued> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const ended = new AbortController();
  const loopback = await listenOnLoopback({
    state,
    path: "/",
    signal: options.signal,
    name: "Google",
  });
  try {
    const { port } = loopback;
    const redirectUri = `http://127.0.0.1:${port}`;
    const consent = new URL(options.endpoints.auth);
    for (const [name, value] of Object.entries({
      client_id: options.client.id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: options.scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      // Consent every time, so the answer always carries a lasting sign-in.
      prompt: "consent",
    }))
      consent.searchParams.set(name, value);
    await options.open(consent.href, { port, ended: ended.signal });
    const { code } = await loopback.answered;
    return await exchange(options, code, verifier, redirectUri);
  } finally {
    ended.abort();
    loopback.close();
  }
}

async function exchange(
  options: LoopbackSignInOptions,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<GoogleIssued> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.endpoints.token, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: options.client.id,
        ...(options.client.secret ? { client_secret: options.client.secret } : {}),
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    throw new Error("Could not reach Google to finish signing in.");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const issued = issuedFrom(body, options.now());
  if (!response.ok || !issued)
    throw new Error(
      `Google did not finish the sign-in${typeof body.error === "string" ? ` (${cutText(body.error, 64)})` : ""}.`,
    );
  if (!issued.refreshToken)
    throw new Error("Google did not give the app a lasting sign-in. Sign in again.");
  return { ...issued, refreshToken: issued.refreshToken };
}

/** A token answer's fields, from a sign-in or a renewal; undefined when it holds no access token. */
export function issuedFrom(
  body: Record<string, unknown>,
  now: number,
): (Omit<GoogleIssued, "refreshToken"> & { refreshToken?: string }) | undefined {
  if (typeof body.access_token !== "string" || !body.access_token) return undefined;
  if (typeof body.expires_in !== "number" || !(body.expires_in > 0)) return undefined;
  return {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    ...(typeof body.refresh_token === "string" && body.refresh_token
      ? { refreshToken: body.refresh_token }
      : {}),
  };
}
