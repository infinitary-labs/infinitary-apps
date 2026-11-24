import {
  endHolder,
  type FolderHolder,
  findFolderHolders,
  type HoldersReading,
} from "@core/placed/folderHolders";
import type { ProgramOutcome } from "@shared/leftoverPrograms";

/**
 * How long a program left in the data folder after the tasks closed may take
 * to end by itself before a reset ends it.
 */
export const LEFTOVER_WAIT_MS = 15_000;
const LOOK_MS = 1_000;

export type LeftoverSeams = {
  /** The programs holding the folder, never this app or anything it started. */
  find: (folder: string) => Promise<HoldersReading>;
  end: (holder: FolderHolder) => Promise<ProgramOutcome>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
};

export const LEFTOVER_SEAMS: LeftoverSeams = {
  find: (folder) => findFolderHolders([folder]),
  end: (holder) => endHolder(holder),
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
};

/**
 * Ends every program of this account still holding a file or working folder
 * in the data folder once the first mate stopped (docs/reset.md, "Before it
 * quits"): a server a task started that outlived its close, or a terminal
 * the person opened in a task's working copy. Each gets the wait to end by itself, then
 * an end request and a kill. Left running, one holding a file would stop
 * Windows from renaming the folder at the next start. True once none is
 * left; a system whose programs cannot be read answers false.
 */
export async function endLeftoverPrograms(
  dataDir: string,
  seams: LeftoverSeams = LEFTOVER_SEAMS,
): Promise<boolean> {
  const until = seams.now() + LEFTOVER_WAIT_MS;
  for (;;) {
    const reading = await seams.find(dataDir);
    if (reading.status !== "checked") return false;
    if (reading.holders.length === 0) return true;
    if (seams.now() >= until) {
      const outcomes = await Promise.all(reading.holders.map((holder) => seams.end(holder)));
      return outcomes.every((outcome) => outcome.outcome !== "survived");
    }
    await seams.wait(LOOK_MS);
  }
}
