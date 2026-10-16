import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * Reading the motion tokens where a move happens (design skill, Motion;
 * `tokens/effects.css`). Durations come back in ms, distances in px and
 * scales as plain numbers; an absent token reads 0. Under reduced motion the
 * shared rule zeroes every duration, so a move that reads 0 is a cut.
 */
export function motionToken(el: Element, name: string): number {
  return Number.parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0;
}

/** The entrance curve, the glide (`--ease-out`). */
export function motionEase(el: Element): string {
  return getComputedStyle(el).getPropertyValue("--ease-out").trim() || "ease-out";
}

/**
 * A popover's presence (design skill, Motion: popovers grow from their
 * button): the update panel, the Reduced motion panel and every row menu.
 * `open` is the caller's own state, which changes at once; this says whether
 * the panel is still drawn. Opening draws it and grows it from `--scale-pop`
 * at the centre of `trigger` over `--dur-quick`. Closing keeps the drawing,
 * inert and hidden from assistive technology, while it fades out over
 * `--dur-popover-out`, then removes it; reopening in the meantime, up to the
 * render that removes it, takes it back where it stands. Reduced motion makes
 * both a cut. It checks after every render, since a caller may draw the panel
 * a render after it opens.
 */
export function usePopoverPresence(
  open: boolean,
  panel: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
): boolean {
  const [drawn, setDrawn] = useState(open);
  if (open && !drawn) setDrawn(true);
  const shown = useRef(false);
  const exit = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    if (!drawn || !el) {
      shown.current = false;
      // A fade-out is let go only once its panel is removed: until then a
      // finished one still holds the panel hidden, and a reopening must take
      // it back.
      if (!drawn) exit.current = null;
      return;
    }
    if (open) {
      if (exit.current) {
        exit.current.cancel();
        exit.current = null;
        el.inert = false;
        el.removeAttribute("aria-hidden");
        el.style.pointerEvents = "";
      }
      if (shown.current) return;
      shown.current = true;
      const duration = motionToken(el, "--dur-quick");
      if (duration <= 0) return;
      const box = el.getBoundingClientRect();
      const from = trigger.current?.getBoundingClientRect();
      if (from) {
        const x = from.left + from.width / 2 - box.left;
        const y = from.top + from.height / 2 - box.top;
        el.style.transformOrigin = `${Math.round(x)}px ${Math.round(y)}px`;
      }
      const scale = motionToken(el, "--scale-pop") || 1;
      el.animate(
        [
          { opacity: 0, transform: `scale(${scale})` },
          { opacity: 1, transform: "none" },
        ],
        { duration, easing: motionEase(el) },
      );
      return;
    }
    if (!shown.current || exit.current) return;
    shown.current = false;
    const duration = motionToken(el, "--dur-popover-out");
    if (duration <= 0) {
      setDrawn(false);
      return;
    }
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    el.style.pointerEvents = "none";
    for (const running of el.getAnimations()) running.cancel();
    const leaving = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "scale(0.98)" },
      ],
      { duration, easing: motionEase(el), fill: "forwards" },
    );
    exit.current = leaving;
    leaving.onfinish = () => {
      if (exit.current === leaving) setDrawn(false);
    };
  });
  return drawn;
}
