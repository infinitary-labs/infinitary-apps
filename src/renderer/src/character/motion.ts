import { useEffect, useRef } from "react";
import { onReducedMotionChange, prefersReducedMotion } from "./reducedMotion";

/**
 * Drives a canvas animation loop that pauses when the document is hidden and
 * collapses to a single static frame under prefers-reduced-motion. The mock
 * ran a bare requestAnimationFrame loop; production adds these two behaviors
 * (docs/architecture.md) without touching the drawing math.
 * The preference is read through ./reducedMotion so a review page can
 * simulate it.
 */
export function useAnimationLoop(frame: (now: number) => void, resetKey: unknown): void {
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the caller's redraw input
  useEffect(() => {
    let raf = 0;
    let running = false;

    const tick = (now: number) => {
      frameRef.current(now);
      if (running && !prefersReducedMotion()) {
        raf = requestAnimationFrame(tick);
      }
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    // A reduced-motion toggle repaints one fresh static frame; turning it off
    // resumes the loop.
    const onMotionChange = () => {
      stop();
      start();
    };

    document.addEventListener("visibilitychange", onVisibility);
    const unbindMotion = onReducedMotionChange(onMotionChange);
    if (!document.hidden) start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      unbindMotion();
    };
  }, [resetKey]);
}
