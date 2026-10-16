import { type PluginManifestInput, parsePluginManifest } from "@shared/plugins/manifest";
import { describe, expect, it } from "vitest";
import { type PluginBindings, type SidePanelContribution, sidePanelBinding } from "./contributions";
import { PluginCapabilityError, PluginHost, placeSidePanels, RAIL_MOUNT_CAP } from "./host";
import { createPanelSource } from "./panelSource";
import { ContributionError } from "./registry";

const Empty = () => null;
const Body = (_props: { content: string }) => null;

function panelBinding() {
  return sidePanelBinding({ source: createPanelSource<string>("hello").source, Body });
}

function manifestWithPanels(
  id: string,
  panels: {
    id: string;
    side: "left" | "right";
    y?: "top" | "bottom";
    order?: number;
  }[],
): PluginManifestInput {
  return {
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    contributes: {
      sidePanels: panels.map((panel) => ({
        id: panel.id,
        title: panel.id,
        preferredPlacement: { x: panel.side, y: panel.y ?? "top" },
        order: panel.order ?? 0,
      })),
    },
    capabilities: {},
  };
}

function bindingsFor(manifest: PluginManifestInput): PluginBindings {
  const sidePanels: Record<string, ReturnType<typeof panelBinding>> = {};
  for (const panel of manifest.contributes?.sidePanels ?? []) {
    sidePanels[panel.id] = panelBinding();
  }
  return { sidePanels };
}

describe("PluginHost.registerPlugin", () => {
  it("registers every declared contribution and removes them all again", () => {
    const host = new PluginHost();
    const manifest = parsePluginManifest({
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      contributes: {
        cardKinds: [{ kind: "ticket", chrome: "note", body: { streaming: "html" } }],
        settingsSections: [{ id: "acme", label: "Acme", order: 50 }],
        sidePanels: [
          {
            id: "board",
            title: "Board",
            preferredPlacement: { x: "right", y: "top" },
            order: 1,
          },
        ],
      },
      capabilities: {},
    });
    const remove = host.registerPlugin(manifest, {
      settingsSections: { acme: { Component: Empty } },
      sidePanels: { board: panelBinding() },
    });
    expect(host.cardKinds.get("ticket")?.pluginId).toBe("acme");
    expect(host.settingsSections.get("acme")?.width).toBe("wide");
    const board = host.sidePanels.get("board");
    expect(board?.attribution).toBe("Acme");
    expect(board?.preferredPlacement).toEqual({ x: "right", y: "top" });
    expect(board?.size).toBe("content");
    remove();
    expect(host.cardKinds.list()).toHaveLength(0);
    expect(host.settingsSections.list()).toHaveLength(0);
    expect(host.sidePanels.list()).toHaveLength(0);
  });

  it("refuses a manifest asking for any grant this host does not serve", () => {
    const host = new PluginHost();
    const manifest = parsePluginManifest({
      ...manifestWithPanels("jira", []),
      capabilities: {
        net: { origins: { jira: { userSupplied: true } } },
        reads: ["feed.recent"],
      },
    });
    expect(() => host.registerPlugin(manifest)).toThrow(PluginCapabilityError);
    expect(() => host.registerPlugin(manifest)).toThrow(
      'plugin "jira" asks for net.origins, reads:feed.recent, which this host does not serve',
    );
  });

  it("serves a read only when its catalog names it", () => {
    const manifest = parsePluginManifest({
      ...manifestWithPanels("jira", []),
      capabilities: { reads: ["feed.recent"] },
    });
    expect(() =>
      new PluginHost({ reads: new Set(["crew.counts"]) }).registerPlugin(manifest),
    ).toThrow("reads:feed.recent");
    expect(() =>
      new PluginHost({ reads: new Set(["feed.recent"]) }).registerPlugin(manifest),
    ).not.toThrow();
  });

  it("keeps the capabilities a plugin was admitted with, until it is removed", () => {
    const host = new PluginHost({ reads: new Set(["feed.recent", "crew.counts"]) });
    const manifest = parsePluginManifest({
      ...manifestWithPanels("acme", []),
      capabilities: { reads: ["crew.counts"] },
    });
    const remove = host.registerPlugin(manifest);
    expect(host.capabilitiesOf("acme")).toEqual({ reads: ["crew.counts"] });
    expect(host.declaredReads("acme")).toEqual(["crew.counts"]);
    expect(host.declaredReads("nobody")).toEqual([]);
    expect(() => host.registerPlugin(manifest)).toThrow('plugin "acme" is already registered');
    remove();
    expect(host.capabilitiesOf("acme")).toBeUndefined();
    expect(() => host.registerPlugin(manifest)).not.toThrow();
  });

  it("requires a binding for every declared section and panel, and no stray binding", () => {
    const host = new PluginHost();
    const manifest = parsePluginManifest(
      manifestWithPanels("acme", [{ id: "board", side: "left" }]),
    );
    expect(() => host.registerPlugin(manifest)).toThrow(
      'side-panel: plugin "acme" declares board but binds no implementation',
    );
    expect(() =>
      host.registerPlugin(manifest, {
        sidePanels: { board: panelBinding(), extra: panelBinding() },
      }),
    ).toThrow("binds extra without declaring it");
    expect(host.sidePanels.list()).toHaveLength(0);
  });

  it("unwinds everything it registered when a later contribution is refused", () => {
    const host = new PluginHost();
    host.registerPlugin(
      parsePluginManifest({
        id: "first",
        name: "First",
        version: "1.0.0",
        contributes: {
          cardKinds: [{ kind: "shared", chrome: "note", body: { streaming: "html" } }],
        },
        capabilities: {},
      }),
    );
    const clashing = parsePluginManifest({
      id: "second",
      name: "Second",
      version: "1.0.0",
      contributes: {
        cardKinds: [
          { kind: "fresh", chrome: "note", body: { streaming: "html" } },
          { kind: "shared", chrome: "note", body: { streaming: "html" } },
        ],
      },
      capabilities: {},
    });
    expect(() => host.registerPlugin(clashing)).toThrow(ContributionError);
    expect(host.cardKinds.get("fresh")).toBeUndefined();
    expect(host.cardKinds.get("shared")?.pluginId).toBe("first");
  });
});

describe("the side-panel mount cap (D5 rule 6)", () => {
  it(`holds ${RAIL_MOUNT_CAP} panels per rail and refuses the next one loudly`, () => {
    const host = new PluginHost();
    const fill = manifestWithPanels(
      "fill",
      Array.from({ length: RAIL_MOUNT_CAP }, (_, i) => ({
        id: `left-${i}`,
        side: "left" as const,
      })),
    );
    host.registerPlugin(parsePluginManifest(fill), bindingsFor(fill));
    const overflow = manifestWithPanels("more", [{ id: "one-too-many", side: "left" }]);
    expect(() => host.registerPlugin(parsePluginManifest(overflow), bindingsFor(overflow))).toThrow(
      `side-panel: the left rail already holds ${RAIL_MOUNT_CAP} panels (left-0, left-1, left-2); "one-too-many" from "more" was refused`,
    );
    expect(host.sidePanels.list()).toHaveLength(RAIL_MOUNT_CAP);
  });

  it("caps each rail independently", () => {
    const host = new PluginHost();
    const left = manifestWithPanels(
      "left",
      Array.from({ length: RAIL_MOUNT_CAP }, (_, i) => ({ id: `l-${i}`, side: "left" as const })),
    );
    host.registerPlugin(parsePluginManifest(left), bindingsFor(left));
    const right = manifestWithPanels("right", [{ id: "r-0", side: "right" }]);
    expect(() => host.registerPlugin(parsePluginManifest(right), bindingsFor(right))).not.toThrow();
    expect(placeSidePanels(host.sidePanels.list()).right.map((panel) => panel.id)).toEqual(["r-0"]);
  });
});

describe("placement and ordering", () => {
  it("places panels on their preferred side, ordered by order then id", () => {
    const host = new PluginHost();
    const manifest = manifestWithPanels("acme", [
      { id: "zulu", side: "left", order: 1 },
      { id: "alpha", side: "left", order: 1 },
      { id: "first", side: "left", order: 0 },
      { id: "solo", side: "right", order: 5 },
    ]);
    host.registerPlugin(parsePluginManifest(manifest), bindingsFor(manifest));
    const placed = placeSidePanels(host.sidePanels.list());
    expect(placed.left.map((panel: SidePanelContribution) => panel.id)).toEqual([
      "first",
      "alpha",
      "zulu",
    ]);
    expect(placed.right.map((panel) => panel.id)).toEqual(["solo"]);
  });

  it("stacks top-placed panels above bottom-placed ones within a rail, order breaking ties inside each", () => {
    const host = new PluginHost();
    const manifest = manifestWithPanels("acme", [
      { id: "footer", side: "left", y: "bottom", order: 0 },
      { id: "header", side: "left", y: "top", order: 5 },
      { id: "banner", side: "left", y: "top", order: 1 },
    ]);
    host.registerPlugin(parsePluginManifest(manifest), bindingsFor(manifest));
    const placed = placeSidePanels(host.sidePanels.list());
    expect(placed.left.map((panel: SidePanelContribution) => panel.id)).toEqual([
      "banner",
      "header",
      "footer",
    ]);
  });
});

describe("describeCardKind", () => {
  it("returns the registered description, else the neutral note dress", () => {
    const host = new PluginHost();
    host.registerPlugin(
      parsePluginManifest({
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        contributes: {
          cardKinds: [
            {
              kind: "ticket",
              chrome: "decision",
              body: { streaming: "plain" },
            },
          ],
        },
        capabilities: {},
      }),
    );
    expect(host.describeCardKind("ticket").chrome).toBe("decision");
    expect(host.describeCardKind("never-heard-of")).toMatchObject({
      pluginId: "host",
      chrome: "note",
      body: { streaming: "html" },
    });
  });
});

describe("placement under the captain's layout (talk-to-personalize Step 1)", () => {
  it("keeps a hidden panel off both rails and moves a placed one, with the applied placement on it", () => {
    const host = new PluginHost();
    const manifest = manifestWithPanels("acme", [
      { id: "activity", side: "left", y: "bottom" },
      { id: "now", side: "right", y: "bottom" },
      { id: "quota", side: "right", y: "top" },
    ]);
    host.registerPlugin(parsePluginManifest(manifest), bindingsFor(manifest));
    const placed = placeSidePanels(host.sidePanels.list(), {
      collapsedPanels: {},
      hiddenPanels: { now: true },
      placements: { activity: { x: "right", y: "top" } },
    });
    expect(placed.left).toEqual([]);
    expect(placed.right.map((panel) => [panel.id, panel.preferredPlacement])).toEqual([
      ["activity", { x: "right", y: "top" }],
      ["quota", { x: "right", y: "top" }],
    ]);
    // The registered contribution itself is untouched: the record is applied, not written back.
    expect(host.sidePanels.get("activity")?.preferredPlacement).toEqual({ x: "left", y: "bottom" });
  });
});
