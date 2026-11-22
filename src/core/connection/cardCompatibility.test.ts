import { type CardNote, noteText } from "@shared/cardNotes";
import { cardNavigationParts } from "@shared/cardParts";
import {
  type CardAnswer,
  cardAnswerSchema,
  cardMessageSchema,
  cardSchema,
  cardThreadSchema,
  pastCardSchema,
} from "@shared/cards";
import { CHOICE_ATTACHMENTS } from "@shared/choiceCarried";
import { OWN_SPELLING } from "@shared/codeNames";
import { THROUGH_THE_COMMAND } from "@shared/through";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_BODY,
  ANNOTATION_COMMENT,
  ANNOTATION_DRAWING,
  ANNOTATION_DRAWING_CAPTION,
  ANNOTATION_WORDS,
} from "../../../tests/fixtures/cardAnnotations";
import { cardPushFor, legacyCardSnapshot, pastCardFor, threadLinesFor } from "./cardCompatibility";

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

// INF-5531 piece 1 (`card-live-reads.md`): an older desktop view reads a card
// strictly, so it is sent the card without the reads its crewmate declared,
// and draws it without live data; a view that lists the change keeps them.
describe("live reads compatibility", () => {
  const card = cardSchema.parse({
    id: "card-t1-allowance",
    taskId: "t1",
    author: "crewmate",
    priority: 30,
    title: "Allowance this week",
    meta: "now",
    body: "<p>Reading the meter.</p>",
    actions: [],
    status: "ready",
    createdAt: 1,
    reads: ["quota.snapshot"],
    sql: ["v_usage_v1"],
  });
  const reads = {
    updates: true,
    ended: true,
    annotations: true,
    files: true,
    through: true,
    skipped: true,
    places: true,
  };

  it("leaves a card's reads and views out of a snapshot for a view without the change", () => {
    const older = legacyCardSnapshot([card], { ...reads, liveReads: false }) as unknown[];
    const { reads: _reads, sql: _sql, ...rest } = card;
    expect(cardSchema.omit({ reads: true, sql: true }).parse(older[0])).toEqual(rest);
    expect(legacyCardSnapshot([card], { ...reads, liveReads: true })).toEqual([card]);
  });

  it("does the same to a pushed card list", () => {
    const entry = {
      seq: 1,
      channel: "inf:cards",
      frame: JSON.stringify({ t: "push", seq: 1, channel: "inf:cards", payload: [card] }),
    };
    const sent = (liveReads: boolean) =>
      JSON.parse(cardPushFor(entry, OWN_SPELLING, { ...reads, liveReads })).payload;
    expect(sent(false)[0]).not.toHaveProperty("reads");
    expect(sent(false)[0]).not.toHaveProperty("sql");
    expect(sent(true)).toEqual([card]);
  });
});

/**
 * INF-5608's plan, item 11: a past card names what its closing choice carried, and a reader
 * whose hello does not list `choice-attachments` reads past cards strictly, so it gets the
 * card without that field.
 */
describe("what a past card's closing choice carried", () => {
  const past = pastCardSchema.parse({
    id: "layout-card",
    author: "crewmate",
    title: "Which layout should the settings page use",
    meta: "crewmate",
    body: "<p>Keep the current layout, or move to two columns.</p>",
    actions: [{ id: "two", label: "Two columns", default: true }],
    ending: { how: "chose", at: 1, actionId: "two", label: "Two columns", by: "captain" },
    answers: [],
    carried: {
      notes: [
        {
          start: 0,
          key: "p:0",
          kind: "paragraph",
          excerpt: "Keep the current layout",
          comment: "Use the wider column here",
          line: 1,
        },
      ],
      pictures: ["screen.png"],
    },
    messages: [],
  });

  it("reaches a reader that lists the change whole", () => {
    expect(pastCardFor("inf:cards:past", past, [CHOICE_ATTACHMENTS])).toEqual(past);
  });

  it("leaves the carried items out for an older reader, on each reply that holds a past card", () => {
    const { carried: _carried, ...older } = past;
    for (const channel of ["inf:cards:show", "inf:cards:past", "inf:cards:show-past"]) {
      expect(pastCardFor(channel, past, [])).toEqual(older);
    }
    expect(pastCardFor("inf:cards:past", null, undefined)).toBeNull();
  });
});
