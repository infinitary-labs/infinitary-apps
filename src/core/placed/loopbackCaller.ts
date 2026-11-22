import { readFile } from "node:fs/promises";
import { RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { hostPlatform } from "../platform";
import { procOpenFiles, procPids, readLsof } from "./openFiles";
import { descendsFrom, type ProcessReading, readProcesses } from "./processResources";
import type { ShellGroup } from "./shellGroups";
import { readWindowsLoopbackOwners } from "./windowsProcesses";

/**
 * Who asked over a loopback connection this app accepted, as the system
 * lists it (docs/axi-commands.md, "Never the crew's"): the program holding
 * the connection's other end, and whether it is the crew's. It is when this
 * app started it, directly or through programs it started, or when it is in
 * the process group a crewmate shell started while that shell's task is
 * open. On Windows a group is the job the app put that shell in, which
 * every program it starts stays in after it ends. Only process numbers,
 * parents and groups are read; no name, argument or environment of any
 * program is read into the app.
 *
 * A program a crewmate shell left running, with `&` or nohup, has a parent
 * the app never was once the shell ends, and is still in the shell's group.
 * One that starts a group of its own, as setsid and tmux do, or one the
 * system or another app started, reads as not the crew's.
 */

export type LoopbackEnds = { clientPort: number; serverPort: number };

/** What the reading says, or why there is none: a system it cannot read, or a failed read. */
export type CallerReading =
  | { status: "checked"; crew: boolean }
  | { status: "unsupported" | "unreadable" };

/** A loopback address and port as lsof and the kernel's table name it. */
const LOOPBACK = "127.0.0.1";

/**
 * The programs holding the client end of the connection, from lsof on a
 * Mac (`-F pn`: process, then each matching socket's name, which reads
 * `client->server` on the caller's side).
 */
function peersFromLsof(text: string, ends: LoopbackEnds): number[] {
  const wanted = `${LOOPBACK}:${ends.clientPort}->${LOOPBACK}:${ends.serverPort}`;
  const peers = new Set<number>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && line.slice(1) === wanted && Number.isSafeInteger(pid) && pid > 0)
      peers.add(pid);
  }
  return [...peers];
}

async function lsofPeers(ends: LoopbackEnds): Promise<number[] | null> {
  const listed = await readLsof(
    [`-iTCP@${LOOPBACK}:${ends.clientPort}`, "-sTCP:ESTABLISHED", "-F", "pn"],
    { timeoutMs: RESOURCE_READ_TIMEOUT_MS },
  );
  return listed === null ? null : peersFromLsof(listed, ends);
}

/**
 * The kernel's sockets for the connection's client end, from a Linux
 * `/proc/net/tcp` table: each row's local and remote `address:port` in
 * hex, its state (`01` is established) and its inode.
 */
function socketInodes(table: string, ends: LoopbackEnds): Set<string> {
  // The address is the kernel's word in its own byte order.
  const loopback = new Set(["0100007F", "7F000001"]);
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [localHost, localPort] = (fields[1] ?? "").split(":");
    const [remoteHost, remotePort] = (fields[2] ?? "").split(":");
    const inode = fields[9];
    if (
      fields[3] === "01" &&
      loopback.has(localHost ?? "") &&
      loopback.has(remoteHost ?? "") &&
      Number.parseInt(localPort ?? "", 16) === ends.clientPort &&
      Number.parseInt(remotePort ?? "", 16) === ends.serverPort &&
      inode &&
      inode !== "0"
    )
      inodes.add(inode);
  }
  return inodes;
}

async function procPeers(ends: LoopbackEnds): Promise<number[] | null> {
  let inodes: Set<string>;
  try {
    inodes = socketInodes(await readFile("/proc/net/tcp", "utf8"), ends);
  } catch {
    return null;
  }
  const pids = await procPids();
  if (!pids || inodes.size === 0) return null;
  const sockets = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  const peers: number[] = [];
  // One program at a time, so a reading cannot use up the app's open files.
  for (const pid of pids)
    if ((await procOpenFiles(pid)).some((target) => sockets.has(target))) peers.push(pid);
  return peers;
}

/**
 * Whether a program is in a crewmate shell's group while its task is open
 * (`shells`). The system numbers a group after the shell that leads it; a
 * living program leading a group with that number is the shell itself, or
 * one that took the number after the shell ended, whose group is another:
 * its birth stamp tells which when the app read the shell's, and otherwise
 * whether the shell has ended does. On Windows the group is a job the app
 * made, which a program inside it can take the leader's number from, so the
 * birth the app kept for that job decides instead.
 */
export function inCrewShell(
  row: ProcessReading,
  byPid: ReadonlyMap<number, ProcessReading>,
  shells: (group: number) => ShellGroup | undefined,
): boolean {
  const shell = shells(row.group);
  if (!shell) return false;
  if (row.groupStarted !== undefined) return shell.started === row.groupStarted;
  const leader = byPid.get(row.group);
  if (!leader || leader.exited || leader.group !== row.group) return true;
  return shell.started !== undefined ? leader.started === shell.started : !shell.shellEnded;
}

/**
 * Who holds the client end of a loopback connection, and whether it is the
 * crew's: started by the app (`appPid`, this process unless named), or in a
 * crewmate shell's group while its task is open (`shells`). A program
 * holding no end, or one gone from the table before it was read, is
 * unreadable.
 */
export async function loopbackCaller(
  ends: LoopbackEnds,
  options: { appPid?: number; shells?: (group: number) => ShellGroup | undefined } = {},
): Promise<CallerReading> {
  const platform = hostPlatform();
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    return { status: "unsupported" };
  if (!Number.isSafeInteger(ends.clientPort) || !Number.isSafeInteger(ends.serverPort))
    return { status: "unreadable" };
  const peers =
    platform === "darwin"
      ? await lsofPeers(ends)
      : platform === "win32"
        ? readWindowsLoopbackOwners(ends)
        : await procPeers(ends);
  if (!peers || peers.length === 0) return { status: "unreadable" };
  const rows = await readProcesses();
  if (!rows) return { status: "unreadable" };
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const appPid = options.appPid ?? process.pid;
  const { shells } = options;
  const answers = peers.map((pid) => {
    const row = byPid.get(pid);
    if (row && shells && inCrewShell(row, byPid, shells)) return true;
    return descendsFrom(pid, appPid, byPid);
  });
  if (answers.includes(true)) return { status: "checked", crew: true };
  if (answers.includes(undefined)) return { status: "unreadable" };
  return { status: "checked", crew: false };
}
