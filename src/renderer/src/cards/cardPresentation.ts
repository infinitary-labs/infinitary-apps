import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

/** Retarget within the original entrance window, never add another full duration. */
export function remainingEntrance(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}
export function boundedShell(height: number, chrome: number, cap: number): number {
  return Math.min(cap, Math.max(Math.min(chrome, cap), height));
}

type Presentation = {
  entry: string | null;
  document: string;
  safety: string;
  waiting: boolean;
  replacement: boolean;
  deadline: number;
  target: number;
  cap: number;
  animation: Animation | null;
  /** A press landed on the shell: it holds still until the release. */
  pressed: boolean;
};

/**
 * An element's height as laid out. A card growing into place (the stage's
 * arrival, a card coming forward after a close) is scaled on screen for a
 * moment; its natural height is still its laid-out one. Unscaled, the
 * on-screen height keeps its fraction: `offsetHeight` rounds it to the
 * nearest whole pixel, so only a difference that rounding explains is the
 * fraction, and a larger one, however small, is the scale.
 */
function laidOutHeight(element: Element): number {
  const seen = element.getBoundingClientRect().height;
  const laidOut = element instanceof HTMLElement ? element.offsetHeight : seen;
  return Math.abs(seen - laidOut) <= 0.5 ? seen : laidOut;
}

/**
 * A card's parts besides its body: the head, the title and the revised line
 * in its middle (ResponseCard's `data-card-middle`, which holds the body),
 * and the rows under it. Their heights are the card's chrome, and each is an
 * intrinsic input the natural height follows.
 */
function chromeParts(card: Element): Element[] {
  return Array.from(card.children).flatMap((child) =>
    child.hasAttribute("data-card-middle")
      ? Array.from(child.children).filter((part) => !part.hasAttribute("data-card-body"))
      : [child],
  );
}

/** The shown stack entry inside the shell (`StageEntry`); prepared and leaving entries are not it. */
const SHOWN = ':scope > [data-stage-entry="shown"]';

function shownEntry(shell: HTMLElement): HTMLElement | null {
  return shell.querySelector<HTMLElement>(SHOWN);
}

/** Inside an entry that is leaving or prepared: never the card the captain acts on. */
function inRetiredEntry(shell: HTMLElement, element: Element): boolean {
  const entry = element.closest("[data-stage-entry]");
  return (
    entry !== null && shell.contains(entry) && entry.getAttribute("data-stage-entry") !== "shown"
  );
}

/**
 * The stage's shell height (docs/renderer.md, "Replacement presentation").
 * Through a replacement the displayed rectangle holds until the shown entry
 * is `ready` - its current document drew at its width - then eases once,
 * centre-fixed, while the stage crossfades the drawings. Natural height is
 * measured from the shown entry alone, never from a drawing that is leaving
 * or a successor being prepared. Geometry is presentation only: neither
 * controls nor intrinsic frame heights wait on it.
 */
export function useCardPresentation(
  ref: RefObject<HTMLDivElement | null>,
  entry: string | null,
  documentKey: string,
  safety: string,
  ready: boolean,
  onSettled?: (entry: string) => void,
) {
  const latest = useRef({ entry, documentKey, safety, ready });
  latest.current = { entry, documentKey, safety, ready };
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const scheduleRef = useRef<() => void>(() => {});
  const queued = useRef(false);
  const state = useRef<Presentation>({
    entry: null,
    document: "",
    safety: "",
    waiting: false,
    replacement: false,
    deadline: 0,
    target: 0,
    cap: 0,
    animation: null,
    pressed: false,
  });
  const reconcile = useRef<() => void>(() => {});
  const watch = useRef<() => void>(() => {});
  const watched = useRef<HTMLElement | null>(null);

  reconcile.current = () => {
    const shell = ref.current;
    const held = state.current;
    if (!shell || !latest.current.entry) {
      held.animation?.cancel();
      held.entry = null;
      held.animation = null;
      return;
    }
    // Nothing moves under a press; the release settles it.
    if (held.pressed) return;
    const current = latest.current;
    const shown = shownEntry(shell);
    const envelope = shell.closest<HTMLElement>("[data-card-envelope]");
    const cap = envelope?.getBoundingClientRect().height ?? window.innerHeight;
    const visible = shell.getBoundingClientRect().height;
    const replacement = held.entry !== null && held.entry !== current.entry;
    const continuingReplacement = held.replacement && held.waiting && held.entry === current.entry;
    const changed = held.entry !== current.entry || held.document !== current.documentKey;
    const unsafe =
      held.safety !== current.safety || (held.cap > 0 && Math.abs(held.cap - cap) > 0.5);
    held.cap = cap;
    if (changed) {
      held.animation?.cancel();
      held.animation = null;
      // Only a card the captain already sees holds its rectangle while the
      // next one gets ready. An entry on an empty stage is unseen until it
      // is ready, so it lays out at its natural height meanwhile: its body
      // frame, clipped by a held rectangle, would report no drawing, and the
      // record would only appear after the hold ran out (INF-510).
      held.waiting = !current.ready && (replacement || held.waiting);
      held.replacement = replacement || continuingReplacement;
      held.deadline = 0;
      held.entry = current.entry;
      held.document = current.documentKey;
      // Explicit pixels keep the displayed rectangle through the switch,
      // including interruption in the middle of a previous entrance.
      shell.style.height = `${Math.min(visible || cap, cap)}px`;
    }
    if (unsafe && !replacement) {
      held.animation?.cancel();
      held.animation = null;
      held.deadline = 0;
      held.replacement = false;
    }
    held.safety = current.safety;

    const scrollers = Array.from(shown?.querySelectorAll<HTMLElement>("[data-card-body]") ?? []);
    const positions = scrollers.map((el) => el.scrollTop);
    // A body that overflows needs no release to measure: what the shown
    // entry lacks is exactly what its scrollers lie past their edges. Releasing
    // the constraint would clamp their scrollTop to 0 and writing it back
    // cancels a smooth scroll already under way (a PageDown pressed just
    // before this ran). Only a card with nothing to scroll is released.
    const overflow = scrollers.reduce(
      (sum, el) => sum + Math.max(0, el.scrollHeight - el.clientHeight),
      0,
    );
    const scrolls = overflow > 1;
    // Release only the presentation constraint, once before paint. The
    // intrinsic iframe viewport NEVER follows the shell's animated height.
    if (!scrolls) shell.dataset.cardGeometry = "natural";
    const natural = Math.min(cap, shown ? laidOutHeight(shown) + (scrolls ? overflow : 0) : 0);
    const card = shown?.querySelector<HTMLElement>("[data-response-card]");
    // A lone card's one field is its own chrome, above its choices (INF-924).
    const chrome = card ? chromeParts(card).reduce((sum, part) => sum + laidOutHeight(part), 2) : 0;
    shell.dataset.cardGeometry = "held";
    if (!scrolls)
      scrollers.forEach((el, i) => {
        el.scrollTop = positions[i] ?? 0;
      });
    const target = boundedShell(natural, chrome, cap);
    if (held.waiting && !current.ready) {
      shell.style.height = `${boundedShell(visible || target, chrome, cap)}px`;
      shell.dataset.cardGeometry = "waiting";
      return;
    }
    const wasWaiting = held.waiting;
    held.waiting = false;
    const duration = Number.parseFloat(getComputedStyle(shell).getPropertyValue("--dur-med")) || 0;
    const now = performance.now();
    const remaining = remainingEntrance(held.deadline, now);
    const active = held.animation !== null && remaining > 0;
    if (Math.abs(held.target - target) < 0.5 && !wasWaiting && !changed && !unsafe) {
      if (active) shell.dataset.cardGeometry = "animating";
      else if (current.entry) onSettledRef.current?.(current.entry);
      return;
    }
    const start = Math.min(visible || target, cap);
    held.animation?.cancel();
    held.animation = null;
    shell.style.height = `${target}px`;
    held.target = target;
    const time = active ? remaining : held.replacement && (changed || wasWaiting) ? duration : 0;
    const focus = document.activeElement;
    const focusedInside =
      focus !== null &&
      shell.parentElement?.contains(focus) === true &&
      !inRetiredEntry(shell, focus);
    if (time > 0 && Math.abs(start - target) >= 0.5 && !focusedInside) {
      if (!active) held.deadline = now + time;
      const animation = shell.animate([{ height: `${start}px` }, { height: `${target}px` }], {
        duration: time,
        easing: getComputedStyle(shell).getPropertyValue("--ease-out").trim(),
      });
      held.animation = animation;
      // The easing's own finish ends it. Its clock can start a frame ahead
      // of the deadline read above, so the deadline may not have passed yet
      // when it finishes: kept, it would hold the card as easing with
      // nothing left to settle it (INF-624).
      animation.onfinish = () => {
        if (state.current.animation !== animation) return;
        state.current.animation = null;
        state.current.deadline = 0;
        scheduleRef.current();
      };
      shell.dataset.cardGeometry = "animating";
    } else {
      held.deadline = 0;
      held.replacement = false;
      shell.dataset.cardGeometry = "held";
      if (current.entry) onSettledRef.current?.(current.entry);
    }
  };

  const cancelGeometry = useCallback(() => {
    const held = state.current;
    if (held.pressed) return;
    held.animation?.cancel();
    held.animation = null;
    held.deadline = 0;
    held.replacement = false;
    reconcile.current();
  }, []);

  /**
   * A press on the card: the card holds where it is until the press is
   * released, so the control under the pointer stays under it and the click
   * lands; then it settles at once. That holds while its height eases and
   * when it would jump with no easing, as a task record does when its body
   * frame draws after the record appears (INF-204). Snapping to the target
   * on the press would move that control away mid-click.
   */
  const pressGeometry = useCallback(() => {
    const shell = ref.current;
    const held = state.current;
    if (!shell || held.pressed) {
      cancelGeometry();
      return;
    }
    if (held.animation) {
      const height = shell.getBoundingClientRect().height;
      held.animation.cancel();
      held.animation = null;
      shell.style.height = `${height}px`;
      shell.dataset.cardGeometry = "held";
    }
    held.deadline = 0;
    held.replacement = false;
    held.pressed = true;
    const release = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      held.pressed = false;
      // The held height is not the target: settle on it, without easing.
      held.target = Number.NaN;
      reconcile.current();
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
  }, [cancelGeometry, ref]);

  scheduleRef.current = () => {
    if (queued.current) return;
    queued.current = true;
    queueMicrotask(() => {
      queued.current = false;
      const shell = ref.current;
      if (shell && shownEntry(shell) !== watched.current) watch.current();
      reconcile.current();
    });
  };
  const present = entry !== null;
  useLayoutEffect(() => {
    latest.current = { entry, documentKey, safety, ready };
    scheduleRef.current();
  }, [entry, documentKey, safety, ready]);
  useLayoutEffect(() => {
    if (!present) return;
    const shell = ref.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => {
      scheduleRef.current();
    });
    watch.current = () => {
      observer.disconnect();
      const envelope = shell.closest("[data-card-envelope]");
      if (envelope) observer.observe(envelope);
      // Do not observe the animated wrapper, body scroller, or flex thread
      // viewport: only the shown entry's intrinsic inputs may remeasure the
      // natural target. A prepared or leaving entry never moves it.
      const shown = shownEntry(shell);
      watched.current = shown;
      if (!shown) return;
      for (const card of shown.querySelectorAll("[data-response-card]")) {
        for (const part of chromeParts(card)) observer.observe(part);
        for (const body of card.querySelectorAll(":scope > [data-card-middle] > [data-card-body]"))
          for (const content of body.children) observer.observe(content);
      }
      for (const message of shown.querySelectorAll(
        "[data-thread-message], [data-thread-working], [data-card-reply]",
      ))
        observer.observe(message);
    };
    const mutations = new MutationObserver(() => {
      scheduleRef.current();
    });
    mutations.observe(shell, { childList: true, subtree: true });
    watch.current();
    reconcile.current();
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => cancelGeometry();
    const resize = () => cancelGeometry();
    const blur = () => {
      if (shell.parentElement?.contains(document.activeElement)) cancelGeometry();
    };
    motion.addEventListener("change", reduced);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    return () => {
      mutations.disconnect();
      observer.disconnect();
      watch.current = () => {};
      watched.current = null;
      state.current.animation?.cancel();
      motion.removeEventListener("change", reduced);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
    };
  }, [present, cancelGeometry, ref]);
  return { cancelGeometry, pressGeometry };
}
