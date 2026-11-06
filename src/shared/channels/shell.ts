import { z } from "zod";
import { CHOSEN_FILES_MAX, chosenFileSchema, droppedPathSchema } from "../attachments";
import { crewWordSchema, firstRunViewSchema } from "../firstRun";
import { MAIN_COMMAND_IDS, type MainCommandId } from "../keyboard";
import { keymapSnapshotSchema, panelCommandsSchema, savedKeymapSchema } from "../keymap";
import {
  taskBrowserCommandResultSchema,
  taskBrowserInputSchema,
  taskBrowserSizeSchema,
} from "../taskBrowser";
import {
  micAccessSchema,
  recognizerPlaceSchema,
  voiceClipSchema,
  voiceStatusSchema,
} from "../voice";
import { type ChannelDeclaration, okSchema } from "./common";

/**
 * The window's own buttons where the app draws them (design skill readme,
 * "Linux desktop conventions"): minimize, maximize or restore, and close.
 */
/** `front` brings the window ahead of other apps, as when a sign-in in the browser finishes (INF-838). */
const windowControlSchema = z.enum(["minimize", "maximize", "close", "front"]);
export type WindowControl = z.infer<typeof windowControlSchema>;

/** Whether the window fills the screen, so its middle button reads Restore. */
export const windowStateSchema = z.strictObject({ maximized: z.boolean() });
export type WindowState = z.infer<typeof windowStateSchema>;

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
    request: z.tuple([
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("personal") }),
        z.strictObject({ kind: z.literal("builtin"), id: z.string().min(1) }),
      ]),
    ]),
    response: okSchema,
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
  // The panels' commands the window has now (docs/keyboard.md, "A panel's
  // commands"): installed with the catalog's, each suggested key given only
  // where nothing else uses it. Answers the installed keys.
  "inf:keyboard:panels": {
    effect: "change",
    surface: "host",
    request: z.tuple([panelCommandsSchema]),
    response: keymapSnapshotSchema,
  },
  // Keyboard settings records a key: while on, the window's keys run
  // nothing and each key pressed comes back as `inf:keyboard:recorded`.
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
  // The captain's view watches a task's browser (docs/task-browser.md, "The
  // view"): pictures of its page come to this window on `inf:browser:frame`
  // until it unwatches, reloads or closes. Pixels of this Mac's page for
  // this Mac's window, so the shell answers; false when there is none.
  "inf:browser:watch": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.object({ watching: z.boolean() }),
  },
  "inf:browser:unwatch": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64)]),
    response: okSchema,
  },
  // The room this window's maximized view gives the task's page, or none
  // once it is restored (docs/task-browser.md, "The view"): the page lays
  // out at it while this window watches. Asked of a watch this window holds.
  "inf:browser:size": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64), taskBrowserSizeSchema.nullable()]),
    response: okSchema,
  },
  // The captain's own input to a task's page while he has control
  // (docs/task-browser.md, "Taking control"): this window's pointer and keys
  // to this Mac's page, so the shell answers; the core refuses it unless he
  // holds the browser, and nothing records it.
  "inf:browser:input": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64), taskBrowserInputSchema]),
    response: taskBrowserCommandResultSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
