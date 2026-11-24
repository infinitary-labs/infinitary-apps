import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { KEY_TEXT_PATTERN } from "@shared/devices";
import { remoteLoginAddressSchema } from "@shared/remoteLogin";
import { z } from "zod";
import { hostKeySchema } from "../devices/hostTrust";

/**
 * The removal record (docs/reset.md, "Computers out of reach"): a file beside
 * the data folder, never in it, so it outlives the wipe. It names each paired
 * computer the reset could not tell it was removed, and keeps the old first
 * mate's key, which the fresh first mate shows only to answer such a
 * computer's dial with a removal. This module is its one writer: the reset
 * writes it, the fresh first mate drops each computer once it is removed and
 * the whole file once none is left or its time is up.
 */
export const RESET_REMOVALS_SUFFIX = ".reset-removals.json";

/** How long a reset's computers wait to hear they were removed, and its key is kept. */
export const RESET_REMOVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** The most resets one record holds: one more drops the oldest's computers. */
const RESETS_KEPT = 8;

export const resetRemovalComputerSchema = z.strictObject({
  id: z.string().min(1).max(64),
  /** How the old first mate's list named it, for the feed. */
  name: z.string().min(1).max(160),
  /** The pin of its own key, which its dial shows. */
  keyPin: z.string().regex(KEY_TEXT_PATTERN),
  /**
   * Refusals in a row its dials met, and when the last was: two are what it
   * reads as removed, and a computer that read it dials no more.
   */
  told: z.number().int().min(0).max(1_000_000),
  toldAt: z.number().int().nonnegative().optional(),
  /** Where the old first mate reached it over Remote Login, with the host key the captain checked. */
  ssh: z
    .strictObject({
      address: remoteLoginAddressSchema,
      hostKey: hostKeySchema.optional(),
    })
    .optional(),
});
export type ResetRemovalComputer = z.infer<typeof resetRemovalComputerSchema>;

export const resetRemovalSchema = z.strictObject({
  /** When the person confirmed the reset, in milliseconds since the epoch. */
  at: z.number().int().nonnegative(),
  /** The old first mate's key and certificate, PEM, and its pin. */
  home: z.strictObject({
    key: z.string().min(1).max(16_384),
    cert: z.string().min(1).max(16_384),
    pin: z.string().regex(KEY_TEXT_PATTERN),
  }),
  computers: z.array(resetRemovalComputerSchema).min(1).max(256),
});
export type ResetRemoval = z.infer<typeof resetRemovalSchema>;

export const resetRemovalsFileSchema = z.strictObject({
  version: z.literal(1),
  resets: z.array(resetRemovalSchema).max(RESETS_KEPT),
});

export function resetRemovalsPath(dataDir: string): string {
  return join(dirname(dataDir), `${basename(dataDir)}${RESET_REMOVALS_SUFFIX}`);
}

/**
 * The resets still waiting: none when there is no file. A file that cannot be
 * read or parsed holds none either, and is deleted, so a key it might hold
 * never outlives what reads it.
 */
export function readResetRemovals(dataDir: string): ResetRemoval[] {
  const path = resetRemovalsPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = resetRemovalsFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.resets;
  } catch {}
  rmSync(path, { force: true });
  return [];
}

/**
 * Writes the record whole or not at all, readable by this account alone, or
 * deletes it, with the keys it held, once no reset in it waits.
 */
export function writeResetRemovals(dataDir: string, resets: readonly ResetRemoval[]): void {
  const path = resetRemovalsPath(dataDir);
  const waiting = resets.filter((reset) => reset.computers.length > 0);
  if (waiting.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(
    pending,
    `${JSON.stringify(resetRemovalsFileSchema.parse({ version: 1, resets: waiting }))}\n`,
    { mode: 0o600 },
  );
  renameSync(pending, path);
}

/** `earlier` with `reset` added last, in place of one under the same key, keeping the newest few. */
export function withResetRemoval(
  earlier: readonly ResetRemoval[],
  reset: ResetRemoval,
): ResetRemoval[] {
  return [...earlier.filter((each) => each.home.pin !== reset.home.pin), reset].slice(-RESETS_KEPT);
}
