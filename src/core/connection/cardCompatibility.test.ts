import { type CardNote, noteText } from "@shared/cardNotes";
import { cardNavigationParts } from "@shared/cardParts";
import {
  type CardAnswer,
  cardAnswerSchema,
  cardMessageSchema,
  cardThreadSchema,
} from "@shared/cards";
import { THROUGH_THE_COMMAND } from "@shared/through";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_BODY,
  ANNOTATION_COMMENT,
  ANNOTATION_DRAWING,
  ANNOTATION_DRAWING_CAPTION,
  ANNOTATION_WORDS,
} from "../../../tests/fixtures/cardAnnotations";
import { threadLinesFor } from "./cardCompatibility";

/** Intent: the approved desktop annotation must not break strict older desktop readers or leave phone replies blank. */
function thread() {
  const part = cardNavigationParts(ANNOTATION_BODY)[0];
  if (!part) throw new Error("missing example part");
  const note: CardNote = {
    start: part.start,
    key: part.key,
    kind: "paragraph",
    excerpt: "A change the queue sent back showed as a plain failed check.",
    comment: ANNOTATION_COMMENT,
    line: 1,
  };
  return cardThreadSchema.parse({
    cardId: "annotation-card",
    messages: [
      {
        id: 1,
        cardId: "annotation-card",
        who: "captain",
        text: ANNOTATION_WORDS,
        at: 1,
        notes: [note],
      },
    ],
  });
}
describe("annotation compatibility", () => {
  it("keeps current desktop notes structured and gives other readers plain Pointed at lines", () => {
    const value = thread(),
      message = value.messages[0];
    if (!message) throw new Error("missing reply");
    expect(threadLinesFor(value, { sharing: true, annotations: true })).toEqual(value);
    const old = threadLinesFor(value, { sharing: false, annotations: false }) as typeof value;
    const decoded = cardMessageSchema
      .omit({ notes: true, contributor: true, answersMessage: true, clarification: true })
      .parse(old.messages[0]);
    expect(decoded.text).toBe([message.text, ...(message.notes ?? []).map(noteText)].join("\n"));
    expect(decoded).not.toHaveProperty("notes");
  });
  it("adapts nested past-card messages and message arrays through the same owner", () => {
    const value = thread();
    const result = threadLinesFor({ cards: [value] }, { sharing: true, annotations: false }) as {
      cards: (typeof value)[];
    };
    expect(result.cards[0]?.messages[0]?.notes).toBeUndefined();
    expect(result.cards[0]?.messages[0]?.text).toContain(ANNOTATION_COMMENT);
    expect(threadLinesFor([value], { sharing: true, annotations: false })).toEqual(result.cards);
  });
  it("keeps the command's mark only for a view that lists the change (INF-3898 piece 2)", () => {
    const value = thread(),
      message = value.messages[0];
    if (!message) throw new Error("missing reply");
    const marked = { ...value, messages: [{ ...message, through: THROUGH_THE_COMMAND }] };
    const reads = { sharing: true, annotations: true };
    const current = threadLinesFor(marked, { ...reads, through: true }) as typeof marked;
    expect(current.messages[0]?.through).toBe(THROUGH_THE_COMMAND);
    const older = threadLinesFor(marked, { ...reads, through: false }) as typeof marked;
    expect(cardMessageSchema.omit({ through: true }).parse(older.messages[0])).not.toHaveProperty(
      "through",
    );
  });
  it("leaves a skip's mark out of answers for a view that does not list it (INF-4425)", () => {
    const value = thread(),
      message = value.messages[0];
    if (!message) throw new Error("missing reply");
    const skipped: CardAnswer = {
      name: "width",
      values: ["wide"],
      labels: ["Wide"],
      changed: false,
      skipped: true,
    };
    const past = { ...value, answers: [skipped], messages: [{ ...message, answers: [skipped] }] };
    const reads = { sharing: true, annotations: true, through: true };
    expect(threadLinesFor({ cards: [past] }, { ...reads, skipped: true })).toEqual({
      cards: [past],
    });
    const older = threadLinesFor({ cards: [past] }, { ...reads, skipped: false }) as {
      cards: (typeof past)[];
    };
    // An older desktop's strict decoder reads each answer, the Default kept.
    const strict = cardAnswerSchema.omit({ skipped: true });
    const { skipped: _mark, ...unmarked } = skipped;
    const card = older.cards[0];
    expect(card?.answers?.map((answer) => strict.parse(answer))).toEqual([unmarked]);
    expect(card?.messages[0]?.answers?.map((answer) => strict.parse(answer))).toEqual([unmarked]);
  });
  /** Intent: the accepted Point at plan - "A view without it reads the readable Pointed at line." */
  it("folds a note's place into the line's words for a view that draws notes and reads no place", () => {
    const value = thread(),
      message = value.messages[0],
      plain = message?.notes?.[0];
    const drawing = cardNavigationParts(`${ANNOTATION_BODY}\n${ANNOTATION_DRAWING}`).at(-1);
    if (!message || !plain || !drawing) throw new Error("missing reply or drawing");
    const marked: CardNote = {
      start: drawing.start,
      key: drawing.key,
      kind: "drawing",
      excerpt: ANNOTATION_DRAWING_CAPTION,
      comment: "Say which card",
      line: 4,
      place: { width: 750, height: 120, box: { x: 450, y: 25, width: 280, height: 70 } },
    };
    const placed = { ...value, messages: [{ ...message, notes: [plain, marked] }] };
    const reads = { sharing: true, annotations: true, through: true, skipped: true };
    expect(threadLinesFor(placed, { ...reads, places: true })).toEqual(placed);
    const older = threadLinesFor(placed, { ...reads, places: false }) as typeof placed;
    // The note on words stays a note; the mark reads as a line, numbered as the reply numbers it.
    expect(older.messages[0]?.notes).toEqual([plain]);
    expect(older.messages[0]?.text).toBe(
      `${ANNOTATION_WORDS}\nPointed at drawing: “${ANNOTATION_DRAWING_CAPTION}” (mark 1, box 450,25 280×70 in the 750×120 picture)\nSay which card`,
    );
    // A view that draws no notes at all reads every one as a line, the mark with its place.
    const oldest = threadLinesFor(placed, { sharing: true, annotations: false }) as typeof placed;
    expect(oldest.messages[0]?.notes).toBeUndefined();
    expect(oldest.messages[0]?.text).toContain(
      "(mark 1, box 450,25 280×70 in the 750×120 picture)",
    );
  });
});
