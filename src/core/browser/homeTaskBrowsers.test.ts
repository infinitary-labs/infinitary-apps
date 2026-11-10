import { canOpenAgain } from "@shared/taskBrowser";
import { describe, expect, it } from "vitest";
import { harness } from "../../../tests/helpers/taskBrowserStandIn";
import type { TaskRecord } from "../storage/taskRecordTypes";
import type { TaskChange } from "../tasks/taskWriter";
import { openTaskChannel } from "./homeTaskBrowsers";
import { TASK_BROWSER_IDLE_MS } from "./taskBrowsers";

/**
 * A task's close reaches its browser through the task channel's watch of the
 * task board (docs/task-browser.md: Open again is "refused ... once the task
 * has closed"). Intent: INF-3307's audit row 12, a browser stopped before its
 * task closes could still be opened again after the close.
 */
async function wired() {
  const h = harness();
  const status = new Map<string, TaskRecord["status"]>();
  let listener: ((change: TaskChange) => void) | undefined;
  await openTaskChannel({
    // No task command process: the browsers alone hear the close.
    host: { app: { version: "0" } as never },
    paths: { taskChannelDir: "" },
    axiBinDir: "",
    tasks: {
      get: (id) => (status.has(id) ? ({ id, status: status.get(id) } as TaskRecord) : undefined),
      onChange: (next) => {
        listener = next;
        return () => undefined;
      },
    },
    jobs: { answering: () => undefined },
    inbox: { serve: () => undefined },
    browsers: h.browsers,
  });
  const close = (id: string, to: "done" | "dropped") => {
    status.set(id, to);
    listener?.({ seq: 1, taskIds: [id], events: [], removed: [], reset: false });
  };
  return { ...h, status, close };
}

describe("a closed task's browser", () => {
  it("stopped by the captain before the close cannot be opened again", async () => {
    const { browsers, status, close } = await wired();
    status.set("t1", "active");
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    browsers.stopByCaptain("t1");
    close("t1", "done");
    const fact = browsers.fact("t1");
    expect(fact).toMatchObject({ state: "stopped", stopped: "task-closed" });
    expect(fact && canOpenAgain(fact)).toBe(false);
    expect(await browsers.reopen("t1")).toMatchObject({ ok: false });
    expect(browsers.isOpen("t1")).toBe(false);
  });

  it("stopped for quiet before a drop cannot be opened again", async () => {
    const { browsers, status, close, fire } = await wired();
    status.set("t2", "active");
    await browsers.forTask("t2").navigate({ url: "http://localhost:5173/" });
    fire(TASK_BROWSER_IDLE_MS);
    expect(browsers.fact("t2")).toMatchObject({ state: "stopped", stopped: "idle" });
    close("t2", "dropped");
    expect(browsers.fact("t2")).toMatchObject({ state: "stopped", stopped: "task-closed" });
    expect(await browsers.reopen("t2")).toMatchObject({ ok: false });
    expect(browsers.isOpen("t2")).toBe(false);
  });

  it("still open at the close stops and cannot be opened again", async () => {
    const { browsers, status, close } = await wired();
    status.set("t3", "active");
    await browsers.forTask("t3").navigate({ url: "http://localhost:5173/" });
    close("t3", "done");
    expect(browsers.fact("t3")).toMatchObject({ state: "stopped", stopped: "task-closed" });
    expect(await browsers.reopen("t3")).toMatchObject({ ok: false });
  });
});
