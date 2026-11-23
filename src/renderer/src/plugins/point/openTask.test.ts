import type { Card } from "@shared/cards";
import { endedLineWords } from "@shared/endedCard";
import type { TaskBoard, TaskDetail } from "@shared/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shownEntry } from "../../app/stack";
import { useShellStore } from "../../app/store";
import { openTask, openTaskFromKey, openTaskOn } from "./openTask";

const navigation = vi.hoisted(() => ({ board: undefined as TaskBoard | undefined }));
vi.mock("../reads/appExecutor", () => ({
  boardOnScreen: () => navigation.board,
  searchedTask: () => undefined,
}));

const target = () => ({
  focusCard: vi.fn(() => true),
  openRecord: vi.fn(),
});

describe("opening a task", () => {
  it("brings the named card forward when the stack still holds it", () => {
    const shell = target();
    // The captain's presses counted when he pointed go with it (INF-551).
    const since = 3;
    expect(openTaskOn({ taskId: "t1", cardId: "card-1" }, shell, since)).toBe("card");
    expect(shell.focusCard).toHaveBeenCalledWith("card-1", since);
    expect(shell.openRecord).not.toHaveBeenCalled();
  });

  it("opens the record when there is no card, or the card is gone from the stack", () => {
    const shell = { ...target(), focusCard: vi.fn(() => false) };
    expect(openTaskOn({ taskId: "t1" }, shell)).toBe("record");
    expect(shell.focusCard).not.toHaveBeenCalled();
    expect(openTaskOn({ taskId: "t2", cardId: "stale" }, shell)).toBe("record");
    expect(shell.openRecord).toHaveBeenLastCalledWith("t2");
  });

  it("refuses a value that is not the declared shape, touching nothing", () => {
    const shell = target();
    for (const value of [
      undefined,
      null,
      "t1",
      {},
      { taskId: "" },
      { taskId: "t1", extra: 1 },
      { taskId: "t1", anchor: { top: 1 } },
    ]) {
      expect(() => openTaskOn(value, shell), JSON.stringify(value)).toThrow("open:");
    }
    expect(shell.focusCard).not.toHaveBeenCalled();
    expect(shell.openRecord).not.toHaveBeenCalled();
  });
});

/**
 * A Waiting on you row for a required action the captain put off with Not
 * now (INF-358; the captain's "it should directly open the decision card
 * that's waiting on the user, not the task card"): the row has no open card,
 * so the click runs the typed show-card operation and brings the card it
 * puts up forward; a task with neither a decision nor one to show opens its
 * record, and a blocked one is not asked for.
 */
describe("opening a task whose required action was deferred", () => {
  const choice: Card["actions"] = [{ id: "ok", label: "I installed it", default: true }];
  const actionCard = (status: Card["status"]): Card => ({
    id: "card-fm-required-action-op1",
    taskId: "op1",
    author: "firstmate",
    priority: 40,
    title: "Install the new version",
    meta: "Waiting on you",
    body: "",
    actions: choice,
    status,
    createdAt: 1,
  });
  const detailOf = (
    state: "deferred" | "ready" | "blocked",
    waitingCardId: string | null,
    status: "open" | "done" = "open",
  ) =>
    ({
      id: "op1",
      status,
      waitingCardId,
      requiredAction: { cardId: "card-fm-required-action-op1", state, result: "Waiting on you" },
    }) as unknown as TaskDetail;

  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({ cards: [], records: [], cardIndex: 0 });
  });

  it("re-shows the deferred action's card from the row, as the record's Show the card does", async () => {
    const run = vi.fn(async () => {
      // The operation puts the card on the stage; the stack hears it.
      useShellStore.setState({ cards: [actionCard("ready")] });
      return { ok: true as const };
    });
    const detail = vi
      .fn()
      .mockResolvedValueOnce(detailOf("deferred", null))
      .mockResolvedValueOnce(detailOf("ready", "card-fm-required-action-op1"));
    vi.stubGlobal("window", { infinitary: { tasks: { detail }, task: { run } } });
    useShellStore.setState({ cards: [], records: [], cardIndex: 0 });
    await openTask({ taskId: "op1" });
    expect(run).toHaveBeenCalledWith("op1", "show-card");
    expect(useShellStore.getState().records).toEqual([]);
    expect(useShellStore.getState().cardIndex).toBe(0);
    expect(useShellStore.getState().cards[0]?.id).toBe("card-fm-required-action-op1");
  });

  it("opens the record when the operation refuses, and never asks for a blocked or closed one", async () => {
    const run = vi.fn(async () => ({ ok: false as const, text: "not yet" }));
    const detail = vi.fn().mockResolvedValue(detailOf("deferred", null));
    vi.stubGlobal("window", { infinitary: { tasks: { detail }, task: { run } } });
    await openTask({ taskId: "op1" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(useShellStore.getState().records).toEqual([{ taskId: "op1" }]);

    run.mockClear();
    detail.mockResolvedValue(detailOf("blocked", null));
    await openTask({ taskId: "op1" });
    detail.mockResolvedValue(detailOf("deferred", null, "done"));
    await openTask({ taskId: "op1" });
    expect(run).not.toHaveBeenCalled();
  });
});

/** Approved navigation plan: rows show the waiting decision before the newest showable card;
 * links always open records. These exercise the shell owner, not a duplicate selector. */
describe("row cards and task links", () => {
  const detail = vi.fn();
  const card = (id: string, createdAt: number, extra: Partial<Card> = {}): Card => ({
    id,
    taskId: "harbour",
    author: "crewmate",
    priority: 20,
    title: id,
    meta: "harbour",
    body: "<p>The harbour summary is ready.</p>",
    actions: [],
    status: "ready",
    createdAt,
    ...extra,
  });
  const row = { id: "harbour", status: "open", waitingCardId: null } as TaskDetail;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    navigation.board = undefined;
    useShellStore.setState({ cards: [], records: [], cardIndex: 0 });
  });
  const prepare = (cards: Card[], task: TaskDetail = row) => {
    navigation.board = { seq: 1, at: 1, tasks: [task], projects: [], links: [] };
    vi.stubGlobal("window", { infinitary: { tasks: { detail } } });
    useShellStore.setState({ cards, records: [], cardIndex: 0 });
  };
  it("opens the newest note without a task lookup and keeps it on another row press", async () => {
    prepare([card("earlier", 1), card("answer-note", 2)]);
    await openTask({ taskId: row.id });
    expect(useShellStore.getState().cardFocusTarget).toBe("answer-note");
    await openTask({ taskId: row.id });
    expect(useShellStore.getState().cardFocusTarget).toBe("answer-note");
    expect(useShellStore.getState().records).toEqual([]);
    expect(detail).not.toHaveBeenCalled();
  });
  it("uses the same waiting decision as Waiting on you ahead of a newer note", async () => {
    prepare(
      [
        card("decision", 1, { actions: [{ id: "chart", label: "Use the chart" }] }),
        card("note", 2),
      ],
      { ...row, waitingCardId: "decision" },
    );
    await openTask({ taskId: row.id });
    expect(useShellStore.getState().cardFocusTarget).toBe("decision");
    expect(detail).not.toHaveBeenCalled();
  });
  it("includes a replied-under card but not an off-stage or ended card", async () => {
    prepare([
      card("reply", 1, { awaiting: "answer", sentBackAt: 1 }),
      card("off-stage", 2, { awaiting: "answer" }),
      card("ended", 3, {
        ended: {
          by: "crewmate",
          reason: "withdrawn",
          at: 3,
          line: endedLineWords("crewmate", "withdrawn"),
        },
      }),
    ]);
    await openTask({ taskId: row.id });
    expect(useShellStore.getState().cardFocusTarget).toBe("reply");
  });
  it("restores put-aside notes before choosing the newest one", async () => {
    const notes = [card("earlier", 1, { minimized: true }), card("newest", 2, { minimized: true })];
    prepare(notes);
    const minimize = vi.fn(async () => {});
    const list = vi.fn(async () => notes.map((note) => ({ ...note, minimized: false })));
    vi.stubGlobal("window", { infinitary: { tasks: { detail }, cards: { minimize, list } } });
    await openTask({ taskId: row.id });
    expect(minimize.mock.calls).toEqual([
      ["earlier", false],
      ["newest", false],
    ]);
    expect(useShellStore.getState().cardFocusTarget).toBe("newest");
    expect(detail).not.toHaveBeenCalled();
  });
  it("shows a deferred action before an existing newer note", async () => {
    prepare([card("note", 2)], {
      ...row,
      requiredAction: { state: "deferred", cardId: "action" },
    } as TaskDetail);
    const run = vi.fn(async () => {
      useShellStore.setState({
        cards: [
          card("note", 2),
          card("action", 1, { actions: [{ id: "done", label: "I installed it" }] }),
        ],
      });
      return { ok: true };
    });
    detail.mockResolvedValue({ ...row, waitingCardId: "action" });
    vi.stubGlobal("window", { infinitary: { tasks: { detail }, task: { run } } });
    await openTask({ taskId: row.id });
    expect(run).toHaveBeenCalledWith(row.id, "show-card");
    expect(useShellStore.getState().cardFocusTarget).toBe("action");
  });
  it("opens the record when none of its cards can be shown", async () => {
    prepare([card("off-stage", 2, { awaiting: "answer" })]);
    await openTask({ taskId: row.id });
    expect(useShellStore.getState().records).toEqual([{ taskId: row.id }]);
  });
  it("opens a linked task's record in front and Hide returns to the originating card", async () => {
    prepare([
      card("summary", 1),
      card("decision", 2, { actions: [{ id: "chart", label: "Use the chart" }] }),
    ]);
    await openTaskFromKey({ id: row.id });
    expect(useShellStore.getState().records).toEqual([
      { taskId: row.id, from: { cardId: "summary" } },
    ]);
    useShellStore.getState().closeRecord();
    expect(shownEntry(useShellStore.getState())?.id).toBe("summary");
    expect(detail).not.toHaveBeenCalled();
  });
});
