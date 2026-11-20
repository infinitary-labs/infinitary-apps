import type { WebContents } from "electron";

/** One recovery per minute, on a monotonic clock; repeated crashes stay stopped. */
export function followRendererRecovery(
  contents: Pick<WebContents, "on" | "reload" | "isDestroyed">,
  now: () => number = () => performance.now(),
): void {
  let lastRecovery = Number.NEGATIVE_INFINITY;
  contents.on("render-process-gone", (_event, details) => {
    if (!["crashed", "oom", "abnormal-exit"].includes(details.reason) || contents.isDestroyed())
      return;
    const time = now();
    if (time - lastRecovery < 60_000) {
      console.warn("Renderer recovery stopped: another crash within one minute.");
      return;
    }
    lastRecovery = time;
    // Leave the native crash callback before starting a new renderer.
    setImmediate(() => {
      if (!contents.isDestroyed()) contents.reload();
    });
  });
}
