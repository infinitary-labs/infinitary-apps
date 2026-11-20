import type { Locator } from "@playwright/test";

type HeldFrames = {
  asked: Map<number, FrameRequestCallback>;
  request: typeof requestAnimationFrame;
  cancel: typeof cancelAnimationFrame;
};

/**
 * Holds the animation frames the page `root` sits in asks for until
 * `release` runs them, in the order they were asked for: the order a late
 * frame gives. A window that paints late draws a frame a command or a key
 * asked for after the person has already moved on - a virtual Mac's hidden
 * window (INF-699), hosted Linux under two workers (INF-963) - and a
 * journey that holds the frames meets that order on every run.
 */
export async function holdFrames(root: Locator): Promise<{ release: () => Promise<void> }> {
  await root.evaluate((element) => {
    const view = element.ownerDocument.defaultView as (Window & { heldFrames?: HeldFrames }) | null;
    if (!view || view.heldFrames) throw new Error("the page's frames are already held");
    const held: HeldFrames = {
      asked: new Map(),
      request: view.requestAnimationFrame,
      cancel: view.cancelAnimationFrame,
    };
    let next = 1_000_000;
    view.heldFrames = held;
    view.requestAnimationFrame = (callback) => {
      next += 1;
      held.asked.set(next, callback);
      return next;
    };
    view.cancelAnimationFrame = (id) => {
      if (!held.asked.delete(id)) held.cancel.call(view, id);
    };
  });
  return {
    release: () =>
      root.evaluate((element) => {
        const view = element.ownerDocument.defaultView as
          | (Window & { heldFrames?: HeldFrames })
          | null;
        const held = view?.heldFrames;
        if (!view || !held) throw new Error("the page's frames are not held");
        view.requestAnimationFrame = held.request;
        view.cancelAnimationFrame = held.cancel;
        delete view.heldFrames;
        const at = view.performance.now();
        for (const callback of held.asked.values()) callback(at);
      }),
  };
}
