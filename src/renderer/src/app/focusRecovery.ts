/** A live control must still be visible and usable, including through its ancestors. */
export function available(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element.matches(":disabled") || element.closest('[inert], [hidden], [aria-hidden="true"]'))
    return false;
  const style = getComputedStyle(element);
  return (
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

/**
 * Whether an open modal dialog holds focus: the picture viewer, the custom
 * API form. Command search is the store's to say (`commandSearchOpen`), so
 * it is not counted here.
 */
export function modalOpen(): boolean {
  return [...document.querySelectorAll('[aria-modal="true"]:not([data-command-search])')].some(
    available,
  );
}

/** Where lost focus goes, and whether it is still waiting for its place to be ready. */
export type Landing = { land: () => void; waiting: () => boolean };

/**
 * One fallback for the whole shell: if there is no usable focused control,
 * `landing` puts focus where the window's rule says (./focusLanding,
 * docs/keyboard.md "Where focus lands"). No remembered card or pager target
 * survives a blur. A live reply field (including #712's read-only send)
 * stays focused; Settings and the first-launch gate have no available
 * composer. `wayBack` goes first and says whether it put focus somewhere:
 * the frame the window's own page just took focus from by itself gets it
 * back (`giveHandedFocusBack`). While the landing waits for its place (a
 * card not ready yet), every change in the window asks it again.
 */
export function guardLostFocus(wayBack: () => boolean, landing: Landing): () => void {
  const recover = () => {
    if (landing.waiting()) {
      landing.land();
      return;
    }
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      available(active)
    )
      return;
    if (wayBack()) return;
    landing.land();
  };
  // Native pointer focus and React's live reply restoration finish before
  // recovery. Mutation callbacks can otherwise run in the blur/focus gap.
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      recover();
    });
  };
  const observer = new MutationObserver((records) => {
    if (landing.waiting()) {
      schedule();
      return;
    }
    const active = document.activeElement;
    // A style write elsewhere (a hidden character, an animating shell) is not
    // a focus change. Check only when the focused control, or an ancestor,
    // actually changed, and coalesce that check to one frame.
    if (
      active instanceof Element &&
      active !== document.body &&
      active !== document.documentElement &&
      !records.some(
        (record) =>
          record.target === active ||
          (record.target instanceof Element && record.target.contains(active)),
      )
    )
      return;
    schedule();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "inert", "aria-hidden", "class", "style"],
  });
  // Removal may blur before the mutation is delivered. Wait until the next
  // focus target has been chosen; never override a live destination.
  let live = true;
  const blur = (event: FocusEvent) => {
    const previous = event.target;
    // A normal click can blur before Chromium focuses its new target.
    // Recover only a control that actually became unavailable, not that gap.
    if (!(previous instanceof Element) || available(previous)) return;
    queueMicrotask(() => {
      if (live) schedule();
    });
  };
  document.addEventListener("focusout", blur);
  window.addEventListener("resize", schedule);
  document.addEventListener("transitionend", schedule);
  schedule();
  return () => {
    live = false;
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    document.removeEventListener("focusout", blur);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("transitionend", schedule);
  };
}

/**
 * Whether a control holds focus that a way back to the main message gives
 * way to (`focusMainMessage`'s `yields`): any available control but the
 * page itself and command search, which is closing.
 */
export function focusTakenElsewhere(): boolean {
  const active = document.activeElement;
  return (
    active !== null &&
    active !== document.body &&
    active !== document.documentElement &&
    active.closest("[data-command-search]") === null &&
    available(active)
  );
}
