/**
 * A wheel scroll of a task page (docs/task-browser.md, "Input actions").
 * The wheel is real input. It lands on a later frame than the protocol
 * call returns, later still on a busy computer, so the call waits for that
 * scroller's `scrollend` before it returns. A wheel that cannot move the
 * page does not wait that bound.
 */

/** How long a wheel scroll waits for the page to say its scroll ended. */
export const SCROLL_END_MS = 1_000;
/**
 * How long after that bound the host stops waiting. A page that replaces
 * its own timer or listener cannot hold the answer for the command's limit.
 */
export const SCROLL_END_MARGIN_MS = 50;

/** One command over a page's own protocol, answered as the protocol answers it. */
export type ProtocolSend = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/**
 * Finds the scroller a wheel at this point can still move, and arms a wait
 * for that scroller's next scroll end. Returns false when nothing there can
 * move. A document scroll ends on the document, so that target accepts the
 * document as well. Any other scroller's end is ignored.
 */
export function canStillScrollExpression(
  direction: "up" | "down",
  x: number,
  y: number,
  boundMs: number,
): string {
  return `(() => {
    const direction = ${JSON.stringify(direction)};
    const epsilon = 1;
    const canMove = (node) => {
      if (!node) return false;
      const max = node.scrollHeight - node.clientHeight;
      if (max <= epsilon) return false;
      return direction === "down" ? node.scrollTop < max - epsilon : node.scrollTop > epsilon;
    };
    const scrolls = (node) => {
      if (node === document.scrollingElement || node === document.documentElement) return true;
      const overflow = getComputedStyle(node).overflowY;
      return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    };
    let target = null;
    let node = document.elementFromPoint(${x}, ${y});
    while (node) {
      if (scrolls(node) && canMove(node)) { target = node; break; }
      node = node.parentElement;
    }
    if (!target) return false;
    const documentScroller =
      target === document ||
      target === document.documentElement ||
      target === document.scrollingElement ||
      target === document.body;
    return new Promise((done) => {
      const onEnd = (event) => {
        const scrolled = event.target;
        const ours =
          scrolled === target ||
          (documentScroller &&
            (scrolled === document ||
              scrolled === document.documentElement ||
              scrolled === document.scrollingElement));
        if (!ours) return;
        removeEventListener("scrollend", onEnd, { capture: true });
        done(true);
      };
      addEventListener("scrollend", onEnd, { capture: true });
      setTimeout(() => {
        removeEventListener("scrollend", onEnd, { capture: true });
        done(false);
      }, ${boundMs});
    });
  })()`;
}

/**
 * Send one wheel and return only after that scroller's scroll has ended, or
 * after the bound when the page never says so. Already at that edge: send
 * the wheel and return, so a scroll that cannot move does not wait the bound.
 */
export async function wheelScroll(
  send: ProtocolSend,
  direction: "up" | "down",
  size: { width: number; height: number },
  boundMs = SCROLL_END_MS,
): Promise<void> {
  const x = size.width / 2;
  const y = size.height / 2;
  let objectId: string | undefined;
  try {
    const armed = await send<{ result?: { objectId?: string; value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression: canStillScrollExpression(direction, x, y, boundMs),
        awaitPromise: false,
      },
    );
    if (armed.result?.value !== false) objectId = armed.result?.objectId;
  } catch {
    // The wheel still goes out. Without a listener the caller cannot wait.
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY: (direction === "down" ? 1 : -1) * Math.round(size.height * 0.8),
  });
  if (!objectId) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hostBound = new Promise<void>((done) => {
    timer = setTimeout(done, boundMs + SCROLL_END_MARGIN_MS);
  });
  const page = send("Runtime.awaitPromise", {
    promiseObjectId: objectId,
    returnByValue: true,
  }).then(
    () => undefined,
    () => undefined,
  );
  try {
    await Promise.race([page, hostBound]);
  } finally {
    clearTimeout(timer);
  }
}
