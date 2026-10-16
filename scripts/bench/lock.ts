/**
 * A cross-process lock file: created exclusively, holding the owner's pid.
 * A lock whose owner is gone is taken over, so a killed run never wedges
 * the next one.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function withLock<T>(path: string, work: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      break;
    } catch {
      if (!ownerAlive(path)) rmSync(path, { force: true });
      else await sleep(250);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(path, { force: true });
  }
}

function ownerAlive(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return true;
  }
  // Empty: the owner created the file and has not written its pid yet.
  if (text === "") return true;
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
