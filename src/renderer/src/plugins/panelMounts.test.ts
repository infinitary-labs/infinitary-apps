import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import type { PanelMount, PanelMounts } from "@shared/personal/mounts";
import { DEFAULT_LAYOUT, type Layout } from "@shared/preferences";
import { READ_NAMES } from "@shared/reads";
import { afterEach, describe, expect, it } from "vitest";
import { panelBodies } from "../personal/panelBodies";
import { PersonalPlugins } from "../personal/personalPlugins";
import { registerBuiltinPlugin } from "./builtin";
import { BUILTIN_PLUGIN_ID } from "./builtin/manifest";
import { PluginHost } from "./host";
import { noteMountSnapshot, readPanelMounts, startPanelMounts } from "./panelMounts";
import { panelRail } from "./panelRail";
import { railRefusals } from "./railRefusals";

/**
 * The window's answer about its panels (INF-607, docs/personal-panels.md
 * "Placed on the rail"): read from the real host, the real reconciler and
 * the stores the rails draw from, so a panel the window refused is named
 * refused with the refusal's own words, never shown - and never answered
 * for by the app's own panel that holds its id.
 */
function view(overrides: Partial<PersonalExtensionView> & { id: string }): PersonalExtensionView {
  return {
    source: "yours",
    by: null,
    frame: null,
    title: overrides.id,
    placement: { x: "left", y: "top" },
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

const VERSION = "0123456789abcdef";

function answer(host: PluginHost, snapshot: PersonalSnapshot, layout: Layout = DEFAULT_LAYOUT) {
  return readPanelMounts({
    panels: host.sidePanels.list(),
    layout,
    views: snapshot.extensions,
    refusals: railRefusals.list(),
    bodies: panelBodies.list(),
    said: (id) => panelRail.get(id),
    isCollapsed: (id) => id === "folded",
    slot: { shows: false, why: "it shows once his third task has finished" },
  });
}

const of = (mounts: ReturnType<typeof answer>, id: string, kind: PanelMount["kind"] = "personal") =>
  mounts.find((mount) => mount.id === id && mount.kind === kind);

describe("the window's answer about its panels", () => {
  let plugins: PersonalPlugins | null = null;
  let builtin: (() => void) | null = null;
  afterEach(() => {
    plugins?.clear();
    plugins = null;
    builtin?.();
    builtin = null;
  });

  it("names a panel of the captain's refused for an id the app's panel holds, apart from that panel, and draws it under a new id", () => {
    const host = new PluginHost({ reads: new Set(READ_NAMES) });
    builtin = registerBuiltinPlugin(host);
    plugins = new PersonalPlugins(host, () => {});
    // A crewmate names the captain's new panel's folder after the app's
    // Activity panel: every rail takes it (PR #187), but the id is taken.
    const named: PersonalSnapshot = { extensions: [view({ id: "activity" })] };
    plugins.apply(named);
    const mounts = answer(host, named);
    const mine = of(mounts, "activity", "personal");
    expect(mine).toMatchObject({ state: "refused", rail: "left", version: VERSION });
    expect(mine?.why).toBe(
      `side-panel: "activity" from "personal-activity" is already registered by "${BUILTIN_PLUGIN_ID}"`,
    );
    // The app's own Activity answers for itself, never for the refused one.
    expect(of(mounts, "activity", "app")).toMatchObject({ kind: "app", version: null });
    expect(of(mounts, "activity", "app")?.state).not.toBe("refused");

    // Renamed, it mounts, and its body has not drawn yet.
    const renamed: PersonalSnapshot = { extensions: [view({ id: "my-activity" })] };
    plugins.apply(renamed);
    expect(railRefusals.list().size).toBe(0);
    expect(of(answer(host, renamed), "activity", "personal")).toBeUndefined();
    expect(of(answer(host, renamed), "my-activity", "personal")).toMatchObject({
      state: "loading",
      why: null,
    });
    panelBodies.note("my-activity", { version: VERSION, state: "drawn" });
    expect(of(answer(host, renamed), "my-activity", "personal")).toMatchObject({
      state: "drawn",
      rail: "left",
    });
  });

  it("says why a registered panel has nothing on its rail, a body stopped, and the layout's hidden and collapsed", () => {
    const host = new PluginHost();
    plugins = new PersonalPlugins(host, () => {});
    const snapshot: PersonalSnapshot = {
      extensions: [
        view({ id: "empty", present: false, placement: { x: "right", y: "top" } }),
        view({
          id: "broken",
          present: false,
          panel: null,
          error: { stage: "panel", message: "broken/panel.tsx: Unexpected token" },
          placement: { x: "right", y: "top" },
        }),
        view({ id: "decides", ownPresence: true, placement: { x: "right", y: "bottom" } }),
        view({ id: "thrown" }),
        view({ id: "folded" }),
        view({ id: "tucked" }),
      ],
    };
    plugins.apply(snapshot);
    panelBodies.note("thrown", { version: VERSION, state: "stopped", why: "TypeError: x is null" });
    panelBodies.note("folded", { version: VERSION, state: "drawn" });
    const mounts = answer(host, snapshot, {
      ...DEFAULT_LAYOUT,
      hiddenPanels: { tucked: true },
    });
    expect(of(mounts, "empty")).toMatchObject({ state: "off", rail: "right" });
    expect(of(mounts, "empty")?.why).toContain("its presence rule finds nothing to show");
    expect(of(mounts, "broken")).toMatchObject({
      state: "off",
      version: null,
      why: "broken/panel.tsx: Unexpected token",
    });
    expect(of(mounts, "decides")).toMatchObject({
      state: "off",
      why: "its own code has not put it on its rail yet",
    });
    expect(of(mounts, "thrown")).toMatchObject({ state: "stopped", why: "TypeError: x is null" });
    expect(of(mounts, "folded")).toMatchObject({ state: "collapsed", why: null });
    expect(of(mounts, "tucked")).toMatchObject({ state: "hidden", why: null });
    expect(of(mounts, "create-panel", "app")).toMatchObject({
      state: "off",
      rail: "left",
      why: "it shows once his third task has finished",
    });
  });

  it("sends the answer once per change of it, coalesced", async () => {
    const host = new PluginHost();
    plugins = new PersonalPlugins(host, () => {});
    const sent: PanelMounts[] = [];
    const stop = startPanelMounts(host, {
      reportMounts: async (mounts) => {
        sent.push(mounts);
      },
    });
    try {
      await Promise.resolve();
      const before = sent.length;
      const snapshot: PersonalSnapshot = { extensions: [view({ id: "clock" })] };
      plugins.apply(snapshot);
      noteMountSnapshot(snapshot);
      await Promise.resolve();
      expect(sent.length).toBe(before + 1);
      expect(sent.at(-1)?.panels.find((mount) => mount.id === "clock")?.state).toBe("loading");
      // The same answer again sends nothing.
      noteMountSnapshot(snapshot);
      await Promise.resolve();
      expect(sent.length).toBe(before + 1);
      panelBodies.note("clock", { version: VERSION, state: "drawn" });
      await Promise.resolve();
      expect(sent.at(-1)?.panels.find((mount) => mount.id === "clock")?.state).toBe("drawn");
    } finally {
      stop();
      noteMountSnapshot({ extensions: [] });
    }
  });
});
