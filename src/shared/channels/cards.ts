import { z } from "zod";
import { cardDraftChangedSchema, cardDraftChangeSchema, cardDraftsSchema } from "../cardDrafts";
import {
  cardFilePieceSchema,
  cardFileSavedSchema,
  cardFilesSavedSchema,
  openCardFileResultSchema,
  pictureSaveSourceSchema,
  savedCardFilesSchema,
} from "../cardFiles";
import { cardNotesSchema } from "../cardNotes";
import {
  CARD_DATA_TYPE,
  CARD_LOG_TYPES,
  CARD_MEDIA_PIECE_BYTES,
  CARD_MEDIA_TYPES,
  CARD_TYPEFACE_TYPES,
} from "../cardPictures";
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
  // answer task as answered, Got it reads the note. The second argument is
  // the shell's submission metadata, as on close; the third, sent only when
  // the card's field holds words, carries them as act's chrome value does
  // (`{ answers }` with the `anything_else` answer, `note-done-words.md`),
  // with the field's notes, files and pictures (`choice-attachments.md`).
  "inf:cards:note-done": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.unknown().optional(), z.unknown().optional()]),
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
  // Each open card's unsent draft (`card-drafts.md`; docs/card-authoring.md,
  // "Unsent picks follow you"): a window reads every one at each welcome,
  // then follows the `inf:cards:draft` live frame.
  "inf:cards:drafts": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: cardDraftsSchema,
  },
  "inf:cards:draft": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(256), cardDraftChangeSchema]),
    response: cardDraftChangedSchema,
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
  // A card's data file by its file name (docs/card-authoring.md, "Data by
  // reference"): how a window, a view or a phone hands a card's frame the
  // text its script asks the bridge for (`inf.data`), from the home's own
  // copy. Only a minted data name (`@shared/cardPictures`); anything else is
  // refused.
  "inf:cards:data": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      contentType: z.literal(CARD_DATA_TYPE),
      /** The file's text, as the host checked and kept it. */
      data: z.string(),
    }),
  },
  // A kept proof log's text by its file name (docs/view.md, docs/ios.md): how
  // a view or a phone opens the home's own copy of a log a merge card names
  // in its log reader (docs/card-authoring.md "Proof logs"). Only a kept
  // log's name (`@shared/cardPictures`); anything else is refused.
  "inf:cards:log": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(160)]),
    response: z.object({
      contentType: z.enum([CARD_LOG_TYPES.txt, CARD_LOG_TYPES.json]),
      /** The file, base64. */
      data: z.string(),
    }),
  },
  // A piece of a card's demo recording or sound clip by its file name
  // (docs/view.md): how a view plays the home's own copy, a range at a time,
  // in its picture viewer or a card's sound strip. Only a minted recording name, at most `CARD_MEDIA_PIECE_BYTES`
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
      contentType: z.enum([
        CARD_MEDIA_TYPES.mp4,
        CARD_MEDIA_TYPES.gif,
        CARD_MEDIA_TYPES.m4a,
        CARD_MEDIA_TYPES.mp3,
        CARD_MEDIA_TYPES.wav,
      ]),
      /** The whole file's size in bytes. */
      size: z.number().int().nonnegative(),
      /** The piece, base64. */
      data: z.string(),
    }),
  },
  // A piece of a file for the captain a card carries (docs/card-authoring.md,
  // "Files for the captain"): how the window whose Save the captain clicked
  // gets the file, wherever its kept copy is, at most `CARD_FILE_PIECE_BYTES`
  // from an offset. Nothing is read before that click.
  "inf:cards:file": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string().min(1).max(256),
      z.string().min(1).max(128),
      z.number().int().nonnegative(),
    ]),
    response: cardFilePieceSchema,
  },
  // Saves a card's file into Downloads on the computer whose window asked,
  // reading it through `inf:cards:file` (docs/card-authoring.md, "Files for
  // the captain"): never over another file of the same name.
  "inf:cards:save-file": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(256), z.string().min(1).max(128)]),
    response: cardFileSavedSchema,
  },
  // The picture viewer's Save to Downloads: the picture or recording shown,
  // as its own file, into Downloads on the computer whose window asked,
  // named for the card and never over another file (the design skill's
  // PictureViewer, "The picture's menu").
  "inf:cards:save-picture": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(1024), pictureSaveSourceSchema]),
    response: cardFileSavedSchema,
  },
  // Save all on a card's files: every named file into one new folder in
  // Downloads on the computer whose window asked, named for the task
  // (docs/card-authoring.md, "Files for the captain"), each read through
  // `inf:cards:file` and checked as a single Save is.
  "inf:cards:save-files": {
    effect: "change",
    surface: "host",
    request: z.tuple([
      z.string().min(1).max(256),
      z.array(z.string().min(1).max(128)).min(1),
      z.string().min(1).max(1024),
    ]),
    response: cardFilesSavedSchema,
  },
  "inf:cards:saved-files": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().min(1).max(256), z.array(z.string().min(1).max(128))]),
    response: savedCardFilesSchema,
  },
  "inf:cards:open-saved-file": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(256), z.string().min(1).max(128).nullable()]),
    response: openCardFileResultSchema,
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
  // card. The page opens in the browser on the first mate's computer, whose
  // project folder it is, so any view may ask and then watches it there.
  "inf:cards:open-page": {
    effect: "change",
    surface: "core",
    reach: "views",
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
          notes: cardNotesSchema.optional(),
          /**
           * The window's project filter, as `inf:converse` carries it
           * (`project-filter-on-every-message.md`): a reply under a first
           * mate card tells it, and a crewmate's ignores it.
           */
          focusedProjectId: z.string().min(1).max(64).optional(),
          allProjects: z.literal(true).optional(),
        }),
      ]),
      z.unknown().optional(),
      // Read no more: a reply never moves its card. Kept so an older view's call still parses.
      z.boolean().optional(),
    ]),
    response: cardThreadSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
