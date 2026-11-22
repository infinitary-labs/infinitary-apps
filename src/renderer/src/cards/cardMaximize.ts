/**
 * A maximized card's lifetime and its reading place (design skill
 * `components/cards/ResponseCard.prompt.md`, "Maximize"). The stage keeps
 * which entry was maximized and when; the size itself is
 * `maximizedPlacement` (./cardGeometry).
 */

/** The entry maximized, and the main message's focus request it was maximized under. */
export type MaximizedAt = { entryId: string; focusRequest: number };

/**
 * Whether the shown entry is maximized now: only the entry that was
 * maximized, and only until the main message is asked for. Paging, a close
 * or another card coming forward starts another visit at its saved default
 * (the stage seeds that visit); a request to focus the main message
 * (Go to the main message, a close that hands focus back) restores it first.
 */
export function isMaximized(
  at: MaximizedAt | null,
  shownId: string | undefined,
  focusRequest: number,
): boolean {
  return at !== null && at.entryId === shownId && at.focusRequest === focusRequest;
}

/** Where a person is reading in a scrolled body: its end, or how far down its top edge is. */
export type ReadingAnchor = { at: "end" } | { at: "fraction"; fraction: number };

type Scrolled = { top: number; height: number; scrollHeight: number };

/** The reading place in a scroller, read before its width changes. */
export function readingAnchor({ top, height, scrollHeight }: Scrolled): ReadingAnchor {
  if (top > 0 && scrollHeight - height - top <= 2) return { at: "end" };
  return { at: "fraction", fraction: scrollHeight > 0 ? top / scrollHeight : 0 };
}

/** Where the scroller goes to keep `anchor` once what it holds has reflowed. */
export function anchoredScrollTop(
  anchor: ReadingAnchor,
  { height, scrollHeight }: Omit<Scrolled, "top">,
): number {
  const end = Math.max(0, scrollHeight - height);
  if (anchor.at === "end") return end;
  return Math.min(end, Math.round(anchor.fraction * scrollHeight));
}

/** How long a reflow may keep moving the reading place after a change of size. */
const HOLD_MS = 2_000;

/**
 * Keeps `scroller` at `anchor` while what it holds reflows at its new width:
 * a body's frame draws again and reports its new height a few frames later.
 * The place is put back each time the scroller or its content changes size,
 * until the person scrolls, presses or types, or the hold runs out.
 * Returns the release.
 */
export function holdReadingAnchor(scroller: HTMLElement, anchor: ReadingAnchor): () => void {
  let released = false;
  const apply = () => {
    scroller.scrollTop = anchoredScrollTop(anchor, {
      height: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    });
  };
  const observer = new ResizeObserver(apply);
  observer.observe(scroller);
  for (const content of scroller.children) observer.observe(content);
  apply();
  const timer = window.setTimeout(release, HOLD_MS);
  const events = ["wheel", "pointerdown", "keydown"] as const;
  for (const event of events) window.addEventListener(event, release, true);
  function release(): void {
    if (released) return;
    released = true;
    observer.disconnect();
    window.clearTimeout(timer);
    for (const event of events) window.removeEventListener(event, release, true);
  }
  return release;
}
