import { askedResetMark, type ResetOutsideKind, writeResetMark } from "@core/reset/mark";
import type { ResetAnswer } from "@shared/reset";

/**
 * Reset Infinitary, once the person confirmed it in Settings → General
 * (docs/reset.md, "Before it quits"). The system confirms the person at
 * this computer; then the first mate undoes what its own
 * side set up elsewhere; this program clears what only it reaches; the mark
 * beside the folder asks the next start to wipe it; the first mate stops,
 * every program still holding a file or working folder in the folder ends,
 * and the app starts again. Nothing here deletes the folder, which this start
 * still holds: the next start does, before anything opens it.
 */
export type RunningResetSeams = {
  /**
   * The system's own confirmation of the person at this computer, after the
   * row's question; false changes nothing.
   */
  confirm: () => Promise<boolean>;
  /**
   * On a computer that controls another's first mate, asks that computer to
   * reset itself once the person here confirmed; false when it did not
   * answer, and nothing changes here either.
   */
  askHome?: () => Promise<boolean>;
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
  /** Ends every program of this account still holding a file or working folder in the folder (./leftovers.ts). */
  endLeftovers: () => Promise<unknown>;
  /** Starts the app again and quits this one. */
  restart: () => Promise<void> | void;
  /** Waits up to `ms` for `work`, then goes on. */
  within: <T>(work: Promise<T>, ms: number) => Promise<T | "timed-out">;
};

/** How long the first mate's undoing may take before the reset goes on without it. */
export const RESET_PREPARE_MS = 120_000;
/** How long the first mate may take to stop. */
export const RESET_STOP_MS = 30_000;
/** How long ending the leftover programs may take: their own wait, then an end request and a kill. */
export const RESET_LEFTOVERS_MS = 45_000;

export async function runReset(seams: RunningResetSeams): Promise<ResetAnswer> {
  if (!(await seams.confirm().catch(() => false))) return { outcome: "kept" };
  if (seams.askHome && !(await seams.askHome().catch(() => false))) return { outcome: "unreached" };
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
  await seams.within(seams.endLeftovers(), RESET_LEFTOVERS_MS).catch(() => undefined);
  await seams.restart();
  return { outcome: "restarting" };
}
