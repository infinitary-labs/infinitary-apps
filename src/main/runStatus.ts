import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAlive } from "@core/helper/runAgent";
import type { z } from "zod";
import {
  lockHolder,
  RUN_LAST_STOP,
  RUN_MARKER,
  type RunMarker,
  RunMarkerSchema,
  type RunStop,
  RunStopSchema,
} from "./runCommand";
import type { RunEnvironment } from "./runEnvironment";
import { commandWords } from "./workCommand";

export const STATUS_WORDS = {
  usage: [
    "Usage: infinitary status [--json]",
    "Reads the command's status without starting Infinitary.",
  ],
  running: "A command is running Infinitary here.",
  stopped: "No command is running Infinitary here.",
  unknown: "Infinitary could not read whether a command is running here.",
  noStop: "No previous stop was recorded.",
  lastStop: "Last recorded stop:",
  interrupted:
    "The last command ended without recording why. Its stop time and exit code are unknown.",
  unreadable: "The command's saved status could not be read.",
  otherProcess: "Another process holds this folder; its status is not recorded by the run command.",
  noEnvironment: "No environment reading was recorded.",
  environment: "Environment when the command started (not a live check):",
  display: {
    own: "Hidden pages use Infinitary's own display.",
    session: "A display was named by the login session.",
    none: "No display was available for hidden pages.",
    unknown: "Whether hidden pages can draw here is unknown.",
  },
  keychain: {
    locked: "This account's login Keychain was locked; sign-ins kept there may be unavailable.",
    unlocked: "This account's login Keychain was unlocked; this does not check any sign-in.",
    absent: "This account had no login Keychain.",
    unknown: "This account's login Keychain's lock state was not available.",
    "not-applicable": "The macOS Keychain is not used on this system.",
  },
  voice: "Voice is not prepared when a command starts Infinitary.",
  notifications: "Delivery of notifications in this session has not been checked.",
} as const;

export function statusCommand(argv: readonly string[], defaultApp: boolean): string[] | null {
  const words = commandWords(argv, defaultApp);
  return words?.[0] === "status" ? words.slice(1) : null;
}

type Reading<T> = { kind: "read"; value: T } | { kind: "absent" | "unreadable" };
function readRecord<T>(path: string, schema: z.ZodType<T>): Reading<T> {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? { kind: "read", value: parsed.data } : { kind: "unreadable" };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" };
  }
}

type UnrecordedStop = {
  pid: number;
  startedAt: string;
  stoppedAt: null;
  reason: "unrecorded";
  exitCode: null;
  lines: string[];
};
export type RunStatus = {
  schemaVersion: 1;
  /** null is unreadable, never a false stopped report. This is the run command's status. */
  running: boolean | null;
  run: RunMarker | null;
  lastStop: RunStop | UnrecordedStop | null;
  environment: RunEnvironment | null;
  problems: string[];
};

/**
 * Read-only: no core, lock acquisition, migration, Keychain query, or file
 * creation. The note's run is read by the birth it keeps on Windows
 * (`runAlive`), as the window's startup reads it (`commandHolding`), so a
 * program that took the number of a run that ended is not that run; a folder
 * whose lock another process holds while its note names no live run is
 * unknown, never stopped, so no window joins as if nothing ran.
 */
export function readRunStatus(
  dataDir: string,
  alive: (pid: number, birth?: string) => boolean = runAlive,
): RunStatus {
  // Stop precedes marker: a concurrent clean stop writes history before removing the marker.
  let stop = readRecord(join(dataDir, RUN_LAST_STOP), RunStopSchema);
  const marker = readRecord(join(dataDir, RUN_MARKER), RunMarkerSchema);
  const holder = lockHolder(dataDir);
  const problems: string[] = [];
  if (stop.kind === "unreadable" || marker.kind === "unreadable")
    problems.push(STATUS_WORDS.unreadable);
  let running: boolean | null = marker.kind === "unreadable" ? null : false;
  const run = marker.kind === "read" ? marker.value : null;
  if (run) {
    running = alive(run.pid, run.birth) && (holder === undefined || holder === run.pid);
    // Pick up a stop written while the marker was being read.
    if (!running) stop = readRecord(join(dataDir, RUN_LAST_STOP), RunStopSchema);
  }
  if (!running && marker.kind !== "unreadable") {
    if (holder !== null && (holder === undefined || (holder !== run?.pid && alive(holder)))) {
      running = null;
      problems.push(STATUS_WORDS.otherProcess);
    }
  }
  let lastStop: RunStatus["lastStop"] = stop.kind === "read" ? stop.value : null;
  if (run && !running && (lastStop?.pid !== run.pid || lastStop.startedAt !== run.startedAt)) {
    lastStop = {
      pid: run.pid,
      startedAt: run.startedAt,
      stoppedAt: null,
      reason: "unrecorded",
      exitCode: null,
      lines: [STATUS_WORDS.interrupted],
    };
  }
  return {
    schemaVersion: 1,
    running,
    run: running ? run : null,
    lastStop,
    environment: run
      ? (run.environment ?? null)
      : marker.kind === "unreadable"
        ? null
        : ((stop.kind === "read" ? stop.value.environment : null) ?? null),
    problems,
  };
}

export function statusText(status: RunStatus): string {
  const lines: string[] = [
    status.running === true
      ? STATUS_WORDS.running
      : status.running === false
        ? STATUS_WORDS.stopped
        : STATUS_WORDS.unknown,
  ];
  if (status.lastStop) lines.push(STATUS_WORDS.lastStop, ...status.lastStop.lines);
  else lines.push(STATUS_WORDS.noStop);
  lines.push(...status.problems);
  const environment = status.environment;
  if (environment)
    lines.push(
      STATUS_WORDS.environment,
      `  ${environment.observedAt}`,
      `  ${STATUS_WORDS.display[environment.display]}`,
      `  ${STATUS_WORDS.keychain[environment.keychain]}`,
      `  ${STATUS_WORDS.voice}`,
      `  ${STATUS_WORDS.notifications}`,
    );
  else lines.push(STATUS_WORDS.noEnvironment);
  return `${lines.join("\n")}\n`;
}

export function runStatusCommand(
  args: readonly string[],
  dataDir: string,
): { code: number; out: string; error: string } {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    return { code: 2, out: "", error: `${STATUS_WORDS.usage.join("\n")}\n` };
  }
  const status = readRunStatus(dataDir);
  return {
    code: status.running === null || status.problems.length > 0 ? 1 : 0,
    out: args[0] === "--json" ? `${JSON.stringify(status)}\n` : statusText(status),
    error: "",
  };
}
