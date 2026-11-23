import { z } from "zod";
import { PASTE_FILE_MAX_BYTES, PASTE_FILES_MAX } from "../composer";

/**
 * Who may ask a core channel: a paired view as well as this computer, this
 * computer alone, or a computer that runs work alone. `home` is what stays
 * with the first mate's own computer: its computers and phones and the
 * address they find it at, a task's browser and a page from a task's
 * project, its Secrets, and its own look, voice, extensions, Knowledge,
 * Observe, release notes, Dock and update, with what this computer's own
 * window tells a first mate a command started (docs/run.md, "The window
 * opened beside it"). A view asks everything else, the captain's panels
 * included, whatever started that first mate (docs/connection.md,
 * "Requests").
 */
type ChannelReach = "views" | "home" | "work";

export type ChannelDeclaration = {
  effect: "read" | "change";
  request: z.ZodType;
  response: z.ZodType;
} & ({ surface: "core"; reach: ChannelReach } | { surface: "host"; reach?: never });

export const pastedFilesSchema = z
  .array(
    z.object({
      /** The file's display name when the text came from a dropped or chosen file. */
      name: z.string().max(120).optional(),
      text: z
        .string()
        .refine((text) => new TextEncoder().encode(text).length <= PASTE_FILE_MAX_BYTES),
    }),
  )
  .max(PASTE_FILES_MAX);

export const okSchema = z.object({ ok: z.literal(true) });
