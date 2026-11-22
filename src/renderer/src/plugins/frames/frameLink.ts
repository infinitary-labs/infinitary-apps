import { isSafeCardHref } from "@shared/linkify";

/**
 * The quiet log lines a frame's link leaves on the window's console
 * (docs/ui-plugins.md, "A frame's links"): one when the window hears the
 * frame ask to open it, and one for each step that does not open it, naming
 * why. A click that leaves no line at all never became a link message in
 * the frame. Nothing here reaches a surface.
 */
export function noteFrameLink(href: string, what: string): void {
  console.info(`[infinitary] link ${href}: ${what}`);
}

/**
 * A frame message the window drops before it reads it as a link: logged
 * only when it says it is one, with whatever address it carries.
 */
export function noteDroppedLinkMessage(data: unknown, why: string): void {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "link")
    return;
  const href = "href" in data ? data.href : undefined;
  const shown = typeof href === "string" ? href.slice(0, 2_048) : JSON.stringify(href ?? null);
  // i18n-exempt: not shown (a console line)
  noteFrameLink(shown, `not opened, ${why}`);
}

export type FrameLinkSteps = {
  /** Whether the frame's card is the one the captain can act on now. */
  admitted: () => boolean;
  /** Runs `then` once the frame holds the window's focus, else `otherwise` (`whenFrameHoldsFocus`). */
  whenFocused: (then: () => void, otherwise: () => void) => void;
  focusedOn: () => string;
  /** The browser: `inf:app:open-external`. */
  open: (href: string) => Promise<unknown>;
};

/**
 * A link a card's frame asked to open: only an address a card may open,
 * from the card on screen, by the captain's own click or Enter - the frame
 * holds the window's focus - and then in the browser. Each step that stops
 * it says so (`noteFrameLink`).
 */
export function openFrameLink(href: string, steps: FrameLinkSteps): void {
  if (!isSafeCardHref(href)) {
    // i18n-exempt: not shown (a console line)
    noteFrameLink(href, "not opened, it is not an address a card may open");
    return;
  }
  if (!steps.admitted()) {
    // i18n-exempt: not shown (a console line)
    noteFrameLink(href, "not opened, its card is not the one on screen");
    return;
  }
  steps.whenFocused(
    () => {
      // i18n-exempt: not shown (a console line)
      noteFrameLink(href, "opening it in the browser");
      steps.open(href).catch((caught: unknown) => {
        const reason = caught instanceof Error ? caught.message : String(caught);
        // i18n-exempt: not shown (a console line)
        noteFrameLink(href, `not opened, the system could not open it: ${reason}`);
      });
    },
    () =>
      noteFrameLink(
        href,
        // i18n-exempt: not shown (a console line)
        `not opened, its frame did not hold the window's focus (focus was on ${steps.focusedOn()})`,
      ),
  );
}

export function describeFocus(element: Element | null): string {
  if (!element || element === document.body) return "nothing";
  const name =
    element.getAttribute("aria-label") ??
    element.getAttribute("title") ??
    element.getAttribute("name");
  return name ? `${element.tagName.toLowerCase()} "${name}"` : element.tagName.toLowerCase();
}
