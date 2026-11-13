import { type CardNote, noteText } from "@shared/cardNotes";
import { cardNavigationParts } from "@shared/cardParts";
import { cardMessageSchema, cardThreadSchema } from "@shared/cards";
import { THROUGH_THE_COMMAND } from "@shared/through";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_BODY,
  ANNOTATION_COMMENT,
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
});
