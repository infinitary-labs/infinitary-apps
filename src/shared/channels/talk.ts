import { z } from "zod";
import { batchAnswerSchema, batchesViewSchema } from "../batches";
import { cardNotesSchema } from "../cardNotes";
import {
  CARD_REPLY_MAX_CHARS,
  CONVERSE_TEXT_MAX_CHARS,
  dropTaskReviewSchema,
  TURN_IMAGES_MAX,
  taskLifecycleOpSchema,
  taskMoveFromSchema,
  turnImageSchema,
} from "../cards";
import { conversationPageRequestSchema, conversationPageSchema } from "../conversation";
import { crewSendResultSchema } from "../crewTranscript";
import { lastTurnSchema } from "../lastTurn";
import {
  folderOfferSchema,
  projectsFolderViewSchema,
  repoMoveResultSchema,
  repoMoveTargetSchema,
  repoPolicyPatchSchema,
  repoRemovalSchema,
  repoSetupResultSchema,
  repoSetupSpecSchema,
  repoViewSchema,
} from "../repos";
import { takeBackRequestSchema, takeBackResultSchema } from "../takeBack";
import { moveOptionsSchema } from "../tasks";
import { type ChannelDeclaration, okSchema, pastedFilesSchema } from "./common";

/** Talking to the first mate, a task's own controls and the projects it works in. */
export const talkChannels = {
  "inf:converse": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.union([
        z.string().min(1).max(CONVERSE_TEXT_MAX_CHARS),
        z.object({
          text: z.string().min(0).max(CONVERSE_TEXT_MAX_CHARS).optional(),
          files: pastedFilesSchema.optional(),
          images: z
            .array(
              z.object({
                mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
                // Base64 without the data: prefix; the cap mirrors the 5MB
                // paste limit in VoiceInput (5MB binary ~ 6.9MB base64).
                data: z.string().min(1).max(7_500_000),
                name: z.string().max(120).optional(),
              }),
            )
            .max(TURN_IMAGES_MAX)
            .optional(),
          /** The card currently on screen, if any. A hint, not the topic. */
          visibleCardId: z.string().min(1).max(128).optional(),
          /**
           * The task the open record card points at (task-system P1/P4): the
           * same kind of hint as the card, filled by the renderer the way
           * visibleCardId is. Never the topic by itself.
           */
          taskId: z.string().min(1).max(64).optional(),
          /**
           * The past card shown on the stage (FI3-579): a closed card read
           * as history. A hint like the card, never the topic by itself.
           */
          pastCardId: z.string().min(1).max(128).optional(),
          /**
           * The project the window is focused on (the top bar's project
           * pill, docs/project-focus.md): a hint below a shown record.
           */
          focusedProjectId: z.string().min(1).max(64).optional(),
          /**
           * All projects is picked while the window shows the project pill
           * (`project-filter-on-every-message.md`): the first mate hears
           * it, so no filter field never stands for All projects.
           */
          allProjects: z.literal(true).optional(),
          /**
           * The captain's newest message, which this one replaces: it is
           * taken back as this one is saved (docs/task-capture.md,
           * "Taking back a message"). A home without `take-back-message`
           * drops the field and saves this one as a new message.
           */
          replaces: z.string().min(1).max(128).optional(),
        }),
      ]),
    ]),
    response: okSchema,
  },
  // Taking back the captain's newest message to the first mate within a
  // minute of sending it (docs/task-capture.md, "Taking back a message").
  "inf:conversation:take-back": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([takeBackRequestSchema]),
    response: takeBackResultSchema,
  },
  // The conversation owner's current busy state, before the view hears live state changes.
  "inf:conversation:state": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.object({ busy: z.boolean() }),
  },
  // The last turn above the input (docs/composer.md "The last turn"): the
  // captain's newest message and the Firstmate's reply line kept beside it,
  // with the round before it (`previous`), read once as the window opens; `user_turn` and `firstmate_reply` carry
  // it after that.
  "inf:conversation:last-turn": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: lastTurnSchema.nullable(),
  },
  // The conversation (docs/composer.md "The conversation"): one page of the
  // captain's messages, their presses of a card's buttons and their lines under
  // cards, each with what answered it, newest first. A window reads it when
  // the conversation card opens and again as it scrolls back.
  "inf:conversation:thread": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([conversationPageRequestSchema.optional()]),
    response: conversationPageSchema,
  },
  "inf:task:abort": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  "inf:task:delete": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  // The Crewmate tab's composer (docs/task-card-tabs.md, "Typing"): a line
  // the captain typed is his steer on the crewmate's own lane, and ⌃C or
  // Stop is his interrupt of its running turn. A refusal comes back as
  // text and writes nothing.
  "inf:task:steer": {
    effect: "change",
    surface: "core",
    reach: "views",
    // With it ride the notes on the task's running page and their marked pictures
    // (docs/task-browser.md, "Pointing at a page"), which need no words (`card-note-places.md`).
    request: z.tuple([
      z.string().min(1).max(64),
      z.string().max(CARD_REPLY_MAX_CHARS),
      z
        .object({
          notes: cardNotesSchema.optional(),
          images: z.array(turnImageSchema).max(TURN_IMAGES_MAX).optional(),
        })
        .optional(),
    ]),
    response: crewSendResultSchema,
  },
  "inf:task:interrupt": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: crewSendResultSchema,
  },
  // The task record's footer and the task board: start, stop, continue, or
  // drop never-started work, and the board's queue and unqueue of it. Drop
  // sends the effects the captain reviewed; a refusal of drop, queue or
  // unqueue comes back as text and writes nothing. A start refused at once
  // comes back as text and a feed line; stop and continue refuse as a feed
  // line. A move a panel made on the captain's click names that panel, so
  // the task's record says where it came from (docs/ui-plugins.md).
  "inf:task:run": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string().min(1).max(64),
      taskLifecycleOpSchema,
      // Null is no review: over the connection, JSON writes an empty review
      // before a panel's name as null (INF-3159).
      dropTaskReviewSchema.nullish(),
      taskMoveFromSchema.optional(),
    ]),
    response: z.discriminatedUnion("ok", [
      okSchema,
      z.object({ ok: z.literal(false), text: z.string().min(1) }),
    ]),
  },
  // The task record's Close as done (INF-3169's plan, piece 3;
  // docs/task-record.md, "One close as done"): the captain's own word that
  // started work is done. The answer is the close's own words, or a refusal
  // at a real limit as text, which writes nothing.
  "inf:task:close-done": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.object({ ok: z.boolean(), text: z.string().min(1) }),
  },
  // Pin a task to the top of Tasks, or unpin it (INF-3127): the Tasks
  // panel's row button, the task board's tile menu and the task record, on
  // the captain's click or key. A fact on the task's own record, whatever
  // its state; a pin a panel made names that panel, as a move does. A
  // refusal comes back as text and writes nothing.
  "inf:task:pin": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.boolean(), taskMoveFromSchema.optional()]),
    response: z.discriminatedUnion("ok", [
      okSchema,
      z.object({ ok: z.literal(false), text: z.string().min(1) }),
    ]),
  },
  // The task record's Edit tags (docs/task-tags.md): the task's tags become
  // exactly these of its project's, by id, as the captain's own, and each
  // change writes one quiet line on its timeline. A refusal comes back as
  // text and writes nothing.
  "inf:task:tags": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.array(z.string().min(1)).max(200)]),
    response: z.discriminatedUnion("ok", [
      okSchema,
      z.object({ ok: z.literal(false), text: z.string().min(1) }),
    ]),
  },
  // The task record's Move to a computer (docs/helper.md, "Moving a started
  // task"): where the task could move, and the move itself - to a computer
  // that runs work by its device id or `this-mac`, or null to cancel a move
  // that still waits. A refusal comes back as text and writes nothing.
  "inf:task:move-options": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: moveOptionsSchema,
  },
  "inf:task:move": {
    effect: "change",
    surface: "core",
    reach: "views",
    // `leaveBehind` moves a task off a computer out of reach from what the
    // home holds, after its options said what stays behind (`away-move.md`).
    request: z.tuple([
      z.string().min(1).max(64),
      z.string().min(1).max(128).nullable(),
      z.object({ leaveBehind: z.literal(true).optional() }).optional(),
    ]),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), text: z.string() }),
      z.object({ ok: z.literal(false), text: z.string().min(1) }),
    ]),
  },
  // Setup, policy and removal share the action catalog with Settings.
  "inf:repos:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(repoViewSchema),
  },
  "inf:repos:setup": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([repoSetupSpecSchema]),
    response: repoSetupResultSchema,
  },
  // A folder the captain dropped on the main message box (docs/composer.md,
  // "Files"): the setup card for it goes up with Add project, as the first
  // mate's proposal puts one up, or the project it already is comes back.
  // Nothing is added until the captain clicks Add project there. The path is
  // on this computer, so only its own window asks.
  "inf:repos:offer-folder": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(4096)]),
    response: folderOfferSchema,
  },
  // Tasks still on a project: the one guard behind removal, read up front.
  "inf:repos:removal": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1)]),
    response: repoRemovalSchema,
  },
  "inf:repos:remove": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1)]),
    response: z.object({ id: z.string(), name: z.string() }),
  },
  // Repositories join another project with their tasks, keys kept
  // (INF-5005): the catalog's project-move line, from the first mate's
  // exact-change card or the captain's own words.
  "inf:repos:move": {
    effect: "change",
    surface: "core",
    reach: "views",
    // The third is a move card's digest of what it showed, refused when
    // the move or what it takes along changed since (INF-5005).
    request: z.tuple([
      z.array(z.string().min(1)).min(1),
      repoMoveTargetSchema,
      z.string().min(1).optional(),
    ]),
    response: repoMoveResultSchema,
  },
  "inf:repos:configure": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1), repoPolicyPatchSchema]),
    response: repoViewSchema,
  },
  // A by-hand answer to a held batch of the captain's own approved changes
  // (Settings -> Projects, docs/forge.md "A held batch"): try it again, or
  // send changes back, each with its reason.
  "inf:repos:batch-answer": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1), batchAnswerSchema]),
    response: okSchema,
  },
  // The Batches panel's read (docs/forge.md, "The Batches panel"): each
  // batched project's line, open batch, changes left out and last day.
  "inf:batches:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: batchesViewSchema,
  },
  // Where new projects go (Settings -> Projects): the folder clone and init
  // create their directories in. Null puts it back to the app's own fleet
  // root; projects already set up never move.
  "inf:repos:folder": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: projectsFolderViewSchema,
  },
  "inf:repos:folder:set": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(4096).nullable()]),
    response: projectsFolderViewSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
