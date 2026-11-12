import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandEnding, CommandNotice } from "@shared/commandNotice";
import { z } from "zod";
import type { RunStatus } from "./runStatus";

/**
 * When Infinitary started by a command stops under the window opened
 * beside it (docs/run.md, "When the command stops"; the captain's answer
 * on INF-3660's plan, restart=wait-for-entry: "Wait for the start entry
 * when one is in place, then offer it; offer it at once when none will
 * restart the run"). The window never starts a first mate of its own
 * while the command it joined is alive, and never by itself: it reads the
 * command's own records and which start entry is in place, waits for the
 * entry where one will start the command again, and offers Start it here
 * where none will, or none did in time.
 */

/** The command a window joined, as its note in the data folder names it. */
export type JoinedRun = { pid: number; startedAt: string };

/** The start entry the app wrote that is in place now, by the system that reads it; null for none. */
export type StartEntry = "linux-unit" | "mac-daemon" | null;

/** How a command that no longer runs ended, and with which code when it said. */
export type CommandEnd = {
  ending: CommandEnding;
  exitCode: number | null;
  /** Which command ended, as its note or its record names it. */
  of: JoinedRun | null;
  /** When its own record says it stopped; null for an end that left none. */
  at: number | null;
};

/**
 * The start entry's own wait before it starts the command again: the
 * unit's `RestartSec=10` and launchd's ten seconds between starts of one
 * job (`bootUnit`, `bootPlist`, src/core/helper/background.ts).
 */
export const START_ENTRY_RESTART_MS = 10_000;

/** How long a window waits for its first welcome before it draws anyway (`LocalWindow.ready`). */
export const JOIN_WAIT_MS = 10_000;

/**
 * How long a start entry gets to start the command again before Start it
 * here is offered: its own restart wait, then the time a window allows a
 * command to welcome it.
 */
export function entryWaitMs(restartMs = START_ENTRY_RESTART_MS, joinMs = JOIN_WAIT_MS): number {
  return restartMs + joinMs;
}

/**
 * How the command ended, or null while one runs or none ever did. The
 * command records why it stopped only on a clean stop, so a record that
 * names another command than the one the window joined means the joined
 * one left none: it crashed.
 */
export function runEnd(
  status: Pick<RunStatus, "running" | "lastStop">,
  joined: JoinedRun | null,
): CommandEnd | null {
  // Unreadable is never a stopped report.
  if (status.running !== false) return null;
  const crashed = (of: JoinedRun): CommandEnd => ({
    ending: "crashed",
    exitCode: null,
    of,
    at: null,
  });
  const stop = status.lastStop;
  if (!stop) return joined ? crashed(joined) : null;
  if (joined && !sameRun(stop, joined)) return crashed(joined);
  const of = { pid: stop.pid, startedAt: stop.startedAt };
  if (stop.reason === "unrecorded") return crashed(of);
  const at = Date.parse(stop.stoppedAt);
  return { ending: stop.reason, exitCode: stop.exitCode, of, at: Number.isNaN(at) ? null : at };
}

function sameRun(a: JoinedRun, b: JoinedRun): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Whether the start entry in place starts the command again after this
 * end. The Linux unit restarts on a failure and never after code 78, a
 * settings file to fix; the Mac's entry restarts every failed exit, 78
 * included. Neither restarts a clean stop.
 */
export function entryRestarts(entry: StartEntry, end: CommandEnd): boolean {
  if (!entry) return false;
  if (end.ending === "crashed" || end.exitCode === null) return true;
  if (end.exitCode === 0) return false;
  return !(entry === "linux-unit" && end.exitCode === 78);
}

/**
 * What the window shows over itself now, or null while a command runs.
 * `goneFor` is how long the window has seen no command running, and
 * `waitMs` how long an entry gets: its own restart wait plus the time a
 * window allows to join.
 */
export function commandNotice(input: {
  end: CommandEnd | null;
  entry: StartEntry;
  goneFor: number;
  waitMs: number;
}): CommandNotice | null {
  const { end } = input;
  if (!end) return null;
  const waits = entryRestarts(input.entry, end) && input.goneFor < input.waitMs;
  return { state: waits ? "waiting" : "stopped", ending: end.ending };
}

/**
 * Whether a window opened now opens between two commands: none runs, and
 * the start entry in place is still expected to start one again after how
 * the last one ended. Such a window joins the command to come, under its
 * notice, and starts no first mate of its own. An entry that had its time
 * since the recorded stop will not start it, and an end the person already
 * answered with Start it here is not waited for again: the app opens as
 * this computer's own first mate, as it does with no entry in place.
 */
export function betweenStops(
  status: Pick<RunStatus, "running" | "lastStop">,
  entry: StartEntry,
  at: { now: number; waitMs: number; startedHere: JoinedRun | null },
): boolean {
  const end = runEnd(status, null);
  if (!end || !entryRestarts(entry, end)) return false;
  if (end.of && at.startedHere && sameRun(end.of, at.startedHere)) return false;
  return end.at === null || at.now - end.at < at.waitMs;
}

/** The argument Start it here starts the app again with: its own first mate, whatever entry is in place. */
export const START_HERE_ARG = "--start-here";

/** The file in the data folder that names the ended command a person answered with Start it here. */
export const STARTED_HERE = "run-started-here.json";

const startedHereSchema = z.strictObject({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

/**
 * Remembers which ended command the person answered with Start it here, so
 * a later launch never waits under the notice for that same end again. A
 * folder that cannot take the note only waits once more.
 */
export function noteStartedHere(
  dataDir: string,
  status: Pick<RunStatus, "running" | "lastStop">,
): void {
  const of = runEnd(status, null)?.of;
  if (!of) return;
  try {
    writeFileSync(join(dataDir, STARTED_HERE), `${JSON.stringify(of)}\n`, { mode: 0o600 });
  } catch {
    // The next launch waits for the entry once more, then offers it again.
  }
}

/** The ended command the person last answered with Start it here, or null. */
export function startedHere(dataDir: string): JoinedRun | null {
  try {
    const parsed = startedHereSchema.safeParse(
      JSON.parse(readFileSync(join(dataDir, STARTED_HERE), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
