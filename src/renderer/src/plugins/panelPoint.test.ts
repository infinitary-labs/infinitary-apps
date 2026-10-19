import type { TaskBoard } from "@shared/tasks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { shownCard, useShellStore } from "../app/store";

/**
 * Pointing at the app's own tasks and cards from a panel (docs/ui-plugins.md,
 * "A panel's cards", piece 3): only a task or a card the board on screen
 * lists - or, for a panel that searches, closed work a search found - only
 * from the captain's own click or key for anything that moves his focus or
 * his words, and the view the app pushes into a panel.
 */

const board = {
  seq: 1,
  at: 1,
  projects: [],
  links: [],
  tasks: [
    { id: "t-open", key: "FM-1", waitingCardId: null },
    { id: "t-waits", key: "FM-2", waitingCardId: "card-decide" },
  ],
} as unknown as TaskBoard;

/** Closed work a search found, beside the board. */
const found = { id: "t-closed", key: "FM-9", waitingCardId: null };
vi.mock("./reads/appExecutor", () => ({
  boardOnScreen: () => board,
  searchedTask: (id: string) => (id === found.id ? found : undefined),
}));
const opened = vi.fn(async (_value: { taskId: string; cardId?: string }) => {});
vi.mock("./point/openTask", () => ({ openTask: (value: never) => opened(value) }));

const { panelPoint, panelViewKey, panelViewOf } = await import("./panelPoint");
const { taskPeek } = await import("./point/taskPeek");

const shell = () => useShellStore.getState();
const reader = { view: "reader", title: "Reading" };

beforeEach(() => {
  opened.mockClear();
  taskPeek.set(null);
  useShellStore.setState({ cards: [], records: [], cardIndex: 0, unreadCardIds: [] });
});
afterEach(() => useShellStore.setState({ records: [], cards: [], cardIndex: 0 }));

/** The page's frame, sitting 40 px in and 100 px down the window. */
const frameAt = {
  getBoundingClientRect: () => ({ top: 100, left: 40 }) as DOMRect,
} as HTMLIFrameElement;

const page = (asked: boolean, card?: string) => ({
  reads: ["tasks.board"],
  ...(card ? { card } : {}),
  gate: async () => asked,
  frame: () => frameAt,
});

describe("point", () => {
  it("opens a task the board lists, its waiting card forward, only from the captain's click or key", async () => {
    await expect(panelPoint("desk", page(false)).openTask("t-waits")).resolves.toBe(false);
    expect(opened).not.toHaveBeenCalled();
    const point = panelPoint("desk", page(true));
    await expect(point.openTask("t-waits")).resolves.toBe(true);
    expect(opened).toHaveBeenCalledWith({ taskId: "t-waits", cardId: "card-decide" });
    await expect(point.openTask("t-open")).resolves.toBe(true);
    expect(opened).toHaveBeenLastCalledWith({ taskId: "t-open" });
    await expect(point.openTask("t-gone")).resolves.toBe(false);
  });

  it("opens a task's record, its waiting card or not, only from the captain's click or key", async () => {
    const real = shell().openRecord;
    const openRecord = vi.fn();
    useShellStore.setState({ openRecord } as never);
    onTestFinished(() => useShellStore.setState({ openRecord: real }));
    await expect(panelPoint("desk", page(false)).openRecord("t-waits")).resolves.toBe(false);
    await expect(panelPoint("desk", page(true)).openRecord("t-gone")).resolves.toBe(false);
    expect(openRecord).not.toHaveBeenCalled();
    await expect(panelPoint("desk", page(true)).openRecord("t-waits")).resolves.toBe(true);
    expect(openRecord).toHaveBeenCalledWith("t-waits");
    expect(opened).not.toHaveBeenCalled();
  });

  it("points at closed work a search found only for a panel that searches", async () => {
    await expect(panelPoint("desk", page(true)).openTask("t-closed")).resolves.toBe(false);
    const searching = { ...page(true), reads: ["tasks.board", "tasks.search"] };
    await expect(panelPoint("desk", searching).openTask("t-closed")).resolves.toBe(true);
    expect(opened).toHaveBeenLastCalledWith({ taskId: "t-closed" });
  });

  it("refuses a panel that does not read the board, at the call", async () => {
    const point = panelPoint("desk", { ...page(true), reads: ["feed.recent"] });
    await expect(point.openTask("t-open")).rejects.toThrow('name "tasks.board"');
    expect(() => point.peekTask(null)).toThrow('name "tasks.board"');
  });

  it("rests on a task with its box in the window, the page's place added, and lets go", () => {
    // The page in the window the panel draws in: its panel on its rail.
    const where = { isConnected: true } as HTMLElement;
    const asked: string[] = [];
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    vi.stubGlobal("document", {
      querySelector: (selector: string) => {
        asked.push(selector);
        return where;
      },
    });
    const point = panelPoint("desk", page(false));
    point.peekTask({ taskId: "t-open", box: { top: 10, right: 50, bottom: 30, left: 5 } });
    expect(asked).toEqual(['[data-side-panel="desk"]']);
    expect(taskPeek.get()).toEqual({
      taskId: "t-open",
      box: { top: 110, right: 90, bottom: 130, left: 45 },
      page: where,
      pageFrame: frameAt,
    });
    point.peekTask(null);
    expect(taskPeek.get()).toBeNull();
    // In the window, a box is the window's already; a card's page is its card.
    panelPoint("desk", { ...page(false, "r"), frame: () => null }).peekTask({
      taskId: "t-open",
      box: { top: 1, right: 2, bottom: 3, left: 0 },
    });
    expect(asked.at(-1)).toBe('[data-panel-card="desk/r"]');
    expect(taskPeek.get()).toEqual({
      taskId: "t-open",
      box: { top: 1, right: 2, bottom: 3, left: 0 },
      page: where,
      pageFrame: null,
    });
    vi.unstubAllGlobals();
  });

  it("brings forward only a waiting card the board names, from a click or key", async () => {
    const focusCard = vi.fn(() => true);
    useShellStore.setState({ focusCard } as never);
    await expect(panelPoint("desk", page(true)).showCard("card-other")).resolves.toBe(false);
    await expect(panelPoint("desk", page(false)).showCard("card-decide")).resolves.toBe(false);
    await expect(panelPoint("desk", page(true)).showCard("card-decide")).resolves.toBe(true);
    expect(focusCard).toHaveBeenCalledTimes(1);
  });

  it("aims the turn from a card view at a task the board lists, and lets go", async () => {
    shell().emitPanelCard("desk", { ...reader, id: "r" }, true);
    await expect(panelPoint("desk", page(true)).aim("t-open")).rejects.toThrow(
      "only a card view aims the turn",
    );
    await expect(panelPoint("desk", page(false, "r")).aim("t-open")).resolves.toBe(false);
    await expect(panelPoint("desk", page(true, "r")).aim("t-gone")).resolves.toBe(false);
    await expect(panelPoint("desk", page(true, "r")).aim("t-open")).resolves.toBe(true);
    const entry = () => shownCard(shell().cards, shell().cardIndex, [], shell().records);
    expect(entry()?.panelCard?.aim).toBe("t-open");
    // Letting go aims nothing, so it needs no click.
    await expect(panelPoint("desk", page(false, "r")).aim(null)).resolves.toBe(true);
    expect(entry()?.panelCard?.aim).toBeNull();
  });

  it("starts the captain's next message from any panel's click or key, and sends nothing", async () => {
    const real = shell().submit;
    const submit = vi.fn();
    const { firstRunSettled, firstRun } = shell();
    useShellStore.setState({
      submit,
      inputText: "and the retries",
      recording: false,
      firstRunSettled: true,
      firstRun: null,
    } as never);
    onTestFinished(() =>
      useShellStore.setState({ submit: real, inputText: "", firstRunSettled, firstRun }),
    );
    // A panel that reads nothing of the board may: the words name nothing of the app's.
    const reading = { ...page(true), reads: ["knowledge.entry"] };
    const words = "What should I know about the finding “A” (f-abc123, revision 2)? ";
    await expect(
      panelPoint("desk", { ...reading, gate: async () => false }).draft(words),
    ).resolves.toBe(false);
    expect(shell().inputText).toBe("and the retries");
    await expect(panelPoint("desk", reading).draft(words)).resolves.toBe(true);
    // At the head, what he had typed after it, and the caret after the words.
    expect(shell().inputText).toBe(`${words}and the retries`);
    expect(shell().inputCaret).toBe(words.length);
    // Again: the same words are not put twice.
    await expect(panelPoint("desk", reading).draft(words)).resolves.toBe(true);
    expect(shell().inputText).toBe(`${words}and the retries`);
    expect(submit).not.toHaveBeenCalled();
    // A held message field takes nothing; words over a line or past the bound are refused.
    useShellStore.setState({ recording: true });
    await expect(panelPoint("desk", reading).draft("Another question? ")).resolves.toBe(false);
    useShellStore.setState({ recording: false });
    await expect(panelPoint("desk", reading).draft("two\nlines")).rejects.toThrow("point.draft");
    await expect(panelPoint("desk", reading).draft("x".repeat(501))).rejects.toThrow("point.draft");
    await expect(panelPoint("desk", reading).draft("   ")).rejects.toThrow("point.draft");
  });
});

describe("the view a panel that reads the board is handed", () => {
  it("names the open records and the shown entry's task, a card's aim among them", () => {
    shell().openRecord("t-open");
    expect(panelViewOf(panelViewKey(shell()))).toEqual({
      openTaskIds: ["t-open"],
      shownTaskId: "t-open",
      litTaskId: null,
    });
    shell().emitPanelCard("desk", { ...reader, id: "r" }, true);
    shell().aimPanelCard("desk", "r", "t-waits");
    expect(panelViewOf(panelViewKey(shell()))).toEqual({
      openTaskIds: ["t-open"],
      shownTaskId: "t-waits",
      litTaskId: null,
    });
  });

  it("carries the lit task, so every panel draws the rest anywhere in the window (INF-237)", () => {
    expect(panelViewOf(panelViewKey(shell(), "t-lit")).litTaskId).toBe("t-lit");
    expect(panelViewKey(shell(), "t-lit")).not.toBe(panelViewKey(shell()));
  });
});
