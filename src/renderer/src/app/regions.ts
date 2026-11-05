import { focusWithRing } from "../design/focus";
import { giveFocusBack } from "../plugins/frames/frameFocus";
import { railStore } from "../plugins/railStore";
import { available } from "./focusRecovery";
import { useShellStore } from "./store";

/**
 * The window's parts (docs/keyboard.md, "Parts of the window"): the places
 * F6 and ⇧F6 move between, in the order a person reads the window. Each
 * part's root carries `data-window-region` with its kind, painted by the
 * code that draws it, so this module reads the window as it stands and
 * never keeps a list of its own.
 *
 * Home: each side panel on the left rail, the shown card, each side panel
 * on the right rail, then the main message. Settings: its tabs, then the
 * open section. A part that is hidden, inert, held transparent or not
 * drawn yet is skipped.
 */

/** The kinds of part, as `data-window-region` names them. */
export type WindowRegion = "panel" | "card" | "main-message" | "settings-tabs" | "settings-section";

export const REGION_ATTRIBUTE = "data-window-region";

/** What can take focus with Tab, in the order Tab reaches it. */
const TABBABLE =
  'a[href], button, input, select, textarea, iframe, [contenteditable="true"], [tabindex]';

/** The first control in `root` Tab reaches, if any. */
export function firstTabbable(root: HTMLElement): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (element.tabIndex >= 0 && available(element)) return element;
  }
  return null;
}

/** The last control in `root` Tab reaches, if any. */
export function lastTabbable(root: HTMLElement): HTMLElement | null {
  const elements = [...root.querySelectorAll<HTMLElement>(TABBABLE)];
  return elements.findLast((element) => element.tabIndex >= 0 && available(element)) ?? null;
}

/** The main message's field, while a person can type in it. */
function mainMessageField(root: HTMLElement): HTMLElement | null {
  const field = root.querySelector<HTMLElement>('[aria-label="Task prompt"]');
  return field && available(field) ? field : null;
}

/** Focus a key moved, with its ring (../design/focus.ts). */
function land(element: HTMLElement, scroll = true): void {
  focusWithRing(element, { preventScroll: !scroll });
}

/**
 * Focus enters a part where a person would start in it: the main message
 * with its words and caret as they were; the card itself, so Tab goes on
 * into it; a panel's list (its own document puts focus on its row), or its
 * chevron while it is collapsed; Settings' chosen tab; the open section's
 * first control.
 */
function enter(kind: WindowRegion, root: HTMLElement): boolean {
  switch (kind) {
    case "main-message":
      if (!mainMessageField(root)) return false;
      useShellStore.getState().focusMainMessage();
      return true;
    case "card":
      enterCard(root);
      return true;
    case "panel": {
      const id = root.getAttribute("data-side-panel");
      // A collapsed panel keeps its body running out of sight: that body is not where F6 lands.
      const body = root.querySelector<HTMLElement>("[data-side-panel-body]:not([hidden])");
      // A panel in a frame of its own: the window gives the frame focus, and
      // the panel puts it where a person starts in it (`asks.onFocus`).
      if (id !== null && body?.querySelector("iframe")) {
        railStore.askBodyFocus(id);
        return true;
      }
      // A part with no body or header (the create-your-own-panel slot)
      // starts on its first control.
      const start =
        (body && firstTabbable(body)) ??
        root.querySelector<HTMLElement>("header button[aria-expanded]") ??
        firstTabbable(root);
      if (start) land(start);
      // A panel in the window starts on its first control, and is asked too.
      if (id !== null && body) railStore.askBodyFocus(id);
      return start !== null;
    }
    case "settings-tabs": {
      const tab = root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (tab) land(tab);
      return tab !== null;
    }
    case "settings-section":
      land(firstTabbable(root) ?? root);
      return true;
  }
}

/**
 * The shown card itself, ringed, so Tab goes on into it - or, for a card
 * whose page runs in a frame of its own (a panel's card from elsewhere,
 * docs/ui-plugins.md "A panel's cards"), that page, which then puts focus
 * back where it last had it.
 */
export function enterCard(root: HTMLElement): void {
  const page = root.querySelector<HTMLIFrameElement>("[data-panel-card-page] iframe");
  if (page && giveFocusBack(page)) return;
  land(root, false);
}

function kindOf(root: Element): WindowRegion | null {
  const kind = root.getAttribute(REGION_ATTRIBUTE);
  return kind === "panel" ||
    kind === "card" ||
    kind === "main-message" ||
    kind === "settings-tabs" ||
    kind === "settings-section"
    ? kind
    : null;
}

/** The parts a person can go to now, in reading order. */
export function windowRegions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${REGION_ATTRIBUTE}]`)].filter(
    (root) =>
      kindOf(root) !== null &&
      available(root) &&
      // A card selected but not ready to appear is held transparent
      // (stage/CardLayer.tsx); a part fading in is already there.
      root.style.opacity !== "0" &&
      (kindOf(root) !== "main-message" || mainMessageField(root) !== null),
  );
}

/** The part that holds focus now, or -1: a frame's focus is its iframe's in this document. */
function regionAt(regions: readonly HTMLElement[]): number {
  const active = document.activeElement;
  if (!active || active === document.body) return -1;
  return regions.findIndex((root) => root.contains(active));
}

/**
 * Moves focus into the next part of the window, or the previous one, from
 * wherever it is; from outside every part, F6 starts at the first and ⇧F6
 * at the last. Returns whether focus went somewhere.
 */
export function moveToRegion(step: 1 | -1): boolean {
  const regions = windowRegions();
  if (regions.length === 0) return false;
  const at = regionAt(regions);
  for (let tried = 1; tried <= regions.length; tried++) {
    const count = regions.length;
    const index =
      at < 0
        ? step === 1
          ? tried - 1
          : count - tried
        : (((at + step * tried) % count) + count) % count;
    const root = regions[index];
    const kind = root ? kindOf(root) : null;
    if (root && kind && enter(kind, root)) return true;
  }
  return false;
}
