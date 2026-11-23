import { z } from "zod";
import { savedKeymapSchema } from "../keymap";
import {
  dockPresenceSchema,
  ownWindowAnswerSchema,
  ownWindowAskedSchema,
  updateAskedSchema,
} from "../ownWindow";
import { updateWorkSchema } from "../update";
import { type ChannelDeclaration, okSchema } from "./common";

/** A built-in runbook's read-only copy, or the folder of the captain's own. */
export const runbookFolderRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({ kind: z.literal("builtin"), id: z.string().min(1) }),
]);

/** One step of the hold a window keeps on the crew's saved work while it installs an update. */
export const updateHoldStepSchema = z.enum(["save", "later", "release", "replaced", "status"]);
export type UpdateHoldStep = z.infer<typeof updateHoldStepSchema>;

export const updateHoldSchema = z.strictObject({
  /** The crew's running work is saved and held for this window's update. */
  saved: z.boolean(),
  /** What the crew's work is doing around the update, as the update notice shows it. */
  work: updateWorkSchema.optional(),
});
export type UpdateHold = z.infer<typeof updateHoldSchema>;

/**
 * What this computer's own window asks its first mate, and nothing else
 * may (docs/run.md, "The window opened beside it"): the first mate keeps
 * the settings, the records and the crew, and only this computer's window
 * touches the desktop. Each is the same rule applied once more, for a
 * first mate a command started in another program.
 */
export const ownWindowChannels = {
  /**
   * This computer's window is open and takes what its first mate asks of it
   * (`inf:own-window:ask`), until its connection drops.
   */
  "inf:own-window:here": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  "inf:own-window:answer": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([ownWindowAskedSchema.shape.id, ownWindowAnswerSchema]),
    response: okSchema,
  },
  /** The window came to the front: a stale reading of the plan's allowance is read again. */
  "inf:own-window:focused": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  /** The window asked the system about the microphone with dictation on: the first hold to talk is recorded. */
  "inf:voice:primed": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  /** The keys the captain changed, which this computer's window installs (docs/keyboard.md). */
  "inf:settings:keys:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.strictObject({ saved: savedKeymapSchema, unreadable: z.boolean() }),
  },
  "inf:settings:keys:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([savedKeymapSchema]),
    response: okSchema,
  },
  /**
   * A runbook's folder on the first mate's computer, made ready for the
   * window there to open: its path means nothing on another computer.
   */
  "inf:runbooks:folder": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([runbookFolderRequestSchema]),
    response: z.string().min(1),
  },
  /**
   * The hold a window keeps on the crew's saved work while it installs an
   * update for a first mate a command started (docs/alpha.md, "Saving work
   * before an update"): `save` stops running work where nothing is lost
   * and answers once it is saved or let go, `later` lets it go, `release`
   * carries the work on when nothing replaced the copy, and `replaced`
   * ends that first mate with its work still saved, for the new copy to
   * resume. The hold ends when the window's connection drops.
   */
  "inf:update:hold": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([updateHoldStepSchema]),
    response: updateHoldSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;

export const ownWindowPushes = {
  // One thing a first mate a command started asks of the window opened
  // beside it; the window answers with `inf:own-window:answer`.
  "inf:own-window:ask": { payload: ownWindowAskedSchema, surface: "core" },
  // Show in Dock, after every change: the first mate keeps it and this
  // computer's window applies it to its own program.
  "inf:presence:dock": { payload: dockPresenceSchema, surface: "core" },
  // A paired view started this computer's own update (`home-update.md`):
  // the window opens its update notice, says who asked, and follows it, so
  // someone at this computer can still choose Update later. A Mac that
  // controls this one never hands it on to its own windows.
  "inf:update:asked": { payload: updateAskedSchema, surface: "core" },
} as const;
