import type { Card } from "@shared/cards";
import type { TaskDetail } from "@shared/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "../../app/store";
import { openTask, openTaskOn } from "./openTask";

/** The one way a pointing gesture opens a task: its waiting card forward, or its record. */

const target = () => ({
  focusCard: vi.fn(() => true),
  openRecord: vi.fn(),
});

describe("opening a task", () => {
  it("brings the named card forward when the stack still holds it", () => {
    const shell = target();
    expect(openTaskOn({ taskId: "t1", cardId: "card-1" }, shell)).toBe("card");
    expect(shell.focusCard).toHaveBeenCalledWith("card-1");
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
