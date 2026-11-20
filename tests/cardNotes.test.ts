import { describe, expect, it, vi } from "vitest";
import { type CardNote, cardNotesSchema, pointedAtLines } from "../src/shared/cardNotes";
import { notePart, notePartIn, sameNoteTarget } from "../src/shared/cardNoteTargets";
import * as partsOwner from "../src/shared/cardParts";
import { cardNavigationParts } from "../src/shared/cardParts";
import { SETTLE_FACTS_OPEN, splitSettleFacts } from "../src/shared/cards";
import { FRAME_BRIDGE_VERSION, frameMessageSchema } from "../src/shared/plugins/bridge";
import {
  ANNOTATION_BODY,
  ANNOTATION_COMMENT,
  ANNOTATION_RANGE,
  ANNOTATION_RANGE_END,
} from "./fixtures/cardAnnotations";

/** Intent: the approved desktop annotation plan keeps exact ranges and identifies moved or missing parts. */
function rangeNote(): CardNote {
  const part = cardNavigationParts(ANNOTATION_BODY)[0];
  if (!part) throw new Error("missing example paragraph");
  const start = "A change the queue sent back showed as a ".length;
  return {
    start: part.start,
    key: part.key,
    kind: "text",
    excerpt: ANNOTATION_RANGE,
    span: { start, end: start + ANNOTATION_RANGE.length },
    comment: ANNOTATION_COMMENT,
    line: 1,
  };
}
describe("card annotations (captain-approved desktop plan)", () => {
  it("maps repeated merge-card parts through the same fact-strip removal as normal reveals (review f2)", () => {
    const facts = `${SETTLE_FACTS_OPEN}<span data-fact="checks">The checks passed</span></div>`;
    const source = `${ANNOTATION_BODY}${facts}${ANNOTATION_BODY}`;
    const split = splitSettleFacts(source);
    if (!split) throw new Error("missing actual settle-facts projection");
    const sourceParts = cardNavigationParts(source);
    const repeated = sourceParts.filter((part) => part.key === rangeNote().key).at(-1);
    if (!repeated) throw new Error("missing repeated example paragraph");
    const note = { ...rangeNote(), start: repeated.start };
    const parts = cardNavigationParts(split.body);
    const map = (start: number) => (start > split.at ? start - split.facts.length : start);
    const parse = vi.spyOn(partsOwner, "cardNavigationParts");
    try {
      expect(notePartIn(parts, note, map)).toBe(map(repeated.start));
      expect(notePartIn(parts, note)).toBeUndefined();
      // Review f4: resolving any number of queued targets reuses this parsed projection.
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
  it("ignores comment-only edits but observes changed frame targets (review f4)", () => {
    const note = rangeNote();
    expect(
      sameNoteTarget(note, {
        ...note,
        comment: "",
        span: note.span ? { ...note.span } : undefined,
      }),
    ).toBe(true);
    expect(sameNoteTarget(note, { ...note, start: note.start + ANNOTATION_BODY.length })).toBe(
      false,
    );
    expect(sameNoteTarget(note, undefined)).toBe(false);
  });
  it("keeps range offsets through the bridge and refuses reversed or unbounded picks", () => {
    const { start, kind, excerpt, span } = rangeNote();
    const message = {
      fm: FRAME_BRIDGE_VERSION,
      type: "annotate",
      focus: false,
      document: "shown-card",
      target: { start, kind, excerpt, span },
      box: { top: 20, bottom: 36, left: 24, right: 160 },
    };
    expect(frameMessageSchema.parse(message)).toEqual(message);
    expect(
      frameMessageSchema.safeParse({
        ...message,
        target: { ...message.target, span: { start: span?.end, end: span?.start } },
      }).success,
    ).toBe(false);
    expect(
      frameMessageSchema.safeParse({
        ...message,
        target: { ...message.target, excerpt: ANNOTATION_BODY.repeat(2) },
      }).success,
    ).toBe(false);
  });
  it("names the range, comment and body line for the author, including notes without comments", () => {
    const note = rangeNote();
    expect(
      pointedAtLines([note, { ...note, kind: "paragraph", span: undefined, comment: "" }]),
    ).toEqual([
      "Pointed at:",
      `- text ${JSON.stringify(ANNOTATION_RANGE)} (characters ${note.span?.start}–${note.span?.end}), body line 1: ${ANNOTATION_COMMENT}`,
      `- paragraph ${JSON.stringify(ANNOTATION_RANGE)}, body line 1: No comment`,
    ]);
    expect(cardNotesSchema.parse([note])[0]).toEqual(note);
  });
  it("finds a moved unchanged part and refuses a missing or ambiguous part", () => {
    const note = rangeNote();
    const moved = `<p>The check passed.</p>\n${ANNOTATION_BODY}`;
    expect(notePart(moved, note)).toBe(moved.indexOf(ANNOTATION_BODY));
    expect(notePart("<p>The queue passed.</p>", note)).toBeUndefined();
    expect(
      notePart(`<p>The check passed.</p>${ANNOTATION_BODY}${ANNOTATION_BODY}`, note),
    ).toBeUndefined();
  });
  it("keeps both endpoints of a selection across parts and marks a removed endpoint stale", () => {
    const parts = cardNavigationParts(ANNOTATION_BODY),
      first = parts[0],
      last = parts[1];
    if (!first || !last) throw new Error("example endpoints missing");
    const note = {
      ...rangeNote(),
      endKey: last.key,
      span: {
        start: rangeNote().span?.start ?? 0,
        end: ANNOTATION_RANGE_END.length,
        endPart: last.start,
      },
    };
    expect(cardNotesSchema.parse([note])[0]).toEqual(note);
    expect(notePart(ANNOTATION_BODY, note)).toBe(first.start);
    const withoutEnd = ANNOTATION_BODY.slice(0, last.start);
    expect(notePart(withoutEnd, note)).toBeUndefined();
  });
});
