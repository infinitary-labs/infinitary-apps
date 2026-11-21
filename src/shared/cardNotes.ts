import { z } from "zod";
import { inLanguage } from "./i18n/current.ts";
import { formatNumber } from "./i18n/format.ts";
import { SOURCE_LANGUAGE } from "./i18n/languages.ts";
import * as m from "./i18n/messages.generated.ts";

/**
 * A drawn line holds at most this many points: a longer one is thinned to it as it is drawn
 * (`linePlace`), since a note rides one connection frame beside its reply.
 */
export const NOTE_LINE_POINTS_MAX = 256;
/** One note's place holds at most this many drawn lines, for the same frame. */
export const NOTE_PLACE_LINES_MAX = 8;

const pixel = z.number().int().nonnegative();
const placeBoxSchema = z.object({ x: pixel, y: pixel, width: pixel, height: pixel });
const placePointSchema = z.object({
  x: pixel,
  y: pixel,
  /** The line's width here, in the picture's pixels, where the pointer reported its pressure. */
  w: z.number().int().positive().optional(),
});

/**
 * A place in a picture (docs/card-threads.md, "Pointing at a place"), in the picture's own pixels:
 * a box, where a box with no size is a spot, or lines drawn freehand. `width` and `height` are
 * the picture's size, so a reader knows what the numbers are measured in. `picture` says which
 * of the part's pictures it is, counted from 1, where the picture is inside its part.
 */
export const notePlaceSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    picture: z.number().int().positive().optional(),
    box: placeBoxSchema.optional(),
    lines: z
      .array(z.array(placePointSchema).min(1).max(NOTE_LINE_POINTS_MAX))
      .min(1)
      .max(NOTE_PLACE_LINES_MAX)
      .optional(),
  })
  .refine((place) => place.box !== undefined || place.lines !== undefined);
export type NotePlace = z.infer<typeof notePlaceSchema>;
export type PlaceBox = z.infer<typeof placeBoxSchema>;
export type PlacePoint = z.infer<typeof placePointSchema>;

/**
 * The running page a note marks (docs/task-browser.md, "Pointing at a page"): its address and
 * title as the crewmate's own reads give them, and what the page's outline names under the mark.
 */
export const notePageSchema = z.object({
  url: z.string().max(2_048),
  title: z.string().max(240),
  under: z.object({ role: z.string().max(64), name: z.string().max(240) }).optional(),
});
export type NotePage = z.infer<typeof notePageSchema>;

/** The part a page note names: a running page is no part of a card's body. */
export const PAGE_NOTE_KEY = "page";
export const PAGE_NOTE_KIND = "page";

/** A note uses the same part identity as revision navigation, never a selector. */
export const cardNoteSchema = z.object({
  start: z.number().int().nonnegative(),
  key: z.string().max(65_536),
  endKey: z.string().max(65_536).optional(),
  kind: z.string().min(1).max(32),
  excerpt: z.string().max(240),
  span: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      endPart: z.number().int().nonnegative().optional(),
    })
    .refine((span) => span.endPart !== undefined || span.end > span.start)
    .optional(),
  // Same physical field size as the card reply (CARD_REPLY_MAX_CHARS).
  comment: z.string().max(4_000),
  line: z.number().int().positive(),
  /** Where in the part's picture the note points (`card-note-places.md`). */
  place: notePlaceSchema.optional(),
  /** The running page the note marks, in place of a part of a card. */
  page: notePageSchema.optional(),
});
export const cardNotesSchema = z.array(cardNoteSchema);
export type CardNote = z.infer<typeof cardNoteSchema>;
export const POINT_AT = m.cardNotePointAt();
export const POINTED_AT = m.cardNotePointedAt();
export const STALE_NOTE = m.cardNoteStale();
export const UNAVAILABLE_NOTE = m.cardNoteUnavailable();
export const EDIT_UNAVAILABLE = m.cardNoteEditUnavailable();
export const EMPTY_NOTE = m.cardNoteEmpty();
/** What a note on a page says when its picture shows the crewmate a page the captain holds. */
export const PAGE_NOTE_SHOWS = m.cardNotePageShows();

/**
 * Each note's mark number, or undefined for a note with no place: marks are numbered in the
 * order queued, and the marked picture a reply carries draws the same numbers.
 */
export function markNumbers(notes: readonly CardNote[]): (number | undefined)[] {
  let next = 0;
  return notes.map((note) => (note.place ? ++next : undefined));
}

/** One place by what it marks, whatever order its fields were written in: what tells two marks on a picture apart. */
export function placeKey(place: NotePlace | undefined): string {
  if (!place) return "";
  const { box } = place;
  return JSON.stringify([
    place.width,
    place.height,
    place.picture ?? 0,
    box ? [box.x, box.y, box.width, box.height] : null,
    (place.lines ?? []).map((line) => line.map((point) => [point.x, point.y, point.w ?? 0])),
  ]);
}

/** The smallest box that holds a place's box and lines. */
export function placeBounds(place: NotePlace): PlaceBox {
  const points = [
    ...(place.box
      ? [
          { x: place.box.x, y: place.box.y },
          { x: place.box.x + place.box.width, y: place.box.y + place.box.height },
        ]
      : []),
    ...(place.lines ?? []).flat(),
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** A place as the crew reads it: English, since the words are served to a model. */
export function placeWords(place: NotePlace, mark: number | undefined): string {
  // i18n-exempt: served to a model
  const which = place.picture === undefined ? "" : `, picture ${place.picture} of its part`;
  // i18n-exempt: served to a model
  const within = `in the ${place.width}×${place.height} picture${which}`;
  const box = place.box;
  const lines = place.lines?.length ?? 0;
  // i18n-exempt: served to a model
  const drawn =
    lines > 0
      ? (({ x, y, width, height }) =>
          `${lines === 1 ? "a line" : `${lines} lines`} drawn within ${x},${y} ${width}×${height}`)(
          placeBounds({ ...place, box: undefined }),
        )
      : "";
  // i18n-exempt: served to a model
  const boxed = !box
    ? ""
    : box.width === 0 && box.height === 0
      ? `spot at ${box.x},${box.y}`
      : `box ${box.x},${box.y} ${box.width}×${box.height}`;
  // i18n-exempt: served to a model
  return `${mark === undefined ? "" : `mark ${mark}, `}${[boxed, drawn].filter(Boolean).join(" and ")} ${within}`;
}

/** What a page note names besides its place: the page's address, and what its outline reads under the mark. */
function pageWords(page: NotePage): { address: string; under: string } {
  return {
    address: page.url ? ` (${page.url})` : "",
    under: page.under
      ? `, on ${page.under.role}${page.under.name ? ` ${JSON.stringify(page.under.name)}` : ""}`
      : "",
  };
}

export function pointedAtLines(notes: readonly CardNote[]): string[] {
  if (!notes.length) return [];
  const marks = markNumbers(notes);
  return [
    "Pointed at:",
    ...notes.map((note, index) => {
      const page = note.page ? pageWords(note.page) : undefined;
      const span = note.span
        ? ` (characters ${note.span.start}–${note.span.end}${note.span.endPart !== undefined ? `, ending in the part at body offset ${note.span.endPart}` : ""})`
        : "";
      const place = note.place ? `, ${placeWords(note.place, marks[index])}` : "";
      const where = page ? page.under : `, body line ${note.line}`;
      return `- ${note.kind} ${JSON.stringify(note.excerpt)}${page?.address ?? ""}${span}${place}${where}: ${note.comment || EMPTY_NOTE}`;
    }),
    ...(marks.some((mark) => mark !== undefined) ? [MARKED_PICTURES_LINE] : []),
  ];
}

/**
 * What follows the notes when any has a place: where the crew sees the marks. A note that
 * reached the sending window through the card's draft rides without its picture, so the line
 * also says what to go by then. Served to a model, so English.
 */
// i18n-exempt: served to a model
export const MARKED_PICTURES_LINE =
  "Each numbered mark is drawn on a marked picture attached to this message, one per marked picture or page. If no marked picture is attached, go by the place each line gives.";

export const ANNOTATE = m.cardNoteAnnotate();
export const QUEUE_NOTE = m.cardNoteQueue();
export const NOTE_COMMENT_LABEL = m.cardNoteCommentLabel();
export const NOTE_CANCEL = m.cardNoteCancel();
export const NOTE_EDIT = m.cardNoteEdit();
export const NOTE_REMOVE = m.cardNoteRemove();
export const NOT_SENT = m.cardNoteNotSent();
export const NOTE_PLACEHOLDER = m.cardNotePlaceholder();
export const NOTE_DISCARD_HINT = m.cardNoteDiscardHint();
/** The card's send button while notes wait (INF-3786): the notes and any typed words leave as one reply. */
export function sendNotesLabel(count: number): string {
  return m.cardNoteSend({ count });
}
export function queuedNotesWords(count: number): string {
  return m.cardNoteQueued({ count });
}

/** Reader-facing fallback for a view that cannot draw structured notes; a note with a place names its mark. */
export function noteLabel(note: Pick<CardNote, "kind" | "excerpt">, mark?: number): string {
  return mark === undefined
    ? m.cardNoteLabel({ kind: note.kind, excerpt: note.excerpt })
    : m.cardNoteMarkLabel({
        mark: formatNumber(mark),
        kind: note.kind,
        excerpt: note.excerpt,
      });
}
/**
 * A note as the saved reply and the crew read it: always the source language (docs/i18n.md, "What stays
 * English"). A note with a place says where, so a view that cannot draw the place still reads it.
 */
export function noteText(note: CardNote, mark?: number): string {
  const label = inLanguage(SOURCE_LANGUAGE, () => noteLabel(note));
  const place = note.place ? ` (${placeWords(note.place, mark)})` : "";
  const page = note.page ? pageWords(note.page) : undefined;
  return `${label}${page?.address ?? ""}${place}${page?.under ?? ""}\n${note.comment || EMPTY_NOTE}`;
}
/** Every note of one reply as `noteText` writes it, each place with its mark number. */
export function noteTexts(notes: readonly CardNote[]): string[] {
  const marks = markNumbers(notes);
  return notes.map((note, index) => noteText(note, marks[index]));
}
