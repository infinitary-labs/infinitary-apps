import type { BrowserViewer } from "@core/browser/browserViews";
import { parseInvokeRequest } from "@shared/ipc";
import { type TaskBrowserSize, taskBrowserFrameSchema } from "@shared/taskBrowser";

/** The three requests a window's view of a task's browser makes. */
export type BrowserWatchChannel = "inf:browser:watch" | "inf:browser:unwatch" | "inf:browser:size";

export function isBrowserWatchChannel(channel: string): channel is BrowserWatchChannel {
  return (
    channel === "inf:browser:watch" ||
    channel === "inf:browser:unwatch" ||
    channel === "inf:browser:size"
  );
}

/**
 * Every window here watching a task's browser through one connection
 * (docs/view.md, "A task's browser on a view"): the first mate hears one
 * watch per task, the end of the last, and every room a window asks for;
 * each picture it sends goes to the windows here that watch that task. A
 * new connection forgot every watch, so each is asked again there.
 */
export class BrowserWatches {
  /** Each task watched here, with the room each window's maximized view last asked for. */
  private readonly watching = new Map<string, Map<BrowserViewer, TaskBrowserSize | null>>();
  private readonly viewers = new WeakSet<BrowserViewer>();

  constructor(
    private readonly invoke: (channel: BrowserWatchChannel, args: unknown[]) => Promise<unknown>,
    /** A first mate known not to show its task's browsers here: nothing is asked of it. */
    private readonly waitsThere: () => boolean = () => false,
  ) {}

  /** A window's watch of a task's browser, its end, or the room its maximized view gives the page. */
  async view(
    channel: BrowserWatchChannel,
    rawArgs: unknown[],
    viewer: BrowserViewer,
  ): Promise<unknown> {
    if (channel === "inf:browser:unwatch") {
      const [taskId] = parseInvokeRequest(channel, rawArgs);
      this.unwatch(viewer, taskId);
      return { ok: true };
    }
    if (channel === "inf:browser:size") {
      const [taskId, size] = parseInvokeRequest(channel, rawArgs);
      const viewers = this.watching.get(taskId);
      if (!viewers?.has(viewer)) return { ok: true };
      viewers.set(viewer, size);
      return this.invoke("inf:browser:size", [taskId, size]);
    }
    const [taskId] = parseInvokeRequest(channel, rawArgs);
    if (this.waitsThere()) return { watching: false };
    if (!this.viewers.has(viewer)) {
      this.viewers.add(viewer);
      viewer.onGone(() => this.gone(viewer));
    }
    const viewers = this.watching.get(taskId) ?? new Map<BrowserViewer, TaskBrowserSize | null>();
    const first = viewers.size === 0;
    if (!viewers.has(viewer)) viewers.set(viewer, null);
    this.watching.set(taskId, viewers);
    // Kept while out of reach: the next welcome asks again.
    if (!first) return { watching: true };
    return this.invoke("inf:browser:watch", [taskId]);
  }

  /** One picture from the first mate, for the windows here that watch its task. */
  show(payload: unknown): void {
    const frame = taskBrowserFrameSchema.safeParse(payload);
    if (!frame.success) return;
    for (const viewer of this.watching.get(frame.data.taskId)?.keys() ?? [])
      viewer.show(frame.data);
  }

  /** Every watch again, on a connection the first mate just welcomed. */
  again(): void {
    for (const [taskId, viewers] of this.watching) {
      const room = [...viewers.values()].findLast((size) => size !== null) ?? null;
      void this.invoke("inf:browser:watch", [taskId])
        .then(() => (room ? this.invoke("inf:browser:size", [taskId, room]) : undefined))
        .catch(() => {
          // Asked again at the next welcome.
        });
    }
  }

  clear(): void {
    this.watching.clear();
  }

  private unwatch(viewer: BrowserViewer, taskId: string): void {
    const viewers = this.watching.get(taskId);
    if (!viewers?.delete(viewer)) return;
    if (viewers.size > 0) return;
    this.watching.delete(taskId);
    this.invoke("inf:browser:unwatch", [taskId]).catch(() => {
      // Out of reach: the first mate forgot the watch with the connection.
    });
  }

  /** A window that loaded another document or closed: its watches end. */
  private gone(viewer: BrowserViewer): void {
    this.viewers.delete(viewer);
    for (const taskId of [...this.watching.keys()]) this.unwatch(viewer, taskId);
  }
}
