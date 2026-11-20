import { z } from "zod";
import { recordPathSchema } from "./homeMove";
import { STANDBY_TAKE_OVER_CHANGE, streamIdSchema } from "./standby";

/**
 * Copies that reach each other (docs/devices.md, "Copies that reach each
 * other"): every computer that keeps a copy of the first mate's record
 * listens on its own key for the other copies, and dials them at the
 * addresses each told the home, which the record carries. Two copies keep
 * one link, opened by whichever side can dial, that asks both ways and
 * stays up while the home is out of reach.
 *
 * The contract change that carries it is `standby-peers`
 * (`src/shared/contract-changes/standby-peers.md`): the hello's `listens`,
 * the home's order below, and the link between two copies.
 */

/** The contract change's name (`src/shared/contract-changes/standby-peers.md`). */
export const STANDBY_PEERS_CHANGE = "standby-peers";

/**
 * The port a copy asks for first to listen for the other copies; when it is
 * taken, as by a second copy on the same computer, the system picks one.
 */
export const COPY_LINK_PORT = 47_624;

/** The path a copy's dial upgrades on. */
export const COPY_LINK_PATH = "/copies";

/** The largest frame the link takes: an answer is a few facts, never a file. */
export const COPY_LINK_FRAME_BYTES = 64 * 1024;

const orderIdSchema = z.number().int().nonnegative();

/**
 * One frame on the link, as JSON text. Each side says `hello` first, with
 * the contract changes it has; the link is in reach once it heard the other
 * side's. Then either side may `ask` an order, answered by its `id`.
 */
export const copyLinkFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), changes: z.array(z.string().min(1).max(64)).max(256) }),
  z.object({
    t: z.literal("ask"),
    id: orderIdSchema,
    channel: z.string().min(1).max(64),
    args: z.array(z.unknown()).max(8),
  }),
  z.object({ t: z.literal("answer"), id: orderIdSchema, value: z.unknown() }),
  z.object({ t: z.literal("refused"), id: orderIdSchema, error: z.string().max(600) }),
]);
export type CopyLinkFrame = z.infer<typeof copyLinkFrameSchema>;

export const COPY_WHERE_ORDER = "inf:copy:where";
export const COPY_FILES_ORDER = "inf:copy:files";
export const COPY_PIECE_ORDER = "inf:copy:piece";

/** The orders that bring in a newer copy, which a copy offers when its link hello lists this change. */
export const COPY_GATHER_CHANGE = STANDBY_TAKE_OVER_CHANGE;

/** How many files one page of `inf:copy:files` names: each line is under 1,200 characters, within a frame. */
export const COPY_FILES_PAGE = 40;

/** The most one `inf:copy:piece` carries: as base64, well within a frame. */
export const COPY_PIECE_BYTES = 36 * 1024;

/** The orders one copy asks another over their link. */
export const copyOrders = {
  /**
   * Where its copy stands, as `inf:standby:hello` says it, and the home
   * number it heard last (docs/devices.md, "Moving the first mate"), so a
   * computer about to take over can tell the newest copy and a home that
   * moved since.
   */
  [COPY_WHERE_ORDER]: {
    effect: "read",
    request: z.tuple([]),
    response: z.object({
      stream: streamIdSchema.nullable(),
      seq: z.number().int().nonnegative(),
      at: z.number().int().nonnegative().nullable(),
      homeNumber: z.number().int().nonnegative(),
    }),
  },
  /**
   * The files of its copy, a page at a time from `from`, each with its size
   * and SHA-256, and where the copy stood when they were read
   * (`standby-take-over`): a computer taking over brings in a newer copy
   * before it starts (docs/devices.md, "Bringing in a newer copy").
   */
  [COPY_FILES_ORDER]: {
    effect: "read",
    request: z.tuple([z.object({ from: z.number().int().nonnegative() })]),
    response: z.object({
      stream: streamIdSchema.nullable(),
      seq: z.number().int().nonnegative(),
      files: z
        .array(
          z.object({
            path: recordPathSchema,
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          }),
        )
        .max(COPY_FILES_PAGE),
      /** Where the next page starts; null after the last. */
      next: z.number().int().nonnegative().nullable(),
    }),
  },
  /** One piece of one file of its copy, as base64, from `offset` (`standby-take-over`). */
  [COPY_PIECE_ORDER]: {
    effect: "read",
    request: z.tuple([
      z.object({ path: recordPathSchema, offset: z.number().int().nonnegative() }),
    ]),
    response: z.object({ data: z.string().max(Math.ceil(COPY_PIECE_BYTES / 3) * 4) }),
  },
} as const;
export type CopyOrderChannel = keyof typeof copyOrders;
export const COPY_ORDER_CHANNELS = Object.keys(copyOrders) as CopyOrderChannel[];
export function isCopyOrderChannel(channel: string): channel is CopyOrderChannel {
  return Object.hasOwn(copyOrders, channel);
}

/**
 * Whether a copy reaches one other copy: `in-reach` over a link now;
 * `out-of-reach` with no link, though it knows where that copy listens;
 * `no-address` while its record says nothing of where that copy listens.
 */
export const copyPeerStateSchema = z.enum(["in-reach", "out-of-reach", "no-address"]);
export type CopyPeerState = z.infer<typeof copyPeerStateSchema>;

export const copyPeerSchema = z.object({
  deviceId: z.string().min(1).max(64),
  state: copyPeerStateSchema,
});
export type CopyPeer = z.infer<typeof copyPeerSchema>;

export const STANDBY_PEERS_ORDER = "inf:standby:peers";

/** What a home asks a computer that keeps a copy about the other copies (`standby-peers`). */
export const standbyPeersOrders = {
  /** Every other copy its record names, and whether it reaches each. */
  [STANDBY_PEERS_ORDER]: {
    effect: "read",
    request: z.tuple([]),
    response: z.object({ peers: z.array(copyPeerSchema).max(64) }),
  },
} as const;
export type StandbyPeersOrderChannel = keyof typeof standbyPeersOrders;
export const STANDBY_PEERS_ORDER_CHANNELS = Object.keys(
  standbyPeersOrders,
) as StandbyPeersOrderChannel[];
export function isStandbyPeersOrderChannel(channel: string): channel is StandbyPeersOrderChannel {
  return Object.hasOwn(standbyPeersOrders, channel);
}
