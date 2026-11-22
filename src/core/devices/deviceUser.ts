import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { win32 } from "node:path";
import type { DeviceUser } from "@shared/connection";
import { hostEnv } from "../hostEnv";

/**
 * The user this computer joins a home as (docs/devices.md, "Joining"): its
 * name and, on a Mac or Linux, its number. Windows gives a user no number -
 * Node answers -1 there - so a Windows PC says its security identifier in
 * its place, read from Windows' own `whoami`.
 */

/** Windows' own `whoami`, which any user may run. */
export function windowsWhoami(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return win32.join(root, "System32", "whoami.exe");
}

/**
 * The security identifier `whoami /user /fo csv /nh` printed: its one line
 * is the user's name and identifier, each quoted, such as
 * `"desktop-1\kun chen","S-1-5-21-1-2-3-1001"`. Null for anything else.
 */
export function readWhoamiSid(output: string): string | null {
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(output.trim())?.[1];
  return sid && sid.length <= 184 ? sid : null;
}

export type DeviceUserLook = {
  platform: NodeJS.Platform;
  /** This user's name, and its number where the system gives one. */
  user?: () => { username: string; uid: number };
  getuid?: (() => number) | undefined;
  /** Runs `whoami /user /fo csv /nh` and answers what it printed, or null. */
  whoami?: () => Promise<string | null>;
};

/**
 * Who this computer joins as, or null on a Windows PC whose identifier
 * could not be read: a join without it would be refused by the home, so the
 * caller says it could not join.
 */
export async function thisDeviceUser(look: DeviceUserLook): Promise<DeviceUser | null> {
  const user = (look.user ?? userInfo)();
  if (look.platform !== "win32") return { name: user.username, uid: look.getuid?.() ?? user.uid };
  const said = await (look.whoami ?? runWhoami)();
  const sid = said === null ? null : readWhoamiSid(said);
  return sid ? { name: user.username, sid } : null;
}

function runWhoami(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      windowsWhoami(),
      ["/user", "/fo", "csv", "/nh"],
      { env: hostEnv(), timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}
