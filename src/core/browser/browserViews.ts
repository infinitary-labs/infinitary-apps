import type { TaskBrowserFrame, TaskBrowserSize } from "@shared/taskBrowser";
import type { BrowserFrameSink } from "./taskBrowsers";

/**
 * Whoever watches a task's browser (docs/task-browser.md, "The view"): a
 * window on the first mate's computer, or a connection from a computer that
 * controls it. Its pictures go to it alone.
 */
export type BrowserViewer = {
  show(frame: TaskBrowserFrame): void;
  /**
   * Hears it go once: its window loads another document or closes, its
   * connection drops. A viewer that watches again afterwards is heard again.
   */
  onGone(listener: () => void): void;
};

/** The browsers a viewer watches: this computer's and those of tasks on other computers. */
export type WatchedBrowsers = {
  watch(taskId: string, sink: BrowserFrameSink): () => void;
  sizeView(taskId: string, sink: BrowserFrameSink, size: TaskBrowserSize | null): void;
};

type Watch = { sink: BrowserFrameSink; unwatch: () => void };

/**
 * The one path every view watches a task's browser by (`inf:browser:watch`,
 * `inf:browser:unwatch`, `inf:browser:size`): each viewer's watches, ended
 * when it unwatches or goes, so a page never sends pictures to nobody. The
 * browsers keep a watched page from its idle stop, and lay it out at the
 * room a watch asks for until that watch ends.
 */
export class BrowserViews {
  private readonly watches = new Map<BrowserViewer, Map<string, Watch>>();

  constructor(private readonly browsers: () => WatchedBrowsers | undefined) {}

  /** Starts sending the task's pictures to the viewer; false when there are no task browsers. */
  watch(viewer: BrowserViewer, taskId: string): { watching: boolean } {
    const browsers = this.browsers();
    if (!browsers) return { watching: false };
    let mine = this.watches.get(viewer);
    if (!mine) {
      mine = new Map();
      this.watches.set(viewer, mine);
      viewer.onGone(() => this.forget(viewer));
    }
    if (!mine.has(taskId)) {
      const sink: BrowserFrameSink = (frame) => viewer.show({ taskId, ...frame });
      mine.set(taskId, { sink, unwatch: browsers.watch(taskId, sink) });
    }
    return { watching: true };
  }

  unwatch(viewer: BrowserViewer, taskId: string): void {
    const mine = this.watches.get(viewer);
    mine?.get(taskId)?.unwatch();
    mine?.delete(taskId);
  }

  /** The room the viewer's maximized view gives the page; only a watch it holds may ask. */
  size(viewer: BrowserViewer, taskId: string, size: TaskBrowserSize | null): void {
    const watch = this.watches.get(viewer)?.get(taskId);
    if (watch) this.browsers()?.sizeView(taskId, watch.sink, size);
  }

  private forget(viewer: BrowserViewer): void {
    for (const watch of this.watches.get(viewer)?.values() ?? []) watch.unwatch();
    this.watches.delete(viewer);
  }
}
