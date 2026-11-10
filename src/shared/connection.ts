import { z } from "zod";
import {
  automaticStartupSchema,
  deviceChipSchema,
  deviceKindSchema,
  deviceNameSchema,
  deviceRoleSchema,
  deviceSystemSchema,
  deviceUserNameSchema,
  dialAddressSchema,
  foundToolsSchema,
  KEY_TEXT_PATTERN,
} from "./devices";

export type { FoundTools } from "./devices";

import type { ContractAccess } from "./contractFeatures";

/**
 * The connection's wire (docs/connection.md): what a paired device and the
 * home say to each other over one WebSocket. The requests and pushes it
 * carries are the contract's own (`src/shared/ipc.ts`); this file adds only
 * the envelope around them - the handshake, a numbered push, and a request's
 * answer - so every client parses the same frames the home writes.
 *
 * A push is numbered at the connection: `epoch` names one run of the home's
 * journal and `seq` counts its pushes from 1. A client keeps the last pair it
 * saw as its cursor and hands it back on its next hello. The home answers
 * `replay` and sends exactly the pushes after it, or `reload` when it cannot
 * (another epoch, or older than the journal keeps), and the client then reads
 * its state again through ordinary requests.
 *
 * Requests go both ways with the same two frames: a device asks the home
 * with `invoke` and gets one `result`, and the home asks a computer that
 * runs work the same way (src/shared/work.ts).
 *
 * Before any of that, a device uses its link once at `PAIR_PATH`
 * (docs/devices.md); every byte rides TLS pinned to the home's key.
 *
 * Both sides read a frame leniently: a field this version does not know is
 * ignored, so adding an optional one is a minor change under the version
 * rule (docs/contract.md), never a closed connection. Every shape here is
 * published in docs/contract.json beside the contract's own.
 */

/** Where a paired device dials the home for its WebSocket. */
export const CONNECTION_PATH = "/connection";

/** Where a device uses its link, once, to join (docs/devices.md, "Joining"). */
export const PAIR_PATH = "/pair";

/** The largest body `/pair` reads. */
export const PAIR_BODY_MAX_BYTES = 4 * 1024;

/**
 * Where a command run on another Mac gets Firstmate from its home, with the
 * link the command carries (docs/devices.md, "Getting Firstmate from this
 * Mac"): `POST` with `{ "code" }`, answered with this app as a gzipped tar
 * of its one bundle. The code must be open and made for a computer that runs
 * work; reading it never spends it, so only `/pair` joins. A computer that
 * runs work already on the home's list, updated by its home, sends `{}`: the
 * key it shows in TLS proves it (docs/devices.md, "Updating over the
 * connection"). That path and body never change across majors, so a
 * computer on any version from `WORK_UPDATE_SINCE` on gets the home's
 * Firstmate. A refusal is `/pair`'s, with the same statuses, or 404 `none`
 * from a home that cannot send itself.
 */
export const FETCH_APP_PATH = "/firstmate";

/** What a command, or a computer being updated, sends to `FETCH_APP_PATH`. */
export const fetchAppRequestSchema = z.strictObject({
  /** The code of the link a command carries; absent from a computer already on the list. */
  code: z.string().regex(KEY_TEXT_PATTERN).optional(),
  /**
   * The system and chip the asking computer runs (docs/devices.md, "Firstmate
   * for another system"), from protocol `FETCH_APP_SYSTEM_SINCE` on: the home
   * answers the Firstmate published for them at its own version, or its own
   * when it is that system's. A computer that names neither gets the home's
   * own, as before; one that names a system the home cannot send is `none`.
   */
  system: deviceSystemSchema.optional(),
  chip: deviceChipSchema.optional(),
  /**
   * Asks for the Ubuntu package for that system and chip rather than its
   * AppImage (`major-15.md`): the command for another computer
   * asks it on Ubuntu 24.04 and 26.04 with no Infinitary installed, and
   * installs it there (docs/devices.md, "Joining by a command"). Only this
   * home's own command asks it, so no older home is ever asked it.
   */
  package: z.literal("deb").optional(),
  /**
   * Asks only whether the code is still open, and sends nothing (from
   * protocol 8.15): the home answers 204, or the same refusal. A command
   * asks it before it downloads Firstmate from its published release
   * (docs/devices.md, "Joining by a command"), and only this home's own
   * command does, so no older home is ever asked it.
   */
  check: z.literal(true).optional(),
});
export type FetchAppRequest = z.infer<typeof fetchAppRequestSchema>;

/**
 * How `FETCH_APP_PATH` answers, by its `Content-Type`: a gzipped tar of a
 * Mac's one app bundle (`application/gzip`), as it always has; a Mac's
 * published zip from a home that is not a Mac (`application/zip`); or a
 * Linux AppImage itself (`application/octet-stream`).
 */
export const FETCH_APP_TYPES = {
  bundle: "application/gzip",
  zip: "application/zip",
  appImage: "application/octet-stream",
} as const;

/**
 * The header `FETCH_APP_PATH` answers a published build with: its SHA-256 in
 * hex, which root checks the Ubuntu package against before it installs it
 * (docs/devices.md, "Joining by a command").
 */
export const FETCH_APP_SHA256_HEADER = "x-infinitary-sha256";

/**
 * What a device sends to `/pair`: the link's code, the kind it is, its own
 * label, and - for a computer that runs work, which must say it - the macOS
 * user it runs as, by its short name and its number (docs/helper.md), and
 * what it found there. The home keeps the name; the number only tells it
 * whether a device on this Mac runs as the home's own user. `again`: a
 * device already on the list finds its home where the link says it is now,
 * showing the key it was paired with (docs/devices.md, "Finding the home
 * again").
 */
export const pairRequestSchema = z.strictObject({
  code: z.string().regex(KEY_TEXT_PATTERN),
  kind: deviceKindSchema,
  name: deviceNameSchema,
  user: z
    .strictObject({
      name: deviceUserNameSchema,
      uid: z.number().int().nonnegative(),
    })
    .optional(),
  found: foundToolsSchema.optional(),
  again: z.literal(true).optional(),
  /**
   * The app joining at its own first launch, with its window, rather than
   * its work mode (docs/view.md, "Joining"): from this Mac itself it joins
   * as a second app that only controls, never as work run as anyone here.
   */
  window: z.literal(true).optional(),
  /**
   * The system the device runs (docs/devices.md, "What a device is").
   * A phone (`ios`) joins as a `view` whichever link it used, so it is never
   * a computer that runs work (docs/devices.md, "Joining").
   */
  system: deviceSystemSchema.optional(),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

/**
 * The home's answer to a link used well: who the device now is on its list.
 * The device proves itself afterwards with the key it showed in TLS, so the
 * answer carries no secret.
 */
export const pairGrantSchema = z.strictObject({
  deviceId: z.string().min(1).max(64),
  kind: deviceKindSchema,
});
export type PairGrant = z.infer<typeof pairGrantSchema>;

/**
 * Why `/pair` refused, with the status each answers as. Only a link used
 * well is spent: every refusal leaves it as it was. `same-user`: a computer
 * that runs work dialed from this Mac as the macOS user the home itself runs
 * as, which would give its work the captain's own files (docs/helper.md).
 * `removed`: a device finding its home again showed a key the list no
 * longer holds, because the home removed it while it was out of reach.
 */
export const PAIR_REFUSAL_STATUS = {
  malformed: 400,
  unknown: 401,
  unproven: 401,
  kind: 409,
  paired: 409,
  "same-user": 409,
  used: 410,
  expired: 410,
  removed: 410,
} as const;
export type PairRefusal = keyof typeof PAIR_REFUSAL_STATUS;

export const pairRefusalSchema = z.strictObject({
  refused: z.enum([
    "malformed",
    "unknown",
    "unproven",
    "kind",
    "paired",
    "same-user",
    "used",
    "expired",
    "removed",
  ]),
  reason: z.string(),
});

/**
 * Why `FETCH_APP_PATH` refused, with the status each answers as: `/pair`'s
 * refusals of a link, and `none` from a home that cannot send itself - one
 * run from a checkout rather than an installed app. Every refusal is
 * `{ "refused", "reason" }`.
 */
export const FETCH_APP_REFUSAL_STATUS = {
  malformed: 400,
  unknown: 401,
  kind: 409,
  used: 410,
  expired: 410,
  none: 404,
} as const;
export type FetchAppRefusal = keyof typeof FETCH_APP_REFUSAL_STATUS;

export const fetchAppRefusalSchema = z.strictObject({
  refused: z.enum(["malformed", "unknown", "kind", "used", "expired", "none"]),
  reason: z.string(),
});

/** The port a paired device dials, on loopback and on the chosen address alike. */
export const CONNECTION_PORT = 47_623;

/**
 * The largest frame either side accepts. Sized to the largest request the
 * contract admits - a turn with its images and pasted files at their caps -
 * with room to spare.
 */
export const CONNECTION_MAX_FRAME_BYTES = 64 * 1024 * 1024;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** A place in the numbered pushes: the journal's run and the last push seen. */
export const connectionCursorSchema = z.strictObject({
  epoch: z.string().min(1).max(64),
  seq: z.number().int().nonnegative(),
});
export type ConnectionCursor = z.infer<typeof connectionCursorSchema>;

/**
 * The spellings of channel names a side reads (`@shared/codeNames`; the
 * Infinitary rename, docs/connection.md "Two spellings"): `fm` for
 * `inf:cards`, `inf` for `inf:cards`. Each side writes a name in its own
 * spelling when the other reads it, and in `fm` otherwise; a side that says
 * nothing reads only `fm`. Open strings, so a later spelling still parses.
 */
const spellingsSchema = z.array(z.string().min(1).max(32)).max(16).optional();

/**
 * The name of each minor contract change a side has, one per file in
 * `src/shared/contract-changes/` but the major's
 * (`src/core/connection/contractChanges.ts`, docs/contract.md "Changes by
 * name"). A feature that needs the other side to have a change waits for its
 * name here; a side that says nothing has none. Open strings, as spellings
 * are; a major removes every name, so the list stays short.
 */
const changesSchema = z.array(z.string().min(1).max(64)).max(256).optional();

const requestIdSchema = z.union([z.number().int().nonnegative(), z.string().min(1).max(64)]);

/** A request, either way: the device asks the home, and the home asks a computer that runs work. */
const invokeFrameSchema = z.object({
  t: z.literal("invoke"),
  id: requestIdSchema,
  channel: z.string().min(1).max(128),
  args: z.unknown(),
});

/**
 * A request's arguments as an `invoke` frame carries them. JSON writes an
 * empty (undefined) array item as null, and a contract's optional last
 * argument refuses null, so the empty ones at the end are left off, as the
 * window's own call leaves them off (INF-3153). An empty argument before a
 * given one still goes as null, which JSON has no other way to write, so
 * that request's contract reads null there as absent (INF-3159).
 */
export function invokeArgs(args: unknown): unknown {
  if (!Array.isArray(args)) return args;
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return end === args.length ? args : args.slice(0, end);
}

/** One answer per request id, either way: the answer, or why there is none. */
const resultFrameSchemas = [
  z.object({
    t: z.literal("result"),
    id: requestIdSchema,
    ok: z.literal(true),
    value: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("result"),
    id: requestIdSchema,
    ok: z.literal(false),
    error: z.string(),
  }),
] as const;

/**
 * What a device sends: one hello first, then any number of requests, and
 * `leave` when its person leaves this home: the home takes the device off
 * its list and closes it as `unpaired` (docs/devices.md, "Leave"). A
 * computer that runs work also answers what the home asks it, with one
 * `result` per request id (src/shared/work.ts).
 */
export const clientFrameSchema = z.union([
  z.discriminatedUnion("t", [
    z.object({
      t: z.literal("hello"),
      /** The contract version the device speaks (`PROTOCOL_VERSION`); the version rule reads its major. */
      protocolVersion: versionSchema,
      /**
       * The version of Firstmate the device runs, the app's own, which the
       * home says in Settings -> Devices when it is not its own
       * (docs/devices.md, "Another version"). Absent from a device too old
       * to say it.
       */
      appVersion: z.string().min(1).max(64).optional(),
      /** The last push it saw on an earlier connection; absent on a first one. */
      cursor: connectionCursorSchema.optional(),
      /**
       * A computer's join dials once only to hear the home's name
       * (docs/helper.md, "Joining"): the home welcomes it, and counts
       * nothing of it as that computer in reach, so Devices can tell a
       * computer whose work never reached the home since it joined.
       */
      nameOnly: z.literal(true).optional(),
      automaticStartup: automaticStartupSchema.optional(),
      /**
       * What this connection of the device does (docs/connection.md,
       * "Hello"): `view`, Firstmate open there controlling this one, or
       * `work`, its work. A Mac that does both says it on each; absent, a
       * device does what its kind does, and a Mac its work.
       */
      as: deviceRoleSchema.optional(),
      /**
       * For a view: the oldest home major it can still change things on, its
       * own build's `VIEW_FLOOR` (docs/contract.md, "The version rule"), so a
       * newer view keeps changing things on an older home. Absent from a
       * view too old to say it, which changes things on its own major and
       * newer only; a computer that runs work never says it.
       */
      viewFloor: z.number().int().nonnegative().optional(),
      /**
       * The system the device runs and its chip (docs/devices.md, "What a
       * device is"), which the home keeps beside its kind. Absent from a
       * device too old to say them, or on a system it has no word for.
       */
      system: deviceSystemSchema.optional(),
      chip: deviceChipSchema.optional(),
      spellings: spellingsSchema,
      changes: changesSchema,
    }),
    invokeFrameSchema,
    z.object({ t: z.literal("leave") }),
  ]),
  ...resultFrameSchemas,
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

/**
 * What the home sends. Pushes after a `replay` welcome are the missed ones,
 * in order. Only a computer that runs work is asked anything (`invoke`),
 * and only once its welcome said it takes work.
 */
export const homeFrameSchema = z.union([
  z.object({
    t: z.literal("welcome"),
    protocolVersion: versionSchema,
    /** The journal's run and its newest push; the cursor a device starts from. */
    epoch: z.string().min(1).max(64),
    seq: z.number().int().nonnegative(),
    catchUp: z.enum(["replay", "reload"]),
    /**
     * What the version rule lets this device ask, from the version its hello
     * spoke and, for a view, the floor it said: everything, or the reads
     * alone (`contractAccess`).
     */
    access: z.enum(["full", "read"]) satisfies z.ZodType<ContractAccess>,
    /**
     * The home Mac's own name, such as its computer name, which a view says
     * it controls. Absent when the home could not read it.
     */
    name: deviceNameSchema.optional(),
    /** Authenticated routing alternatives; absent on an older home. */
    addresses: z.array(dialAddressSchema).optional(),
    /**
     * For a computer that runs work alone: whether its version may take new
     * work from this home, which needs the same major (`takesWork`,
     * docs/helper.md). Absent for a view.
     */
    takesWork: z.boolean().optional(),
    /**
     * For a computer that runs work: whether it runs on the home's own Mac,
     * as the home found where it joined from (`onThisMac` on its list), which
     * decides the priority its work runs at (docs/helper.md, "In the
     * background"). Absent for a view, and while the home's list does not
     * say (protocol 9.1).
     */
    onHomeMac: z.boolean().optional(),
    /**
     * For a view: the first mate was started by a command, with no window,
     * so a view asks everything its window would but what stays there
     * (`RUN_HOME_ONLY_CHANNELS`, docs/run.md "Control from another
     * computer"). Absent otherwise, and from an older home.
     */
    startedByCommand: z.literal(true).optional(),
    spellings: spellingsSchema,
    changes: changesSchema,
  }),
  z.object({
    t: z.literal("push"),
    seq: z.number().int().positive(),
    channel: z.string(),
    payload: z.unknown(),
  }),
  /**
   * To a device whose hello listed `frame-parts`: the next frame, longer
   * than one piece, comes as whole text messages after this one, each a
   * piece of its JSON text, whose UTF-8 bytes add up to `bytes`
   * (docs/connection.md, "Pacing and liveness").
   */
  z.object({
    t: z.literal("parts"),
    bytes: z.number().int().positive().max(CONNECTION_MAX_FRAME_BYTES),
  }),
  ...resultFrameSchemas,
  invokeFrameSchema,
]);
export type HomeFrame = z.infer<typeof homeFrameSchema>;

/**
 * Why the home closed a connection, as WebSocket close codes in the range
 * reserved for applications. A device that broke the protocol gets
 * `protocol`; one whose pairing went gets `unpaired`; a client too slow to
 * take its pushes gets `behind` and comes back with its cursor.
 */
export const CONNECTION_CLOSE = {
  protocol: 4400,
  unpaired: 4401,
  behind: 4408,
  closing: 1001,
} as const;
