import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostPlatform } from "../../core/platform";
import type { FreshAuthentication } from "../../core/secrets/approvals";
import { changeable } from "../../core/secrets/recipient";

/**
 * Fresh system authentication on Linux (docs/secrets.md, "Trusted
 * approvals"): polkit asks the person, through their desktop's own
 * authentication agent, to confirm with their password for the action
 * `app.infinitary.secrets.approve`, whose policy keeps no confirmation
 * (`auth_self`, never `auth_self_keep`). Only polkit's yes - pkcheck's exit 0 -
 * confirms; no agent, a dismissed dialog, a policy that is not installed, or
 * any failure approves nothing.
 *
 * pkcheck and pkaction run only from a system folder this user cannot
 * change, with an environment of their own, so neither a program on the
 * person's search path nor a system bus address in their shell's startup
 * files can answer in polkit's place.
 */
export const POLKIT_ACTION = "app.infinitary.secrets.approve";

/** Where distributions install polkit's commands: most in /usr/bin, NixOS in its system profile. */
const SYSTEM_FOLDERS = ["/usr/bin", "/run/current-system/sw/bin"];
/** No search path of the person's and no bus address: pkcheck finds the system bus itself. */
const POLKIT_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };

export type PolkitPrograms = { pkcheck: string; pkaction: string };

/**
 * `programs` names the commands outright - for the composition root that
 * already resolved them, or a test's stand-ins; otherwise they are looked up
 * in the system folders and trusted only as root's, unchangeable by this user.
 */
export function createLinuxFreshAuthentication(
  programs?: PolkitPrograms,
): FreshAuthentication | undefined {
  if (hostPlatform() !== "linux") return undefined;
  let resolved: Promise<PolkitPrograms | undefined> | undefined;
  const polkit = () => {
    resolved ??= programs ? Promise.resolve(programs) : trustedPolkit();
    return resolved;
  };
  return {
    available: async () => {
      const found = await polkit();
      if (!found) return false;
      return (await exitCode(found.pkaction, ["--action-id", POLKIT_ACTION])) === 0;
    },
    confirm: async (reason) => {
      const found = await polkit();
      const subject = await thisProcess();
      if (!found || !subject) return false;
      const code = await exitCode(found.pkcheck, [
        "--action-id",
        POLKIT_ACTION,
        "--process",
        subject,
        // The policy's message names the use with $(reason).
        "--detail",
        "reason",
        reason,
        "--allow-user-interaction",
      ]);
      return code === 0;
    },
  };
}

async function trustedPolkit(): Promise<PolkitPrograms | undefined> {
  for (const folder of SYSTEM_FOLDERS) {
    const pkcheck = await trustedProgram(join(folder, "pkcheck"));
    const pkaction = await trustedProgram(join(folder, "pkaction"));
    if (pkcheck && pkaction) return { pkcheck, pkaction };
  }
  return undefined;
}

/** The program's real path when root owns it and this user can change neither it nor a folder above it. */
export async function trustedProgram(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    const facts = await stat(real);
    if (!facts.isFile() || facts.uid !== 0 || (facts.mode & 0o111) === 0) return undefined;
    return (await changeable(real)) ? undefined : real;
  } catch {
    return undefined;
  }
}

/**
 * polkit's subject: this process by id, start time and user, so the answer
 * cannot be meant for another process that later takes the same id.
 */
async function thisProcess(): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    // The command name sits in parentheses and may hold spaces; the fields after it start at field 3.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = fields[22 - 3];
    const uid = process.getuid?.();
    if (!startTime || !/^\d+$/.test(startTime) || uid === undefined) return undefined;
    return `${process.pid},${startTime},${uid}`;
  } catch {
    return undefined;
  }
}

/** The command's exit code; a command that could not start, or ended by a signal, answers -1. */
function exitCode(program: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(program, args, { env: POLKIT_ENV }, (error) => {
      if (!error) return resolve(0);
      resolve(typeof error.code === "number" ? error.code : -1);
    });
  });
}
