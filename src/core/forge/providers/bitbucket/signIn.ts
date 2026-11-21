import { BITBUCKET } from "@shared/forges";
import { ForgeError } from "../../forge";
import type { ForgeServer, ForgeWhoAmI } from "../../signIns";
import { BitbucketClient } from "./client";

/**
 * The git user Bitbucket names for an API token in a git address; the
 * token itself is the password (`docs/forge.md`, "Bitbucket sign-in and
 * projects").
 */
export const BITBUCKET_GIT_USER = "x-bitbucket-api-token-auth";

/**
 * An Atlassian API token: longer than other keys and padded with `=`,
 * which the shared key pattern does not allow.
 */
const BITBUCKET_KEY = /^[A-Za-z0-9_.=-]{20,1024}$/;

/**
 * Bitbucket Cloud by API token alone: bitbucket.org is its one host for
 * now, and git answers it with the app's sign-in alone, as the pull
 * requests the app opens there are made with that sign-in too.
 */
export function createBitbucketServer(options: {
  apiBaseFor: (host: string) => string;
  fetch?: typeof fetch;
}): ForgeServer {
  return {
    ...BITBUCKET,
    kind: "bitbucket",
    hosts: ["bitbucket.org"],
    publicOnly: true,
    gitUser: BITBUCKET_GIT_USER,
    keyPattern: BITBUCKET_KEY,
    signIn: (host) => ({
      host,
      name: "Bitbucket",
      server: BITBUCKET,
      whoAmI: async (token): Promise<ForgeWhoAmI> => {
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
      },
    }),
  };
}
