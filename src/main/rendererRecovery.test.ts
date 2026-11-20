import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { followRendererRecovery } from "./rendererRecovery";

function arrange() {
  const contents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    isDestroyed: vi.fn(() => false),
  });
  let time = 0;
  followRendererRecovery(contents as unknown as WebContents, () => time);
  return {
    contents,
    crash: (reason = "crashed") => contents.emit("render-process-gone", {}, { reason }),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("main page recovery", () => {
  it("recovers a crash once, stops a crash loop, and allows a later recovery", async () => {
    const { contents, crash, advance } = arrange();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    crash();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(contents.reload).toHaveBeenCalledTimes(1);
    crash();
    advance(59_999);
    crash("oom");
    expect(contents.reload).toHaveBeenCalledTimes(1);
    advance(1);
    crash("abnormal-exit");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(contents.reload).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("does not reload a deliberate exit, failed launch or destroyed page", () => {
    const { contents, crash } = arrange();
    for (const reason of ["clean-exit", "killed", "launch-failed", "integrity-failure"])
      crash(reason);
    expect(contents.reload).not.toHaveBeenCalled();
    contents.isDestroyed.mockReturnValue(true);
    crash();
    expect(contents.reload).not.toHaveBeenCalled();
  });
});
