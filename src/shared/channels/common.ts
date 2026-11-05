import { z } from "zod";
import { PASTE_FILE_MAX_BYTES, PASTE_FILES_MAX } from "../composer";

/**
 * Who may ask a core channel: a paired view as well as this Mac, this Mac
 * alone, or a computer that runs work alone.
 */
type ChannelReach = "views" | "home" | "work";

/** One channel of the contract: its effect, both directions' shapes, and where it may be asked. */
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
