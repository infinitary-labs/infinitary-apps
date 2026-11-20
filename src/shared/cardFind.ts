import { foldForSearch } from "./searchText";

/**
 * Finding words in the shown card (⌘F; docs/keyboard.md, "Finding in the
 * shown card"): the one rule for what matches. The window walks its own
 * words and each card page hands out the words it shows; both are matched
 * here, so a page never receives what the person typed, only where the
 * matches are.
 */

/** A match's place in the words it was found in, as UTF-16 offsets: `start` up to, not including, `end`. */
export type FindSpan = { start: number; end: number };

/** Combining marks: what an accented letter leaves once it is taken apart (é is e and ´). */
const MARKS = /\p{M}/gu;

/** Every kind of space a page may draw reads as the space a keyboard types. */
const SPACES = /\s/u;

/**
 * Text as find compares it, one character at a time: lowercase, without
 * accents, with curly quotes and apostrophes read as plain ones (as task
 * search reads them, `foldForSearch`) and any space as a plain space.
 * `from[i]` and `to[i]` give where the folded character `i` came from in
 * the original text, so a match maps back to the words as drawn.
 */
export function foldForFind(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const character of text) {
    const next = at + character.length;
    const plain = SPACES.test(character)
      ? " "
      : foldForSearch(character.normalize("NFD").replace(MARKS, ""));
    for (let i = 0; i < plain.length; i++) {
      from.push(at);
      to.push(next);
    }
    folded += plain;
    at = next;
  }
  return { folded, from, to };
}

/**
 * Every place `words` appears in `text`, in order and never overlapping,
 * by the folding above. Words of nothing but spaces find nothing.
 */
export function findMatches(text: string, words: string): FindSpan[] {
  const wanted = foldForFind(words).folded;
  if (!wanted.trim()) return [];
  const { folded, from, to } = foldForFind(text);
  const spans: FindSpan[] = [];
  let at = folded.indexOf(wanted);
  while (at >= 0) {
    const end = at + wanted.length;
    spans.push({ start: from[at] ?? 0, end: to[end - 1] ?? text.length });
    at = folded.indexOf(wanted, end);
  }
  return spans;
}
