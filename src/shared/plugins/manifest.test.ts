import { describe, expect, it } from "vitest";
import {
  canonicalCapabilities,
  consentSummary,
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
    integrations: [
      { integration: "github", actions: ["read"], why: "Shows the alpha's runs." },
      { integration: "Linear", events: ["issue_changed"], why: "Counts open issues." },
    ],
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

  it("accepts the integrations a panel names, each with its actions or events and why", () => {
    const manifest = parsePluginManifest(withGrants);
    expect(manifest.capabilities.integrations).toEqual([
      { integration: "github", actions: ["read"], why: "Shows the alpha's runs." },
      { integration: "Linear", events: ["issue_changed"], why: "Counts open issues." },
    ]);
  });

  it("refuses an integration named with no action and no event, twice, or with no why", () => {
    const withUses = (integrations: unknown) =>
      parsePluginManifest({ ...minimal, capabilities: { integrations } });
    expect(() => withUses([{ integration: "github", why: "Runs." }])).toThrow(
      /names no action and no event/,
    );
    expect(() =>
      withUses([
        { integration: "github", actions: ["read"], why: "Runs." },
        { integration: "GitHub", actions: ["write"], why: "Reruns." },
      ]),
    ).toThrow(/named twice/);
    expect(() => withUses([{ integration: "github", actions: ["read"], why: " " }])).toThrow(/why/);
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

  it("refuses the retired hosts and keys, pointing at integrations (the captain's INF-2334 answer)", () => {
    for (const key of ["net", "secrets"]) {
      const raw = { ...minimal, capabilities: { [key]: {} } };
      expect(() => parsePluginManifest(raw)).toThrow(
        new RegExp(
          `"${key}" is retired: a panel reaches a service outside your projects only through an integration`,
        ),
      );
    }
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
      "integrations",
      "storage.kv",
      "reads",
    ]);
  });

  it("refuses every grant a host does not serve, read by read", () => {
    const capabilities = parsePluginManifest(withGrants).capabilities;
    expect(unservableGrants(capabilities, {})).toEqual([
      "integrations",
      "storage.kv",
      "reads:feed.recent",
      "reads:crew.counts",
    ]);
    expect(
      unservableGrants(capabilities, {
        integrations: true,
        storage: true,
        reads: new Set(["feed.recent"]),
      }),
    ).toEqual(["reads:crew.counts"]);
    expect(unservableGrants(parsePluginManifest(minimal).capabilities, {})).toEqual([]);
  });

  it("summarises consent as what it reads and which integrations it uses for what", () => {
    expect(consentSummary(parsePluginManifest(withGrants).capabilities)).toEqual({
      reads: ["feed.recent", "crew.counts"],
      integrations: [
        { integration: "github", actions: ["read"], why: "Shows the alpha's runs." },
        { integration: "Linear", events: ["issue_changed"], why: "Counts open issues." },
      ],
      storageBytes: 65_536,
      views: [],
      moves: false,
      actions: [],
    });
    expect(consentSummary(parsePluginManifest(minimal).capabilities)).toEqual({
      reads: [],
      views: [],
      integrations: [],
      storageBytes: null,
      moves: false,
      actions: [],
    });
  });

  it("asks again when an update widens what a panel uses an integration for", () => {
    const reading = parsePluginManifest(withGrants).capabilities;
    const widened = {
      ...reading,
      integrations: [
        { integration: "github", actions: ["read", "write"], why: "Shows the alpha's runs." },
        { integration: "Linear", events: ["issue_changed"], why: "Counts open issues." },
      ],
    };
    expect(canonicalCapabilities(widened)).not.toBe(canonicalCapabilities(reading));
    // The same uses in another order are what was agreed to.
    const reordered = { ...reading, integrations: [...(reading.integrations ?? [])].reverse() };
    expect(canonicalCapabilities(reordered)).toBe(canonicalCapabilities(reading));
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
