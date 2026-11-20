import type { FrameBridgeApi } from "@shared/plugins/bridge";
import { PANEL_KEY_CLICK_ACTION } from "@shared/plugins/panelActionIds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followKeyClicks } from "./keyClicks";

/**
 * A panel page's half of the key reminder (docs/keyboard.md, "The key
 * reminder"): a mouse click on one of its controls marked with one of its
 * own commands asks the window, through the bridge, to name that command's
 * key; a click a key or a script made, one on a control marked off, and one
 * on a control with no command ask nothing.
 */

/** An element as the click reads it: its attributes, and its ancestors' by `closest`. */
class FakeElement {
  constructor(
    readonly attributes: Record<string, string>,
    readonly parent: FakeElement | null = null,
  ) {}
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  closest(selector: string): FakeElement | null {
    const wanted = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!wanted) throw new Error(`the fake reads no selector like ${selector}`);
    const [, name = "", value] = wanted;
    for (let at: FakeElement | null = this; at; at = at.parent) {
      const has = at.attributes[name];
      if (has !== undefined && (value === undefined || has === value)) return at;
    }
    return null;
  }
}

function fakePage() {
  const listeners: ((event: unknown) => void)[] = [];
  const doc = {
    addEventListener: (type: string, listener: (event: unknown) => void, capture: boolean) => {
      expect(type).toBe("click");
      expect(capture).toBe(true);
      listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: (event: unknown) => void) => {
      listeners.splice(listeners.indexOf(listener), 1);
    },
  } as unknown as Document;
  const asked: [string, unknown][] = [];
  const bridge = {
    action: async (id: string, value: unknown) => {
      asked.push([id, value]);
      return undefined;
    },
  } as unknown as FrameBridgeApi;
  const click = (target: FakeElement, { trusted = true, detail = 1 } = {}) => {
    for (const listener of [...listeners]) listener({ isTrusted: trusted, detail, target });
  };
  return { doc, bridge, asked, click, listeners };
}

beforeEach(() => {
  vi.stubGlobal("Element", FakeElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a panel page's clicks for the key reminder", () => {
  it("asks the window to name the key of the command a mouse click pressed, from the control or inside it", () => {
    const { doc, bridge, asked, click } = fakePage();
    followKeyClicks(doc, bridge);
    const tab = new FakeElement({ "data-key-command": "board-backlog" });
    click(tab);
    click(new FakeElement({}, tab), { detail: 2 });
    expect(asked).toEqual([
      [PANEL_KEY_CLICK_ACTION, "board-backlog"],
      [PANEL_KEY_CLICK_ACTION, "board-backlog"],
    ]);
  });

  it("asks nothing for Enter or Space, a script's click, a control marked off or one with no command", () => {
    const { doc, bridge, asked, click } = fakePage();
    followKeyClicks(doc, bridge);
    const tab = new FakeElement({ "data-key-command": "board-backlog" });
    click(tab, { detail: 0 });
    click(tab, { trusted: false });
    click(
      new FakeElement(
        { "data-key-command": "board-move" },
        new FakeElement({ "aria-disabled": "true" }),
      ),
    );
    click(new FakeElement({ "data-board-chip": "all" }));
    click(new FakeElement({ "data-key-command": "" }));
    expect(asked).toEqual([]);
  });

  it("stops hearing clicks once stopped", () => {
    const { doc, bridge, asked, click, listeners } = fakePage();
    const stop = followKeyClicks(doc, bridge);
    stop();
    expect(listeners).toHaveLength(0);
    click(new FakeElement({ "data-key-command": "board-backlog" }));
    expect(asked).toEqual([]);
  });
});
