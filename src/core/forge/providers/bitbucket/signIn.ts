import { BITBUCKET, serverHostName } from "@shared/forges";
import { ForgeError } from "../../forge";
import type { ForgeServer, ForgeWhoAmI } from "../../signIns";
import { BitbucketClient } from "./client";
import { DataCenterClient } from "./dataCenterClient";

/**
 * The git user Bitbucket names for an API token in a git address; the
 * token itself is the password (`docs/forge.md`, "Bitbucket sign-in and
 * projects").
 */
export const BITBUCKET_GIT_USER = "x-bitbucket-api-token-auth";

/**
 * An Atlassian API token, or a Bitbucket Data Center HTTP access token:
 * longer than other keys, padded with `=`, and a Data Center token's
 * base64 may hold `+` and `/`, which the shared key pattern does not allow.
 */
const BITBUCKET_KEY = /^[A-Za-z0-9_.=+/-]{20,1024}$/;

/** The oldest Bitbucket Data Center the app signs in to: its pull request reads and merges need 8.19. */
export const BITBUCKET_DATA_CENTER_OLDEST = [8, 19] as const;

/**
 * Bitbucket by token alone: Bitbucket Cloud's API token at bitbucket.org,
 * and an HTTP access token at any other address, which is a Bitbucket Data
 * Center server (`docs/forge.md`, "Bitbucket Data Center"). Git answers
 * either with the app's sign-in alone, as the pull requests the app opens
 * there are made with that sign-in too.
 */
export function createBitbucketServer(options: {
  apiBaseFor: (host: string) => string;
  /** A Data Center server's address, such as `https://bitbucket.example.com`. */
  dataCenterBaseFor: (host: string) => string;
  fetch?: typeof fetch;
}): ForgeServer {
  return {
    ...BITBUCKET,
    kind: "bitbucket",
    hosts: ["bitbucket.org"],
    gitUser: BITBUCKET_GIT_USER,
    keyPattern: BITBUCKET_KEY,
    signIn: (host) => ({
      host,
      name: host === "bitbucket.org" ? "Bitbucket" : serverHostName(host, BITBUCKET),
      server: BITBUCKET,
      whoAmI: (token) =>
        host === "bitbucket.org"
          ? cloudWhoAmI(host, token, options)
          : dataCenterWhoAmI(host, token, options),
    }),
  };
}

/**
 * Who a Data Center token is: the server must name itself Bitbucket at
 * 8.19 or newer, and an authenticated read must name the user, whose name
 * git gives with the token as the password. A version too old, or an
 * answer that is not Bitbucket's, reads as not this kind of server.
 */
async function dataCenterWhoAmI(
  host: string,
  token: string,
  options: { dataCenterBaseFor: (host: string) => string; fetch?: typeof fetch },
): Promise<ForgeWhoAmI> {
  const client = new DataCenterClient(host, {
    token: async () => token,
    serverUrl: options.dataCenterBaseFor(host),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  try {
    const about = await client.get<{ version?: unknown; displayName?: unknown } | null>(
      "/rest/api/latest/application-properties",
    );
    const version = typeof about?.version === "string" ? about.version : "";
    if (about?.displayName !== "Bitbucket" || !version)
      // i18n-exempt: a reason for the sign-in log, never shown to a person
      return { state: "unavailable", reason: "not Bitbucket Data Center", status: 200 };
    if (!atLeast(version, BITBUCKET_DATA_CENTER_OLDEST))
      return {
        state: "unavailable",
        // i18n-exempt: a reason for the sign-in log, never shown to a person
        reason: `Bitbucket ${version} is older than ${BITBUCKET_DATA_CENTER_OLDEST.join(".")}`,
        status: 200,
      };
    const users = await client.request("GET", "/rest/api/latest/users?limit=1");
    const named = users.user ? safeDecode(users.user) : await client.signedInUser();
    // i18n-exempt: a reason for the sign-in log, never shown to a person
    if (!named) return { state: "unavailable", reason: "unreadable answer", status: 200 };
    return { state: "ok", login: named, status: 200, gitUser: named };
  } catch (caught) {
    return refusedReading(caught);
  }
}

/** Whether a dotted version is at least `oldest`. */
export function atLeast(version: string, oldest: readonly [number, number]): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major === undefined || !Number.isFinite(major)) return false;
  if (major !== oldest[0]) return major > oldest[0];
  return minor !== undefined && Number.isFinite(minor) && minor >= oldest[1];
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && !/[\s<>"]/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** A failed reading, typed: a refused token, a missing permission, an address answering nothing. */
function refusedReading(caught: unknown): ForgeWhoAmI {
  if (caught instanceof ForgeError) {
    if (caught.failure === "sign-in") return { state: "rejected", status: 401 };
    if (caught.failure === "permission")
      return { state: "unavailable", reason: "403", status: 403 };
    if (caught.failure === "not-found") return { state: "unavailable", reason: "404", status: 404 };
    if (caught.failure === "refused")
      return { state: "unavailable", reason: "refused", status: 400 };
  }
  // i18n-exempt: a reason for the sign-in log, never shown to a person
  return { state: "unavailable", reason: "could not reach host" };
}

/** Who a Bitbucket Cloud API token is: its account's user name. */
async function cloudWhoAmI(
  host: string,
  token: string,
  options: { apiBaseFor: (host: string) => string; fetch?: typeof fetch },
): Promise<ForgeWhoAmI> {
  const client = new BitbucketClient(host, {
    token: async () => token,
    apiBaseUrl: options.apiBaseFor(host),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  try {
    const user = await client.get<{
      username?: unknown;
      nickname?: unknown;
      display_name?: unknown;
    } | null>("/user");
    const login = [user?.username, user?.nickname, user?.display_name].find(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    return login
      ? { state: "ok", login, status: 200 }
      : { state: "unavailable", reason: "unreadable answer", status: 200 };
  } catch (caught) {
    if (caught instanceof ForgeError) {
      if (caught.failure === "sign-in") return { state: "rejected", status: 401 };
      if (caught.failure === "permission")
        return { state: "unavailable", reason: "403", status: 403 };
      if (caught.failure === "not-found")
        return { state: "unavailable", reason: "404", status: 404 };
    }
    return { state: "unavailable", reason: "could not reach host" };
  }
}
