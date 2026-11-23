import {
  automaticStartupSchema,
  deviceChipSchema,
  deviceSystemSchema,
  deviceViewSchema,
  KEY_TEXT_PATTERN,
} from "@shared/devices";
import { remoteLoginAddressSchema } from "@shared/remoteLogin";
import { z } from "zod";

/**
 * The files `DevicePairing` keeps in `userData/devices/` (docs/devices.md):
 * their names and the shapes it reads and writes them in. `DevicePairing`
 * stays the one writer; this file only says what the records are.
 */

/** Which takeover made this home, in its record (`TAKE_OVER_RECORD`, src/core/standby/takeOver.ts). */
export const TAKE_OVER_FILE = "take-over.json";
export const takeOverIdSchema = z.object({ id: z.string().uuid() });

/**
 * The way back of a home whose record is copied (docs/devices.md, "An old
 * home that returns"): a Mac on its own list whose id the record names
 * (`returning.json`, copied with it), and whose key only this home keeps
 * (`returning-key.json`, never copied), so a computer that takes over from
 * a copy already lets the old home in when it returns.
 */
export const RETURNING_FILE = "returning.json";
/** Its file name in the devices folder; `WAY_BACK_KEY` in the record's terms (src/core/homeMove/record.ts). */
export const RETURNING_KEY_FILE = "returning-key.json";
export const returningKeySchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1).max(64),
  key: z.string().min(1),
  cert: z.string().min(1),
});
export type ReturningIdentity = { deviceId: string; key: string; cert: string };
export const returningIdSchema = z.object({ deviceId: z.string().min(1).max(64) });

export const LIST_FILE = "devices.json";
export const LIST_VERSION = 1;
/**
 * When each device was last in reach, and the computers that run work the
 * captain chose to remove once they are back (docs/devices.md, "Remove"):
 * files of their own beside the list, so a list an older app reads is
 * still the list it knows.
 */
export const SEEN_FILE = "seen.json";
export const seenFileSchema = z.strictObject({
  version: z.literal(1),
  seen: z.record(z.string(), z.number().int().nonnegative()),
});
/**
 * The version of Firstmate that did not start on each computer that runs
 * work, which went back to the copy it kept (docs/helper.md, "A copy that
 * does not start"): never sent there again.
 */
export const FAILED_UPDATES_FILE = "failed-updates.json";
export const failedUpdatesFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), z.string().min(1).max(64)),
});
/** Computers the captain let run this Mac's source, asked once each (docs/devices.md). */
export const SOURCE_ALLOWED_FILE = "source-builds.json";
export const sourceAllowedFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.array(z.string().min(1).max(64)),
});
export const WHEN_BACK_FILE = "removing.json";
export const whenBackFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.array(z.string().min(1).max(64)),
});
/**
 * A computer removed while out of reach has not heard it was removed
 * (docs/devices.md, "Remove"): its key's pin is kept, so the home listens for
 * it and refuses it, which it reads as removed, and then removes what
 * Firstmate set up there. Kept until it has been refused `FAREWELL_TELLS`
 * times - a device needs two refusals in a row - or for `FAREWELL_MS`.
 */
export const FAREWELL_FILE = "removed.json";
export const farewellFileSchema = z.strictObject({
  version: z.literal(1),
  removed: z.array(
    z.strictObject({
      keyPin: z.string().regex(KEY_TEXT_PATTERN),
      at: z.number().int().nonnegative(),
      told: z.number().int().nonnegative(),
    }),
  ),
});
/**
 * How this Mac reaches each computer it set up over Remote Login
 * (docs/devices.md, "Kept with the device"): the address it was added at,
 * which the home updates Firstmate at and removes what it set up there
 * through, and its connection - `ssh` when that computer reaches this Mac
 * only through this Mac's own SSH connection to the address, `network` when
 * it dials this Mac's network address itself.
 */
export const SSH_FILE = "ssh.json";
export const PACKAGE_UPDATE_ADDRESSES = "package-update-addresses.json";
export const packageUpdateAddressesSchema = z.record(z.string(), remoteLoginAddressSchema);
export const sshConnectionSchema = z.enum(["ssh", "network"]);
export const sshRecordSchema = z.strictObject({
  address: remoteLoginAddressSchema,
  connection: sshConnectionSchema,
});
export type SshRecord = z.infer<typeof sshRecordSchema>;
/**
 * A computer this Mac removed while what Firstmate set up there could not be
 * removed over SSH yet (docs/devices.md, "Removing it there"): bound to the
 * removed computer's id, never an active connection, and tried again until
 * thirty days after `at`. `name` is how the list named it, for the words.
 */
export const sshCleanupSchema = z.strictObject({
  address: remoteLoginAddressSchema,
  name: z.string().min(1).max(160),
  at: z.number().int().nonnegative(),
});
export type SshCleanup = z.infer<typeof sshCleanupSchema> & { deviceId: string };
export const sshFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), sshRecordSchema),
  cleanups: z.record(z.string(), sshCleanupSchema).optional(),
});
/**
 * Where each device last reached this Mac: the address and port it dialed,
 * as its connection's socket says (docs/devices.md, "Finding the home
 * again"), so Devices can say when this Mac's address changed since.
 */
export const REACHED_FILE = "reached.json";
export const reachedFileSchema = z.strictObject({
  version: z.literal(1),
  reached: z.record(z.string(), z.string().min(1).max(64)),
});
/**
 * What each device said it is in its hello (docs/devices.md, "What a device
 * is"): its system and chip, kept beside the list in a file of their own, so
 * a list an older app reads is still the list it knows.
 */
export const SYSTEMS_FILE = "systems.json";
export const systemRecordSchema = z.strictObject({
  automaticStartup: automaticStartupSchema.optional(),
  system: deviceSystemSchema.optional(),
  chip: deviceChipSchema.optional(),
});
export type SystemRecord = z.infer<typeof systemRecordSchema>;
export const systemsFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), systemRecordSchema),
});

// What the list keeps of a device: never what the home reads of it live.
export const entrySchema = deviceViewSchema
  .pick({ id: true, kind: true, name: true, pairedAt: true, user: true, onThisMac: true })
  .extend({ keyPin: z.string().regex(KEY_TEXT_PATTERN) });
export type Entry = z.infer<typeof entrySchema>;
export const listSchema = z.strictObject({
  version: z.literal(LIST_VERSION),
  devices: z.array(entrySchema),
});
