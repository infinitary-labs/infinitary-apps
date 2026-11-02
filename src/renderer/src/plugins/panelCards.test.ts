import { panelCommandId } from "@shared/keyboard";
import { parsePluginManifest } from "@shared/plugins/manifest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shownCard, useShellStore } from "../app/store";
import { sidePanelBinding } from "./contributions";
import { pluginHost } from "./host";
import {
  emitNamedCard,
  emitPanelCard,
  framePanelCardAction,
  keepPanelCard,
  onPanelAsk,
  onPanelFocus,
  openPanelCards,
  pushPanelAsk,
  pushPanelFocus,
  windowPanelCards,
} from "./panelCards";
import { panelCommandRefusal, panelCommandsOf, runPanelCommand } from "./panelCommands";
import { panelRail } from "./panelRail";
import { createPanelSource } from "./panelSource";
import { railStore } from "./railStore";

/**
 * A panel's cards, the host's side (docs/ui-plugins.md, "A panel's cards"):
 * `cards.emit` checked like any input from a panel, the captain's own click
 * or key bringing a card to the front and anything else putting it behind,
 * the named cards a header button or a command puts up, the asks a button
 * presses into its panel, and the panel's commands as the window's keys and
 * command search read them.
 */

const shell = () => useShellStore.getState();
const shown = () => shownCard(shell().cards, shell().cardIndex, [], shell().records);

const content = createPanelSource<string>("reading");
let unregister: () => void = () => {};

beforeEach(() => {
  useShellStore.setState({
    cards: [],
    records: [],
    cardIndex: 0,
    unreadCardIds: [],
    view: "home",
  });
  unregister = registerReading();
});

/**
 * The reading list panel, the captain's own unless `own` registers it as
 * one of the app's own, whose own code then decides whether it shows.
 */
function registerReading(own = false): () => void {
  return pluginHost.registerPlugin(
    parsePluginManifest({
      id: "personal-reading",
      name: "yours",
      version: "1.0.0",
      contributes: {
        sidePanels: [
          {
            id: "reading",
            title: "Reading list",
            preferredPlacement: { x: "right", y: "top" },
            order: 100,
            cardViews: ["reader"],
            cards: { reader: { view: "reader", title: "Reading", data: { from: "manifest" } } },
            header: [
              { id: "open", icon: "open", label: "Open reading", emits: "reader" },
              { id: "search", icon: "search", label: "Search" },
            ],
            commands: [
              { id: "open", label: "Open reading", emits: "reader", key: "⌘J" },
              { id: "find", label: "Find a piece", presses: "search" },
            ],
          },
        ],
      },
      capabilities: {},
    }),
    {
      sidePanels: {
        reading: sidePanelBinding({
          source: content.source,
          ...(own ? { rail: { decides: true } } : {}),
          Body: () => null,
        }),
      },
    },
    own ? { firstParty: true } : undefined,
  );
}

afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
  useShellStore.setState({ records: [], cards: [], cardIndex: 0, unreadCardIds: [] });
});

describe("cards.emit, checked at the boundary", () => {
  it("refuses a view the panel does not have, a panel the app does not have, and a bad shape", () => {
    expect(() => emitPanelCard("reading", { view: "other", title: "x" }, true)).toThrow(
      'cards.emit: "other" is not one of this panel\'s card views; write cards/other.tsx',
    );
    expect(() => emitPanelCard("gone", { view: "reader", title: "x" }, true)).toThrow(
      '"gone" is not a panel the app has now',
    );
    expect(() => emitPanelCard("reading", { view: "reader" }, true)).toThrow("cards.emit: title");
    expect(shell().records).toEqual([]);
  });

  it("lists a panel's open cards, newest first, and which is shown", () => {
    emitPanelCard("reading", { id: "a", view: "reader", title: "A" }, true);
    emitPanelCard("reading", { id: "b", view: "reader", title: "B" }, false);
    emitPanelCard("reading", { id: "c", view: "reader", title: "C", height: "fill" }, false);
    expect(openPanelCards("reading")).toEqual([
      { id: "c", view: "reader", title: "C", width: "wide", height: "fill", shown: false },
      { id: "b", view: "reader", title: "B", width: "wide", height: "content", shown: false },
      { id: "a", view: "reader", title: "A", width: "wide", height: "content", shown: true },
    ]);
  });
});

describe("who asked for a card", () => {
  it("brings a named card to the front from a header button or command, its name its id", () => {
    emitPanelCard("reading", { id: "other", view: "reader", title: "Other" }, true);
    expect(emitNamedCard("reading", "reader")).toBe("reader");
    expect(shown()?.panelCard).toMatchObject({
      id: "reader",
      title: "Reading",
      data: { from: "manifest" },
    });
    expect(shown()?.panelCard?.revision).toBe(1);
    expect(emitNamedCard("reading", "reader", { focus: "find" })).toBe("reader");
    expect(shown()?.panelCard?.data).toEqual({ focus: "find" });
    // Each time it is put up again is one more revision, its data new or the same.
    expect(shown()?.panelCard?.revision).toBe(2);
    expect(emitNamedCard("reading", "reader", { focus: "find" })).toBe("reader");
    expect(shown()?.panelCard?.revision).toBe(3);
    expect(shell().records).toHaveLength(2);
    expect(emitNamedCard("reading", "missing")).toBeNull();
  });

  it("in the window: at the front while the window holds a click or key, behind otherwise", async () => {
    const cards = windowPanelCards("reading");
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });
    await cards.emit({ id: "first", view: "reader", title: "First" });
    await cards.emit({ id: "quiet", view: "reader", title: "Quiet" });
    expect(shown()?.panelCard?.id).toBe("first");
    expect(shell().unreadCardIds).toEqual(["panel-card:reading/quiet"]);
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    await expect(cards.emit({ id: "asked", view: "reader", title: "Asked" })).resolves.toBe(
      "asked",
    );
    expect(shown()?.panelCard?.id).toBe("asked");
    await cards.close("asked");
    expect(openPanelCards("reading").map((card) => card.id)).toEqual(["quiet", "first"]);
  });

  it("in a frame: at the front only while that frame holds the window's focus", async () => {
    const frame = {} as HTMLIFrameElement;
    const focus = { activeElement: null as unknown };
    vi.stubGlobal("document", focus);
    vi.stubGlobal("requestAnimationFrame", (step: () => void) => queueMicrotask(step));
    const act = framePanelCardAction("reading", () => frame);
    emitPanelCard("reading", { id: "first", view: "reader", title: "First" }, true);
    await expect(act("cards.emit", { id: "script", view: "reader", title: "x" })).resolves.toBe(
      "script",
    );
    expect(shown()?.panelCard?.id).toBe("first");
    focus.activeElement = frame;
    await act("cards.emit", { id: "click", view: "reader", title: "y" });
    expect(shown()?.panelCard?.id).toBe("click");
    await expect(act("cards.open", undefined)).resolves.toHaveLength(3);
    await act("cards.close", { id: "click" });
    await expect(act("other", undefined)).rejects.toThrow("is not one of a panel's card actions");
  });
});

describe("a card's kept place", () => {
  it("is held on its entry, at most 4,096 bytes of JSON, and only a card's own page keeps one", async () => {
    emitPanelCard("reading", { id: "r", view: "reader", title: "R" }, true);
    keepPanelCard("reading", "r", { tab: "notes", scroll: 40 });
    expect(shown()?.panelCard?.kept).toEqual({ tab: "notes", scroll: 40 });
    expect(() => keepPanelCard("reading", "r", "x".repeat(4_096))).toThrow(
      "card.keep: a card keeps at most 4096 bytes of JSON",
    );
    expect(shown()?.panelCard?.kept).toEqual({ tab: "notes", scroll: 40 });
    const page = framePanelCardAction("reading", () => null, "r");
    await page("card.keep", { tab: "list" });
    expect(shown()?.panelCard?.kept).toEqual({ tab: "list" });
    const panel = framePanelCardAction("reading", () => null);
    await expect(panel("card.keep", 1)).rejects.toThrow("only a card's own page keeps a place");
  });
});

describe("the asks a header button presses into its panel", () => {
  it("is heard now by a body that listens, or by the next one that does, with how it came", async () => {
    const heard: string[] = [];
    pushPanelAsk("reading", "search", "key");
    const stop = onPanelAsk("reading", (button, via) => heard.push(`${button}:${via}`));
    await Promise.resolve();
    expect(heard).toEqual(["search:key"]);
    pushPanelAsk("reading", "search", "click");
    expect(heard).toEqual(["search:key", "search:click"]);
    stop();
  });

  it("asks a body that is there to put focus where a person starts in it (F6)", () => {
    let asked = 0;
    pushPanelFocus("reading");
    const stop = onPanelFocus("reading", () => {
      asked += 1;
    });
    expect(asked).toBe(0);
    pushPanelFocus("reading");
    expect(asked).toBe(1);
    stop();
    pushPanelFocus("reading");
    expect(asked).toBe(1);
  });
});

describe("a panel's commands", () => {
  it("are listed under the panel's title with the key it suggests", () => {
    expect(panelCommandsOf(pluginHost.sidePanels.list().filter((p) => p.id === "reading"))).toEqual(
      [
        {
          id: panelCommandId("reading", "open"),
          label: "Open reading",
          panel: "Reading list",
          keys: [{ key: "j", meta: true }],
        },
        {
          id: panelCommandId("reading", "find"),
          label: "Find a piece",
          panel: "Reading list",
          keys: [],
        },
      ],
    );
  });

  it("put up their card from anywhere, but press a button only into a panel with something to show", () => {
    const find = panelCommandId("reading", "find");
    const open = panelCommandId("reading", "open");
    expect(panelCommandRefusal(pluginHost, open, false)).toBeNull();
    expect(panelCommandRefusal(pluginHost, open, true)).toBe("A recording is running");
    expect(panelCommandRefusal(pluginHost, panelCommandId("gone", "open"), false)).toBe(
      "Its panel is not here now",
    );
    content.set(null);
    expect(panelCommandRefusal(pluginHost, find, false)).toBe("Reading list has nothing to show");
    expect(panelCommandRefusal(pluginHost, open, false)).toBeNull();
    content.set("reading");
    expect(panelCommandRefusal(pluginHost, find, false)).toBeNull();
  });

  it("run their card at the front, with focus asked for, or press their button into the panel", async () => {
    useShellStore.setState({ view: "settings" });
    const focused: string[] = [];
    runPanelCommand(pluginHost, panelCommandId("reading", "open"), (entry) => focused.push(entry));
    expect(shell().view).toBe("home");
    expect(shown()?.panelCard?.id).toBe("reader");
    expect(focused).toEqual(["panel-card:reading/reader"]);
    const heard: string[] = [];
    const stop = onPanelAsk("reading", (button) => heard.push(button));
    railStore.reset();
    runPanelCommand(pluginHost, panelCommandId("reading", "find"), () => {});
    expect(heard).toEqual(["search"]);
    expect(railStore.isCollapsed("reading")).toBe(false);
    stop();
  });
});

describe("the app's own panel's commands", () => {
  it("read as the window's own, and off its rail say why in the panel's own words", () => {
    unregister();
    unregister = registerReading(true);
    content.set("reading");
    const commands = panelCommandsOf(
      pluginHost.sidePanels.list().filter((p) => p.id === "reading"),
    );
    expect(commands.map((command) => command.own)).toEqual([true, true]);
    const find = panelCommandId("reading", "find");
    // Off its rail until its own code says so: the app's words, until it says its own.
    expect(panelCommandRefusal(pluginHost, find, false)).toBe("Reading list has nothing to show");
    panelRail.show("reading", { shown: false, why: "Nothing to read yet" }, true);
    expect(panelCommandRefusal(pluginHost, find, false)).toBe("Nothing to read yet");
    panelRail.show("reading", true, true);
    expect(panelCommandRefusal(pluginHost, find, false)).toBeNull();
    panelRail.forget("reading");
  });
});
