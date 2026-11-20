// Cutting text to a length by whole characters.
// A plain `.slice(0, n)` counts UTF-16 code units, so a cut can land between
// the two halves of an emoji and keep a lone surrogate: a strict encoder (the
// first mate's TOON context, a phone's JSON decoder) then refuses the whole
// text, and SQLite stores the half as U+FFFD. These cuts keep the length
// limit in code units, as before, and step back one unit rather than split a
// pair.

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The first `max` code units of `text`, one fewer when the cut would split a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = Math.max(0, max);
  if (end > 0 && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) {
    return text.slice(0, end - 1);
  }
  return text.slice(0, end);
}

/** The last `max` code units of `text`, one fewer when the cut would split a surrogate pair. */
export function cutTextEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - Math.max(0, max);
  if (start < text.length && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) {
    return text.slice(start + 1);
  }
  return text.slice(start);
}

/** `index`, or one past it when `index` falls between the two halves of a surrogate pair. */
export function characterBoundary(text: string, index: number): number {
  return index > 0 &&
    index < text.length &&
    isHigh(text.charCodeAt(index - 1)) &&
    isLow(text.charCodeAt(index))
    ? index + 1
    : index;
}
