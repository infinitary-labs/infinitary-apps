import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { type ProcessResources, RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";

const exec = promisify(execFile);

export type ProcessReading = {
  pid: number;
  parent: number;
  group: number;
  started: string;
  cpuMs?: number;
  residentBytes: number;
};

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
    const row = {
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      cpuMs: cpuTime(match[4] ?? ""),
      residentBytes: Number(match[5]) * 1024,
      started: match[6] ?? "",
    };
    if (
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      !Number.isSafeInteger(row.residentBytes) ||
      !Number.isFinite(row.cpuMs)
    )
      return null;
    rows.push(row);
  }
  return rows.length ? rows : null;
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

export async function readProcesses(): Promise<ProcessReading[] | null> {
  if (hostPlatform() !== "darwin" && hostPlatform() !== "linux") return null;
  try {
    const { stdout } = await exec(
      hostPlatform() === "darwin" ? "/bin/ps" : "ps",
      ["-axo", "pid=,ppid=,pgid=,time=,rss=,lstart="],
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
    // Serial asynchronous reads cannot exhaust the app's file descriptors or
    // block its drawing thread. A vanished/unreadable process has unknown CPU.
    for (const row of rows) {
      delete row.cpuMs;
      if (ticks === undefined) continue;
      try {
        const time = linuxProcessTime(await readFile(`/proc/${row.pid}/stat`, "utf8"), ticks);
        if (time) Object.assign(row, time);
      } catch {
        /* Process exited or its metadata is unavailable. */
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/** Task attribution survives reparenting, but never a changed process birth stamp. */
export class ProcessAttribution {
  private previous = new Map<number, { started: string; owner: string }>();

  owners(rows: ProcessReading[], roots: ReadonlyMap<number, string>): Map<number, string> {
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

/** Every process contributes once; RSS is resident bytes, not unique physical memory. */
export function processResources(
  first: ProcessReading[],
  last: ProcessReading[],
  owners: ReadonlyMap<number, string>,
  elapsedMs: number,
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
      previous?.started === row.started && previous.cpuMs !== undefined && row.cpuMs !== undefined
        ? row.cpuMs - previous.cpuMs
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
