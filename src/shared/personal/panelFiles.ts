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

/**
 * The panel library a phone may ask for (docs/view.md, "Panels on the
 * phone"): named by the version of the app a panel's files were built for
 * (`PanelFiles.builtFor`), so a device can keep one copy per version and
 * ask again only when that version changes.
 */
export const panelLibraryRequestSchema = z.strictObject({
  version: z.string().min(1).max(64),
});
export type PanelLibraryRequest = z.infer<typeof panelLibraryRequestSchema>;

/**
 * The answer: every file of the frame realm's library this computer's build
 * made, with the pin its import map must carry, but the app's own panels,
 * which a phone does not draw from it. Null when this computer's version is not
 * the one asked for, or it has no library to serve.
 */
export const panelLibrarySchema = z
  .strictObject({
    version: z.string().min(1).max(64),
    files: z.array(
      z.strictObject({
        /** The file's forward-slashed path under `app-frame://lib/`. */
        path: z.string().min(1).max(512),
        /** Its `sha256-<base64>` pin, as a frame's import map carries it. */
        integrity: z.string().regex(/^sha256-[A-Za-z0-9+/]+=*$/),
        /** Its bytes, base64. */
        data: z.string(),
      }),
    ),
  })
  .nullable();
export type PanelLibrary = z.infer<typeof panelLibrarySchema>;

/** What a window says in place of a panel it cannot draw from the first mate's files. */
export const PANEL_FILES_WORDS = {
  otherVersion:
    "This panel shows once Infinitary here and on the computer where your first mate lives are on the same version.",
} as const;
