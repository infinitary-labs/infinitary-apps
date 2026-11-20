import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { systemSystemctl } from "@core/helper/background";
import { appLauncher } from "@core/helper/launcher";
import { type Schtasks, windowsAccount } from "@core/helper/windowsTask";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { encodedCommand, windowsPowerShell } from "@core/storage/ownerOnly";
import { findOnPath } from "@core/userBin";
import { runLabelOf } from "@shared/codeNames";
import { SETTING_PREFIXES, settingFrom } from "@shared/envSettings";
import { app } from "electron";
import type { StartEntry } from "./besideRun";
import {
  BOOT_WORDS,
  type BootResult,
  bootAsked,
  helpWords,
  MAC_DAEMONS_DIR,
  runStartAtBoot,
  startEntryInPlace,
  userUnitsDir,
} from "./startAtBoot";
import { ownRunFlavor } from "./workContext";

/**
 * What `start-at-boot` and `help` read of this app and this user (./startAtBoot.ts).
 * A development run may stand in its own systemctl, loginctl and launchctl, so a test
 * never sets up a real service, and the service it writes carries the
 * settings that chose its data folder; an installed app reads neither.
 */
const CARRIED = [
  ...["USER_DATA_DIR", "FOLDER_SPELLING"].flatMap((name) =>
    SETTING_PREFIXES.map((prefix) => `${prefix}${name}`),
  ),
  "PI_OFFLINE",
];

/** What a development run's start entry carries of its environment: the settings that chose its data folder. */
export function carriedRunEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    CARRIED.flatMap((name) => {
      const value = env[name];
      return value ? [[name, value]] : [];
    }),
  );
}

/**
 * This Windows computer's own schtasks, in its system folder, or a
 * development run's stand-in (`INFINITARY_SCHTASKS`), so a test never
 * registers a real task; an installed app reads no stand-in.
 */
export function windowsSchtasks(env: NodeJS.ProcessEnv, packaged: boolean): Schtasks {
  const standIn = packaged ? undefined : settingFrom(env, "SCHTASKS")?.trim();
  if (standIn) return systemSystemctl(standIn);
  return Object.assign(
    systemSystemctl(join(env.SystemRoot?.trim() || "C:\\Windows", "System32", "schtasks.exe")),
    { lookup: (label: string) => powerShellTaskLookup(env, label) },
  );
}

/**
 * Task Scheduler's own answer for one task in its root folder, through its
 * scripting interface in Windows' own PowerShell: its not-found error
 * (0x80070002) is gone, and any other error, a PowerShell that cannot start
 * included, is unknown (`TaskLookup`).
 */
function powerShellTaskLookup(
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<"gone" | "there" | "unknown"> {
  return new Promise((resolve) => {
    execFile(
      windowsPowerShell(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedCommand(TASK_LOOKUP_SCRIPT),
      ],
      { env: { ...hostEnv(), INFINITARY_TASK_LABEL: label }, timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        const answer = String(stdout).trim();
        resolve(!error && (answer === "gone" || answer === "there") ? answer : "unknown");
      },
    );
  });
}

/** Asks Task Scheduler for the task its setting names, following each wrapped error to its own code. */
const TASK_LOOKUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  [void]$service.GetFolder('\').GetTask($env:INFINITARY_TASK_LABEL)
  'there'
} catch {
  $e = $_.Exception
  while ($e) {
    if ($e.HResult -eq -2147024894) { 'gone'; exit 0 }
    $e = $e.InnerException
  }
  'unknown'
}
`;

export async function answerBootCommand(
  asked: { boot: string[] | null; help: string[] | null },
  dataDir: string,
): Promise<BootResult> {
  const env = process.env;
  const launcher = appLauncher({
    packaged: app.isPackaged,
    platform: hostPlatform(),
    execPath: process.execPath,
    appDir: app.getAppPath(),
    resourcesDir: process.resourcesPath,
    env,
  });
  if (asked.help) {
    const answer = helpWords(asked.help, launcher);
    const text = `${answer.lines.join("\n")}\n`;
    return answer.code === 0
      ? { code: 0, out: text, error: "" }
      : { code: answer.code, out: "", error: text };
  }
  const words = bootAsked(asked.boot ?? []);
  if (!words) return { code: 2, out: "", error: `${BOOT_WORDS.usage.join("\n")}\n` };
  const program = (name: "SYSTEMCTL" | "LOGINCTL" | "LAUNCHCTL", command: string) => {
    const path = app.isPackaged ? undefined : settingFrom(env, name)?.trim();
    const found = path || findOnPath(command, hostEnv());
    return found ? systemSystemctl(found) : null;
  };
  const flavor = ownRunFlavor();
  const platform = hostPlatform();
  return runStartAtBoot(words, {
    platform,
    user: userInfo().username,
    uid: userInfo().uid,
    homeDir: homedir(),
    unitsDir: userUnitsDir(env, homedir()),
    daemonsDir: MAC_DAEMONS_DIR,
    label: runLabelOf(flavor),
    launcher,
    dataDir,
    env: app.isPackaged ? {} : carriedRunEnv(env),
    cwd: process.cwd(),
    systemctl: program("SYSTEMCTL", "systemctl"),
    loginctl: program("LOGINCTL", "loginctl"),
    launchctl: platform === "darwin" ? program("LAUNCHCTL", "launchctl") : null,
    schtasks: platform === "win32" ? windowsSchtasks(env, app.isPackaged) : null,
    account: windowsAccount(env, userInfo().username),
  });
}

/**
 * Which start entry is in place for this app and data folder now (`startEntryInPlace`). A
 * development run may name a file that stands in for the entry, so a test
 * never writes a real one; an installed app never reads it.
 */
export function ownStartEntry(dataDir: string): StartEntry {
  const platform = hostPlatform();
  const standIn = app.isPackaged ? undefined : settingFrom(process.env, "RUN_START_ENTRY")?.trim();
  if (standIn) {
    if (!existsSync(standIn)) return null;
    return platform === "linux"
      ? "linux-unit"
      : platform === "darwin"
        ? "mac-daemon"
        : platform === "win32"
          ? "windows-task"
          : null;
  }
  const flavor = ownRunFlavor();
  return startEntryInPlace({
    platform,
    unitsDir: userUnitsDir(process.env, homedir()),
    daemonsDir: MAC_DAEMONS_DIR,
    homeDir: homedir(),
    label: runLabelOf(flavor),
    dataDir,
  });
}
