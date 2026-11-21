import type { CardNote } from "./cardNotes";
import { cardNavigationParts, type NavigationPart } from "./cardParts";
import type { FrameAnnotationTarget } from "./plugins/bridge";

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

/** Where a note sits in the body drawn now, as the frame reads it; undefined when its part is gone. */
export function noteTarget(
  parts: readonly NavigationPart[],
  note: CardNote,
  originalToRendered?: (start: number) => number,
): FrameAnnotationTarget | undefined {
  const start = notePartIn(parts, note, originalToRendered);
  const endPart = note.endKey
    ? notePartIn(
        parts,
        {
          ...note,
          key: note.endKey,
          start: note.span?.endPart ?? 0,
          endKey: undefined,
          span: undefined,
        },
        originalToRendered,
      )
    : undefined;
  if (start === undefined || (note.endKey && endPart === undefined)) return undefined;
  return {
    start,
    kind: note.kind,
    excerpt: note.excerpt,
    ...(note.span ? { span: { ...note.span, ...(endPart !== undefined ? { endPart } : {}) } } : {}),
  };
}

/**
 * The note a pick in the frame makes, keyed by the part's identity and its offset in the card's own body, or the
 * queued note on the same target, which the pick opens again; undefined when the pick names no part drawn now.
 */
export function pickedNote(input: {
  picked: FrameAnnotationTarget;
  parts: readonly NavigationPart[];
  source: string;
  queued: readonly CardNote[];
  originalToRendered?: (start: number) => number;
}): CardNote | undefined {
  const { picked, parts, source, originalToRendered } = input;
  const part = parts.find((candidate) => candidate.start === picked.start);
  if (!part) return undefined;
  const sourceParts = cardNavigationParts(source);
  const rendered = (start: number) => originalToRendered?.(start) ?? start;
  const original =
    sourceParts.find(
      (candidate) => candidate.key === part.key && rendered(candidate.start) === part.start,
    ) ?? sourceParts.find((candidate) => candidate.key === part.key);
  const end =
    picked.span?.endPart === undefined
      ? undefined
      : parts.find((candidate) => candidate.start === picked.span?.endPart);
  const originalEnd = end
    ? sourceParts.find(
        (candidate) => candidate.key === end.key && rendered(candidate.start) === end.start,
      )
    : undefined;
  const note: CardNote = {
    ...picked,
    start: original?.start ?? part.start,
    key: part.key,
    ...(end && picked.span
      ? { endKey: end.key, span: { ...picked.span, endPart: originalEnd?.start ?? end.start } }
      : {}),
    comment: "",
    line: source.slice(0, original?.start ?? part.start).split("\n").length,
  };
  // A note on a place in the part is its own note: a pick of the whole part never opens it.
  const existing = input.queued.find(
    (queued) =>
      !queued.place &&
      queued.key === note.key &&
      notePartIn(parts, queued, originalToRendered) === picked.start &&
      JSON.stringify(noteTarget(parts, queued, originalToRendered)?.span) ===
        JSON.stringify(picked.span),
  );
  return existing ?? note;
}
