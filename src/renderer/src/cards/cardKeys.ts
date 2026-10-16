/**
 * The shown card read from the keyboard (docs/keyboard.md, "Cards and
 * frames"). F6 lands on the card whole, and from there the reading keys
 * scroll its body as they scroll any page: the arrows a line at a time, the
 * page keys and Space a screen at a time, Home and End to the ends.
 */

/** How far one arrow moves the body, about one line of its text. */
export const READING_LINE_PX = 40;
/** A page keeps a little of the last screen in view, as a browser's does. */
const PAGE_KEPT = 0.875;

/** Where a reading key takes a scroller of this size from `top`, or null for any other key. */
export function readingScrollTop(
  key: string,
  shift: boolean,
  box: { top: number; height: number; scrollHeight: number },
): number | null {
  const page = Math.max(READING_LINE_PX, Math.round(box.height * PAGE_KEPT));
  const end = Math.max(0, box.scrollHeight - box.height);
  const to = (next: number) => Math.min(end, Math.max(0, next));
  switch (key) {
    case "ArrowDown":
      return to(box.top + READING_LINE_PX);
    case "ArrowUp":
      return to(box.top - READING_LINE_PX);
    case "PageDown":
      return to(box.top + page);
    case "PageUp":
      return to(box.top - page);
    case " ":
      return to(box.top + (shift ? -page : page));
    case "Home":
      return 0;
    case "End":
      return end;
    default:
      return null;
  }
}
