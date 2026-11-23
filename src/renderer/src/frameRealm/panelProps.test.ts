import type { FrameBridgeApi, FrameStoreRequest } from "@shared/plugins/bridge";
import { PANEL_SERVER_ACTION } from "@shared/plugins/frameDocument";
import { describe, expect, it, vi } from "vitest";
import {
  cardData,
  cardKept,
  cardRevision,
  firstState,
  frameKeep,
  frameKeys,
  framePanelProps,
  frameRail,
  frameView,
} from "./panelProps";

/**
 * `PanelProps` as the frame realm builds it over the bridge: the same calls
 * a panel makes in the app's window, carried as bridge verbs the host
 * checks. A fake bridge records what the panel's calls became.
 */

function fakeBridge() {
  const subscribed: { read: string; args: unknown }[] = [];
  const unsubscribed: string[] = [];
  const stored: FrameStoreRequest[] = [];
  const pushes = new Map<string, (value: unknown) => void>();
  const storeListeners: ((key: string) => void)[] = [];
  const stateListeners: ((state: unknown) => void)[] = [];
  const bridge = {
    version: 2,
    theme: "dark",
    state: null,
    onTheme: () => () => {},
    onState: (listener: (state: unknown) => void) => {
      stateListeners.push(listener);
      return () => {};
    },
    subscribe: (read: string, args: Record<string, unknown> | undefined, onValue: never) => {
      subscribed.push({ read, args });
      pushes.set(read, onValue);
      return {
        ready: Promise.resolve(),
        unsubscribe: async () => {
          unsubscribed.push(read);
        },
      };
    },
    action: vi.fn(async () => {}),
    fetch: vi.fn(async () => ({})),
    store: async (request: FrameStoreRequest) => {
      stored.push(request);
      if (request.op === "get") return { value: 7 };
      if (request.op === "list") return { entries: [{ key: "a", value: 1, updatedAt: 3 }] };
      return {};
    },
    onStore: (listener: (key: string) => void) => {
      storeListeners.push(listener);
      return () => storeListeners.splice(storeListeners.indexOf(listener), 1);
    },
  } as unknown as FrameBridgeApi;
  const pushState = (state: unknown) => {
    for (const listener of stateListeners) listener(state);
  };
  return { api: bridge, subscribed, unsubscribed, stored, pushes, storeListeners, pushState };
}

describe("PanelProps in the frame realm", () => {
  it("serves the reads the panel declared over bridge.subscribe, and throws at the call for one it did not", async () => {
    const bridge = fakeBridge();
    const props = framePanelProps(
      { id: "meter", reads: ["feed.recent"], sql: ["v_usage_v1"] },
      bridge.api,
      () => {},
    );
    const lines: unknown[] = [];
    const stop = props.reads.subscribe("feed.recent", (value) => lines.push(value));
    bridge.pushes.get("feed.recent")?.([{ text: "hi" }]);
    expect(lines).toEqual([[{ text: "hi" }]]);
    const answers: unknown[] = [];
    props.reads.subscribe("sql", { sql: "SELECT 1 FROM v_usage_v1", params: [1] }, (answer) =>
      answers.push(answer),
    );
    expect(bridge.subscribed).toEqual([
      { read: "feed.recent", args: {} },
      { read: "sql", args: { sql: "SELECT 1 FROM v_usage_v1", params: [1] } },
    ]);
    stop();
    await Promise.resolve();
    expect(bridge.unsubscribed).toEqual(["feed.recent"]);
    expect(() => props.reads.subscribe("tasks.board", () => {})).toThrow(
      /"tasks.board" is not a read this panel declared/,
    );
    const noViews = framePanelProps({ id: "meter", reads: [], sql: [] }, bridge.api, () => {});
    expect(() => noViews.reads.subscribe("sql", { sql: "SELECT 1" }, () => {})).toThrow(
      /"sql" reads the views this panel declared/,
    );
  });

  it("carries the store over the bridge's store verb, naming a key and never a slice", async () => {
    const bridge = fakeBridge();
    const { store } = framePanelProps({ id: "meter", reads: [], sql: [] }, bridge.api);
    expect(await store.get("count")).toBe(7);
    await store.set("count", 8);
    await store.delete("count");
    expect(await store.list("a")).toEqual([{ key: "a", value: 1, updatedAt: 3 }]);
    await store.list();
    expect(bridge.stored).toEqual([
      { op: "get", key: "count" },
      { op: "set", key: "count", value: 8 },
      { op: "delete", key: "count" },
      { op: "list", prefix: "a" },
      { op: "list" },
    ]);
    const heard: string[] = [];
    const stop = store.subscribe((key) => heard.push(key));
    for (const listener of bridge.storeListeners) listener("count");
    stop();
    expect(heard).toEqual(["count"]);
    expect(bridge.storeListeners).toHaveLength(0);
  });

  it("runs no server code: invoke rejects", async () => {
    const { api: bridge } = fakeBridge();
    const props = framePanelProps({ id: "meter", reads: [], sql: [] }, bridge);
    expect(props.id).toBe("meter");
    await expect(props.invoke("refresh")).rejects.toThrow('"meter" has no server.ts');
  });

  // INF-2205 piece C: the captain's own panel draws in a frame and reaches
  // its server.ts through the host, which runs it in the panel's own process.
  it("asks the host's server.invoke for a panel with background work, answering what it returned", async () => {
    const { api: bridge } = fakeBridge();
    vi.mocked(bridge.action)
      .mockResolvedValueOnce({ rows: 2 })
      .mockRejectedValueOnce(new Error("stopped"));
    const props = framePanelProps({ id: "notes", reads: [], sql: [], server: true }, bridge);
    await expect(props.invoke("count", { since: 1 })).resolves.toEqual({ rows: 2 });
    await expect(props.invoke("refresh")).rejects.toThrow("stopped");
    expect(vi.mocked(bridge.action).mock.calls).toEqual([
      [PANEL_SERVER_ACTION, { action: "count", input: { since: 1 } }],
      [PANEL_SERVER_ACTION, { action: "refresh" }],
    ]);
  });
});

describe("a panel's cards and asks in the frame realm (docs/ui-plugins.md, \"A panel's cards\")", () => {
  it("puts cards up, closes and lists them through the card actions, answering the card's id", async () => {
    const bridge = fakeBridge();
    const action = vi.fn(async (id: string) =>
      id === "cards.emit" ? "notes-1" : id === "cards.open" ? [{ id: "notes-1" }] : undefined,
    );
    (bridge.api as unknown as { action: typeof action }).action = action;
    const props = framePanelProps({ id: "notes", reads: [], sql: [] }, bridge.api, () => {});
    const card = { view: "notes", title: "Notes", data: { taskId: "t1" } };
    await expect(props.cards.emit(card)).resolves.toBe("notes-1");
    await expect(props.cards.open()).resolves.toEqual([{ id: "notes-1" }]);
    await props.cards.close("notes-1");
    expect(action.mock.calls).toEqual([
      ["cards.emit", card],
      ["cards.open"],
      ["cards.close", { id: "notes-1" }],
    ]);
  });

  it("hears a header button's press once, with how it came, and never the presses its document was born with", () => {
    const bridge = fakeBridge();
    const props = framePanelProps({ id: "notes", reads: [], sql: [] }, bridge.api, () => {});
    const heard: string[] = [];
    props.asks.subscribe((button, via) => heard.push(`${button}:${via}`));
    // The first state is the birth: a count it carries is an earlier press.
    bridge.pushState({ asks: { search: 2 }, askedBy: { search: "click" } });
    expect(heard).toEqual([]);
    bridge.pushState({ asks: { search: 3 }, askedBy: { search: "click" } });
    bridge.pushState({ asks: { search: 3, add: 1 }, askedBy: { search: "click", add: "key" } });
    bridge.pushState({ asks: { search: 3, add: 1 }, askedBy: { search: "click", add: "key" } });
    expect(heard).toEqual(["search:click", "add:key"]);
  });

  it("hears F6's ask for focus once, and never the asks its document was born with", () => {
    const bridge = fakeBridge();
    const props = framePanelProps({ id: "notes", reads: [], sql: [] }, bridge.api, () => {});
    let asked = 0;
    props.asks.onFocus(() => {
      asked += 1;
    });
    bridge.pushState({ focus: 4 });
    bridge.pushState({ focus: 4 });
    expect(asked).toBe(0);
    bridge.pushState({ focus: 5 });
    expect(asked).toBe(1);
  });
});

describe("a card's kept place in the frame realm", () => {
  it("waits for the first view state, reads the card's data and place from it, and keeps through card.keep", async () => {
    const bridge = fakeBridge();
    const born = firstState(bridge.api);
    bridge.pushState({ card: { data: { piece: "a" }, kept: { scroll: 80 } } });
    const state = await born;
    expect(cardData(state)).toEqual({ piece: "a" });
    expect(cardKept(state)).toEqual({ scroll: 80 });
    expect(cardKept({ card: { data: 1 } })).toBeNull();
    expect(cardRevision({ card: { data: 1, revision: 3 } })).toBe(3);
    expect(cardRevision(null)).toBe(0);
    await frameKeep(bridge.api)({ scroll: 120 });
    expect(bridge.api.action).toHaveBeenCalledWith("card.keep", { scroll: 120 });
  });
});

describe("pointing, moves, the view and the rail in the frame realm", () => {
  it("points through the actions the host declared, answering whether it happened, and throws at the call without the board", async () => {
    const bridge = fakeBridge();
    const action = vi.fn(async (id: string) => id !== "point.showCard");
    (bridge.api as unknown as { action: typeof action }).action = action;
    const props = framePanelProps(
      { id: "desk", reads: ["tasks.board"], sql: [], card: { id: "c1" } },
      bridge.api,
      () => {},
    );
    await expect(props.point.openTask("t1")).resolves.toBe(true);
    await expect(props.point.openRecord("t1")).resolves.toBe(true);
    await expect(props.point.showCard("card-1")).resolves.toBe(false);
    await expect(props.point.aim(null)).resolves.toBe(true);
    props.point.peekTask({ taskId: "t1", box: { top: 1, right: 2, bottom: 3, left: 0 } });
    expect(action.mock.calls).toEqual([
      ["point.openTask", { taskId: "t1" }],
      ["point.openRecord", { taskId: "t1" }],
      ["point.showCard", { cardId: "card-1" }],
      ["point.aim", { taskId: null }],
      ["point.peekTask", { taskId: "t1", box: { top: 1, right: 2, bottom: 3, left: 0 } }],
    ]);
    const blind = framePanelProps({ id: "desk", reads: [], sql: [] }, bridge.api, () => {});
    await expect(blind.point.openTask("t1")).rejects.toThrow('name "tasks.board"');
    const panel = framePanelProps({ id: "desk", reads: ["tasks.board"], sql: [] }, bridge.api);
    await expect(panel.point.aim("t1")).rejects.toThrow("only a card view aims the turn");
  });

  it("moves a task only when the captain agreed, and reads one task in full by its id", async () => {
    const bridge = fakeBridge();
    const action = vi.fn(async () => ({ ok: true }));
    (bridge.api as unknown as { action: typeof action }).action = action;
    expect(framePanelProps({ id: "desk", reads: [], sql: [] }, bridge.api).tasks).toBeUndefined();
    const props = framePanelProps(
      { id: "desk", reads: ["tasks.board", "tasks.detail"], sql: [], moves: true },
      bridge.api,
      () => {},
    );
    await expect(props.tasks?.run("t1", "queue-task")).resolves.toEqual({ ok: true });
    expect(action).toHaveBeenCalledWith("tasks.run", { taskId: "t1", move: "queue-task" });
    props.reads.subscribe("tasks.detail", { id: "t1" }, () => {});
    expect(bridge.subscribed).toContainEqual({ read: "tasks.detail", args: { id: "t1" } });
    // Closed work is searched by its words, for a panel that declared it.
    expect(() => props.reads.subscribe("tasks.search", { query: "x" }, () => {})).toThrow(
      "not a read this panel declared",
    );
    const searching = framePanelProps(
      { id: "desk", reads: ["tasks.board", "tasks.search"], sql: [] },
      bridge.api,
      () => {},
    );
    searching.reads.subscribe("tasks.search", { query: "history" }, () => {});
    expect(bridge.subscribed).toContainEqual({ read: "tasks.search", args: { query: "history" } });
  });

  it("reads the view and whether the panel is collapsed from view state, and speaks to its rail through actions", async () => {
    expect(
      frameView({
        view: {
          openTaskIds: ["t1", 3],
          shownTaskId: "t1",
          litTaskId: "t2",
          focusedProjectId: "p1",
        },
      }),
    ).toEqual({
      openTaskIds: ["t1"],
      shownTaskId: "t1",
      litTaskId: "t2",
      focusedProjectId: "p1",
    });
    expect(frameView(null)).toEqual({
      openTaskIds: [],
      shownTaskId: null,
      litTaskId: null,
      focusedProjectId: null,
    });
    const bridge = fakeBridge();
    const rail = frameRail({ collapsed: true }, bridge.api, () => {});
    expect(rail.collapsed).toBe(true);
    rail.summarize([{ text: "2 waiting", strong: true }]);
    rail.show(true);
    expect(bridge.api.action).toHaveBeenCalledWith("rail.summarize", [
      { text: "2 waiting", strong: true },
    ]);
    expect(bridge.api.action).toHaveBeenCalledWith("rail.show", true);
  });

  it("reads the keys its commands have now from view state, each naming its command, leaving out an entry with no drawn key", () => {
    expect(
      frameKeys({
        keys: {
          "board-find": { keys: "⌃⌘F", "aria-keyshortcuts": "Control+Meta+F" },
          "board-move": { keys: "⌘K ⌘M" },
          "board-done": { keys: "" },
          "board-dropped": { "aria-keyshortcuts": "F9" },
          broken: null,
        },
      }),
    ).toEqual({
      "board-find": {
        keys: "⌃⌘F",
        "aria-keyshortcuts": "Control+Meta+F",
        "data-key-command": "board-find",
      },
      "board-move": { keys: "⌘K ⌘M", "data-key-command": "board-move" },
    });
    expect(frameKeys(null)).toEqual({});
    expect(frameKeys({ keys: "⌃⌘F" })).toEqual({});
  });
});
