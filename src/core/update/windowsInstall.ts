import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { UpdateChannel } from "@shared/update";
import { windowsPowerShell } from "../storage/ownerOnly";
import type { BuildDownload } from "./updateChannels";
import { downloadChecked, rememberUpdateChannel, UpdateInstallProblem } from "./updateDownload";

/**
 * How an installed Windows app updates itself (docs/alpha.md "Updates on
 * Windows"). The one update reader (`updateChecker.ts`) offers its
 * channel's installer from the builds file, under `windows`, this PC's
 * chip and `exe`; this module installs it. It downloads the installer and
 * keeps it only when its bytes match the published SHA-256, lets the
 * crew's work be saved, and hands the installer to Windows PowerShell,
 * which waits for this program to end and then runs it silently, as an
 * update (`--updated /S --force-run`), outside the task that started a
 * command, so it outlives this program. The installer replaces the copy for
 * this person alone, with no administrator, keeps the data folder, and
 * opens the new copy through its Start menu entry, as the Start menu does.
 *
 * Nothing here checks who published the installer yet: until the Windows
 * package is signed, an update trusts the download site and its checksum,
 * as a Linux package does.
 */

/** This installation, as the update reader keys the builds file. */
export type WindowsInstallation = {
  /** `x64`: the builds file's chip. */
  chip: string;
};

/** One offered installer the app runs: what version, from which channel and where. */
export type WindowsInstallPlan = {
  version: string;
  channel: UpdateChannel;
  download: BuildDownload;
};

/** The folder in the data root the installer downloads into. */
export const WINDOWS_UPDATES_FOLDER = "updates";

/**
 * What runs the installer. A command Task Scheduler started is in that
 * task's group of processes, which Windows ends with the command, and a
 * detached child stays in it: a hand-over started directly died with the
 * command before the installer ran. So this script, run directly, only asks
 * Windows' own process service (`Win32_Process.Create`) to start the
 * hand-over, which then belongs to no task and outlives this program. The
 * hand-over waits for the app's own process to end, so nothing of the old
 * copy is running when the installer replaces it, then starts the installer
 * as an update. Paths and the process number ride this script's environment,
 * never the command's text; the script quotes them into the hand-over's
 * script itself. A wait that runs past five minutes starts the installer
 * anyway, which ends what is left of the old copy itself. It exits 1 when
 * Windows refused to start the hand-over.
 */
export const RUN_INSTALLER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$wait = [int]$env:INFINITARY_UPDATE_WAIT",
  '$installer = $env:INFINITARY_UPDATE_INSTALLER.Replace("\'", "\'\'")',
  "$handOver = \"Wait-Process -Id $wait -Timeout 300 -ErrorAction SilentlyContinue; Start-Process -FilePath '$installer' -ArgumentList '--updated','/S','--force-run'\"",
  "$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($handOver))",
  "$shell = Join-Path $PSHOME 'powershell.exe'",
  "$hidden = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
  '$started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$shell`" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"; ProcessStartupInformation = $hidden }',
  "if ($started.ReturnValue -ne 0) { exit 1 }",
].join("\n");

export type WindowsInstallerOptions = {
  /** The run's own userData: the downloads folder and the channel marker. */
  dataRoot: string;
  fetchImpl: typeof fetch;
  /** Every child's environment (`hostEnv`). */
  env: () => NodeJS.ProcessEnv;
  /**
   * Ends this program for the installer, without starting it again: the
   * installer opens the new copy. A window quits; a command ends as for an
   * update, with 75.
   */
  end: () => void;
  /** This program's process, which the installer waits for. */
  pid?: number;
  spawnImpl?: typeof spawn;
};

/**
 * The installer an update notice runs. It answers once the installer was
 * handed over and this program is ending; it throws, having replaced
 * nothing, when the download or the hand-over failed.
 */
export function createWindowsInstaller(
  options: WindowsInstallerOptions,
): (plan: WindowsInstallPlan, beforeReplace?: () => Promise<void>) => Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const folder = join(options.dataRoot, WINDOWS_UPDATES_FOLDER);
  // The installer an earlier update ran is still there, held while it
  // opened this copy; gone by now, or at the next update.
  const leftover = rm(folder, { recursive: true, force: true }).catch(() => undefined);

  function handOver(file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = options.env();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnImpl(
          windowsPowerShell(env),
          ["-NoProfile", "-NonInteractive", "-Command", RUN_INSTALLER_SCRIPT],
          {
            env: {
              ...env,
              INFINITARY_UPDATE_WAIT: String(options.pid ?? process.pid),
              INFINITARY_UPDATE_INSTALLER: file,
            },
            stdio: "ignore",
            windowsHide: true,
          },
        );
      } catch {
        reject(
          new UpdateInstallProblem("The installer could not start, so nothing was installed."),
        );
        return;
      }
      const refused = () =>
        reject(
          new UpdateInstallProblem("The installer could not start, so nothing was installed."),
        );
      child.once("error", refused);
      // The script ends once Windows started the hand-over, or refused to.
      child.once("exit", (code) => (code === 0 ? resolve() : refused()));
    });
  }

  // `beforeReplace` runs once the download is checked and before the
  // installer is handed over (docs/alpha.md, "Saving work before an
  // update"); a throw there hands nothing over.
  return async (plan, beforeReplace) => {
    await leftover;
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    const file = join(folder, basename(new URL(plan.download.url).pathname));
    try {
      await downloadChecked(options.fetchImpl, plan.download, file);
      await beforeReplace?.();
      await handOver(file);
    } catch (caught) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw caught;
    }
    // The new copy follows the channel it came from, as on Linux.
    await rememberUpdateChannel(options.dataRoot, plan.channel, plan.version).catch(
      () => undefined,
    );
    options.end();
  };
}
