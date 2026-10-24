import { createHash } from "node:crypto";
import { type ForgesView, GITHUB_ENTERPRISE, GITLAB, serverHostName } from "@shared/forges";
import { INTEGRATION_KIND_NAMES } from "@shared/integrations";
import type { IntegrationBinding } from "../binding";
import { type GithubIntegrationOptions, githubIntegration } from "./github";

/** A stable per-host id within the published integration id shape. */
export function forgeIntegrationId(kind: "gitlab" | "github-enterprise", host: string): string {
  if (kind === "gitlab" && host === "gitlab.com") return "gitlab";
  const prefix = kind === "gitlab" ? "gitlab" : "ghe";
  const digest = createHash("sha256").update(host).digest("hex").slice(0, 12);
  return `${prefix}-${host.replace(/[^a-z0-9]/g, "-").slice(0, 26)}-${digest}`;
}

/** Views over the forge's existing per-host sign-ins; no secrets or files move. */
export function forgeHostIntegration(
  kind: "gitlab" | "github-enterprise",
  options: {
    signIns: GithubIntegrationOptions["signIns"] & { view: () => ForgesView };
    gateway: (host: string) => GithubIntegrationOptions["gateway"];
  },
): IntegrationBinding {
  const hosts = () =>
    options.signIns
      .view()
      .signIns.filter((row) =>
        kind === "gitlab"
          ? row.server?.kind === "gitlab" || row.host === "gitlab.com"
          : row.server?.kind === "github" && row.host !== "github.com",
      );
  const binding = (id: string) => {
    const row = hosts().find((host) => forgeIntegrationId(kind, host.host) === id);
    if (!row) throw new Error("This host is no longer signed in.");
    return githubIntegration(
      { signIns: options.signIns, gateway: options.gateway(row.host) },
      {
        host: row.host,
        name:
          kind === "gitlab" && row.host === "gitlab.com"
            ? INTEGRATION_KIND_NAMES.gitlab
            : serverHostName(row.host, kind === "gitlab" ? GITLAB : GITHUB_ENTERPRISE),
        label: INTEGRATION_KIND_NAMES[kind],
        id,
      },
    );
  };
  return {
    kind,
    many: true,
    connections: () =>
      hosts().flatMap((row) => {
        const id = forgeIntegrationId(kind, row.host);
        return binding(id)
          .connections()
          .map((connection) => ({
            ...connection,
            host: row.host,
            name:
              row.host === "gitlab.com"
                ? "GitLab"
                : serverHostName(row.host, kind === "gitlab" ? GITLAB : GITHUB_ENTERPRISE),
          }));
      }),
    check: async (id) => {
      await binding(id).check?.(id);
    },
    remove: async (id) => {
      await binding(id).remove?.(id);
    },
    call: (id, action, input, caller) => binding(id).call(id, action, input, caller),
  };
}
