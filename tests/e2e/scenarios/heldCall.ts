import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Scenario } from "../mockProvider";

/** A crewmate the spawn titles with this makes one call that keeps running until the journey lets it go. */
export const HELD_CALL_MARKER = "Read the build log";

/**
 * The pipe the held call reads, made in `dir`: reading it waits until the
 * journey writes something to it.
 */
export function heldCallPipe(dir: string): string {
  const pipe = join(dir, "held-call");
  execFileSync("mkfifo", [pipe]);
  return pipe;
}

/**
 * A crewmate's call that is still running, as a slow read of a disk or a
 * network share is: it reads a named pipe, which answers only once the
 * journey writes it. A command would not do, since one that runs past the
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
