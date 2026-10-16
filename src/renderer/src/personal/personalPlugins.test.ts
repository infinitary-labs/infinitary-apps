import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import { describe, expect, it } from "vitest";
import { useShellStore } from "../app/store";
import { PluginHost, placeSidePanels } from "../plugins/host";
import { panelDrafts } from "./PanelDrafts";
import { PersonalPlugins, startPersonalPlugins } from "./personalPlugins";

/**
 * The reconciler mounts the core's snapshot through the host's one door:
 * presence is the panel's content source (null hides it with no chrome),
 * running is the busy dot's source, a manifest change re-registers, a
 * removal unregisters, and a full rail is a logged refusal, not a crash.
 */
function view(overrides: Partial<PersonalExtensionView> & { id: string }): PersonalExtensionView {
  return {
    source: "yours",
    by: null,
    frame: null,
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
    panel: {
      url: `app-plugin://personal/${overrides.id}/0123456789abcdef/panel.mjs`,
      version: "0123456789abcdef",
    },
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
      attribution: "yours",
      preferredPlacement: { x: "right", y: "top" },
    });
    expect(clock?.source.get()).toEqual({
      id: "clock",
      title: "Tokyo",
      moves: false,
      decides: false,
      url: "app-plugin://personal/clock/0123456789abcdef/panel.mjs",
      version: "0123456789abcdef",
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
      panel: {
        url: "app-plugin://personal/clock/fedcba9876543210/panel.mjs",
        version: "fedcba9876543210",
      },
    });
    const fresh = view({ id: "fresh" });
    plugins.apply({
      extensions: [view({ id: "clock", title: "Tokyo", running: true })],
      drafts: [draft, fresh],
    });
    // The rail: the same registration and version, with the busy dot. A
    // draft registers nothing, so a new panel is on no rail yet.
    expect(host.sidePanels.list()).toEqual([clock]);
    expect(clock?.source.get()).toMatchObject({ title: "Tokyo", version: "0123456789abcdef" });
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

  it("logs a refused mount when a rail is full and keeps the rest", () => {
    const host = new PluginHost();
    const warnings: string[] = [];
    const plugins = new PersonalPlugins(host, (message) => warnings.push(message));
    plugins.apply({
      extensions: ["a", "b", "c", "d"].map((id) => view({ id: `${id}-panel` })),
    });
    expect(host.sidePanels.list().map((p) => p.id)).toEqual(["a-panel", "b-panel", "c-panel"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('personal panel "d-panel" was not mounted');
    expect(warnings[0]).toContain("already holds 3 panels");
    plugins.apply({ extensions: [view({ id: "d-panel" })] });
    expect(host.sidePanels.list().map((p) => p.id)).toEqual(["d-panel"]);
    plugins.clear();
    expect(host.sidePanels.list()).toEqual([]);
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
