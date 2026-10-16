import { describe, expect, it, vi } from "vitest";
import { openTaskOn } from "./openTask";

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
