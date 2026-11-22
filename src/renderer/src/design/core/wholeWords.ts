import { useCallback, useLayoutEffect, useState } from "react";

/**
 * One line of words cut after a whole word (docs/composer.md "The last
 * turn"): a line too long for its box ends on the last whole word that fits
 * beside the ellipsis, never part way through one. The phone keeps the same
 * rule (`WholeWords` in the phone's kit).
 *
 * The node keeps all its words, for a reader, a copy and a rest label, and
 * the browser still draws the ellipsis (`text-overflow: ellipsis`): the cut
 * only narrows the node to the words it shows, the ellipsis and half the
 * next character, so the browser's own ellipsis falls right after the last
 * whole word. A first word too wide for the line keeps the browser's cut,
 * part way through it.
 */

/** No-break spaces join their words, so a cut never falls before one. */
const BREAKING_SPACE = /[^\S   ]/;
const ELLIPSIS = "…";
/** Layout lengths are 1/64 px; a text that fits measures within that of its box. */
const LAYOUT_UNIT_PX = 1 / 64;

const segmenter =
  typeof Intl === "object" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * Where a line of `words` may be cut, as ascending offsets: before a space
 * that ends a word, and between two words of a script written without
 * spaces, where one word starts as the last ends.
 */
export function wordEnds(words: string): number[] {
  const ends = new Set<number>();
  for (let at = 1; at < words.length; at++) {
    if (BREAKING_SPACE.test(words.charAt(at)) && !/\s/.test(words.charAt(at - 1))) ends.add(at);
  }
  let previous: { end: number; word: boolean } | null = null;
  for (const piece of segmenter?.segment(words) ?? []) {
    const word = piece.isWordLike === true;
    if (word && previous?.word && previous.end === piece.index) ends.add(piece.index);
    previous = { end: piece.index + piece.segment.length, word };
  }
  return [...ends].sort((a, b) => a - b);
}

let pen: CanvasRenderingContext2D | null | undefined;

function ellipsisWidth(node: HTMLElement): number {
  pen ??= document.createElement("canvas").getContext("2d");
  if (!pen) return 0;
  const style = getComputedStyle(node);
  pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  pen.letterSpacing = style.letterSpacing === "normal" ? "0em" : style.letterSpacing;
  return pen.measureText(ELLIPSIS).width;
}

/** The offset after the character that starts at `at`, a pair of surrogates whole. */
function nextCharacter(words: string, at: number): number {
  const code = words.codePointAt(at) ?? 0;
  return at + (code > 0xffff ? 2 : 1);
}

/**
 * Narrows `node` to the last whole word that fits beside the ellipsis, or
 * leaves it whole when every word fits or the first is too wide. The node's
 * one child is its text, and its box is laid out one line, cut by its own
 * width (`overflow: hidden`, `white-space: nowrap`).
 */
export function cutAtWholeWord(node: HTMLElement): void {
  node.style.maxWidth = "";
  const text = node.firstChild;
  if (!(text instanceof Text) || text !== node.lastChild || !text.data) return;
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return;
  // Measured with nothing cut, so the range reads each character where it lies.
  node.style.textOverflow = "clip";
  try {
    const room = node.getBoundingClientRect().width;
    if (!(room > 0)) return;
    const widthTo = (end: number) => {
      range.setStart(text, 0);
      range.setEnd(text, end);
      return range.getBoundingClientRect().width;
    };
    if (widthTo(text.length) <= room + LAYOUT_UNIT_PX) return;
    const ends = wordEnds(text.data);
    const ellipsis = ellipsisWidth(node);
    // How many cuts fit: the widths only grow along the line.
    let low = 0;
    let high = ends.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (widthTo(ends[middle] ?? 0) + ellipsis <= room) low = middle + 1;
      else high = middle;
    }
    const end = ends[low - 1];
    if (end === undefined) return;
    const shown = widthTo(end);
    const next = widthTo(nextCharacter(text.data, end)) - shown;
    node.style.maxWidth = `${shown + ellipsis + next / 2}px`;
  } finally {
    node.style.textOverflow = "";
  }
}

/**
 * Keeps a one-line node cut at a whole word as its words, its box's width or
 * the type's loaded font change. `frame` names the ancestor whose width
 * bounds the line and which the line's own words never size, such as the
 * lane a row sits in; it is watched for width, so the cut follows the window
 * and anything beside it.
 */
export function useWholeWords(
  text: string | undefined,
  frame: string,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const ref = useCallback((next: HTMLElement | null) => setNode(next), []);
  useLayoutEffect(() => {
    if (!node || !text) return;
    const cut = () => cutAtWholeWord(node);
    cut();
    const bound = node.closest(frame);
    const observer = typeof ResizeObserver === "function" && bound ? new ResizeObserver(cut) : null;
    if (bound) observer?.observe(bound);
    document.fonts?.addEventListener("loadingdone", cut);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", cut);
      node.style.maxWidth = "";
    };
  }, [node, text, frame]);
  return ref;
}
