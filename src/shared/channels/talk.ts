import { z } from "zod";
import {
  CARD_REPLY_MAX_CHARS,
  CONVERSE_TEXT_MAX_CHARS,
  dropTaskReviewSchema,
  TURN_IMAGES_MAX,
  taskLifecycleOpSchema,
  taskMoveFromSchema,
} from "../cards";
import { crewSendResultSchema } from "../crewTranscript";
import { lastTurnSchema } from "../lastTurn";
import {
  projectsFolderViewSchema,
  queueAnswerSchema,
  queueCredentialSchema,
  repoPolicyPatchSchema,
  repoRemovalSchema,
  repoSetupResultSchema,
  repoSetupSpecSchema,
  repoViewSchema,
} from "../repos";
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
        }),
      ]),
    ]),
    response: okSchema,
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
  "inf:task:abort": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  "inf:task:delete": {
    effect: "change",
    surface: "core",
    reach: "home",
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
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(CARD_REPLY_MAX_CHARS)]),
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
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(128).nullable()]),
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
    reach: "home",
    request: z.tuple([repoSetupSpecSchema]),
    response: repoSetupResultSchema,
  },
  // Tasks still on a project: the one guard behind removal, read up front.
  "inf:repos:removal": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1)]),
    response: repoRemovalSchema,
  },
  "inf:repos:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1)]),
    response: z.object({ id: z.string(), name: z.string() }),
  },
  "inf:repos:configure": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1), repoPolicyPatchSchema]),
    response: repoViewSchema,
  },
  // A by-hand answer to a project's paused batch (Settings -> Projects,
  // docs/forge.md "A paused batch"): the shipped queue starts where the
  // project lives with the reason, and ends the pause itself.
  "inf:repos:queue-answer": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1), queueAnswerSchema]),
    response: okSchema,
  },
  // The token a project's shipped queue writes with, where its host keeps
  // one in the project's CI settings (GitLab; docs/forge.md, "The shipped
  // queue on GitLab"): null on a host whose queue needs none.
  "inf:repos:queue-credential": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1)]),
    response: queueCredentialSchema.nullable(),
  },
  // Create that token with the captain's own sign-in (Settings -> Projects),
  // one click; the token itself never reaches the app.
  "inf:repos:queue-credential-create": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1)]),
    response: queueCredentialSchema,
  },
  // Where new projects go (Settings -> Projects): the folder clone and init
  // create their directories in. Null puts it back to the app's own fleet
  // root; projects already set up never move.
  "inf:repos:folder": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: projectsFolderViewSchema,
  },
  "inf:repos:folder:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(4096).nullable()]),
    response: projectsFolderViewSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
