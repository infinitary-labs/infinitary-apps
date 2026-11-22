import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { hostEnv } from "../hostEnv";

const exec = promisify(execFile);

/**
 * What programs hold open, as the system lists it: lsof on a Mac, /proc on
 * Linux. The reading of the programs holding a closed task's folders
 * (`folderHolders`) and of who asked over a loopback connection
 * (`loopbackCaller`) both read here.
 */

/**
 * What lsof lists for `select`, in numbers rather than names, or null when
 * it could not list. lsof exits 1 when some listing failed, with what it
 * could read on stdout, which is kept; a reading stopped at its time limit
 * is cut short, so it is null.
 */
export async function readLsof(
  select: readonly string[],
  options: { timeoutMs: number; maxBuffer?: number },
): Promise<string | null> {
  try {
    // `-b` keeps lsof off the kernel calls that can block on a stuck mount,
    // which once held a whole reading past its time limit.
    const { stdout } = await exec("/usr/sbin/lsof", ["-b", "-n", "-P", "-w", ...select], {
      env: hostEnv({ LC_ALL: "C" }),
      encoding: "utf8",
      timeout: options.timeoutMs,
      ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    });
    return stdout;
  } catch (caught) {
    const failed = caught as { stdout?: unknown; code?: unknown; killed?: boolean };
    return failed.code === 1 &&
      failed.killed !== true &&
      typeof failed.stdout === "string" &&
      failed.stdout.length > 0
      ? failed.stdout
      : null;
  }
}

export async function procPids(): Promise<number[] | null> {
  try {
    return (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)).map(Number);
  } catch {
    return null;
  }
}

export async function procOpenFiles(pid: number): Promise<string[]> {
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
  const targets = await Promise.all(
    fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")),
  );
  return targets.filter((target) => target !== "");
}
