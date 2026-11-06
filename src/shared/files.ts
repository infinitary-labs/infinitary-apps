import { z } from "zod";

/**
 * Reading a file on another of the captain's computers (docs/files.md): the
 * command a crewmate runs, the orders the home asks a computer that runs
 * work for one of its files, and the answers they carry. It only reads:
 * nothing here writes onto another computer.
 */

/** The command in every crewmate's shell (docs/axi-commands.md, "The files command"). */
export const FILES_COMMAND = "infinitary-files-axi";

/** The contract change that brings it (`src/shared/contract-changes/files-there.md`). */
export const FILES_THERE = "files-there";

/** One piece of a file the home reads from another computer, as the other copies read theirs. */
export const FILE_PIECE_BYTES = 4 * 1024 * 1024;

/** A path on the computer that answers: absolute, or from that computer's home folder (`~`). */
const pathSchema = z.string().min(1).max(4096);

/** What one folder holds, by name, as `ls` prints it. */
export const fileListingSchema = z.object({
  /** The folder as that computer resolved it. */
  folder: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      /** `protected`: the app's own sign-ins and keys, which nothing copies. */
      kind: z.enum(["file", "folder", "link", "other", "protected"]),
      size: z.number().int().nonnegative().optional(),
      /** When it last changed, in ms since the epoch. */
      modified: z.number().optional(),
    }),
  ),
});
export type FileListing = z.infer<typeof fileListingSchema>;

/**
 * One file set aside to be read whole: a copy that stays as it was while
 * the home reads it, by the id it reads it with. `database` says the copy
 * came through the database's own backup.
 */
export const fileSnapshotSchema = z.object({
  id: z.string().uuid(),
  /** The file as that computer resolved it, links followed. */
  path: z.string(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  database: z.boolean().optional(),
});
export type FileSnapshot = z.infer<typeof fileSnapshotSchema>;

/**
 * The orders a home asks a computer that runs work for one of its files,
 * from `files-there` on: list a folder, set a file aside, read it piece by
 * piece, and let it go. Each answers live; a computer quitting lets go of
 * everything it set aside.
 */
export const fileOrders = {
  "inf:files:list": {
    effect: "read",
    request: z.tuple([z.object({ path: pathSchema })]),
    response: fileListingSchema,
  },
  "inf:files:snapshot": {
    effect: "change",
    request: z.tuple([z.object({ path: pathSchema })]),
    response: fileSnapshotSchema,
  },
  /** The copy set aside, from `offset`: at most `FILE_PIECE_BYTES`. */
  "inf:files:read": {
    effect: "read",
    request: z.tuple([z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative() })]),
    response: z.object({
      size: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      /** The bytes from `offset`, base64. */
      data: z.string(),
    }),
  },
  "inf:files:release": {
    effect: "change",
    request: z.tuple([z.object({ id: z.string().uuid() })]),
    response: z.object({ ok: z.literal(true) }),
  },
} as const satisfies Record<
  `inf:files:${string}`,
  { effect: "read" | "change"; request: z.ZodType; response: z.ZodType }
>;

export type FileOrderChannel = keyof typeof fileOrders;
export type FileOrderRequest<C extends FileOrderChannel> = z.infer<
  (typeof fileOrders)[C]["request"]
>;
export type FileOrderResponse<C extends FileOrderChannel> = z.infer<
  (typeof fileOrders)[C]["response"]
>;
export const FILE_ORDER_CHANNELS = Object.keys(fileOrders) as FileOrderChannel[];

export function isFileOrderChannel(channel: string): channel is FileOrderChannel {
  return Object.hasOwn(fileOrders, channel);
}

/** What the files command answers: rows, or a refusal's words, as the integrations answer. */
export const filesAnswerSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
  refused: z.enum(["refused", "invalid"]).optional(),
});
export type FilesAnswer = z.infer<typeof filesAnswerSchema>;

/**
 * What a crewmate on a computer that runs work asks its home through the
 * files command: the computers it may name, or one folder's listing
 * (`computer:folder`).
 */
export const filesReadInputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("computers") }),
  z.object({ op: z.literal("list"), target: z.string().min(1).max(4200) }),
]);
export type FilesReadInput = z.infer<typeof filesReadInputSchema>;
