import { z } from "zod";

/**
 * Files for the captain on a card (docs/card-authoring.md, "Files for the
 * captain"): a crewmate names a file on its card, and the host keeps one
 * copy of it with the task's card copies on the computer the crewmate runs
 * on. The card holds only a reference - its name, size, sha256 and where the
 * kept copy is - never the bytes. The bytes move only when the captain
 * clicks Save, into Downloads on the computer whose window he clicked in.
 *
 * A file's id is SELF-LOCATING like a picture's: `<taskId>-<32 hex>`, the
 * hex the first half of its sha256, and its copy is `<id>.file` in the
 * task's `cards` folder on that computer.
 */

const CARD_FILE_ID = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})$/;

/**
 * The most of a file one save request carries (docs/view.md): a file
 * travels to the window in pieces, never whole in one message.
 */
export const CARD_FILE_PIECE_BYTES = 1024 * 1024;

/** A file's id on its card, from its task and its own sha256. */
export function cardFileId(taskId: string, sha256: string): string {
  return `${taskId}-${sha256.slice(0, 32)}`;
}

/** The task a file's id names, or undefined when it is not a file's id. */
export function cardFileTask(id: string): string | undefined {
  return CARD_FILE_ID.exec(id)?.[1];
}

/** The name the kept copy is stored under in its task's `cards` folder. */
export function cardFileStoredName(id: string): string {
  return `${id}.file`;
}

/**
 * One file on a card, as the card row keeps it: the reference, never the
 * bytes. `computer` names the computer that holds the kept copy by its
 * device id, absent when it is the computer where the first mate lives;
 * `path` is where the copy is there, which the home reads only for a copy
 * on another computer.
 */
export const cardFileSchema = z.strictObject({
  id: z.string().regex(CARD_FILE_ID),
  /** The file's own name, as the captain's Downloads gets it. */
  name: z.string().min(1).max(255),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1).max(4096),
  computer: z.string().min(1).max(128).optional(),
});
export type CardFile = z.infer<typeof cardFileSchema>;

/** One piece of a card file for a window saving it (`inf:cards:file`). */
export const cardFilePieceSchema = z.object({
  name: z.string(),
  /** The whole file's size and sha256, which the saving window checks. */
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.number().int().nonnegative(),
  /** The piece, base64; at most `CARD_FILE_PIECE_BYTES`. */
  data: z.string(),
});
export type CardFilePiece = z.infer<typeof cardFilePieceSchema>;

/** Where a saved file landed: its name in the window's computer's Downloads. */
export const cardFileSavedSchema = z.object({
  /** The name it has in Downloads, which differs from its own when that name held another file. */
  savedAs: z.string(),
  /** The full path on the computer that saved it, for showing it in the file browser. */
  path: z.string(),
});
export type CardFileSaved = z.infer<typeof cardFileSavedSchema>;

/**
 * Where Save all put a card's files: the new folder's name in the window's
 * computer's Downloads and its full path, how many files were saved, and
 * each file that was not, by its id with why.
 */
export const cardFilesSavedSchema = z.object({
  savedAs: z.string(),
  path: z.string(),
  saved: z.number().int().nonnegative(),
  failed: z.array(z.object({ id: z.string(), why: z.string() })),
});
export type CardFilesSaved = z.infer<typeof cardFilesSavedSchema>;

/** Only display names leave the window's host when it reads its local saved-file record. */
export const savedCardFilesSchema = z.object({
  files: z.array(z.object({ id: z.string(), savedAs: z.string(), folder: z.string().optional() })),
  batch: cardFilesSavedSchema.omit({ path: true }).nullable(),
});
export type SavedCardFiles = z.infer<typeof savedCardFilesSchema>;
export const openCardFileResultSchema = z.enum(["opened", "revealed", "missing", "failed"]);
export type OpenCardFileResult = z.infer<typeof openCardFileResultSchema>;
