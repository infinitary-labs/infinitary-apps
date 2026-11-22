import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { DeviceFirewall, WindowsFirewall } from "@shared/devices";
import { hostEnv } from "../hostEnv";
import { encodedCommand, windowsPowerShell } from "../storage/ownerOnly";
import { findOnPath } from "../userBin";

/**
 * Whether a Linux home's own firewall may keep its devices out
 * (docs/devices.md, "A home's firewall"): a device dials this
 * computer at the connection's port, and a Linux desktop may turn a
 * firewall on that drops it. A Mac's firewall asks its person instead.
 * A Windows home's is read at the end of this file.
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

export type FirewallRun = (
  program: string,
  args: readonly string[],
) => Promise<{ ok: boolean; output: string }>;

export type FirewallLook = {
  /** The connection's port, which a device dials. */
  port: number;
  /** Reads a file any user may read; null when it is not there or cannot be read. */
  readFile?: (path: string) => string | null;
  run?: FirewallRun;
  which?: (name: string) => string | undefined;
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

/**
 * What Windows' own firewall policy says, as `WINDOWS_FIREWALL_SCRIPT` reads
 * it through `HNetCfg.FwPolicy2`, which any user may read: each network
 * profile in use now, and each enabled incoming TCP rule that names this
 * app's program or no program at all.
 */
export type WindowsFirewallReading = {
  profiles: { bit: number; enabled: boolean; blockAll: boolean; defaultBlock: boolean }[];
  rules: { app: boolean; ports: string; allow: boolean; profiles: number }[];
};

const PROFILE_NAMES: readonly [number, "domain" | "private" | "public"][] = [
  [1, "domain"],
  [2, "private"],
  [4, "public"],
];

/** Whether a rule's local ports, such as `*`, `47623` or `47000-48000,5000`, take `port`. */
export function rulePortsTake(ports: string, port: number): boolean {
  return ports
    .split(",")
    .map((part) => part.trim())
    .some((part) => {
      if (part === "*" || part === "") return true;
      const range = /^(\d+)-(\d+)$/.exec(part);
      if (range) return Number(range[1]) <= port && port <= Number(range[2]);
      return /^\d+$/.test(part) && Number(part) === port;
    });
}

/**
 * Whether Windows Defender Firewall keeps devices out of this Windows home
 * (docs/devices.md, "A home's firewall"), from a reading of its policy. A
 * profile in use keeps them out while it is on and blocks every incoming
 * connection, while a rule blocks this app or the port - which wins over any
 * rule that allows it - or while nothing allows it and the profile blocks
 * what no rule allows, as it does unless someone changed it. Windows asks
 * the person when this app first listens, and writes a rule from their
 * answer: allowing where they let it in, blocking where they did not.
 */
export function windowsFirewallFrom(
  reading: WindowsFirewallReading,
  port: number,
  program: string,
): WindowsFirewall | null {
  const keepOut: ("domain" | "private" | "public")[] = [];
  let blockRule = false;
  let blockAll = false;
  for (const profile of reading.profiles) {
    if (!profile.enabled) continue;
    const name = PROFILE_NAMES.find(([bit]) => bit === profile.bit)?.[1];
    if (!name) continue;
    const rules = reading.rules.filter(
      (rule) => (rule.profiles & profile.bit) !== 0 && rulePortsTake(rule.ports, port),
    );
    const blocked = rules.some((rule) => !rule.allow);
    if (profile.blockAll || blocked || (profile.defaultBlock && !rules.some((rule) => rule.allow)))
      keepOut.push(name);
    blockAll ||= profile.blockAll;
    blockRule ||= rules.some((rule) => !rule.allow && rule.app);
  }
  if (keepOut.length === 0) return null;
  return { name: "windows", port, program, profiles: keepOut, blockRule, blockAll };
}

/** One list from PowerShell's JSON, which writes a list of one as the item and none as nothing. */
function listOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function readWindowsFirewall(output: string): WindowsFirewallReading | null {
  let said: unknown;
  try {
    said = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!said || typeof said !== "object") return null;
  const { profiles, rules } = said as { profiles?: unknown; rules?: unknown };
  const profileList = listOf(profiles).filter(
    (each): each is WindowsFirewallReading["profiles"][number] =>
      !!each &&
      typeof (each as { bit?: unknown }).bit === "number" &&
      typeof (each as { enabled?: unknown }).enabled === "boolean" &&
      typeof (each as { blockAll?: unknown }).blockAll === "boolean" &&
      typeof (each as { defaultBlock?: unknown }).defaultBlock === "boolean",
  );
  const ruleList = listOf(rules).filter(
    (each): each is WindowsFirewallReading["rules"][number] =>
      !!each &&
      typeof (each as { app?: unknown }).app === "boolean" &&
      typeof (each as { ports?: unknown }).ports === "string" &&
      typeof (each as { allow?: unknown }).allow === "boolean" &&
      typeof (each as { profiles?: unknown }).profiles === "number",
  );
  return { profiles: profileList, rules: ruleList };
}

/**
 * Reads Windows' firewall policy as any user may: the profiles in use, and
 * the enabled incoming TCP rules that name this app's program or none. A
 * rule for a service, or for another program, never lets this app in.
 */
export const WINDOWS_FIREWALL_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$program = ($env:INFINITARY_FIREWALL_PROGRAM).ToLowerInvariant()
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$current = $policy.CurrentProfileTypes
$profiles = @()
foreach ($bit in 1, 2, 4) {
  if (($current -band $bit) -eq 0) { continue }
  $profiles += [pscustomobject]@{
    bit = $bit
    enabled = [bool]$policy.FirewallEnabled($bit)
    blockAll = [bool]$policy.BlockAllInboundTraffic($bit)
    defaultBlock = ($policy.DefaultInboundAction($bit) -eq 0)
  }
}
$rules = @()
foreach ($rule in $policy.Rules) {
  if ($rule.Direction -ne 1 -or -not $rule.Enabled) { continue }
  if ($rule.Protocol -ne 6 -and $rule.Protocol -ne 256) { continue }
  if ($rule.serviceName) { continue }
  $app = [string]$rule.ApplicationName
  if ($app -and [Environment]::ExpandEnvironmentVariables($app).ToLowerInvariant() -ne $program) { continue }
  $rules += [pscustomobject]@{
    app = [bool]$app
    ports = [string]$rule.LocalPorts
    allow = ($rule.Action -eq 1)
    profiles = [int]$rule.Profiles
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ profiles = $profiles; rules = $rules })
`;

/**
 * Whether Windows Defender Firewall may keep devices out of this Windows
 * home, read through Windows' own PowerShell; null when it does not, or when
 * the reading failed: a firewall it cannot read is never said to keep
 * devices out.
 */
export async function windowsFirewallKeepsOut(
  port: number,
  program: string,
  run: FirewallRun = runProgramWith({ INFINITARY_FIREWALL_PROGRAM: program }),
): Promise<WindowsFirewall | null> {
  const ran = await run(windowsPowerShell(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand(WINDOWS_FIREWALL_SCRIPT),
  ]);
  const reading = ran.ok ? readWindowsFirewall(ran.output) : null;
  return reading ? windowsFirewallFrom(reading, port, program) : null;
}

function runProgramWith(env: NodeJS.ProcessEnv): FirewallRun {
  return (program, args) =>
    new Promise((resolve) => {
      execFile(
        program,
        [...args],
        { env: { ...hostEnv(), ...env }, timeout: 20_000, windowsHide: true },
        (error, stdout) => resolve({ ok: !error, output: String(stdout).trim() }),
      );
    });
}
