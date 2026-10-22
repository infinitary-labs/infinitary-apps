import { CARD_PEEK_STEP } from "../design/cards/CardStack";
import { motionEase, motionToken } from "../design/motion";

/**
 * How the stage replaces the shown entry (design skill CardStack and
 * Motion; docs/renderer.md, "Replacement presentation"):
 *
 * - `page`: an arrow paged away from it. The next entry slides in from the
 *   arrow's side as the drawing slides out the other way, `--move-page`
 *   over `--dur-page`.
 * - `close`: it left the stack - a close, a closing action, a withdrawal.
 *   Its drawing drops away over `--dur-quick` while the next entry comes
 *   forward from the stack's edge over `--dur-page`, the peeks behind it
 *   moving up one place. The last card drops away the same way.
 * - `swap`: anything else (a reply sending it back, a jump to a record):
 *   one crossfade over `--dur-fast`.
 *
 * The stack's own state never waits: the leaving drawing is inert and only
 * drawn. Reduced motion zeroes the durations, so each is a cut.
 */
export type StageMove = { kind: "page"; dir: 1 | -1 } | { kind: "close" } | { kind: "swap" };

/** The last arrow press: which way, and the entry it was pressed on. */
export type PageStep = { from: string; dir: 1 | -1 };

/** Which move replaces `left`, the entry that stopped being shown, given the stack now. */
export function stageMove(
  left: string,
  stack: readonly { id: string }[],
  paged: PageStep | null,
  sameTask = false,
): StageMove {
  // A tab replaced the task's stack entry, not the task card itself.
  if (sameTask) return { kind: "swap" };
  if (!stack.some((entry) => entry.id === left)) return { kind: "close" };
  if (paged?.from === left) return { kind: "page", dir: paged.dir };
  return { kind: "swap" };
}

/**
 * Plays `move` on the stage: `drawing` is the leaving drawing, kept in the
 * box it was shown in, and `incoming` the entry now shown, or null when the
 * stack emptied or the entry is not on screen yet (`playIncoming` brings it
 * in later). `done` runs once the drawing has gone - at once when the move
 * is a cut. Returns what stops it.
 */
export function playStageMove(
  move: StageMove,
  drawing: HTMLElement,
  incoming: HTMLElement | null,
  done: () => void,
  incomingDone?: () => void,
): () => void {
  const easing = motionEase(drawing);
  // The drawing keeps the transform that centres it in its own box.
  const base = drawing.style.transform || "";
  const at = (extra: string) => `${base} ${extra}`.trim();
  const running: (() => void)[] = [];
  const stop = () => {
    for (const cancel of running) cancel();
  };
  if (move.kind === "close") {
    const duration = motionToken(drawing, "--dur-quick");
    if (duration <= 0) {
      done();
      incomingDone?.();
      return stop;
    }
    const drop = motionToken(drawing, "--move-drop");
    const behind = motionToken(drawing, "--scale-stack") || 1;
    drawing.style.zIndex = "1";
    const out = drawing.animate(
      [
        { opacity: 1, transform: at("translateY(0) scale(1)") },
        { opacity: 0, transform: at(`translateY(${drop}px) scale(${behind})`) },
      ],
      { duration, easing, fill: "forwards" },
    );
    out.onfinish = () => {
      // The drawing may stay mounted as an inert tab; release its final
      // opacity/transform instead of leaving a finished effect on its next visit.
      out.cancel();
      done();
    };
    running.push(() => out.cancel());
    if (incoming) running.push(playIncoming(move, incoming, incomingDone));
    else incomingDone?.();
    return stop;
  }
  const duration = motionToken(drawing, move.kind === "page" ? "--dur-page" : "--dur-fast");
  if (duration <= 0) {
    done();
    incomingDone?.();
    return stop;
  }
  const shift = move.kind === "page" ? motionToken(drawing, "--move-page") * move.dir : 0;
  if (incoming) running.push(playIncoming(move, incoming, incomingDone));
  else incomingDone?.();
  const out = drawing.animate(
    [
      { opacity: 1, transform: at("translateX(0)") },
      { opacity: 0, transform: at(`translateX(${-shift}px)`) },
    ],
    { duration, easing, fill: "forwards" },
  );
  out.onfinish = () => {
    // The drawing may stay mounted as an inert tab; release its final
    // opacity/transform instead of leaving a finished effect on its next visit.
    out.cancel();
    done();
  };
  running.push(() => out.cancel());
  return stop;
}

/**
 * The incoming entry's half of `move`: after a close it comes forward from
 * the stack's edge, the peeks behind it moving up one place; after a page it
 * slides in from the arrow's side; else it fades in. Played with the
 * drawing's half, or on its own once an entry that drew held is shown (a
 * prepared card whose scripts start when it is). Returns what stops it.
 */
export function playIncoming(
  move: StageMove,
  incoming: HTMLElement,
  done?: () => void,
): () => void {
  const easing = motionEase(incoming);
  const running: Animation[] = [];
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    done?.();
  };
  const stop = () => {
    settled = true;
    for (const animation of running) animation.cancel();
  };
  const whenDone = (animation: Animation) => {
    animation.addEventListener("finish", () => {
      if (running.every((item) => item.playState === "finished")) finish();
    });
    return animation;
  };
  if (move.kind === "close") {
    const forward = motionToken(incoming, "--dur-page");
    if (forward <= 0) {
      finish();
      return stop;
    }
    const behind = motionToken(incoming, "--scale-stack") || 1;
    const lift = motionToken(incoming, "--move-stack");
    running.push(
      whenDone(
        incoming.animate(
          [
            { opacity: 0.5, transform: `translateY(${-lift}px) scale(${behind})` },
            { opacity: 1, transform: "none" },
          ],
          { duration: forward, easing },
        ),
      ),
    );
    const slot = incoming.closest("[data-card-slot]");
    for (const peek of slot?.querySelectorAll<HTMLElement>(":scope > [data-card-peek]") ?? [])
      running.push(
        whenDone(
          peek.animate([{ transform: `translateY(${-CARD_PEEK_STEP}px)` }, { transform: "none" }], {
            duration: forward,
            easing,
          }),
        ),
      );
    return stop;
  }
  const duration = motionToken(incoming, move.kind === "page" ? "--dur-page" : "--dur-fast");
  if (duration <= 0) {
    finish();
    return stop;
  }
  const shift = move.kind === "page" ? motionToken(incoming, "--move-page") * move.dir : 0;
  running.push(
    whenDone(
      incoming.animate(
        [
          { opacity: 0, transform: `translateX(${shift}px)` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration, easing },
      ),
    ),
  );
  return stop;
}
