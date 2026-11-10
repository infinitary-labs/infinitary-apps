import type { CardNote } from "./cardNotes";
import { cardNavigationParts, type NavigationPart } from "./cardParts";

/** Preserve identity across moved, unchanged parts; do not guess at edited parts. */
export function notePart(body: string, note: CardNote): number | undefined {
  return notePartIn(cardNavigationParts(body), note);
}

/** Resolve against already-parsed parts, mapping saved source offsets before matching repeats. */
export function notePartIn(
  parts: readonly NavigationPart[],
  note: CardNote,
  originalToRendered: (start: number) => number = (start) => start,
): number | undefined {
  if (note.endKey && !parts.some((part) => part.key === note.endKey)) return undefined;
  const same = parts.filter((part) => part.key === note.key);
  return (
    same.find((part) => part.start === originalToRendered(note.start))?.start ??
    (same.length === 1 ? same[0]?.start : undefined)
  );
}

/** Comments do not change a frame target and must not repaint a selected range. */
export function sameNoteTarget(a: CardNote | undefined, b: CardNote | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.start === b.start &&
      a.key === b.key &&
      a.endKey === b.endKey &&
      a.kind === b.kind &&
      a.excerpt === b.excerpt &&
      a.span?.start === b.span?.start &&
      a.span?.end === b.span?.end &&
      a.span?.endPart === b.span?.endPart)
  );
}
