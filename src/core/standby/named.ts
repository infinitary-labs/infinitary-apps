import { standbyAddressesSchema, standbyHelloSchema } from "@shared/standby";
import { z } from "zod";

/**
 * The computers the captain named to keep a copy, kept in the record so a
 * move carries them and every copy holds the list (docs/devices.md,
 * "Keeping a copy on another computer"). The home writes it
 * (`./stream.ts`); a copy reads its own copy of it to find the others
 * (`./peers.ts`).
 */
export const STANDBYS_FILE = "devices/standbys.json";

export const standbysSchema = z.object({
  version: z.literal(1),
  standbys: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(64),
        /** When its copy is from, as last known here. */
        copyAt: z.number().int().nonnegative().nullable(),
        /**
         * Where it listens for the other copies, as its last hello said
         * (`standby-peers`): kept in the record, so each copy dials the others.
         */
        listens: standbyHelloSchema.shape.listens,
        /**
         * Where a first mate there would answer, as its hello last said
         * (`standby-take-over`): every device is told them, so it finds that
         * computer once it took over.
         */
        addresses: standbyAddressesSchema.optional(),
      }),
    )
    .max(64),
  /** Computers no longer named whose copy is still to be dropped there. */
  dropping: z.array(z.string().min(1).max(64)).max(64),
});
export type Standbys = z.infer<typeof standbysSchema>;
