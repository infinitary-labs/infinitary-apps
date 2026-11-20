import { z } from "zod";
import { deviceNameSchema, dialAddressSchema, PAIRING_LINK_ALSO_MAX } from "./devices";
import { PLACED_COPY_CHUNK_BYTES } from "./work";

/**
 * Moving the first mate to another computer (docs/devices.md, "Moving the
 * first mate"): the captain's one click in Settings, Devices moves the live
 * home, its whole record, to a paired computer that runs work. The old home
 * stops acting, the record crosses, the new home starts with the next home
 * number, and every device follows it.
 *
 * The contract change that carries it is `home-move`
 * (`src/shared/contract-changes/home-move.md`): the welcome's `homeNumber`,
 * the `inf:home:moved` live frame, and the orders below.
 */

/** The contract change's name (`src/shared/contract-changes/home-move.md`). */
export const HOME_MOVE_CHANGE = "home-move";

/**
 * The live frame a home sends every device as its move finishes: where the
 * new home answers, its number, and which device on the list it is. A device
 * keeps the addresses and the number, then dials there; one that does not
 * know the frame ignores it and finds the new home by its announcement.
 */
export const HOME_MOVED_LIVE = "inf:home:moved";

/**
 * The captain's Start my first mate here again, which the move's hold lets
 * through: the hold refuses every other change while the first mate moves
 * (docs/devices.md, "A destination that never answers").
 */
export const HOME_MOVE_START_HERE = "inf:home-move:start-here";

export const homeMovedSchema = z.object({
  homeNumber: z.number().int().min(2),
  addresses: z
    .array(dialAddressSchema)
    .min(1)
    .max(PAIRING_LINK_ALSO_MAX + 1),
  /** The device the home moved to, as the list names it: its own window follows by starting over. */
  to: z.string().min(1).max(64),
  name: deviceNameSchema.optional(),
});
export type HomeMoved = z.infer<typeof homeMovedSchema>;

/** A move's own id: one folder on the destination, and every order of it. */
export const homeMoveIdSchema = z.string().uuid();

/** A file's place in the record, relative to the data folder, written with `/`. */
export const recordPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    { message: "a path inside the record" },
  );

/** One file of the record as the move sends it. */
export const recordFileSchema = z.object({
  path: recordPathSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RecordFile = z.infer<typeof recordFileSchema>;

/**
 * What the move sends beside the record files, in its manifest: each project
 * folder outside the data folder, as a bundle of every branch and the
 * remotes it had, cloned again on the destination.
 */
export const movedProjectSchema = z.object({
  id: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  /** The bundle's place among the move's files; absent for a folder that is not a repository. */
  bundle: recordPathSchema.optional(),
  remotes: z
    .array(z.object({ name: z.string().min(1).max(200), url: z.string().min(1).max(4096) }))
    .max(32),
});
export type MovedProject = z.infer<typeof movedProjectSchema>;

/** The manifest, the move's last file: everything that must be on the destination, and nothing else. */
export const homeMoveManifestSchema = z.object({
  version: z.literal(1),
  files: z.array(recordFileSchema),
  projects: z.array(movedProjectSchema),
  /** The old home's data folder and home folder, which the record's saved paths name. */
  from: z.object({ userData: z.string().min(1).max(4096), homeDir: z.string().min(1).max(4096) }),
  /** The old home's own name, which the new one says it came from. */
  name: z.string().min(1).max(160),
  /**
   * The old home's sign-ins, by name only: nothing of them crosses, and the
   * new home asks the captain for each (docs/devices.md, "What stays").
   */
  signIns: z
    .object({
      providers: z
        .array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(64) }))
        .max(64),
      forges: z
        .array(z.object({ host: z.string().min(1).max(253), name: z.string().min(1).max(64) }))
        .max(64),
    })
    .optional(),
});
export type HomeMoveManifest = z.infer<typeof homeMoveManifestSchema>;

/** The manifest's own place among the move's files. */
export const HOME_MOVE_MANIFEST = "home-move-manifest.json";

/** What the destination says of itself before a move (`inf:home:ready`). */
export const homeMoveFactsSchema = z.object({
  /** The Infinitary version it runs, for the Ready list to compare. */
  appVersion: z.string().min(1).max(64).nullable(),
  /** Free space where its data folder is, in bytes; null when unread. */
  freeBytes: z.number().int().nonnegative().nullable(),
  /** Where its first mate would answer once the home moves there. */
  addresses: z.array(dialAddressSchema).max(PAIRING_LINK_ALSO_MAX + 1),
  /** Its data folder holds a first mate's record of its own, which a move sets aside. */
  ownRecord: z.boolean(),
  /** A first mate runs there now, in its window or a command. */
  firstMateRunning: z.boolean(),
  /** It can start a first mate in the background, with no window open. */
  background: z.boolean(),
});
export type HomeMoveFacts = z.infer<typeof homeMoveFactsSchema>;

export const HOME_READY_ORDER = "inf:home:ready";
export const HOME_RECEIVE_ORDER = "inf:home:receive";
export const HOME_ARRIVE_ORDER = "inf:home:arrive";
export const HOME_ABANDON_ORDER = "inf:home:abandon";

/** The orders a home asks the computer it moves to (`home-move`). */
export const homeMoveOrders = {
  [HOME_READY_ORDER]: {
    effect: "read",
    request: z.tuple([]),
    response: homeMoveFactsSchema,
  },
  /**
   * One piece of one file, kept in the move's folder on the destination. A
   * piece asked again is written again at its offset, so a drop repeats it
   * safely; `complete` once the whole file is there and matches its hash.
   */
  [HOME_RECEIVE_ORDER]: {
    effect: "change",
    request: z.tuple([
      z.object({
        move: homeMoveIdSchema,
        path: recordPathSchema,
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        offset: z.number().int().nonnegative(),
        data: z.string().max(Math.ceil(PLACED_COPY_CHUNK_BYTES / 3) * 4),
      }),
    ]),
    response: z.object({ complete: z.boolean() }),
  },
  /**
   * The move's commit: the destination checks every file the manifest names,
   * puts the record in place as its own with the next home number, and
   * starts its first mate. Asked again after it answered, it answers the same.
   */
  [HOME_ARRIVE_ORDER]: {
    effect: "change",
    request: z.tuple([
      z.object({
        move: homeMoveIdSchema,
        homeNumber: z.number().int().min(2),
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    ]),
    response: z.object({
      addresses: z
        .array(dialAddressSchema)
        .min(1)
        .max(PAIRING_LINK_ALSO_MAX + 1),
      started: z.boolean(),
    }),
  },
  /**
   * A move that did not finish: its folder on the destination goes. While its
   * arrive still runs it is refused, and a half-finished arrive is undone first.
   */
  [HOME_ABANDON_ORDER]: {
    effect: "change",
    request: z.tuple([z.object({ move: homeMoveIdSchema })]),
    /**
     * `dropped` once nothing of the move is in place there: false while its
     * arrive still runs, or once it arrived, so the old home never starts its
     * first mate again beside the new one.
     */
    response: z.object({ dropped: z.boolean() }),
  },
} as const;
export type HomeMoveOrderChannel = keyof typeof homeMoveOrders;
export const HOME_MOVE_ORDER_CHANNELS = Object.keys(homeMoveOrders) as HomeMoveOrderChannel[];
export function isHomeMoveOrderChannel(channel: string): channel is HomeMoveOrderChannel {
  return Object.hasOwn(homeMoveOrders, channel);
}

/**
 * One line of the Ready list (docs/devices.md, "The Ready list"): a gap on
 * the destination the captain should know before the click. `blocks` keeps
 * the move from starting; `notes` says what will differ after it.
 */
export const homeMoveGapSchema = z.object({
  id: z.string().min(1).max(64),
  level: z.enum(["blocks", "notes"]),
  text: z.string().min(1).max(600),
});
export type HomeMoveGap = z.infer<typeof homeMoveGapSchema>;

export const homeMoveReadySchema = z.object({
  deviceId: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  gaps: z.array(homeMoveGapSchema).max(64),
});
export type HomeMoveReady = z.infer<typeof homeMoveReadySchema>;

/** Where a move stands, pushed whole at each change (`inf:home-move:progress`). */
export const homeMoveProgressSchema = z.object({
  deviceId: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  stage: z.enum(["tasks", "copying", "stopping", "arriving", "moved", "failed", "cancelled"]),
  /** Bytes or tasks done of the stage's total, when it counts any. */
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  text: z.string().min(1).max(600),
  /**
   * The destination stayed out of reach so long that the captain may start
   * the first mate here again (docs/devices.md, "A destination that never answers").
   */
  startHere: z.literal(true).optional(),
});
export type HomeMoveProgress = z.infer<typeof homeMoveProgressSchema>;
