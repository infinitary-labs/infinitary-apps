import { z } from "zod";
import { personalIdSchema } from "./manifest";

/**
 * A panel's built files, as a window asks the first mate for them before it
 * draws the panel (docs/ui-plugins.md, "The frame realm"): the first mate
 * names no folder, so a window on its own computer and one on another draw
 * from the same answer. The request names what `panelModuleSchema` names of
 * a panel the captain made or added.
 */
export const panelFilesRequestSchema = z.strictObject({
  source: z.enum(["yours", "installed"]),
  id: personalIdSchema,
  /** The compiled graph's content hash (the compiler's 16 hex). */
  version: z.string().regex(/^[0-9a-f]{16}$/),
  /** One of the captain's own panels as a crewmate is building it. */
  draft: z.literal(true).optional(),
});
export type PanelFilesRequest = z.infer<typeof panelFilesRequestSchema>;

/**
 * The answer: null when the first mate serves no such panel from that
 * source at exactly that version, or its panels are switched off.
 */
export const panelFilesSchema = z
  .strictObject({
    /**
     * The first mate's own version of the app: the files were built for the
     * panel library of that version, which only a window on it serves.
     */
    builtFor: z.string().min(1).max(64),
    /** Every built file, by its forward-slashed path under the panel's version, base64. */
    files: z.array(z.strictObject({ path: z.string().min(1).max(512), data: z.string() })),
  })
  .nullable();
export type PanelFiles = z.infer<typeof panelFilesSchema>;

/** What a window says in place of a panel it cannot draw from the first mate's files. */
export const PANEL_FILES_WORDS = {
  /** The window's app and the first mate's are on different versions. */
  otherVersion:
    "This panel shows once Infinitary here and on the computer where your first mate lives are on the same version.",
} as const;
