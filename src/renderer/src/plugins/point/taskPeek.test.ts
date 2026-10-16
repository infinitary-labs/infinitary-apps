import { describe, expect, it } from "vitest";
import { taskPeek } from "./taskPeek";

/** The task the pointer rests on: a card body's task key, the window's own key, or a task in a panel's page. */

const box = { top: 10, right: 60, bottom: 26, left: 20 };

describe("the key or task the pointer rests on", () => {
  it("lets go of a task only for its own page or its page's frame, and a key only for its own frame", () => {
    const frame = {} as HTMLIFrameElement;
    const other = {} as HTMLIFrameElement;
    const page = {} as HTMLElement;
    const card = { top: 0, right: 500, bottom: 300, left: 0 };
    const key = { taskId: "t1", key: box, card, frame };
    const task = { taskId: "t1", box, page, pageFrame: frame };
    taskPeek.set(key);
    // A key and a panel's task are never the same peek, even for one task.
    taskPeek.set(task);
    expect(taskPeek.get()).toBe(task);
    taskPeek.release(other);
    expect(taskPeek.get()).toBe(task);
    taskPeek.release(frame);
    expect(taskPeek.get()).toBeNull();
    taskPeek.set(task);
    taskPeek.release(page);
    expect(taskPeek.get()).toBeNull();
    taskPeek.set(key);
    taskPeek.release(page);
    expect(taskPeek.get()).toBe(key);
    taskPeek.release(frame);
    expect(taskPeek.get()).toBeNull();
  });

  it("lets go of a key the window draws only for that key's own element", () => {
    const anchor = {} as HTMLElement;
    const elsewhere = {} as HTMLElement;
    const frame = {} as HTMLIFrameElement;
    const card = { top: 0, right: 500, bottom: 300, left: 0 };
    const own = { taskId: "t1", key: box, card, anchor };
    taskPeek.set(own);
    // The same key at the same place is the same peek; a frame's key on the same task is not.
    taskPeek.set({ taskId: "t1", key: { ...box }, card: { ...card }, anchor });
    expect(taskPeek.get()).toBe(own);
    const framed = { taskId: "t1", key: box, card, frame };
    taskPeek.set(framed);
    expect(taskPeek.get()).toBe(framed);
    taskPeek.set(own);
    taskPeek.release(elsewhere);
    taskPeek.release(frame);
    expect(taskPeek.get()).toBe(own);
    taskPeek.release(anchor);
    expect(taskPeek.get()).toBeNull();
  });
});
