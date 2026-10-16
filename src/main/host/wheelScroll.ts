/**
 * A wheel scroll of a task page (docs/task-browser.md, "Input actions").
 * The wheel is real input. It lands on a later frame than the protocol
 * call returns, later still on a busy computer, so the call waits for the
 * page's next `scrollend` before it returns. A wheel that cannot move the
 * page does not wait that bound.
 */

/** How long a wheel scroll waits for the page to say its scroll ended. */
export const SCROLL_END_MS = 1_000;

/** One command over a page's own protocol, answered as the protocol answers it. */
export type ProtocolSend = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/**
 * Whether a wheel at this point can still move a scroller that way.
 * Only a real scroller counts: the document, or an element whose overflow
 * scrolls. One already at that edge does not, and neither does a box that
 * merely paints past its bounds.
 */
export function canStillScrollExpression(direction: "up" | "down", x: number, y: number): string {
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
    let node = document.elementFromPoint(${x}, ${y});
    while (node) {
      if (scrolls(node) && canMove(node)) return true;
      node = node.parentElement;
    }
    return false;
  })()`;
}

/** Settles true when the page's next scroll ends, or false after the bound. */
export function scrollEndExpression(boundMs: number): string {
  return `new Promise((done) => { addEventListener("scrollend", () => done(true), { once: true, capture: true }); setTimeout(() => done(false), ${boundMs}); })`;
}

/**
 * Send one wheel and return only after that scroll has ended, or after the
 * bound when the page never says so. Already at that edge: send the wheel
 * and return, so a scroll that cannot move does not wait the bound.
 */
export async function wheelScroll(
  send: ProtocolSend,
  direction: "up" | "down",
  size: { width: number; height: number },
  boundMs = SCROLL_END_MS,
): Promise<void> {
  const x = size.width / 2;
  const y = size.height / 2;
  let wait = true;
  try {
    const read = await send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: canStillScrollExpression(direction, x, y),
      returnByValue: true,
    });
    if (read.result?.value === false) wait = false;
  } catch {
    // An unreadable layout can still move. Wait, rather than read too soon.
  }
  let objectId: string | undefined;
  if (wait) {
    try {
      const armed = await send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
        expression: scrollEndExpression(boundMs),
        awaitPromise: false,
      });
      objectId = armed.result?.objectId;
    } catch {
      // The wheel still goes out. Without a listener the caller cannot wait.
    }
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY: (direction === "down" ? 1 : -1) * Math.round(size.height * 0.8),
  });
  if (objectId) {
    await send("Runtime.awaitPromise", { promiseObjectId: objectId, returnByValue: true }).catch(
      () => undefined,
    );
  }
}
