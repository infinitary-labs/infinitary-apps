import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Window starts that did not get as far as starting Infinitary (docs/reset.md,
 * "Infinitary could not start"), counted in a file beside the data folder,
 * never in it: a folder Infinitary refuses to open is never written. A start
 * notes itself once it holds the folder's lock, and the count goes once the
 * first mate or the view started, or a window showed. A start that finds
 * earlier ones left `START_ATTEMPTS_SHOWN` or more shows the could-not-start
 * screen instead of starting again.
 */
export const START_ATTEMPTS_SUFFIX = ".start-attempts";
/** Earlier starts that did not get through, after which the screen shows. */
export const START_ATTEMPTS_SHOWN = 2;

export function startAttemptsPath(dataDir: string): string {
  return join(dirname(dataDir), `${basename(dataDir)}${START_ATTEMPTS_SUFFIX}`);
}

/** The earlier starts that did not get through; 0 when none, or when the file cannot be read. */
export function earlierStartAttempts(dataDir: string): number {
  try {
    const count = Number.parseInt(readFileSync(startAttemptsPath(dataDir), "utf8").trim(), 10);
    return Number.isFinite(count) && count > 0 ? Math.min(count, 1000) : 0;
  } catch {
    return 0;
  }
}

/** Notes this start, before anything it does could fail. */
export function noteStartAttempt(dataDir: string, earlier: number): void {
  try {
    writeFileSync(startAttemptsPath(dataDir), `${earlier + 1}\n`, { mode: 0o600 });
  } catch {
    // A folder's parent this account cannot write keeps no count, and never shows the screen.
  }
}

/** This start got through: the count goes. */
export function clearStartAttempts(dataDir: string): void {
  rmSync(startAttemptsPath(dataDir), { force: true });
}
