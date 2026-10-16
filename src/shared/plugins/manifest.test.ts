import { describe, expect, it } from "vitest";
import {
  canonicalCapabilities,
  consentSummary,
  isExactHttpsOrigin,
  isPrivateOrLoopbackHost,
  NET_READ_METHODS,
  PluginManifestError,
  type PluginManifestInput,
  parsePluginManifest,
  requestedGrants,
  STORAGE_KV_MAX_BYTES,
  unservableGrants,
} from "./manifest";

const minimal: PluginManifestInput = {
  id: "jira-board",
  name: "Jira board",
  version: "1.2.0",
  contributes: {},
  capabilities: {},
};

const withGrants: PluginManifestInput = {
  ...minimal,
  capabilities: {
    net: {
      origins: {
        jira: { userSupplied: true, methods: ["GET", "POST"] },
        atlassian: { origin: "https://api.atlassian.com" },
      },
    },
    secrets: {
      "jira-token": { kind: "bearer", label: "Jira API token" },
      "jira-header": { kind: "header", label: "Custom header", header: "X-Jira-Auth" },
    },
    storage: { kv: { maxBytes: 65_536 } },
    reads: ["feed.recent", "crew.counts"],
  },
};

describe("parsePluginManifest", () => {
  it("accepts a minimal manifest and fills contribution defaults", () => {
    const manifest = parsePluginManifest(minimal);
    expect(manifest.contributes).toEqual({ cardKinds: [], settingsSections: [], sidePanels: [] });
    expect(manifest.capabilities).toEqual({});
  });

  it("accepts the full grant model and defaults methods to read-only", () => {
    const manifest = parsePluginManifest(withGrants);
    const origins = manifest.capabilities.net?.origins ?? {};
    expect(origins.atlassian).toEqual({
      origin: "https://api.atlassian.com",
      methods: [...NET_READ_METHODS],
    });
    expect(origins.jira).toEqual({ userSupplied: true, methods: ["GET", "POST"] });
  });

  it("requires the capabilities block even when empty", () => {
    const { capabilities: _omitted, ...withoutCapabilities } = minimal;
    expect(() => parsePluginManifest(withoutCapabilities)).toThrow(PluginManifestError);
    expect(() => parsePluginManifest(withoutCapabilities)).toThrow(/capabilities/);
  });

  it("refuses an unknown capability name loudly, naming it", () => {
    const raw = { ...minimal, capabilities: { ipc: { channels: ["inf:cards:list"] } } };
    expect(() => parsePluginManifest(raw)).toThrow(/plugin "jira-board"/);
    expect(() => parsePluginManifest(raw)).toThrow(/capabilities.*ipc/);
  });

  it("refuses an unknown contribution slot", () => {
    expect(() => parsePluginManifest({ ...minimal, contributes: { toolbars: [] } })).toThrow(
      /contributes.*toolbars/,
    );
  });

  it("refuses duplicate contribution ids within a slot", () => {
    const raw = {
      ...minimal,
      contributes: {
        sidePanels: [
          { id: "board", title: "Board", preferredPlacement: { x: "left", y: "top" }, order: 1 },
          {
            id: "board",
            title: "Board again",
            preferredPlacement: { x: "right", y: "bottom" },
            order: 2,
          },
        ],
      },
    };
    expect(() => parsePluginManifest(raw)).toThrow(/duplicate side-panel id "board"/);
  });

  it("sizes a side panel to its content unless it asks to fill the rail", () => {
    const panel = (size?: string) =>
      parsePluginManifest({
        ...minimal,
        contributes: {
          sidePanels: [
            {
              id: "board",
              title: "Board",
              preferredPlacement: { x: "left", y: "top" },
              order: 1,
              ...(size ? { size } : {}),
            },
          ],
        },
      }).contributes.sidePanels[0]?.size;
    expect(panel()).toBe("content");
    expect(panel("fill")).toBe("fill");
    expect(() => panel("flex")).toThrow(/contributes\.sidePanels\.0\.size/);
  });

  it("accepts a preferredPlacement of any x/y combination and refuses anything else", () => {
    const withPlacement = (placement: unknown) =>
      parsePluginManifest({
        ...minimal,
        contributes: {
          sidePanels: [{ id: "board", title: "Board", preferredPlacement: placement, order: 1 }],
        },
      }).contributes.sidePanels[0]?.preferredPlacement;
    expect(withPlacement({ x: "left", y: "top" })).toEqual({ x: "left", y: "top" });
    expect(withPlacement({ x: "right", y: "bottom" })).toEqual({ x: "right", y: "bottom" });
    expect(() => withPlacement({ x: "left", y: "middle" })).toThrow(/preferredPlacement\.y/);
    expect(() => withPlacement({ x: "left" })).toThrow(/preferredPlacement\.y/);
    expect(() => withPlacement({ x: "left", y: "top", z: "front" })).toThrow(/preferredPlacement/);
  });

  it("refuses malformed ids and versions", () => {
    expect(() => parsePluginManifest({ ...minimal, id: "Jira Board" })).toThrow(/id/);
    expect(() => parsePluginManifest({ ...minimal, version: "v1" })).toThrow(/version/);
  });

  it("ties the header field to the header kind", () => {
    const missing = {
      ...minimal,
      capabilities: { secrets: { token: { kind: "header", label: "Token" } } },
    };
    expect(() => parsePluginManifest(missing)).toThrow(/names no header/);
    const stray = {
      ...minimal,
      capabilities: { secrets: { token: { kind: "bearer", label: "Token", header: "X-A" } } },
    };
    expect(() => parsePluginManifest(stray)).toThrow(/sets header/);
  });

  it("allows at most one user-supplied origin", () => {
    const raw = {
      ...minimal,
      capabilities: {
        net: { origins: { a: { userSupplied: true }, b: { userSupplied: true } } },
      },
    };
    expect(() => parsePluginManifest(raw)).toThrow(/at most one alias/);
  });

  it("caps namespaced storage", () => {
    const raw = {
      ...minimal,
      capabilities: { storage: { kv: { maxBytes: STORAGE_KV_MAX_BYTES + 1 } } },
    };
    expect(() => parsePluginManifest(raw)).toThrow(/maxBytes/);
  });

  it("validates read names as dotted catalog entries", () => {
    expect(() =>
      parsePluginManifest({ ...minimal, capabilities: { reads: ["SELECT *"] } }),
    ).toThrow(/reads/);
  });
});

describe("isExactHttpsOrigin", () => {
  it("accepts exact https origins, with an explicit port", () => {
    expect(isExactHttpsOrigin("https://acme.atlassian.net")).toBe(true);
    expect(isExactHttpsOrigin("https://jira.example.com:8443")).toBe(true);
    expect(isExactHttpsOrigin("https://xn--bcher-kva.example")).toBe(true);
  });

  it("refuses every non-origin shape", () => {
    for (const value of [
      "http://acme.atlassian.net",
      "https://acme.atlassian.net/",
      "https://acme.atlassian.net/rest",
      "https://acme.atlassian.net?x=1",
      "https://user:pw@acme.atlassian.net",
      "https://*.atlassian.net",
      "https://atlassian.net.",
      "https://jira",
      "acme.atlassian.net",
      "wss://acme.atlassian.net",
      "file:///etc/passwd",
      "",
    ]) {
      expect(isExactHttpsOrigin(value), value).toBe(false);
    }
  });

  it("refuses loopback, link-local, and private hosts", () => {
    for (const value of [
      "https://localhost",
      "https://app.localhost",
      "https://printer.local",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://192.168.1.1:8443",
      "https://172.16.0.1",
      "https://172.31.255.255",
      "https://169.254.169.254",
      "https://0.0.0.0",
      "https://[::1]",
      "https://[fe80::1]",
      "https://[fd00::1]",
    ]) {
      expect(isExactHttpsOrigin(value), value).toBe(false);
    }
    expect(isPrivateOrLoopbackHost("172.32.0.1")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
  });
});

describe("the sql grant", () => {
  const withSql = (sql: unknown, reads?: string[]) =>
    parsePluginManifest({
      ...minimal,
      capabilities: { sql, ...(reads ? { reads } : {}) },
    }).capabilities;
  const support = {
    reads: new Set(["feed.recent", "sql"]),
    sql: new Set(["v_usage_v1", "v_tasks_v1"]),
  };

  it("names the views by their versioned names, and asks for the grant by name", () => {
    const capabilities = withSql(["v_usage_v1"]);
    expect(requestedGrants(capabilities)).toEqual(["sql"]);
    expect(unservableGrants(capabilities, support)).toEqual([]);
    expect(consentSummary(capabilities).views).toEqual(["v_usage_v1"]);
    // No plain name: the version is part of the name.
    expect(() => withSql(["v_usage"])).toThrow(PluginManifestError);
    expect(() => withSql(["usage_events"])).toThrow(PluginManifestError);
  });

  it("refuses a view the host does not publish, and the sql read declared as a bare read", () => {
    expect(unservableGrants(withSql(["v_usage_v1", "v_usage_v9"]), support)).toEqual([
      "sql:v_usage_v9",
    ]);
    expect(unservableGrants(withSql(["v_usage_v1"]), {})).toEqual(["sql:v_usage_v1"]);
    expect(unservableGrants(withSql([], ["sql", "feed.recent"]), support)).toEqual(["reads:sql"]);
  });
});

describe("grants", () => {
  it("names exactly the grants a manifest asks for", () => {
    expect(requestedGrants(parsePluginManifest(minimal).capabilities)).toEqual([]);
    expect(requestedGrants(parsePluginManifest(withGrants).capabilities)).toEqual([
      "net.origins",
      "secrets",
      "storage.kv",
      "reads",
    ]);
  });

  it("refuses every grant a host does not serve, read by read", () => {
    const capabilities = parsePluginManifest(withGrants).capabilities;
    expect(unservableGrants(capabilities, {})).toEqual([
      "net.origins",
      "secrets",
      "storage.kv",
      "reads:feed.recent",
      "reads:crew.counts",
    ]);
    expect(
      unservableGrants(capabilities, {
        net: true,
        secrets: true,
        storage: true,
        reads: new Set(["feed.recent"]),
      }),
    ).toEqual(["reads:crew.counts"]);
    expect(unservableGrants(parsePluginManifest(minimal).capabilities, {})).toEqual([]);
  });

  it("summarises consent as the read/send pair", () => {
    expect(consentSummary(parsePluginManifest(withGrants).capabilities)).toEqual({
      reads: ["feed.recent", "crew.counts"],
      sendsTo: ["a host you choose", "https://api.atlassian.com"],
      writesTo: ["a host you choose"],
      secretSlots: ["jira-token", "jira-header"],
      storageBytes: 65_536,
      views: [],
      moves: false,
    });
    expect(consentSummary(parsePluginManifest(minimal).capabilities)).toEqual({
      reads: [],
      views: [],
      sendsTo: [],
      writesTo: [],
      secretSlots: [],
      storageBytes: null,
      moves: false,
    });
  });

  it("asks for moves as a grant of its own: named, served only by a host that moves tasks, and part of what consent compares", () => {
    const moving = parsePluginManifest({
      ...minimal,
      capabilities: { reads: ["tasks.board"], moves: true },
    }).capabilities;
    expect(requestedGrants(moving)).toEqual(["reads", "moves"]);
    expect(consentSummary(moving).moves).toBe(true);
    expect(unservableGrants(moving, { reads: new Set(["tasks.board"]) })).toEqual(["moves"]);
    expect(unservableGrants(moving, { reads: new Set(["tasks.board"]), moves: true })).toEqual([]);
    // An update that adds moves asks again: its canonical block differs.
    expect(canonicalCapabilities(moving)).not.toBe(
      canonicalCapabilities({ reads: ["tasks.board"] }),
    );
  });
});
