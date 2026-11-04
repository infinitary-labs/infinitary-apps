import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { type ProcessResources, RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import type { ProcessGroupOwner } from "./processRoots";

const exec = promisify(execFile);

export type ProcessReading = {
  pid: number;
  parent: number;
  group: number;
  started: string;
  /** Wall-clock birth, at the stamp's whole-second precision or finer; absent when unreadable. */
  bornMs?: number;
  cpuMs?: number;
  residentBytes: number;
  /** A zombie retains its identity but cannot witness a living payload launch. */
  exited?: boolean;
};

/** A Mac's lstart stamp counts whole seconds, so a birth reads up to one second early. */
const BIRTH_STAMP_PRECISION_MS = 1000;

/** ps TIME is cumulative, unlike %CPU's lifetime average on a Mac. */
function cpuTime(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return Number.NaN;
  return (
    (Number(match[1] ?? 0) * 86400 +
      Number(match[2] ?? 0) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4])) *
    1000
  );
}

/** Metadata only: never ask ps for arguments, environment, paths or usernames. */
export function processesFromPs(text: string): ProcessReading[] | null {
  const rows: ProcessReading[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    const birth = match[6] ?? "";
    const state = /\s+([A-Za-z+<>-]+)$/.exec(birth);
    const row = {
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      cpuMs: cpuTime(match[4] ?? ""),
      residentBytes: Number(match[5]) * 1024,
      started: state ? birth.slice(0, state.index) : birth,
      bornMs: Date.parse(state ? birth.slice(0, state.index) : birth),
      ...(state?.[1]?.includes("Z") || state?.[1]?.includes("X") ? { exited: true } : {}),
    };
    if (
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      !Number.isSafeInteger(row.residentBytes) ||
      !Number.isFinite(row.cpuMs)
    )
      return null;
    rows.push(Number.isFinite(row.bornMs) ? row : { ...row, bornMs: undefined });
  }
  return rows.length ? rows : null;
}

/** Receipt birth stamps use UTC, independent of the payload shell's timezone.
 * Keep the existing whole-table birth format unchanged for saved group identities. */
export async function readReceiptProcess(pid: number): Promise<ProcessReading | undefined> {
  if (hostPlatform() !== "darwin") return undefined;
  try {
    const { stdout } = await exec(
      "/bin/ps",
      ["-p", String(pid), "-o", "pid=,ppid=,pgid=,time=,rss=,lstart=,stat="],
      {
        env: hostEnv({ LC_ALL: "C", TZ: "UTC" }),
        encoding: "utf8",
        timeout: RESOURCE_READ_TIMEOUT_MS,
      },
    );
    return processesFromPs(stdout)?.find((row) => row.pid === pid);
  } catch {
    return undefined;
  }
}

let linuxClockTicks: Promise<number | undefined> | undefined;

async function clockTicks(): Promise<number | undefined> {
  linuxClockTicks ??= exec("getconf", ["CLK_TCK"], {
    env: hostEnv(),
    encoding: "utf8",
    timeout: RESOURCE_READ_TIMEOUT_MS,
  })
    .then(({ stdout }) => {
      const value = Number(stdout.trim());
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    })
    .catch(() => undefined);
  return linuxClockTicks;
}

/** /proc/PID/stat uses the host's clock ticks, not ps's whole-second Linux TIME. */
export function linuxProcessTime(
  text: string,
  ticks: number,
): { cpuMs: number; started: string } | undefined {
  const end = text.lastIndexOf(")");
  if (end < 0 || !Number.isFinite(ticks) || ticks <= 0) return undefined;
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  const born = fields[19];
  if (
    !Number.isSafeInteger(user) ||
    user < 0 ||
    !Number.isSafeInteger(system) ||
    system < 0 ||
    !born ||
    !/^\d+$/.test(born)
  )
    return undefined;
  return { cpuMs: ((user + system) * 1000) / ticks, started: `linux:${born}` };
}

/** Linux birth ticks count from boot; /proc/uptime places boot on the wall clock. */
async function linuxBootMs(): Promise<number | undefined> {
  try {
    const uptime = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/)[0]);
    return Number.isFinite(uptime) && uptime >= 0 ? Date.now() - uptime * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export async function readProcesses(): Promise<ProcessReading[] | null> {
  if (hostPlatform() !== "darwin" && hostPlatform() !== "linux") return null;
  try {
    const { stdout } = await exec(
      hostPlatform() === "darwin" ? "/bin/ps" : "ps",
      ["-axo", "pid=,ppid=,pgid=,time=,rss=,lstart=,stat="],
      {
        env: hostEnv({ LC_ALL: "C" }),
        encoding: "utf8",
        timeout: RESOURCE_READ_TIMEOUT_MS,
        // Metadata for large process tables; an oversized table stays unknown.
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const rows = processesFromPs(stdout);
    if (!rows || hostPlatform() !== "linux") return rows;
    const ticks = await clockTicks();
    const boot = ticks === undefined ? undefined : await linuxBootMs();
    const living: ProcessReading[] = [];
    // Serial asynchronous reads cannot exhaust the app's file descriptors or
    // block its drawing thread. An unparsable stat has unknown CPU.
    for (const row of rows) {
      delete row.cpuMs;
      if (ticks === undefined) {
        living.push(row);
        continue;
      }
      try {
        const text = await readFile(`/proc/${row.pid}/stat`, "utf8");
        const time = linuxProcessTime(text, ticks);
        if (time) {
          Object.assign(row, time);
          const born = Number(time.started.slice("linux:".length));
          row.bornMs = boot === undefined ? undefined : boot + (born * 1000) / ticks;
        }
        living.push(row);
      } catch {
        // The process exited between the listing and its stat: it is no longer running.
      }
    }
    return living.length ? living : null;
  } catch {
    return null;
  }
}

/** Task attribution survives reparenting, but never a changed process birth stamp. */
export class ProcessAttribution {
  private previous = new Map<number, { started: string; owner: string }>();

  owners(
    rows: ProcessReading[],
    roots: ReadonlyMap<number, string>,
    groups: ReadonlyMap<number, ProcessGroupOwner> = new Map(),
  ): Map<number, string> {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const owners = new Map<number, string>();
    const ownerOf = (row: ProcessReading): string | undefined => {
      const seen = new Set<number>();
      let current: ProcessReading | undefined = row;
      while (current && !seen.has(current.pid)) {
        seen.add(current.pid);
        const explicit = roots.get(current.pid);
        if (explicit) return explicit;
        const held = this.previous.get(current.pid);
        if (held?.started === current.started) return held.owner;
        current = byPid.get(current.parent);
      }
      const group = groups.get(row.group);
      const leader = byPid.get(row.group);
      if (group && (!leader || leader.group !== row.group || leader.started === group.started))
        return group.owner;
      // A shell may have exited before this read; its living group members
      // still name the explicit root's group. No unregistered group is guessed.
      return roots.get(row.group);
    };
    for (const row of rows) {
      const owner = ownerOf(row);
      if (owner && owner !== "firstmate") owners.set(row.pid, owner);
    }
    this.previous = new Map(
      rows.flatMap((row) => {
        const owner = owners.get(row.pid);
        return owner ? [[row.pid, { started: row.started, owner }] as const] : [];
      }),
    );
    return owners;
  }
}

/** New, or reborn under a reused number, since the first reading. */
function bornInWindow(row: ProcessReading, firstAt: number | undefined): boolean {
  return (
    firstAt !== undefined &&
    row.bornMs !== undefined &&
    row.bornMs + BIRTH_STAMP_PRECISION_MS > firstAt
  );
}

/**
 * Every process contributes once; RSS is resident bytes, not unique physical memory.
 * A process born at or after the first reading (`firstAt`, wall-clock ms) did all its
 * work inside the window, so its whole processor time counts. One missing from the first
 * reading that was born earlier, or with no readable birth, leaves its task's use unknown.
 */
export function processResources(
  first: ProcessReading[],
  last: ProcessReading[],
  owners: ReadonlyMap<number, string>,
  elapsedMs: number,
  firstAt?: number,
): ProcessResources {
  const before = new Map(first.map((row) => [row.pid, row]));
  const groups = new Map<
    string,
    { processCount: number; residentBytes: number; cpuCores?: number }
  >();
  const unknown = new Set<string>();
  for (const row of last) {
    const owner = owners.get(row.pid) ?? "";
    const group = groups.get(owner) ?? { processCount: 0, residentBytes: 0, cpuCores: 0 };
    group.processCount++;
    group.residentBytes += row.residentBytes;
    const previous = before.get(row.pid);
    const delta =
      row.cpuMs === undefined
        ? -1
        : previous?.started === row.started
          ? previous.cpuMs === undefined
            ? -1
            : row.cpuMs - previous.cpuMs
          : bornInWindow(row, firstAt)
            ? row.cpuMs
            : -1;
    if (delta < 0 || elapsedMs <= 0) unknown.add(owner);
    else group.cpuCores = (group.cpuCores ?? 0) + delta / elapsedMs;
    groups.set(owner, group);
  }
  for (const owner of unknown) {
    const group = groups.get(owner);
    if (group) delete group.cpuCores;
  }
  return {
    status: "sampled",
    processCount: last.length,
    tasks: [...groups].flatMap(([taskId, group]) => (taskId ? [{ taskId, ...group }] : [])),
    other: groups.get("") ?? { processCount: 0, residentBytes: 0, cpuCores: 0 },
  };
}
