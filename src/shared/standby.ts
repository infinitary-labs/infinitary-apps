import { z } from "zod";
import { deviceNameSchema, dialAddressSchema, PAIRING_LINK_ALSO_MAX } from "./devices";
import { homeMoveGapSchema, homeMoveManifestSchema, recordPathSchema } from "./homeMove";
import { phoneStandbysSchema } from "./standbyPhone";
import { PLACED_COPY_CHUNK_BYTES } from "./work";

/**
 * Keeping a copy of the first mate's record on other computers
 * (docs/devices.md, "Keeping a copy on another computer"): the captain names
 * any number of computers that run work to keep a copy. Each takes one full
 * copy, then every change right after the home saves it, in one numbered
 * stream; the home never waits for one. A computer that keeps a copy holds
 * it in its work folder and never opens it as a first mate.
 *
 * The contract change that carries it is `standby-copy`
 * (`src/shared/contract-changes/standby-copy.md`): the orders below, asked
 * only of a computer whose hello lists it.
 */

/** The contract change's name (`src/shared/contract-changes/standby-copy.md`). */
export const STANDBY_CHANGE = "standby-copy";

/**
 * The contract change that lets a copy take over as the home
 * (`src/shared/contract-changes/standby-take-over.md`, docs/devices.md
 * "Taking over"): the hello's `addresses`, the `inf:standby:home` order, the
 * welcome's `standbys` and `takeOver`, and the `inf:home:goodbye` frame.
 */
export const STANDBY_TAKE_OVER_CHANGE = "standby-take-over";

/** Where a first mate on one computer would answer: its own addresses, at most as many as a link names. */
export const standbyAddressesSchema = z.array(dialAddressSchema).max(PAIRING_LINK_ALSO_MAX + 1);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One piece of a blob as base64: a copy chunk, the largest an order carries. */
const PIECE_DATA_CHARS = Math.ceil(PLACED_COPY_CHUNK_BYTES / 3) * 4;

/**
 * One stream of changes: a home starts a new one each time it starts, and a
 * copy whose stream is not the home's current one takes a full copy.
 */
export const streamIdSchema = z.string().uuid();

/** Where a computer's copy is: the rest of what taking over needs is the Ready list's (`inf:home:ready`). */
export const standbyHelloSchema = z.object({
  /** The stream its copy follows and the last change it holds; null with no copy. */
  stream: streamIdSchema.nullable(),
  seq: z.number().int().nonnegative(),
  /** When the home saved the last change the copy holds; null with no copy. */
  at: z.number().int().nonnegative().nullable(),
  /**
   * Where it listens for the other copies (`standby-peers`,
   * `./standbyPeers.ts`): the home keeps it in the record, so every copy
   * learns where each other one is. Absent from a computer from before.
   */
  listens: z
    .array(dialAddressSchema)
    .max(PAIRING_LINK_ALSO_MAX + 1)
    .optional(),
  /**
   * Where a first mate on this computer would answer, should it take over
   * (`standby-take-over`); absent from a computer from before.
   */
  addresses: standbyAddressesSchema.optional(),
});
export type StandbyHello = z.infer<typeof standbyHelloSchema>;

/**
 * One change of the stream as it crosses. `pages` is a committed change of
 * a database, written at each page's place and cut to its size; `file` is a
 * file's whole content, inline or sent before as a blob by its hash;
 * `append` adds to the end of a file that only grew; `gone` removes one.
 */
export const standbyChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pages"),
    seq: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    path: recordPathSchema,
    pageSize: z.number().int().min(512).max(65536),
    dbPages: z.number().int().positive(),
    /** Each page's number and its whole image, inline, or in the blob `blob` names. */
    pages: z.array(z.object({ pgno: z.number().int().positive(), data: z.string() })).optional(),
    blob: sha256Schema.optional(),
  }),
  z.object({
    kind: z.literal("file"),
    seq: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    path: recordPathSchema,
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
    /** The content inline; absent when it crossed before as the blob `sha256` names. */
    data: z.string().optional(),
  }),
  z.object({
    kind: z.literal("append"),
    seq: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    path: recordPathSchema,
    /** The size the copy's file has before this change; any other size refuses it. */
    offset: z.number().int().nonnegative(),
    data: z.string(),
  }),
  z.object({
    kind: z.literal("gone"),
    seq: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    path: recordPathSchema,
  }),
]);
export type StandbyChange = z.infer<typeof standbyChangeSchema>;

export const standbyFileSchema = z.object({
  path: recordPathSchema,
  size: z.number().int().nonnegative(),
  sha256: sha256Schema,
});
export type StandbyFile = z.infer<typeof standbyFileSchema>;

/** How many files one `inf:standby:lacks` or `inf:standby:full` order names at most. */
export const STANDBY_FILES_PER_ORDER = 4096;

export const STANDBY_HELLO_ORDER = "inf:standby:hello";
export const STANDBY_PIECE_ORDER = "inf:standby:piece";
export const STANDBY_LACKS_ORDER = "inf:standby:lacks";
export const STANDBY_FULL_ORDER = "inf:standby:full";
export const STANDBY_APPLY_ORDER = "inf:standby:apply";
export const STANDBY_DROP_ORDER = "inf:standby:drop";
export const STANDBY_LOCK_ORDER = "inf:standby:lock";

/**
 * Secrets kept sealed on a computer that keeps a copy (docs/devices.md,
 * "Secrets on a computer that keeps a copy"): the contract change's name
 * (`src/shared/contract-changes/standby-secrets.md`). A home asks
 * `inf:standby:lock` only of a computer whose hello lists it.
 */
export const STANDBY_SECRETS_CHANGE = "standby-secrets";

/**
 * Where a computer's lock for the first mate's secrets stands, for one ask of
 * the home's: `asking` while its own system confirmation waits for the
 * captain, `kept` once confirmed with its lock's public key, `refused` when
 * the confirmation was cancelled or failed, `unavailable` where that computer
 * keeps no lock (no keychain, or no way to confirm the person there), and
 * `none` for an ask it does not know, as after a restart.
 */
export const standbyLockSchema = z.object({
  state: z.enum(["none", "asking", "kept", "refused", "unavailable"]),
  /** The lock's public half (X25519, SPKI DER as base64), only with `kept`. */
  key: z.string().min(1).max(200).nullable(),
});
export type StandbyLock = z.infer<typeof standbyLockSchema>;
export const STANDBY_HOME_ORDER = "inf:standby:home";

/**
 * One copy as the home last saw it, which a computer taking over shows
 * beside its own (docs/devices.md, "The offer"): where it stood, when its
 * copy is from, and the last change of the home's stream it held.
 */
export const standbyHeardSchema = z.object({
  deviceId: z.string().min(1).max(64),
  name: deviceNameSchema,
  state: z.enum(["copying", "in-sync", "catching-up", "away", "needs-update"]),
  copyAt: z.number().int().nonnegative().nullable(),
  seq: z.number().int().nonnegative().nullable(),
});
export type StandbyHeard = z.infer<typeof standbyHeardSchema>;

/**
 * What taking over needs that the record itself does not hold
 * (`inf:standby:home`): the home's name and folders, which the record's
 * saved paths name, each project and where it lives, the sign-ins the new
 * home asks for again, the home's number, every copy as the home sees it,
 * and the device the old home becomes once it is back.
 */
export const standbyHomeSchema = z.object({
  name: homeMoveManifestSchema.shape.name,
  from: homeMoveManifestSchema.shape.from,
  /** Each project folder and its remotes; taking over clones each one again from where it lives. */
  projects: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        path: z.string().min(1).max(4096),
        remotes: z
          .array(z.object({ name: z.string().min(1).max(200), url: z.string().min(1).max(4096) }))
          .max(32),
      }),
    )
    .max(512),
  signIns: homeMoveManifestSchema.shape.signIns,
  homeNumber: z.number().int().positive(),
  /** The stream this was told on and its last change then. */
  stream: streamIdSchema,
  seq: z.number().int().nonnegative(),
  /** When the home told it. */
  at: z.number().int().nonnegative(),
  copies: z.array(standbyHeardSchema).max(64),
});
export type StandbyHome = z.infer<typeof standbyHomeSchema>;

/** The orders a home asks a computer that keeps a copy (`standby-copy`). */
export const standbyOrders = {
  [STANDBY_HELLO_ORDER]: {
    effect: "read",
    request: z.tuple([]),
    response: standbyHelloSchema,
  },
  /**
   * One piece of a blob, kept by its hash until a full copy or a change
   * names it. A piece asked again is written again at its offset, so a drop
   * repeats it safely; `complete` once the whole blob is there and matches.
   */
  [STANDBY_PIECE_ORDER]: {
    effect: "change",
    request: z.tuple([
      z.object({
        sha256: sha256Schema,
        size: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        data: z.string().max(PIECE_DATA_CHARS),
      }),
    ]),
    response: z.object({ complete: z.boolean() }),
  },
  /** Which of these files the copy lacks, by their place in the list. */
  [STANDBY_LACKS_ORDER]: {
    effect: "read",
    request: z.tuple([
      z.object({ files: z.array(standbyFileSchema).max(STANDBY_FILES_PER_ORDER) }),
    ]),
    response: z.object({ lacks: z.array(z.number().int().nonnegative()) }),
  },
  /**
   * A full copy, its files named over one or more orders: `part` counts
   * them from 0, and the one with `last` puts the whole copy in place at
   * once, as of change `seq` of `stream`. Each file comes from a blob sent
   * before, or from the copy already there when its hash matches.
   */
  [STANDBY_FULL_ORDER]: {
    effect: "change",
    request: z.tuple([
      z.object({
        stream: streamIdSchema,
        seq: z.number().int().nonnegative(),
        at: z.number().int().nonnegative(),
        part: z.number().int().nonnegative(),
        last: z.boolean(),
        files: z.array(standbyFileSchema).max(STANDBY_FILES_PER_ORDER),
      }),
    ]),
    response: z.object({ ok: z.boolean() }),
  },
  /**
   * Changes in order, after the copy's `from` and through `through`: applied
   * whole, so a copy is always as of one change. A change read again with
   * the same content is not sent, so `through` may be past the last one. A copy on another stream, or at another place,
   * answers `ok` false with where it is, and the home sends from there or a
   * full copy.
   */
  [STANDBY_APPLY_ORDER]: {
    effect: "change",
    request: z.tuple([
      z.object({
        stream: streamIdSchema,
        from: z.number().int().nonnegative(),
        /** The change the copy is at once these are applied, which may be past the last one sent. */
        through: z.number().int().positive(),
        /** When the home saved change `through`. */
        at: z.number().int().nonnegative(),
        changes: z.array(standbyChangeSchema).max(STANDBY_FILES_PER_ORDER),
      }),
    ]),
    response: z.object({
      ok: z.boolean(),
      stream: streamIdSchema.nullable(),
      seq: z.number().int().nonnegative(),
    }),
  },
  /**
   * The home's ask for this computer's lock on the first mate's secrets
   * (`standby-secrets`): `ask` true starts this computer's own system
   * confirmation for `request`, once, and answers at once; false reads how
   * that ask stands. Only a confirmed ask answers the lock's public half.
   */
  [STANDBY_LOCK_ORDER]: {
    effect: "change",
    request: z.tuple([z.object({ request: z.string().uuid(), ask: z.boolean() })]),
    response: standbyLockSchema,
  },
  /** The captain stopped keeping a copy there: the copy goes. */
  [STANDBY_DROP_ORDER]: {
    effect: "change",
    request: z.tuple([]),
    response: z.object({ dropped: z.boolean() }),
  },
  /**
   * What taking over needs beside the record (`standby-take-over`), kept
   * with the copy and replaced whole each time; asked only of a computer
   * whose hello lists the change.
   */
  [STANDBY_HOME_ORDER]: {
    effect: "change",
    request: z.tuple([standbyHomeSchema]),
    response: z.object({ ok: z.boolean() }),
  },
} as const;
export type StandbyOrderChannel = keyof typeof standbyOrders;
export const STANDBY_ORDER_CHANNELS = Object.keys(standbyOrders) as StandbyOrderChannel[];
export function isStandbyOrderChannel(channel: string): channel is StandbyOrderChannel {
  return Object.hasOwn(standbyOrders, channel);
}

/**
 * Where one computer's copy stands, as Settings, Devices shows it:
 * `copying` a full copy (bytes done of total), `in-sync`, `catching-up`
 * with how many changes it lacks, `away` with when its copy is from, or
 * `needs-update` when its version cannot keep a copy.
 */
export const standbyViewSchema = z.object({
  deviceId: z.string().min(1).max(64),
  state: z.enum(["copying", "in-sync", "catching-up", "away", "needs-update"]),
  behind: z.number().int().nonnegative().optional(),
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  /** When the copy is from: the last moment it held every change it has. */
  copyAt: z.number().int().nonnegative().nullable(),
  /**
   * The first mate's secrets there: `kept` sealed to its own lock, `asking`
   * while it waits for the captain to confirm there, `none` otherwise.
   * Absent from a home from before (`standby-secrets`).
   */
  secrets: z.enum(["none", "asking", "kept"]).optional(),
});
export type StandbyView = z.infer<typeof standbyViewSchema>;

export const standbyViewsSchema = z.object({
  standbys: z.array(standbyViewSchema).max(64),
  /**
   * Another home answers with this home's number (docs/devices.md, "Two
   * homes with one number"): acts that cannot be undone wait until the
   * captain keeps one. A home from before never says it.
   */
  twoHomes: z
    .object({ deviceId: z.string().min(1).max(64), name: z.string().min(1).max(160) })
    .optional(),
});
export type StandbyViews = z.infer<typeof standbyViewsSchema>;

/**
 * A home a window heard beside the one it follows, with the same number and
 * another takeover (docs/devices.md, "Two homes with one number"): its name,
 * number, takeover and where it answered. The window tells each home of the
 * other (`inf:standby:other-home`), so both wait and ask even when they
 * cannot reach each other.
 */
export const otherHomeSchema = z.strictObject({
  name: z.string().max(160).nullable(),
  homeNumber: z.number().int().positive(),
  takeOver: z.string().uuid().nullable(),
  addresses: z
    .array(dialAddressSchema)
    .min(1)
    .max(1 + PAIRING_LINK_ALSO_MAX),
});
export type OtherHome = z.infer<typeof otherHomeSchema>;

/** The Ready to take over list for one computer that keeps a copy. */
export const standbyReadySchema = z.object({
  deviceId: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  gaps: z.array(homeMoveGapSchema).max(64),
  /**
   * The sign-ins this first mate uses that the computer has none of its own
   * for, each one the home's window can start there: a provider's in
   * Settings, Subscriptions, a host's where projects live in Settings,
   * Integrations. Absent from a home from before (`standby-secrets`).
   */
  missing: z
    .object({
      providers: z
        .array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(64) }))
        .max(32),
      forges: z
        .array(z.object({ host: z.string().min(1).max(200), name: z.string().min(1).max(64) }))
        .max(16),
    })
    .optional(),
});
export type StandbyReady = z.infer<typeof standbyReadySchema>;

/**
 * Which takeover made a home (`devices/take-over.json` in its record, and
 * `takeOver` in every welcome): two homes with one number and another
 * takeover are two first mates, which stop and ask (docs/devices.md,
 * "Taking over").
 */
export const standbyTakeOverSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  at: z.number().int().nonnegative(),
  homeNumber: z.number().int().positive(),
  /** The computer that took over, by its id on the list and its name. */
  deviceId: z.string().min(1).max(64),
  name: deviceNameSchema,
  /** The stream and change its copy was at. */
  stream: streamIdSchema,
  seq: z.number().int().nonnegative(),
});
export type StandbyTakeOver = z.infer<typeof standbyTakeOverSchema>;

/**
 * The window's ask to take over, written in the work folder for the work
 * running there (`TAKE_OVER_ASK`), after the captain confirmed it with
 * Touch ID or the password.
 */
export const takeOverAskSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  at: z.number().int().nonnegative(),
});
export type TakeOverAsk = z.infer<typeof takeOverAskSchema>;

/** How the work running there answered it (`TAKE_OVER_ANSWER`). */
export const takeOverAnswerSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  state: z.enum(["running", "started", "refused"]),
  text: z.string().min(1).max(600),
});
export type TakeOverAnswer = z.infer<typeof takeOverAnswerSchema>;

/**
 * The live frame a home sends every device before its computer sleeps
 * (`standby-take-over`), so Take over says the home said goodbye; a device
 * from before ignores it.
 */
export const HOME_GOODBYE_LIVE = "inf:home:goodbye";

/**
 * The live frame a home sends every device when where its copies would
 * answer changes (`standby-take-over`): the same addresses a welcome lists,
 * so a device connected before a copy was kept dials it when the home is out
 * of reach. A device from before ignores it.
 */
export const HOME_ROUTES_LIVE = "inf:home:routes";

export const homeRoutesSchema = z.object({
  addresses: z.array(dialAddressSchema),
  /** Each computer that keeps a copy, told to a phone (`standby-phone`); a device from before ignores it. */
  standbys: phoneStandbysSchema.optional(),
});
export type HomeRoutes = z.infer<typeof homeRoutesSchema>;
