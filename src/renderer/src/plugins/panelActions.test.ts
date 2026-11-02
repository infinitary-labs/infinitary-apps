import { PANEL_BODY_ACTION, PANEL_SERVER_ACTION } from "@shared/plugins/frameDocument";
import { beforeEach, describe, expect, it } from "vitest";
import { useShellStore } from "../app/store";
import { type FramePanelPage, framePanelActions } from "./panelActions";

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
