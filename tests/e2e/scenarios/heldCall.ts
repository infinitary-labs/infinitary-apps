import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../mockProvider";

/** A crewmate the spawn titles with this makes one call that keeps running until the journey lets it go. */
export const HELD_CALL_MARKER = "Read the build log";

/**
 * The pipe the held call reads, made in `dir`: opening it to read waits until
 * the journey opens its other end (`releaseHeldCall`).
 */
export function heldCallPipe(dir: string): string {
  const pipe = join(dir, "held-call");
  execFileSync("mkfifo", [pipe]);
  return pipe;
}

/**
 * A crewmate's call that is still running, as a slow read of a disk or a
 * network share is: it reads a named pipe, whose open waits until the
 * journey lets it go. A command would not do, since one that runs past the
 * bash tool's few seconds goes on as a background job and the turn ends.
 * An update of this computer waits for such a call before it replaces the
 * copy (docs/alpha.md, "Saving work before an update").
 */
export function heldCall(pipe: string): Scenario {
  return () =>
    ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
      if (isFirstmate || !wantsStream || hasToolResults) return undefined;
      if (!latestUserTail.includes(HELD_CALL_MARKER)) return undefined;
      return { calls: [{ name: "read", args: { path: pipe } }] };
    };
}

/**
 * Lets the held call go once its read waits on the pipe, and says whether it
 * did; poll it until it does. Until the read waits, opening the pipe's writing
 * end without waiting fails with ENXIO. Once it waits, that open lets the read
 * go and the journey closes the end unwritten. Pi's read tool first reads the
 * file from a fixed place, which a pipe refuses, so it fails and closes the
 * pipe at once, and a read that went on would find the pipe's end. Words
 * written after the open would race that close and could fail with EPIPE.
 */
export function releaseHeldCall(pipe: string): boolean {
  try {
    closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENXIO") return false;
    throw error;
  }
}
