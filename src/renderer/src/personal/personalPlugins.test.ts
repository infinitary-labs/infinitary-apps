import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import { READ_NAMES } from "@shared/reads";
import { describe, expect, it } from "vitest";
import crewReports from "../../../../tests/fixtures/personal-skills/crew-reports/manifest.json";
import openPrs from "../../../../tests/fixtures/personal-skills/open-prs/manifest.json";
import quotaGlance from "../../../../tests/fixtures/personal-skills/quota-glance/manifest.json";
import tokenWatch from "../../../../tests/fixtures/personal-skills/token-watch/manifest.json";
import tokyoClock from "../../../../tests/fixtures/personal-skills/tokyo-clock/manifest.json";
import { useShellStore } from "../app/store";
import { registerBuiltinPlugin } from "../plugins/builtin";
import { PluginHost, placeSidePanels } from "../plugins/host";
import { panelDrafts } from "./PanelDrafts";
import { PersonalPlugins, startPersonalPlugins } from "./personalPlugins";

/** The tests' personal workspace (tests/fixtures/personal-skills), by folder. */
const FIXTURE_MANIFESTS = {
  "crew-reports": crewReports,
  "open-prs": openPrs,
  "quota-glance": quotaGlance,
  "token-watch": tokenWatch,
  "tokyo-clock": tokyoClock,
};

function view(overrides: Partial<PersonalExtensionView> & { id: string }): PersonalExtensionView {
  return {
    source: "yours",
    by: null,
    title: overrides.id,
    placement: { x: "right", y: "top" },
    order: 100,
    size: "content",
    present: true,
    ownPresence: false,
    moves: false,
    running: false,
    reads: [],
    sql: [],
    panel: null,
    frame: { version: "0123456789abcdef" },
    server: null,
    cardViews: [],
    cards: {},
    header: [],
    commands: [],
    error: null,
    ...overrides,
  };
}

describe("PersonalPlugins", () => {
  it("mounts, hides by presence, lights the busy dot, re-registers on manifest changes, and unmounts", () => {
    const host = new PluginHost();
    const plugins = new PersonalPlugins(host, () => {});
    plugins.apply({ extensions: [view({ id: "clock", title: "Tokyo" })] });
    const [clock] = host.sidePanels.list();
    expect(clock).toMatchObject({
      id: "clock",
      pluginId: "personal-clock",
      title: "Tokyo",
      // The captain, on the panel status mark: remove the "yours" label.
      attribution: null,
      preferredPlacement: { x: "right", y: "top" },
    });
    expect(clock?.source.get()).toEqual({
      id: "clock",
      title: "Tokyo",
      moves: false,
      decides: false,
      // Drawn in a frame from its pinned version (INF-2205 piece C), its
      // server.ts reached through the bridge.
      pluginId: "personal-clock",
      code: { source: "personal", version: "0123456789abcdef" },
      server: true,
      size: "content",
      reads: [],
      sql: [],
    });
    expect(clock?.running?.get()).toBe(false);
    expect(host.capabilitiesOf("personal-clock")).toEqual({});

    plugins.apply({
      extensions: [view({ id: "clock", title: "Tokyo", present: false, running: true })],
    });
    expect(host.sidePanels.list()[0]).toBe(clock);
    expect(clock?.source.get()).toBeNull();
    expect(clock?.running?.get()).toBe(true);

    plugins.apply({
      extensions: [
        view({ id: "clock", title: "Tokyo time", placement: { x: "left", y: "bottom" } }),
      ],
    });
    const moved = host.sidePanels.list()[0];
    expect(moved).not.toBe(clock);
    expect(moved).toMatchObject({
      title: "Tokyo time",
      preferredPlacement: { x: "left", y: "bottom" },
    });
    expect(placeSidePanels(host.sidePanels.list()).left.map((p) => p.id)).toEqual(["clock"]);

    plugins.apply({ extensions: [] });
    expect(host.sidePanels.list()).toEqual([]);
  });

  it("keeps a panel being built on its rail as it was, and hands its draft to the stage out of sight", () => {
    const host = new PluginHost();
    const plugins = new PersonalPlugins(host, () => {});
    plugins.apply({ extensions: [view({ id: "clock", title: "Tokyo" })] });
    const [clock] = host.sidePanels.list();
    const draft = view({
      id: "clock",
      title: "Tokyo, smaller",
      frame: { version: "fedcba9876543210" },
    });
    const fresh = view({ id: "fresh" });
    plugins.apply({
      extensions: [view({ id: "clock", title: "Tokyo", running: true })],
      drafts: [draft, fresh],
    });
    // The rail: the same registration and version, with the busy dot. A
    // draft registers nothing, so a new panel is on no rail yet.
    expect(host.sidePanels.list()).toEqual([clock]);
    expect(clock?.source.get()).toMatchObject({
      title: "Tokyo",
      code: { source: "personal", version: "0123456789abcdef" },
    });
    expect(clock?.running?.get()).toBe(true);
    expect(panelDrafts.get()).toEqual([draft, fresh]);

    // The build's report: the new version is the rail's, and the drafts go.
    plugins.apply({ extensions: [view({ ...draft, running: false }), fresh] });
    expect(host.sidePanels.list().map((panel) => [panel.id, panel.title])).toEqual([
      ["clock", "Tokyo, smaller"],
      ["fresh", "fresh"],
    ]);
    expect(panelDrafts.get()).toEqual([]);
    plugins.apply({ extensions: [], drafts: [fresh] });
    plugins.clear();
    expect(panelDrafts.get()).toEqual([]);
  });

  // INF-609, the captain: "we need to allow more panels, placeable both in
  // the left and right ... not refusing it." The app's own panels and the
  // five panels of the tests' personal workspace put four on the right rail,
  // which used to refuse the fourth.
  it("docks every panel on its rail, in placement order, with nothing refused", () => {
    const host = new PluginHost({ reads: new Set(READ_NAMES) });
    registerBuiltinPlugin(host);
    const warnings: string[] = [];
    const plugins = new PersonalPlugins(host, (message) => warnings.push(message));
    plugins.apply({
      extensions: Object.entries(FIXTURE_MANIFESTS).map(([id, manifest]) =>
        view({
          id,
          title: manifest.title,
          placement: manifest.placement as PersonalExtensionView["placement"],
          order: manifest.order,
        }),
      ),
    });
    expect(warnings).toEqual([]);
    const placed = placeSidePanels(host.sidePanels.list());
    expect(placed.left.map((panel) => panel.id)).toEqual(["open-prs", "quota-glance", "activity"]);
    expect(placed.right.map((panel) => panel.id)).toEqual([
      "crew-reports",
      "tokyo-clock",
      "now",
      "token-watch",
    ]);
    plugins.clear();
  });

  it("applies the boot snapshot and every push until stopped", async () => {
    const host = new PluginHost();
    const captured: { listener: ((snapshot: PersonalSnapshot) => void) | null } = {
      listener: null,
    };
    const stop = startPersonalPlugins(host, {
      list: async () => ({ extensions: [view({ id: "boot" })] }),
      onSnapshot: (l) => {
        captured.listener = l;
        return () => {
          captured.listener = null;
        };
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.sidePanels.list().map((p) => p.id)).toEqual(["boot"]);
    captured.listener?.({ extensions: [view({ id: "pushed" })] });
    expect(host.sidePanels.list().map((p) => p.id)).toEqual(["pushed"]);
    stop();
    expect(captured.listener).toBeNull();
    expect(host.sidePanels.list()).toEqual([]);
  });

  it("registers a panel's cards, buttons and commands, and takes its cards off when it leaves", () => {
    const host = new PluginHost();
    const plugins = new PersonalPlugins(host, () => {});
    const cards = { reader: { view: "reader", title: "Reading" } };
    const header = [{ id: "open", icon: "open" as const, label: "Open reading", emits: "reader" }];
    const commands = [{ id: "open", label: "Open reading", emits: "reader" }];
    plugins.apply({
      extensions: [
        view({ id: "reading", cardViews: ["reader"], cards, header, commands }),
        view({ id: "clock", present: false }),
      ],
    });
    const [reading] = host.sidePanels.list();
    expect(reading).toMatchObject({ cardViews: ["reader"], cards, header, commands });
    expect(reading?.CardBody).toBeTypeOf("function");
    const shell = useShellStore.getState();
    shell.emitPanelCard("reading", { view: "reader", title: "Reading" }, true);
    shell.emitPanelCard("clock", { view: "face", title: "Clock" }, false);
    // A panel with nothing on the rail keeps its cards; one that leaves takes them.
    plugins.apply({ extensions: [view({ id: "clock", present: false })] });
    expect(
      useShellStore
        .getState()
        .records.map((held) => ("panelCard" in held ? held.panelCard.panel : "")),
    ).toEqual(["clock"]);
    plugins.clear();
    expect(useShellStore.getState().records).toEqual([]);
  });
});
