import { describe, expect, it, vi } from "vitest";
import {
  type CardNote,
  cardNotesSchema,
  MARKED_PICTURES_LINE,
  markNumbers,
  NOTE_LINE_POINTS_MAX,
  NOTE_PLACE_LINES_MAX,
  type NotePlace,
  noteTexts,
  PAGE_NOTE_KEY,
  PAGE_NOTE_KIND,
  pointedAtLines,
} from "../src/shared/cardNotes";
import { notePart, notePartIn, sameNoteTarget } from "../src/shared/cardNoteTargets";
import * as partsOwner from "../src/shared/cardParts";
import { cardNavigationParts } from "../src/shared/cardParts";
import { SETTLE_FACTS_OPEN, splitSettleFacts } from "../src/shared/cards";
import { FRAME_BRIDGE_VERSION, frameMessageSchema } from "../src/shared/plugins/bridge";
import {
  ANNOTATION_BODY,
  ANNOTATION_COMMENT,
  ANNOTATION_DRAWING,
  ANNOTATION_DRAWING_CAPTION,
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

/**
 * Intent: the accepted Point at plan's place in a picture - a note names a box, a spot or drawn
 * lines in the picture's own pixels, and the author reads where each numbered mark is.
 */
const DRAWING = { width: 750, height: 120 };
/** A note on the card's drawing, as the viewer queues one: the caption is its excerpt. */
function drawingNote(place: Omit<NotePlace, "width" | "height">, comment: string): CardNote {
  const part = cardNavigationParts(`${ANNOTATION_BODY}\n${ANNOTATION_DRAWING}`).at(-1);
  if (!part) throw new Error("missing example drawing");
  return {
    start: part.start,
    key: part.key,
    kind: "drawing",
    excerpt: ANNOTATION_DRAWING_CAPTION,
    comment,
    line: 4,
    place: { ...DRAWING, ...place },
  };
}
const CARD_BOX = { box: { x: 450, y: 25, width: 280, height: 70 } };
const ARROW_SPOT = { box: { x: 375, y: 60, width: 0, height: 0 } };
const UNDERLINE = {
  lines: [
    [
      { x: 40, y: 72 },
      { x: 96, y: 74, w: 3 },
      { x: 152, y: 71 },
    ],
  ],
};

describe("a note's place in a picture (accepted Point at plan)", () => {
  it("keeps a box, a spot and drawn lines in whole pixels, and refuses a place past its limits", () => {
    const notes = [
      drawingNote(CARD_BOX, "Say which card"),
      drawingNote(ARROW_SPOT, ""),
      drawingNote(UNDERLINE, "Name the check"),
    ];
    expect(cardNotesSchema.parse(notes)).toEqual(notes);
    const refused = (place: unknown) =>
      !cardNotesSchema.safeParse([{ ...notes[0], place: { ...DRAWING, ...(place as object) } }])
        .success;
    // A place marks something: a size alone is none.
    expect(refused({ box: undefined })).toBe(true);
    expect(refused({ box: { x: 450.5, y: 25, width: 280, height: 70 } })).toBe(true);
    expect(refused({ box: { x: -1, y: 25, width: 280, height: 70 } })).toBe(true);
    const point = { x: 40, y: 72 };
    expect(refused({ lines: [Array(NOTE_LINE_POINTS_MAX).fill(point)] })).toBe(false);
    expect(refused({ lines: [Array(NOTE_LINE_POINTS_MAX + 1).fill(point)] })).toBe(true);
    expect(refused({ lines: Array(NOTE_PLACE_LINES_MAX + 1).fill([point]) })).toBe(true);
    expect(refused({ lines: [[]] })).toBe(true);
  });

  it("numbers marks in the order queued and tells the author where each one is", () => {
    const notes = [
      drawingNote(CARD_BOX, "Say which card"),
      rangeNote(),
      drawingNote({ ...ARROW_SPOT, picture: 2 }, ""),
      drawingNote(UNDERLINE, "Name the check"),
    ];
    // A note on words has no mark, and takes no number.
    expect(markNumbers(notes)).toEqual([1, undefined, 2, 3]);
    const drawing = `- drawing ${JSON.stringify(ANNOTATION_DRAWING_CAPTION)}`;
    expect(pointedAtLines(notes)).toEqual([
      "Pointed at:",
      `${drawing}, mark 1, box 450,25 280×70 in the 750×120 picture, body line 4: Say which card`,
      `- text ${JSON.stringify(ANNOTATION_RANGE)} (characters ${rangeNote().span?.start}–${rangeNote().span?.end}), body line 1: ${ANNOTATION_COMMENT}`,
      `${drawing}, mark 2, spot at 375,60 in the 750×120 picture, picture 2 of its part, body line 4: No comment`,
      `${drawing}, mark 3, a line drawn within 40,71 112×3 in the 750×120 picture, body line 4: Name the check`,
      MARKED_PICTURES_LINE,
    ]);
    // Notes with no place promise no marked picture.
    expect(pointedAtLines([rangeNote()])).not.toContain(MARKED_PICTURES_LINE);
  });

  it("writes each place into the saved reply's words, which a view that cannot draw a mark reads", () => {
    expect(noteTexts([rangeNote(), drawingNote(CARD_BOX, "Say which card")])).toEqual([
      `Pointed at text: “${ANNOTATION_RANGE}”\n${ANNOTATION_COMMENT}`,
      `Pointed at drawing: “${ANNOTATION_DRAWING_CAPTION}” (mark 1, box 450,25 280×70 in the 750×120 picture)\nSay which card`,
    ]);
  });
});

/** Intent: the accepted plan's Point at on a running page - the note names the page and what is under the mark. */
describe("a note on a running page (accepted Point at plan)", () => {
  const pageNote = (page: CardNote["page"], place: Omit<NotePlace, "width" | "height">) =>
    ({
      start: 0,
      key: PAGE_NOTE_KEY,
      kind: PAGE_NOTE_KIND,
      excerpt: page?.title ?? "",
      comment: "This should say what happens next",
      line: 1,
      place: { width: 1280, height: 800, ...place },
      page,
    }) satisfies CardNote;
  const signUp = { url: "http://localhost:5173/sign-up", title: "Sign up" };

  it("names the page, its address, the place and what the outline reads under the mark", () => {
    const notes = [
      pageNote(
        { ...signUp, under: { role: "text", name: "Name" } },
        { box: { x: 40, y: 132, width: 47, height: 18 } },
      ),
      // A control the page gives no name is named by its role alone; a mark on nothing names only its place.
      pageNote(
        { ...signUp, under: { role: "button", name: "" } },
        { box: { x: 1252, y: 28, width: 0, height: 0 } },
      ),
      pageNote(signUp, { box: { x: 700, y: 500, width: 200, height: 120 } }),
    ];
    expect(cardNotesSchema.parse(notes)).toEqual(notes);
    const page = '- page "Sign up" (http://localhost:5173/sign-up)';
    const said = "This should say what happens next";
    expect(pointedAtLines(notes)).toEqual([
      "Pointed at:",
      `${page}, mark 1, box 40,132 47×18 in the 1280×800 picture, on text "Name": ${said}`,
      `${page}, mark 2, spot at 1252,28 in the 1280×800 picture, on button: ${said}`,
      `${page}, mark 3, box 700,500 200×120 in the 1280×800 picture: ${said}`,
      MARKED_PICTURES_LINE,
    ]);
    expect(noteTexts(notes)[0]).toBe(
      `Pointed at page: “Sign up” (http://localhost:5173/sign-up) (mark 1, box 40,132 47×18 in the 1280×800 picture), on text "Name"\n${said}`,
    );
  });
});
