import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { cutText } from "@shared/textCut";
import type { SignInReturnTo } from "../../../signInReturns";
import type { GoogleClient, GoogleEndpoints } from "./client";

/**
 * Google's sign-in for an installed app (docs/integrations.md, "Google"):
 * Google's device flow does not reach Gmail or Calendar, so the app listens
 * on this computer's loopback address, at a port the system picks, opens
 * Google's consent page in the person's own browser, and takes the code the
 * browser brings back. PKCE (S256) ties the code to this sign-in, and the
 * state ties the browser's answer to this page; anything else that reaches
 * the listener is turned away. The listener closes as soon as the browser
 * answers, or the sign-in is cancelled.
 *
 * The page may open on another computer that controls this first mate: it
 * is told the port, catches the browser's return there and hands it to this
 * listener (src/core/signInReturns.ts), until the sign-in ends.
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

/** How long one request to Google may take. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

/** The page the browser shows once it has brought the answer back. */
const PAGE = {
  signedIn: "Signed in to Google. You can close this tab and go back to Infinitary.",
  declined: "Not signed in to Google. You can close this tab and go back to Infinitary.",
} as const;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function page(words: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Infinitary</title><body style="font:15px system-ui;margin:3em">${words}</body>`;
}

/** Sign in on the loopback address and answer what Google issued; throws words otherwise. */
export async function signInOnLoopback(options: LoopbackSignInOptions): Promise<GoogleIssued> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const server = createServer();
  const ended = new AbortController();
  try {
    const port = await listen(server, options.signal);
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
    const answered = waitForCode(server, state, options.signal);
    // A cancel while the page is still opening is read below, not lost.
    answered.catch(() => {});
    await options.open(consent.href, { port, ended: ended.signal });
    const code = await answered;
    return await exchange(options, code, verifier, redirectUri);
  } finally {
    ended.abort();
    server.close();
    server.closeAllConnections();
  }
}

function listen(server: Server, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("The sign-in was cancelled."));
      return;
    }
    server.once("error", () => reject(new Error("Could not listen on this computer for Google.")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not listen on this computer for Google."));
    });
  });
}

/** The code the browser brings back with this sign-in's state; anything else is turned away. */
function waitForCode(server: Server, state: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error("The sign-in was cancelled."));
    if (signal.aborted) cancelled();
    signal.addEventListener("abort", cancelled, { once: true });
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        url.pathname !== "/" ||
        url.searchParams.get("state") !== state
      ) {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end(page(code ? PAGE.signedIn : PAGE.declined));
      signal.removeEventListener("abort", cancelled);
      if (code) resolve(code);
      else
        reject(
          new Error(
            error === "access_denied"
              ? "The sign-in was declined on Google's page."
              : `Google did not sign in${error ? ` (${cutText(error, 64)})` : ""}.`,
          ),
        );
    });
  });
}

/** Trade the code for the sign-in, with the verifier only this sign-in holds. */
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
