import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** INF-869 / INF-906: a watchdog activity reading, never admission or a lease.
 * This is the producer for dotfiles-private's hosts/PHONE_ACTIVITY.md.
 * The account's real home is independent of the native gate's disposable HOME.
 */
export function phoneActivityDirectory(env: NodeJS.ProcessEnv, realHome = userInfo().homedir): string {
  return env.IDLE_REBOOT_PHONE_ACTIVITY_DIR || join(realHome, "Library", "Caches", "infinitary-ci", "phone-activity");
}

export function startPhoneActivity(env: NodeJS.ProcessEnv, realHome = userInfo().homedir): { path: string; close(): void } {
  const folder = phoneActivityDirectory(env, realHome);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const info = lstatSync(folder);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("The phone activity folder must be a directory owned by this user");
  }
  chmodSync(folder, 0o700);
  const processStartedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
    env: { ...env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8",
  }).trim().replace(/\s+/g, " ");
  if (!processStartedAt) throw new Error("The phone supervisor's start time could not be read");
  const name = `${process.pid}-${randomUUID()}`;
  const path = join(folder, `${name}.json`);
  const temporary = join(folder, `${name}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, processStartedAt })}\n`, {
      flag: "wx", mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, close: () => rmSync(path, { force: true }) };
}
