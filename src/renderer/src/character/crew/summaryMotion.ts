import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { motionEase, motionToken } from "../../design/motion";
import { CREW_HOVER } from "./hover";

// How a hover summary comes, moves and goes (design skill, Motion: hover
// summaries), shared by the crewmate's summary on the stage and the one a
// Tasks row or a card's task key opens. The first opens a beat after the
// pointer lands, sliding `--move-summary` out from what it describes while
// its hairline draws; resting on another anchor while one shows - or just
// after it went - moves it there at once, with no second wait; letting go
// fades it out over `--dur-summary-out`. Reduced motion keeps the still
// behaviour: each summary opens after the beat and closes at once.

/** How soon after a summary went the next one still moves in at once, ms. */
export const SUMMARY_RECENT_MS = 300;

/** What the summary shows: the anchor it shows for, and whether it is fading out. */
export type SummaryShown<T> = { shown: T | null; leaving: boolean };

/**
 * What happens when the pointer comes to rest on `pointed` (null: it left
 * every anchor), given what shows now, how long ago the last summary went
 * and whether summaries move here (reduced motion zeroes `--dur-quick`):
 * show it at once, wait the beat (closing the one that shows, when
 * summaries do not move), fade the one that shows, close it at once, or
 * nothing.
 */
export type SummaryNext<T> =
  | { kind: "keep" }
  | { kind: "show"; shown: T }
  | { kind: "wait"; shown: T; close: boolean }
  | { kind: "fade" }
  | { kind: "gone" };

export function summaryNext<T>(
  now: SummaryShown<T>,
  pointed: T | null,
  sinceGone: number,
  moving: boolean,
): SummaryNext<T> {
  if (pointed !== null) {
    if (now.shown === pointed && !now.leaving) return { kind: "keep" };
    if (moving && (now.shown !== null || sinceGone < SUMMARY_RECENT_MS))
      return { kind: "show", shown: pointed };
    return { kind: "wait", shown: pointed, close: now.shown !== null };
  }
  if (now.shown === null || now.leaving) return { kind: "keep" };
  return moving ? { kind: "fade" } : { kind: "gone" };
}

/**
 * What the summary shows for `pointed`, what the pointer rests on now. The
 * caller keeps drawing a leaving summary with what it last showed.
 */
export function useSummaryPresence<T>(pointed: T | null): SummaryShown<T> {
  const [state, setState] = useState<SummaryShown<T>>({ shown: null, leaving: false });
  const live = useRef(state);
  live.current = state;
  const goneAt = useRef(Number.NEGATIVE_INFINITY);
  // A layout effect, so the beat's timer for an anchor the pointer left is
  // cleared in the same commit that lets it go. A passive effect's cleanup
  // runs a task later, and a timer due in between opened a summary for an
  // anchor no longer pointed at, which then stayed.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const moving = motionToken(root, "--dur-quick") > 0;
    const next = summaryNext(live.current, pointed, performance.now() - goneAt.current, moving);
    const gone = () => {
      goneAt.current = performance.now();
      setState({ shown: null, leaving: false });
    };
    switch (next.kind) {
      case "keep":
        return;
      case "show":
        setState({ shown: next.shown, leaving: false });
        return;
      case "wait": {
        if (next.close) setState({ shown: null, leaving: false });
        const timer = window.setTimeout(
          () => setState({ shown: next.shown, leaving: false }),
          CREW_HOVER.dwellMs,
        );
        return () => window.clearTimeout(timer);
      }
      case "fade": {
        setState({ shown: live.current.shown, leaving: true });
        const timer = window.setTimeout(gone, motionToken(root, "--dur-summary-out"));
        return () => window.clearTimeout(timer);
      }
      case "gone":
        gone();
        return;
    }
  }, [pointed]);
  return state;
}

export type SummaryPose = { panel: string; line: string; width: string };

export function poseOf(panel: HTMLElement, line: HTMLElement): SummaryPose {
  return { panel: panel.style.transform, line: line.style.transform, width: line.style.width };
}

/**
 * The summary was just placed for the first time: it slides in from its
 * anchor's side, along its hairline's `angle`, as the hairline draws out
 * from the anchor. The panel's own box is placed by its wrapper, so the
 * slide moves what is inside it.
 */
export function openSummary(panel: HTMLElement, line: HTMLElement, angle: number): void {
  const duration = motionToken(panel, "--dur-quick");
  const inner = panel.firstElementChild;
  if (duration <= 0 || !(inner instanceof HTMLElement)) return;
  const move = motionToken(panel, "--move-summary");
  const dx = Math.round(-Math.cos(angle) * move * 10) / 10;
  const dy = Math.round(-Math.sin(angle) * move * 10) / 10;
  const easing = motionEase(panel);
  inner.animate(
    [
      { opacity: 0, transform: `translate(${dx}px, ${dy}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration, easing },
  );
  line.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], {
    duration: Math.round(duration * 0.7),
    easing,
  });
}

/** The summary was placed for a new anchor while it showed: it moves there from `from`. */
export function moveSummary(
  panel: HTMLElement,
  line: HTMLElement,
  from: SummaryPose,
  newWords: boolean,
): void {
  const duration = motionToken(panel, "--dur-quick");
  if (duration <= 0) return;
  const easing = motionEase(panel);
  for (const running of [...panel.getAnimations(), ...line.getAnimations()]) running.cancel();
  if (from.panel && from.panel !== panel.style.transform)
    panel.animate([{ transform: from.panel }, { transform: panel.style.transform }], {
      duration,
      easing,
    });
  if (from.line && (from.line !== line.style.transform || from.width !== line.style.width))
    line.animate(
      [
        { transform: from.line, width: from.width },
        { transform: line.style.transform, width: line.style.width },
      ],
      { duration, easing },
    );
  const inner = panel.firstElementChild;
  if (newWords && inner instanceof HTMLElement)
    inner.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: Math.min(duration, 140),
      easing,
    });
}

/**
 * A summary that was let go fades out while its holder still draws it; one
 * taken back before it went stands at full opacity again. Checked after
 * every render, since the layer may be drawn a render after it opens.
 */
export function useSummaryFade(layer: RefObject<HTMLElement | null>, leaving: boolean): void {
  const applied = useRef<{ layer: HTMLElement | null; leaving: boolean }>({
    layer: null,
    leaving: false,
  });
  useLayoutEffect(() => {
    const el = layer.current;
    const was = applied.current;
    if (el === was.layer && leaving === was.leaving) return;
    applied.current = { layer: el, leaving };
    if (!el) return;
    for (const running of el.getAnimations()) running.cancel();
    const duration = motionToken(el, "--dur-summary-out");
    if (!leaving || duration <= 0) return;
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing: motionEase(el),
      fill: "forwards",
    });
  });
}
