import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostEnv } from "../hostEnv";
import { openWindowsProgram } from "../placed/windowsProcesses";
import { hostPlatform } from "../platform";
import { processAlive, STOPPED_RUN_WAIT_MS } from "./lock";
import type { RunInstance } from "./windowsTask";

const exec = promisify(execFile);

/**
 * One program, opened by its process number: when it was born, by this
 * computer's clock, and how to end it by force and read whether it has
 * ended. On Windows each is asked through the one handle the program was
 * opened with, so a program that took its number since is never read or
 * ended; on a Mac or Linux there is no such handle, so the program now
 * under that number is read again each time.
 */
export type ProgramInstance = {
  /** Its birth in milliseconds since the epoch; undefined where it cannot be read. */
  bornMs: number | undefined;
  end: () => void;
  ended: () => Promise<boolean>;
  close: () => void;
};

/** Opens the program running under a process number: null where none does. */
export type Programs = { open: (pid: number) => Promise<ProgramInstance | null> };

/** How long `endRunInstance` waits between readings of whether the program has ended. */
const ENDED_READ_MS = 100;

/**
 * What ending a run by force did: `ended` once the run's own program is
 * gone; `declined` where the program under its number is not the run, or
 * cannot be shown to be: one born after the run wrote its start took that
 * number since, and a birth that cannot be read proves nothing; `gone`
 * where no program runs under its number; `lasts` where the run's program
 * did not end in time.
 */
export type InstanceEnd = "ended" | "declined" | "gone" | "lasts";

/**
 * Ends `run`, by its process and the start it wrote of itself, by force.
 * A run is born before it writes its start, and a program can take its
 * number only once it has ended, after that start: so the program under
 * that number is the run only while it was born no later than that start.
 * Waits, for as long as a command waits for a stopped run to let its folder
 * go, until that program has ended.
 */
export async function endRunInstance(
  run: RunInstance,
  programs: Programs = systemPrograms(),
  waitMs: number = STOPPED_RUN_WAIT_MS,
): Promise<InstanceEnd> {
  const started = Date.parse(run.startedAt);
  const program = await programs.open(run.pid);
  if (!program) return "gone";
  try {
    if (program.bornMs === undefined || !(program.bornMs <= started)) return "declined";
    try {
      program.end();
    } catch {
      // Gone already, or not this account's to end: the wait below says which.
    }
    const until = Date.now() + waitMs;
    while (!(await program.ended())) {
      if (Date.now() >= until) return "lasts";
      await new Promise((resolve) => setTimeout(resolve, ENDED_READ_MS));
    }
    return "ended";
  } finally {
    program.close();
  }
}

/** This computer's own programs: Windows' handles, or `ps` and a signal on a Mac or Linux. */
export function systemPrograms(): Programs {
  if (hostPlatform() === "win32") return { open: async (pid) => openWindowsProgram(pid) };
  return { open: posixProgram };
}

/**
 * The birth of the program under `pid` on a Mac or Linux, from `ps`'s start
 * stamp: whole seconds, so it reads up to a second early. Null where no
 * program runs under it, undefined where it cannot be read.
 */
async function posixBirth(pid: number): Promise<number | null | undefined> {
  if (!processAlive(pid)) return null;
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
      env: hostEnv({ LC_ALL: "C" }),
      encoding: "utf8",
      timeout: 5_000,
    });
    const born = Date.parse(stdout.trim());
    return Number.isFinite(born) ? born : undefined;
  } catch {
    return processAlive(pid) ? undefined : null;
  }
}

async function posixProgram(pid: number): Promise<ProgramInstance | null> {
  const bornMs = await posixBirth(pid);
  if (bornMs === null) return null;
  return {
    bornMs,
    // No handle binds a signal to a program here: the signal goes to the number read just now.
    end: () => process.kill(pid, "SIGKILL"),
    // Ended once nothing runs under its number, or a program born at another time does.
    ended: async () => {
      const now = await posixBirth(pid);
      return now === null || (now !== undefined && now !== bornMs);
    },
    close: () => {},
  };
}
