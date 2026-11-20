import { GITLAB, serverHostName } from "@shared/forges";
import { ForgeError } from "../../forge";
import type { ForgeServer, ForgeWhoAmI } from "../../signIns";
import { GitLabClient } from "./client";
import { gitlabBrowserSignIn } from "./oauth";

/** GitLab browser sign-in with a public application, or keys without registration, on either host. */
export function createGitLabServer(options: {
  apiBaseFor: (host: string) => string;
  oauthBaseFor?: (host: string) => string;
  fetch?: typeof fetch;
}): ForgeServer {
  return {
    ...GITLAB,
    kind: "gitlab",
    hosts: ["gitlab.com"],
    gitUser: "oauth2",
    signIn: (host, applicationId) => ({
      ...(applicationId
        ? gitlabBrowserSignIn({
            applicationId,
            baseUrl: options.oauthBaseFor?.(host) ?? `https://${host}`,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          })
        : {}),
      host,
      name: host === "gitlab.com" ? "GitLab" : serverHostName(host, GITLAB),
      server: GITLAB,
      whoAmI: async (token): Promise<ForgeWhoAmI> => {
        const client = new GitLabClient(host, {
          token: async () => token,
          apiBaseUrl: options.apiBaseFor(host),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        try {
          const user = await client.get<{ username?: unknown } | null>("/user");
          return typeof user?.username === "string" && user.username
            ? { state: "ok", login: user.username, status: 200 }
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
