import { z } from "zod";
import { CARD_MEDIA_PIECE_BYTES, CARD_MEDIA_TYPES, CARD_TYPEFACE_TYPES } from "../cardPictures";
import {
  CARD_REPLY_MAX_CHARS,
  cardActionSourceSchema,
  cardAnswersSchema,
  cardSchema,
  cardsSnapshotSchema,
  cardThreadSchema,
  pastCardSchema,
  shellEffectSchema,
  TURN_IMAGES_MAX,
  turnImageSchema,
} from "../cards";
import { taskBrowserHandleSchema } from "../taskBrowser";
import { type ChannelDeclaration, okSchema, pastedFilesSchema } from "./common";

/** Cards: the stack, a card's actions and thread, its pictures and media, and past cards. */
export const cardChannels = {
  "inf:cards:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: cardsSnapshotSchema,
  },
  // The last argument of act, close and reply is the shell's submission
  // metadata (`CardSubmission`): the gesture's id and the offer it had
  // mounted. The core reads it leniently and only records it
  // (docs/card-evidence.md), so metadata it cannot read never refuses a
  // choice; the wire takes it as it comes.
  "inf:cards:act": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string(),
      z.string(),
      cardActionSourceSchema,
      z.unknown().optional(),
      z.unknown().optional(),
    ]),
    response: z.object({ effect: shellEffectSchema.optional(), refusal: z.string().optional() }),
  },
  "inf:cards:minimize": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean()]),
    response: okSchema,
  },
  "inf:cards:show": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: z.union([cardSchema, pastCardSchema]),
  },
  "inf:cards:close": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.unknown().optional()]),
    response: okSchema,
  },
  // A live note's own button (INF-2794, `Card.noteDone`): Done closes its
  // answer task as answered, Got it reads the note. The last argument is the
  // shell's submission metadata, as on close.
  "inf:cards:note-done": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.unknown().optional()]),
    response: okSchema,
  },
  // The stage showed the captain this version of the card - shown, the
  // window visible and focused (1.48.0). The core records it once and
  // compares the card's next revision with it (`Card.changes`); a version
  // the stage no longer shows is ignored.
  "inf:cards:seen": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().max(256), z.string().max(64)]),
    response: okSchema,
  },
  // Exact released-update sightings, additive to the legacy two-argument offer sighting.
  "inf:cards:seen-update": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().max(256), z.string().max(64), z.string().max(64)]),
    response: okSchema,
  },
  // The card's thread (cards-as-threads phase 1): read it once when the
  // card comes up, then follow the `inf:cards:thread` push.
  "inf:cards:thread": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: cardThreadSchema,
  },
  // A card picture's bytes by its file name (docs/view.md): how a view shows
  // the home's own copy of a picture a card names, which its frame asks of
  // the view's own shell. The name is the one the home minted
  // (`@shared/cardPictures`); anything else is refused.
  "inf:cards:picture": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      /** The file, base64. */
      data: z.string(),
    }),
  },
  // A project font's bytes by its file name (docs/view.md): how a view draws
  // a preview in the home's own copy of a font its `@font-face` names, which
  // its frame asks of the view's own shell. Only a minted font name
  // (`@shared/cardPictures`); anything else is refused.
  "inf:cards:typeface": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      contentType: z.enum([
        CARD_TYPEFACE_TYPES.woff2,
        CARD_TYPEFACE_TYPES.woff,
        CARD_TYPEFACE_TYPES.ttf,
        CARD_TYPEFACE_TYPES.otf,
      ]),
      /** The file, base64. */
      data: z.string(),
    }),
  },
  // A piece of a card's demo recording by its file name (docs/view.md): how
  // a view plays the home's own copy, a range at a time, in its picture
  // viewer. Only a minted recording name, at most `CARD_MEDIA_PIECE_BYTES`
  // from an offset; the answer says the whole file's size. An empty piece
  // asks for the size alone.
  "inf:cards:media": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string().min(1).max(128),
      z.number().int().nonnegative(),
      z.number().int().nonnegative().max(CARD_MEDIA_PIECE_BYTES),
    ]),
    response: z.object({
      contentType: z.enum([CARD_MEDIA_TYPES.mp4, CARD_MEDIA_TYPES.gif]),
      /** The whole file's size in bytes. */
      size: z.number().int().nonnegative(),
      /** The piece, base64. */
      data: z.string(),
    }),
  },
  // A closed card as the captain last saw it (FI3-579 piece 2): a pure
  // read, null for a card that is open or unknown.
  "inf:cards:past": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: pastCardSchema.nullable(),
  },
  // Bring a closed card forward as the read-only past card on every window's
  // stage (FI3-579 piece 4). The one door the Cards row, the filter and the
  // Firstmate (catalog action show-card) share: it saves nothing, raises no
  // card and runs no effect; an open or unknown card is refused in words.
  "inf:cards:show-past": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: pastCardSchema,
  },
  // The captain's click on a card's page from its task's project
  // (docs/task-browser.md, "A page from the project"): the core reads the
  // path off the card's own attachment, checks the file inside the project
  // folder again and opens it in the task's own browser with the captain in
  // control, answering which browser for the view. It never answers the
  // card. The project folder is this Mac's, so a view is refused.
  "inf:cards:open-page": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      refusal: z.string().optional(),
      browser: taskBrowserHandleSchema.optional(),
    }),
  },
  // The captain's reply, verbatim. The core decides where it goes - a
  // crewmate card's reply is a captain steer to that crewmate, a Firstmate
  // card's is a captain turn about that card - and returns the thread as it
  // now stands, so the sent message paints without a race. Images ride as
  // they do on converse (1.19.0).
  "inf:cards:reply": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string(),
      z.union([
        z.string(),
        z.object({
          text: z.string().max(CARD_REPLY_MAX_CHARS).optional(),
          files: pastedFilesSchema.optional(),
          images: z.array(turnImageSchema).max(TURN_IMAGES_MAX).optional(),
          answers: cardAnswersSchema.optional(),
        }),
      ]),
      z.unknown().optional(),
      // Read no more: a reply never moves its card. Kept so an older view's call still parses.
      z.boolean().optional(),
    ]),
    response: cardThreadSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
