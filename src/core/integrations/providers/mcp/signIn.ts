import { randomBytes } from "node:crypto";
import {
  type AuthorizationServerMetadata,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationFull,
  OAuthError,
  RegistrationRejectedError,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
} from "@modelcontextprotocol/client";
import type { CustomNetworkMode } from "@shared/customApi";
import type { SignInReturnTo } from "../../../signInReturns";
import { LoopbackError, listenOnLoopback } from "../../loopback";
import {
  checkSignInAddress,
  guardedSignInFetch,
  McpAddressError,
  type McpResolver,
} from "./guardedFetch";
import type { McpSavedSignIn } from "./store";

/**
 * The sign-in of an MCP server at an address that asks for one
 * (docs/integrations.md, "MCP servers that sign in"), the way the MCP
 * authorization rules describe it: the server's documents name where its
 * sign-in lives (RFC 9728, RFC 8414); Infinitary registers itself there as
 * a new app for this sign-in alone (RFC 7591), opens the sign-in page in
 * the person's browser, and takes the code the browser brings back to this
 * computer's loopback address (`../../loopback`). PKCE (S256) ties the code
 * to this sign-in, the state ties the browser's answer to this page, and
 * the keys are for this server alone (RFC 8707).
 *
 * Every request goes through the sign-in fetch (`guardedSignInFetch`), and
 * each address a document names is checked before the browser opens, so a
 * document cannot point the sign-in into a private network or over plain
 * http. A sign-in that does not let Infinitary register itself needs an app
 * of the person's own, which this does not offer.
 */

/** What the server's 401 said: where its documents are, and what it asks for. */
export type McpChallenge = { resourceMetadataUrl?: URL; scope?: string };

/** What a sign-in issued: the facts the binding saves, and the keys it keeps in Secrets or memory. */
export type McpIssued = {
  facts: Omit<McpSavedSignIn, "id" | "clientKey" | "key" | "signedInAt">;
  /** The client's own key, when the sign-in gave one. */
  clientSecret?: string;
  accessToken: string;
  /** When the access key runs out, on the app's clock, when the sign-in said. */
  expiresAt?: number;
  refreshToken?: string;
};

/** A server's sign-in could not run; the message says why in the person's words. */
export class McpSignInError extends Error {}

const CALLBACK_PATH = "/callback";

/** When a key given `expires_in` seconds from now runs out, on the app's clock. */
export function expiryOf(expiresIn: unknown, now: number): number | undefined {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? now + expiresIn * 1000
    : undefined;
}

/**
 * Sign in to the server at `server` in the person's browser and answer what
 * it issued; throws words when it cannot, and ends when `signal` aborts.
 * `open` opens the page and says the port the browser comes back to.
 */
export async function signInToServer(options: {
  name: string;
  server: string;
  network: CustomNetworkMode;
  challenge: McpChallenge;
  open: (page: string, to: SignInReturnTo) => Promise<void>;
  signal: AbortSignal;
  now: () => number;
  resolve?: McpResolver;
}): Promise<McpIssued> {
  const { name, server, network, signal } = options;
  const fetchFn = guardedSignInFetch(network, options.resolve);
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(server, {
      fetchFn,
      ...(options.challenge.resourceMetadataUrl
        ? { resourceMetadataUrl: options.challenge.resourceMetadataUrl }
        : {}),
    });
  } catch (error) {
    throw signInError(error, name);
  }
  const metadata = info.authorizationServerMetadata;
  if (!metadata)
    throw new McpSignInError(
      `${name} asks for a sign-in, but its documents do not say where to sign in.`,
    );
  if (!metadata.registration_endpoint)
    throw new McpSignInError(
      `${name} does not let Infinitary register itself to sign in. It needs an app of your own, which Infinitary does not offer yet.`,
    );
  const resource = resourceOf(server, info.resourceMetadata?.resource, name);
  await checkEndpoints(metadata, network, options.resolve);
  const scope =
    options.challenge.scope ?? info.resourceMetadata?.scopes_supported?.join(" ") ?? undefined;

  const state = randomBytes(16).toString("base64url");
  const ended = new AbortController();
  const loopback = await listenOnLoopback({
    state,
    path: CALLBACK_PATH,
    signal,
    name,
  });
  try {
    const redirectUri = `http://127.0.0.1:${loopback.port}${CALLBACK_PATH}`;
    let client: OAuthClientInformationFull;
    try {
      client = await registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: "Infinitary",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        ...(scope ? { scope } : {}),
        fetchFn,
      });
    } catch (error) {
      if (error instanceof RegistrationRejectedError)
        throw new McpSignInError(
          `${name} did not let Infinitary register itself to sign in (status ${error.status}). It may need an app of your own, which Infinitary does not offer yet.`,
        );
      throw error;
    }
    const clientAuth = clientAuthOf(client, metadata);
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      info.authorizationServerUrl,
      {
        metadata,
        clientInformation: client,
        redirectUrl: redirectUri,
        state,
        ...(scope ? { scope } : {}),
        ...(resource ? { resource } : {}),
      },
    );
    await options.open(authorizationUrl.href, { port: loopback.port, ended: ended.signal });
    const answer = await loopback.answered;
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
      metadata,
      clientInformation: client,
      authorizationCode: answer.code,
      ...(answer.iss ? { iss: answer.iss } : {}),
      codeVerifier,
      redirectUri,
      ...(resource ? { resource } : {}),
      fetchFn,
    });
    return {
      facts: {
        issuer: metadata.issuer,
        ...(resource ? { resource: resource.href } : {}),
        token: metadata.token_endpoint,
        ...(revocationOf(metadata) ? { revoke: revocationOf(metadata) as string } : {}),
        clientId: client.client_id,
        clientAuth,
        ...(tokens.scope || scope ? { scope: (tokens.scope ?? scope) as string } : {}),
      },
      ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
      accessToken: tokens.access_token,
      ...(expiryOf(tokens.expires_in, options.now()) !== undefined
        ? { expiresAt: expiryOf(tokens.expires_in, options.now()) as number }
        : {}),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw new McpSignInError("The sign-in was cancelled.");
    throw signInError(error, name);
  } finally {
    ended.abort();
    loopback.close();
  }
}

/**
 * What the keys are for: the resource the server's documents name, which
 * must be this server's own address or one above it (RFC 9728 §3.3).
 */
function resourceOf(server: string, named: string | undefined, name: string): URL | undefined {
  if (!named) return undefined;
  if (
    !checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(server),
      configuredResource: named,
    })
  )
    throw new McpSignInError(
      `${name}'s documents say its sign-in is for another address (${clipAddress(named)}), so Infinitary does not sign in.`,
    );
  return new URL(named);
}

/** Every address the sign-in's documents name, checked before the browser opens. */
async function checkEndpoints(
  metadata: AuthorizationServerMetadata,
  network: CustomNetworkMode,
  resolve: McpResolver | undefined,
) {
  for (const address of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    revocationOf(metadata),
  ]) {
    if (!address) continue;
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new McpAddressError("The server's sign-in names an address that cannot be read.");
    }
    await checkSignInAddress(url, network, resolve);
  }
}

/** Where a key is revoked (RFC 7009), which an OpenID document's type does not declare. */
function revocationOf(metadata: AuthorizationServerMetadata): string | undefined {
  const named = (metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
  return typeof named === "string" && named ? named : undefined;
}

/** How the registered client renews: the way the sign-in agreed to, by its id alone where it gave no key. */
function clientAuthOf(
  client: OAuthClientInformationFull,
  metadata: AuthorizationServerMetadata,
): McpSavedSignIn["clientAuth"] {
  if (!client.client_secret) return "none";
  const agreed = client.token_endpoint_auth_method;
  if (agreed === "client_secret_post" || agreed === "client_secret_basic") return agreed;
  const offered = metadata.token_endpoint_auth_methods_supported ?? [];
  return offered.includes("client_secret_post") && !offered.includes("client_secret_basic")
    ? "client_secret_post"
    : "client_secret_basic";
}

function clipAddress(address: string): string {
  return address.length <= 120 ? address : `${address.slice(0, 119)}…`;
}

function signInError(error: unknown, name: string): McpSignInError {
  if (error instanceof McpSignInError) return error;
  if (error instanceof McpAddressError || error instanceof LoopbackError)
    return new McpSignInError(error.message);
  if (error instanceof OAuthError)
    return new McpSignInError(
      `${name}'s sign-in refused (${clipAddress(error.code)}${
        error.message ? `: ${clipAddress(error.message)}` : ""
      }).`,
    );
  const message = error instanceof Error ? error.message : String(error);
  return new McpSignInError(
    `${name}'s sign-in did not answer as expected: ${clipAddress(message)}`,
  );
}
