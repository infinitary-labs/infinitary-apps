import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writePrivate } from "./identity";

/**
 * The home number (docs/devices.md, "Moving the first mate"): which home of
 * the same record this is. A home that never moved is number 1; each move
 * starts the new home at the next number, and a device that heard a number
 * never again takes a home with a lower one, so a first mate left behind on
 * the old computer, even one that still shows the same key, is never
 * reached again.
 *
 * The home keeps its own in `devices/home-number.json`, written by the move
 * on the computer it arrives on, and says it in every welcome; a device
 * keeps the highest it heard in the same file in its own folder.
 */
export const HOME_NUMBER_FILE = "home-number.json";

/** The number of a home that never moved, and of one whose welcome says none. */
export const FIRST_HOME_NUMBER = 1;

export const homeNumberSchema = z
  .number()
  .int()
  .min(FIRST_HOME_NUMBER)
  .max(Number.MAX_SAFE_INTEGER);

const fileSchema = z.strictObject({
  version: z.literal(1),
  number: homeNumberSchema,
});

/** The number kept in `dir`; the first when none is kept or it cannot be read. */
export function readHomeNumber(dir: string): number {
  const path = join(dir, HOME_NUMBER_FILE);
  if (!existsSync(path)) return FIRST_HOME_NUMBER;
  try {
    return fileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).number;
  } catch {
    return FIRST_HOME_NUMBER;
  }
}

/** Keeps `number` in `dir`, 0600 in a 0700 folder. */
export function writeHomeNumber(dir: string, number: number): void {
  homeNumberSchema.parse(number);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(join(dir, HOME_NUMBER_FILE), `${JSON.stringify({ version: 1, number }, null, 2)}\n`);
}
