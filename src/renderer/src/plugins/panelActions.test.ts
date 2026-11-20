import type { AnyCommandId } from "@shared/keyboard";
import { PANEL_BODY_ACTION, PANEL_SERVER_ACTION } from "@shared/plugins/frameDocument";
import { PANEL_KEY_CLICK_ACTION } from "@shared/plugins/panelActionIds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onPanelKeyClick } from "../app/keyReminderState";
import { useShellStore } from "../app/store";
import { type FramePanelPage, framePanelActions } from "./panelActions";

/** Whether the page's frame holds the window's focus, as the gesture gate reads it. */
const focus = vi.hoisted(() => ({ held: false }));
vi.mock("./frames/frameFocus", async (original) => ({
  ...(await original<typeof import("./frames/frameFocus")>()),
  frameHoldsFocus: async () => focus.held,
}));

/**
 * INF-2205 piece C: every panel, the captain's own included, draws in a
 * frame. Its page reaches its background work, says how its body fared, and
 * a page drawn for a crewmate's build is bound apart from the captain's.
 */

const frame = () => null;

function page(overrides: Partial<FramePanelPage> = {}): FramePanelPage {
  return {
    panel: { id: "notes", title: "Notes", own: false },
    frame,
    reads: [],
    moves: false,
    decides: false,
    ...overrides,
  };
}

beforeEach(() => {
  useShellStore.setState({ cards: [], records: [], cardIndex: 0, unreadCardIds: [] });
});

afterEach(() => {
  focus.held = false;
});

describe("a framed panel page's own actions", () => {
  it("declares its background work and its body report only when it has them", () => {
    const bare = framePanelActions(page()).actions;
    expect(bare).not.toContain(PANEL_SERVER_ACTION);
    expect(bare).not.toContain(PANEL_BODY_ACTION);
    const full = framePanelActions(page({ server: async () => null, onBody: () => {} })).actions;
    expect(full).toContain(PANEL_SERVER_ACTION);
    expect(full).toContain(PANEL_BODY_ACTION);
    // A card's page reports no body: the rail's body is the panel page's.
    const card = framePanelActions(
      page({ card: "notes-1", server: async () => null, onBody: () => {} }),
    ).actions;
    expect(card).toContain(PANEL_SERVER_ACTION);
    expect(card).not.toContain(PANEL_BODY_ACTION);
  });

  it("hands a server call to the panel's background work, checked like any input", async () => {
    const calls: Array<[string, unknown]> = [];
    const { onAction } = framePanelActions(
      page({
        server: async (action, input) => {
          calls.push([action, input]);
          return { rows: 3 };
        },
      }),
    );
    await expect(
      onAction(PANEL_SERVER_ACTION, { action: "count", input: { since: 1 } }),
    ).resolves.toEqual({ rows: 3 });
    expect(calls).toEqual([["count", { since: 1 }]]);
    await expect(onAction(PANEL_SERVER_ACTION, { action: "" })).rejects.toThrow();
    await expect(onAction(PANEL_SERVER_ACTION, { action: "count", extra: 1 })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("hears the body drawn or stopped, and refuses any other report", async () => {
    const heard: unknown[] = [];
    const { onAction } = framePanelActions(page({ onBody: (said) => heard.push(said) }));
    await onAction(PANEL_BODY_ACTION, { state: "drawn" });
    await onAction(PANEL_BODY_ACTION, { state: "stopped", why: "notes/panel.tsx: boom" });
    await expect(onAction(PANEL_BODY_ACTION, { state: "fine" })).rejects.toThrow();
    expect(heard).toEqual([{ state: "drawn" }, { state: "stopped", why: "notes/panel.tsx: boom" }]);
  });

  it("keeps a draft's cards off the captain's stack", async () => {
    const { onAction } = framePanelActions(page({ draft: { id: "notes.draft" } }));
    await expect(onAction("cards.emit", { id: "n-1", view: "notes" })).resolves.toBe("n-1");
    await expect(onAction("cards.open", undefined)).resolves.toEqual([]);
    expect(useShellStore.getState().cards).toEqual([]);
  });
});

describe("a mouse click on a panel page's control with a key", () => {
  /** The commands whose key reminder the window was asked to show. */
  function heard(): { ids: AnyCommandId[]; stop: () => void } {
    const ids: AnyCommandId[] = [];
    return { ids, stop: onPanelKeyClick((id) => ids.push(id)) };
  }

  it("is declared for the panel's page and its cards' pages, never for a draft", () => {
    expect(framePanelActions(page()).actions).toContain(PANEL_KEY_CLICK_ACTION);
    expect(framePanelActions(page({ card: "notes-1" })).actions).toContain(PANEL_KEY_CLICK_ACTION);
    expect(framePanelActions(page({ draft: { id: "notes.draft" } })).actions).not.toContain(
      PANEL_KEY_CLICK_ACTION,
    );
  });

  it("asks the window to remind of that panel's own command, while its frame holds the window's focus", async () => {
    const { ids, stop } = heard();
    try {
      const { onAction } = framePanelActions(page({ card: "notes-1" }));
      focus.held = true;
      await onAction(PANEL_KEY_CLICK_ACTION, "find");
      focus.held = false;
      await onAction(PANEL_KEY_CLICK_ACTION, "find");
      expect(ids).toEqual(["panel:notes/find"]);
    } finally {
      stop();
    }
  });

  it("refuses a value that names no command of a panel's, and a draft's click reaches nothing", async () => {
    const { ids, stop } = heard();
    try {
      focus.held = true;
      const { onAction } = framePanelActions(page());
      for (const value of ["panel:now/board", "Find", "", 3, null, "a".repeat(65)]) {
        await expect(onAction(PANEL_KEY_CLICK_ACTION, value)).rejects.toThrow();
      }
      const draft = framePanelActions(page({ draft: { id: "notes.draft" } }));
      await draft.onAction(PANEL_KEY_CLICK_ACTION, "find").catch(() => {});
      expect(ids).toEqual([]);
    } finally {
      stop();
    }
  });
});
