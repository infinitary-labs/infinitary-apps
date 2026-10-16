import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { DeviceFirewall } from "@shared/devices";
import { hostEnv } from "../hostEnv";
import { findOnPath } from "../userBin";

/**
 * Whether a Linux home's own firewall may keep its devices out
 * (docs/devices.md, "A Linux home's firewall"): a device dials this
 * computer at the connection's port, and a Linux desktop may turn a
 * firewall on that drops it. A Mac's firewall asks its person instead, so
 * this is Linux's alone.
 *
 * It reads only what any user may read, and never asks for a password:
 *
 * - **ufw** (Ubuntu, Omarchy): on when its own settings file says
 *   `ENABLED=yes`. Its rules are root's to read, so while it is on the port
 *   may be closed, and the home says so.
 * - **firewalld** (Fedora): running while its service is active, and open
 *   when `firewall-cmd --query-port` finds the port open, which firewalld
 *   answers someone at the desktop; with no answer, open only in Fedora
 *   Workstation's own zone, which lets every port from 1025 in.
 * - **NixOS's own firewall**: on while its `firewall` service is active.
 *   Its rules are root's to read too.
 *
 * Anything it cannot tell is no warning: an unknown firewall is never said
 * to keep devices out.
 */

/** What one program answered: whether it ended well, and what it printed. */
export type FirewallRun = (
  program: string,
  args: readonly string[],
) => Promise<{ ok: boolean; output: string }>;

export type FirewallLook = {
  /** The connection's port, which a device dials. */
  port: number;
  /** Reads a file any user may read; null when it is not there or cannot be read. */
  readFile?: (path: string) => string | null;
  /** Runs one of the system's own programs, found on the search path. */
  run?: FirewallRun;
  /** Finds a program on the search path. */
  which?: (name: string) => string | undefined;
  /** Whether a path is there. */
  exists?: (path: string) => boolean;
};

const UFW_SETTINGS = "/etc/ufw/ufw.conf";
const NIXOS_MARK = "/etc/NIXOS";
/** Fedora Workstation's own zone, which lets every port from 1025 in. */
const OPEN_ZONE = "FedoraWorkstation";

/** The firewall that may keep devices out of this Linux computer, or null when none is known to. */
export async function firewallKeepsOut(look: FirewallLook): Promise<DeviceFirewall | null> {
  const readFile = look.readFile ?? readable;
  const run = look.run ?? runProgram;
  const which = look.which ?? ((name: string) => findOnPath(name, hostEnv()));
  const exists = look.exists ?? existsSync;
  const { port } = look;
  if (/^\s*ENABLED\s*=\s*yes\s*$/im.test(readFile(UFW_SETTINGS) ?? ""))
    return { name: "ufw", port };
  const systemctl = which("systemctl");
  if (!systemctl) return null;
  const active = async (service: string) =>
    (await run(systemctl, ["is-active", "--quiet", service])).ok;
  const firewallCmd = which("firewall-cmd");
  if (firewallCmd && (await active("firewalld.service"))) {
    if ((await run(firewallCmd, [`--query-port=${port}/tcp`])).ok) return null;
    const zone = await run(firewallCmd, ["--get-default-zone"]);
    return zone.ok && zone.output === OPEN_ZONE ? null : { name: "firewalld", port };
  }
  if (exists(NIXOS_MARK) && (await active("firewall.service"))) return { name: "nixos", port };
  return null;
}

function readable(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function runProgram(
  program: string,
  args: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(program, [...args], { env: hostEnv(), timeout: 5_000 }, (error, stdout) =>
      resolve({ ok: !error, output: String(stdout).trim() }),
    );
  });
}
