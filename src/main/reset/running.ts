import { askedResetMark, type ResetOutsideKind, writeResetMark } from "@core/reset/mark";
import type { ResetAnswer } from "@shared/reset";

/**
 * Reset Infinitary, once the person confirmed it in Settings → General
 * (docs/reset.md, "Before it quits"). The first mate undoes what its own
 * side set up elsewhere; this program clears what only it reaches; the mark
 * beside the folder asks the next start to wipe it; the first mate stops and
 * the app starts again. Nothing here deletes the folder, which this start
 * still holds: the next start does, before anything opens it.
 */
export type RunningResetSeams = {
  /** The first mate's own undoing (`inf:app:reset-prepare`). */
  prepare: () => Promise<unknown>;
  /**
   * What this program clears outside the folder now, by kind: true once
   * nothing of it is left. An isolated run passes none.
   */
  clear?: Partial<Record<ResetOutsideKind, () => Promise<boolean>>>;
  /** Kinds the next start clears whatever happened now, once the old app no longer writes them. */
  atStart: readonly ResetOutsideKind[];
  /** Where the folder is, whose mark the next start finds beside it. */
  dataDir: string;
  /** Stops the first mate this window runs or opened beside, and lets go of what starts it. */
  stopFirstMate: () => Promise<unknown>;
  /** Starts the app again and quits this one. */
  restart: () => void;
  /** Waits up to `ms` for `work`, then goes on. */
  within: <T>(work: Promise<T>, ms: number) => Promise<T | "timed-out">;
};

/** How long the first mate's undoing may take before the reset goes on without it. */
export const RESET_PREPARE_MS = 120_000;
/** How long the first mate may take to stop. */
export const RESET_STOP_MS = 30_000;

export async function runReset(seams: RunningResetSeams): Promise<ResetAnswer> {
  await seams.within(seams.prepare(), RESET_PREPARE_MS).catch(() => undefined);
  const left = new Set<ResetOutsideKind>(seams.atStart);
  for (const [kind, clear] of Object.entries(seams.clear ?? {}) as [
    ResetOutsideKind,
    () => Promise<boolean>,
  ][]) {
    const cleared = await clear().catch(() => false);
    if (!cleared) left.add(kind);
  }
  // Written before the first mate stops: a stop that hangs or a crash after
  // it still leaves the next start to wipe the folder.
  writeResetMark(seams.dataDir, askedResetMark([...left]));
  await seams.within(seams.stopFirstMate(), RESET_STOP_MS).catch(() => undefined);
  seams.restart();
  return { outcome: "restarting" };
}
