import { z } from "zod";
import { CHOSEN_FILES_MAX, chosenFileSchema, droppedPathSchema } from "../attachments";
import { crewWordSchema, firstRunViewSchema } from "../firstRun";
import { MAIN_COMMAND_IDS, type MainCommandId } from "../keyboard";
import { offeredKeySchema } from "../keyboardOffer";
import { keymapSnapshotSchema, panelCommandsSchema, savedKeymapSchema } from "../keymap";
import { keyRemindersSchema } from "../keyReminders";
import { resetAnswerSchema } from "../reset";
import {
  micAccessSchema,
  recognizerPlaceSchema,
  voiceClipSchema,
  voiceStatusSchema,
} from "../voice";
import { type ChannelDeclaration, okSchema } from "./common";
import { runbookFolderRequestSchema } from "./ownWindow";

/** `front` brings the window ahead of other apps, as when a sign-in in the browser finishes (INF-838). */
const windowControlSchema = z.enum(["minimize", "maximize", "close", "front"]);
export type WindowControl = z.infer<typeof windowControlSchema>;

/** Whether the window fills the screen, so its middle button reads Restore. */
export const windowStateSchema = z.strictObject({ maximized: z.boolean() });
export type WindowState = z.infer<typeof windowStateSchema>;

/**
 * Whether someone is at this computer (docs/ambient-music.md, "When nobody is
 * at the computer"): `away` while its screen is off or locked, its screen
 * saver runs or another person's session is in front; `watched` when this
 * computer can tell at all, which a Linux desktop cannot.
 */
export const presenceSchema = z.strictObject({ away: z.boolean(), watched: z.boolean() });
export type Presence = z.infer<typeof presenceSchema>;

/** The window's fence, asked and pushed back with the same token (`inf:window:fence`). */
export const windowFenceSchema = z.strictObject({ token: z.number().int().nonnegative() });

/** The window's own shell: first launch, keys, window controls, files, voice and watching a task's browser. */
export const shellChannels = {
  // The first launch (docs/first-launch.md): whether the stage carries the
  // gate, and the two once-only moments the input's hint follows.
  "inf:app:first-run": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: firstRunViewSchema,
  },
  // A crewmate state word was shown in full (docs/first-launch.md "The
  // crewmate's state words"): written once, never overwritten.
  "inf:app:first-run:crew-word": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([crewWordSchema]),
    response: firstRunViewSchema,
  },
  // Card-body links and similar: https anywhere, http loopback only.
  // Does not widen the window-open github allowlist.
  "inf:app:open-external": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(4096)]),
    response: okSchema,
  },
  // Local folders only, chosen by identity rather than an arbitrary renderer path.
  "inf:app:open-runbook-folder": {
    effect: "change",
    surface: "host",
    request: z.tuple([runbookFolderRequestSchema]),
    response: okSchema,
  },
  // The notice over the window opened beside Infinitary started by a command
  // that stopped (docs/run.md, "When the command stops"): Start it here
  // starts the app again as this computer's own first mate, and answers
  // false where nothing offers it; Quit ends this window's program.
  "inf:app:start-here": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.boolean(),
  },
  // Restart it, on that notice over a command that runs and does not answer
  // (docs/run.md, "A command that runs and does not answer"): the command
  // this window started is ended by force and started again; false where
  // nothing offers it.
  "inf:app:restart-command": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.boolean(),
  },
  // Stop, in Settings → General beside Infinitary started by a command
  // (docs/run.md, "Quit and Stop"): its first mate and crew stop cleanly
  // until the person starts Infinitary again; false where none runs beside.
  "inf:app:stop-command": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.boolean(),
  },
  "inf:app:quit": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  // Reset Infinitary, in Settings → General (docs/reset.md): after the
  // system's own confirmation, this computer's Infinitary undoes what it set
  // up, quits and wipes its folder at the next start.
  "inf:app:reset": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: resetAnswerSchema,
  },
  // A window command the main process runs (the size keys), chosen by name
  // in command search (docs/keyboard.md): the same handler its key runs.
  "inf:keyboard:run": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.enum(MAIN_COMMAND_IDS as [MainCommandId, ...MainCommandId[]])]),
    response: okSchema,
  },
  // The keys the window has installed, and what of them a person changed
  // (docs/keyboard.md). They are this Mac's own, so no paired device asks.
  "inf:keyboard:keymap": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: keymapSnapshotSchema,
  },
  // Saves the keys a person changed and installs them, whole, or refuses
  // with the reason and installs nothing.
  "inf:keyboard:save": {
    effect: "change",
    surface: "host",
    request: z.tuple([savedKeymapSchema]),
    response: keymapSnapshotSchema,
  },
  // The key reminder's switch and the keys pressed, this computer's own
  // (docs/keyboard.md, "The key reminder").
  "inf:keyboard:reminders": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: keyRemindersSchema,
  },
  "inf:keyboard:reminders:set": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.boolean()]),
    response: keyRemindersSchema,
  },
  // The panels' commands the window has now (docs/keyboard.md, "A panel's
  // commands"): installed with the catalog's, each suggested key given only
  // where nothing else uses it. Answers the installed keys.
  "inf:keyboard:panels": {
    effect: "change",
    surface: "host",
    request: z.tuple([panelCommandsSchema]),
    response: keymapSnapshotSchema,
  },
  // An unused document key, resolved only against a native press in that same focused frame.
  "inf:keyboard:offer": {
    effect: "change",
    surface: "host",
    request: z.tuple([offeredKeySchema, z.uuid().optional()]),
    response: okSchema,
  },
  // While recording, keys go only to Keyboard settings, never to a command.
  "inf:keyboard:record": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.boolean()]),
    response: okSchema,
  },
  // The window's own buttons where the app draws them (design skill readme,
  // "Linux desktop conventions"): minimize, maximize or restore - one button
  // that toggles - and close. Answers the asking window's state after it.
  "inf:window:control": {
    effect: "change",
    surface: "host",
    request: z.tuple([windowControlSchema]),
    response: windowStateSchema,
  },
  "inf:window:state": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: windowStateSchema,
  },
  // Whether someone is at this computer, as its main process hears it
  // (src/main/presence.ts); the window pauses its ambient music while nobody is.
  "inf:window:presence": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: presenceSchema,
  },
  // Chromium can hand the window an answer before a push sent ahead of it,
  // since the two arrive on separate queues. The fence comes back as the
  // `inf:window:fence` push, behind every push this window was sent before
  // it, so an answer applied after it is applied in push order.
  "inf:window:fence": {
    effect: "read",
    surface: "host",
    request: z.tuple([windowFenceSchema.shape.token]),
    response: okSchema,
  },
  // The system's folder picker, opened at a starting folder when given:
  // the chosen folder's path, or null when the person cancels. Choosing
  // writes nothing; the caller saves the pick through its own channel.
  "inf:app:choose-folder": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(4096).optional()]),
    response: z.string().nullable(),
  },
  // The system's file picker for one file, such as the connection file, opened
  // at a starting file when given: its path, or null when the person cancels.
  // Choosing reads and writes nothing; the caller saves the pick through its own channel.
  "inf:app:choose-file": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(4096).optional()]),
    response: z.string().nullable(),
  },
  // A File the captain dropped on an input: where it lives on disk, read by
  // the shell's own `webUtils.getPathForFile` in the preload (never a path
  // the page names), and whether it is a regular file. Nothing is read.
  "inf:files:inspect": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().max(4096)]),
    response: droppedPathSchema,
  },
  // The system's file picker (any file, several at once): each choice comes
  // back read as far as its class allows - a supported picture or text file
  // with its bytes, an unsupported format as its path only. null when the
  // person cancels, which changes nothing.
  "inf:files:choose": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.array(chosenFileSchema).max(CHOSEN_FILES_MAX).nullable(),
  },
  "inf:voice:status": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: voiceStatusSchema,
  },
  "inf:voice:ensure-model": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  // Whether macOS lets this app use the microphone, for the line under the
  // input (docs/composer.md, "Voice"), and its System Settings pane. This
  // Mac's microphone, so the shell answers. The first ask with dictation on
  // records the first hold to talk (`firstUse`).
  "inf:voice:mic-access": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.object({ access: micAccessSchema }),
  },
  // The card a click on its notification asked this window to open, once:
  // taking it clears it (src/main/notifiedCard.ts). This computer's
  // notification, so the shell answers.
  "inf:cards:take-notified": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.object({ cardId: z.string().min(1).max(256).nullable() }),
  },
  "inf:voice:open-mic-settings": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  // Where this Mac transcribes (docs/architecture.md section 8): in the voice
  // helper, a process of its own, or in a worker in the window. On this
  // Mac's own model and microphone, so the shell answers.
  "inf:voice:recognizer": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: z.object({ where: recognizerPlaceSchema }),
  },
  // The voice helper's model, loaded and primed while the captain talks.
  "inf:voice:warm-up": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  // One recording as 16 kHz mono PCM, held in memory only (D-13), and its words.
  "inf:voice:transcribe": {
    effect: "change",
    surface: "host",
    request: z.tuple([voiceClipSchema]),
    response: z.object({ text: z.string() }),
  },
} as const satisfies Record<string, ChannelDeclaration>;
