import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** INF-1596 (the captain's "clean up both one-off and automatically moving forward"): a phone check
 * that is killed, by a task stop or the idle reboot, never reaches its own cleanup, so its simulator
 * and scratch folder stay behind. Each gate removes them before it starts its own.
 *
 * A gate creates its simulator and scratch folder only after its process starts, so whatever came into
 * being before every phone check process still running began belongs to none of them. That reading
 * needs no record, age or name of its own: older runs' leftovers are told apart the same way.
 */
export const GATE_SIMULATOR = "Infinitary isolated test";
export const SCRATCH_PREFIX = "infinitary-native-";
// The prefix and mkdtemp's six letters and digits; a longer prefix, such as a unit test's, is not the gate's.
const SCRATCH_FOLDER = new RegExp(`^${SCRATCH_PREFIX}[A-Za-z0-9]{6}$`);
// A gate, a part it starts with Node's full path, and a part inside the starvation wrapper.
const GATE_COMMAND = /(?:^|[\s/])scripts\/test-phone\.ts(?:\s|$)/;
// `LC_ALL=C TZ=UTC ps -o lstart=`, as scripts/phone-activity.ts reads it, before each process's command.
const PROCESS_LINE = /^\s*(\d+)\s+[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s+(.*)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type GateProcess = { pid: number; started: number };

/** Every process of this account with when it began and its command. Read here, never through the gate's
 * command log: other programs' commands can carry what its evidence must not keep. */
function processList(env: NodeJS.ProcessEnv): string {
  return execFileSync("/bin/ps", ["-x", "-o", "pid=,lstart=,command="], {
    env: { ...env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity,
  });
}

/** Every phone check process in a `processList` reading, with when it began. */
export function runningGates(listing: string): GateProcess[] {
  return listing.split("\n").flatMap((line) => {
    const read = PROCESS_LINE.exec(line);
    if (!read || !GATE_COMMAND.test(read[8]!)) return [];
    const [, pid, month, day, hour, minute, second, year] = read;
    const started = Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hour), Number(minute), Number(second));
    return [{ pid: Number(pid), started }];
  });
}

/** The gate's own simulators in a `simctl list devices -j` reading, with the folder CoreSimulator made for each. */
export function gateSimulators(listing: string): { udid: string; state: string; folder: string }[] {
  const devices = (JSON.parse(listing) as { devices: Record<string, { udid: string; name: string; state: string; dataPath: string }[]> }).devices;
  return Object.values(devices).flat().filter((device) => device.name === GATE_SIMULATOR)
    .map(({ udid, state, dataPath }) => ({ udid, state, folder: dirname(dataPath) }));
}

export function isScratchFolder(name: string): boolean {
  return SCRATCH_FOLDER.test(name);
}

/** What came into being before every running phone check began. The reading must show the gate that asks,
 * or it shows no running check at all and nothing could be told apart. */
export function leftBehind<T extends { created: number }>(items: T[], gates: GateProcess[], self: number): T[] {
  if (!gates.some((gate) => gate.pid === self)) throw new Error("The process list does not show this phone check");
  const since = Math.min(...gates.map((gate) => gate.started));
  return items.filter((item) => item.created < since);
}

type Run = (command: string, args: string[]) => Promise<string>;

/** Removes the simulators and scratch folders earlier phone checks left. A removal that fails is reported and the rest go on. */
export async function removePhoneLeftovers(run: Run, env: NodeJS.ProcessEnv, scratch = tmpdir(), self = process.pid,
  log = console.log): Promise<void> {
  const gates = runningGates(processList(env));
  const simulators = gateSimulators(await run("xcrun", ["simctl", "list", "devices", "-j"])).flatMap((simulator) => {
    try { return [{ ...simulator, created: statSync(simulator.folder).birthtimeMs }]; }
    catch { return []; }
  });
  const folders = readdirSync(scratch).filter(isScratchFolder).flatMap((name) => {
    const path = join(scratch, name);
    try {
      const info = lstatSync(path);
      return info.isDirectory() ? [{ path, created: info.birthtimeMs }] : [];
    } catch { return []; }
  });
  const [oldSimulators, oldFolders] = [leftBehind(simulators, gates, self), leftBehind(folders, gates, self)];
  if (!oldSimulators.length && !oldFolders.length) {
    log("No simulator or scratch folder from an earlier phone check was left.");
    return;
  }
  for (const { udid, state, created } of oldSimulators) {
    const made = new Date(created).toISOString();
    try {
      if (state !== "Shutdown") await run("xcrun", ["simctl", "shutdown", udid]);
      await run("xcrun", ["simctl", "delete", udid]);
      log(`Deleted simulator ${udid} (${state}), which an earlier phone check made at ${made}.`);
    } catch (error) {
      log(`Simulator ${udid}, which an earlier phone check made at ${made}, could not be deleted: ${(error as Error).message}`);
    }
  }
  for (const { path, created } of oldFolders) {
    const made = new Date(created).toISOString();
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      log(`Removed ${path}, which an earlier phone check made at ${made}.`);
    } catch (error) {
      log(`${path}, which an earlier phone check made at ${made}, could not be removed: ${(error as Error).message}`);
    }
  }
}
