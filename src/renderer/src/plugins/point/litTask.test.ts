import { afterEach, describe, expect, it, vi } from "vitest";
import { litTask } from "./litTask";

/** INF-237: hover a task anywhere, light it everywhere - one lit task, last rest wins. */

afterEach(() => {
  litTask.release("peek");
  litTask.release("stage");
});

describe("the lit task", () => {
  it("lights one task at a time and the last rest wins", () => {
    litTask.set("t1", "stage");
    litTask.set("t2", "peek");
    expect(litTask.get()).toEqual({ taskId: "t2", by: "peek" });
  });

  it("ignores a release by a source that does not hold it", () => {
    litTask.set("t1", "peek");
    litTask.set("t2", "stage");
    litTask.release("peek");
    expect(litTask.get()).toEqual({ taskId: "t2", by: "stage" });
    litTask.release("stage");
    expect(litTask.get()).toBeNull();
  });

  it("tells a reader only when something moved", () => {
    const heard = vi.fn();
    const stop = litTask.subscribe(heard);
    litTask.set("t1", "peek");
    litTask.set("t1", "peek");
    litTask.release("stage");
    litTask.release("peek");
    litTask.release("peek");
    stop();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
