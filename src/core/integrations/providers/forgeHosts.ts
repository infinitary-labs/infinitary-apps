import { createHash } from "node:crypto";
import { type ServerIntegrationKind, serverIntegrationHost } from "@shared/forgeKinds";
import { type ForgesView, SERVER_VIEWS, serverHostName } from "@shared/forges";
import { INTEGRATION_KIND_NAMES } from "@shared/integrations";
import type { IntegrationBinding } from "../binding";
import { type GithubIntegrationOptions, githubIntegration } from "./github";

/** A stable per-host id within the published integration id shape. */
export function forgeIntegrationId(kind: ServerIntegrationKind, host: string): string {
  const facts = serverIntegrationHost(kind);
  if (facts.publicHostIsServerRow && host === facts.publicHost) return kind;
  const digest = createHash("sha256").update(host).digest("hex").slice(0, 12);
  return `${facts.serverIdPrefix}-${host.replace(/[^a-z0-9]/g, "-").slice(0, 26)}-${digest}`;
}

/** Views over the forge's existing per-host sign-ins; no secrets or files move. */
export function forgeHostIntegration(
  kind: ServerIntegrationKind,
  options: {
    signIns: GithubIntegrationOptions["signIns"] & {
      view: () => ForgesView;
      /** The hosts with a sign-in file, read without any file's contents; null where unknown. */
      presentHosts: () => string[] | null;
    };
    gateway: (host: string) => GithubIntegrationOptions["gateway"];
  },
): IntegrationBinding {
  const facts = serverIntegrationHost(kind);
  // A kind whose public host is one of its rows (GitLab's) lists it beside its servers.
  const hosts = () =>
    options.signIns
      .view()
      .signIns.filter((row) =>
        facts.publicHostIsServerRow
          ? row.server?.kind === facts.kind || row.host === facts.publicHost
          : row.server?.kind === facts.kind && row.host !== facts.publicHost,
      );
  const rowName = (host: string) =>
    facts.publicHostIsServerRow && host === facts.publicHost
      ? INTEGRATION_KIND_NAMES[kind]
      : serverHostName(host, SERVER_VIEWS[facts.kind]);
  const binding = (id: string) => {
    const row = hosts().find((host) => forgeIntegrationId(kind, host.host) === id);
    if (!row) throw new Error("This host is no longer signed in.");
    return githubIntegration(
      { signIns: options.signIns, gateway: options.gateway(row.host) },
      {
        host: row.host,
        name: rowName(row.host),
        label: INTEGRATION_KIND_NAMES[kind],
        id,
        kind: facts.kind,
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
          .map((connection) => ({ ...connection, host: row.host, name: rowName(row.host) }));
      }),
    // From the store's own listing, never a view: no sign-in file is read to
    // tell whether one is here. A server's kind is inside its file, so any
    // host this kind could list counts, and a folder that cannot be listed too.
    saved: () => {
      const present = options.signIns.presentHosts();
      if (present === null) return true;
      return present.some((host) => facts.publicHostIsServerRow || host !== facts.publicHost);
    },
    check: async (id) => {
      await binding(id).check?.(id);
    },
    remove: async (id) => {
      await binding(id).remove?.(id);
    },
    call: (id, action, input, caller) => binding(id).call(id, action, input, caller),
    look: async (id, event, cursor, filter) => {
      const look = binding(id).look;
      if (!look) throw new Error("This host tells no events.");
      return look(id, event, cursor, filter);
    },
  };
}
