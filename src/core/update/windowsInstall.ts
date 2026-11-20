import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { UpdateChannel } from "@shared/update";
import { WINDOWS_HAND_OVER_WORDS } from "@shared/updateWords";
import { windowsPowerShell } from "../storage/ownerOnly";
import type { BuildDownload } from "./updateChannels";
import {
  downloadChecked,
  readChannelMarker,
  rememberUpdateChannel,
  restoreChannelMarker,
  UpdateInstallProblem,
} from "./updateDownload";

/**
 * How an installed Windows app updates itself (docs/alpha.md "Updates on
 * Windows"). The one update reader (`updateChecker.ts`) offers its
 * channel's installer from the builds file, under `windows`, this PC's
 * chip and `exe`; this module installs it. It downloads the installer and
 * keeps it only when its bytes match the published SHA-256, lets the
 * crew's work be saved, and hands the installer to a hidden Windows
 * PowerShell outside the task that started a command, so it outlives this
 * program (`windowsHandOverScript`). It waits for this program to end and
 * runs the installer silently, as an update, and opens the new copy on the
 * same data folder; the installer replaces the copy for this person alone,
 * with no administrator, and keeps the data folder. An update it does not
 * finish keeps this copy, opens it again, and this copy says so on its
 * Version row (`takeWindowsHandOverResult`).
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
  /** The release's page, where a hand-over that left no copy sends the person. */
  page: string;
};

/** The folder in the data root the installer downloads into. */
export const WINDOWS_UPDATES_FOLDER = "updates";

/** The file the hand-over leaves in the data root when it did not finish the update. */
export const WINDOWS_HAND_OVER_RESULT = "update-result.json";

/** What the hand-over says of an update it did not finish, for the copy it kept. */
export type WindowsHandOverResult = {
  outcome: "shutdown-timeout" | "install-failed";
  /** The version the hand-over kept, which says it when it opens. */
  from: string;
  to: string;
};

/** How the hand-over waits for this program to end before it gives up on the update. */
export const WINDOWS_SHUTDOWN_WAIT_SECONDS = 300;

/** A PowerShell literal of `text`, in single quotes. */
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * The hand-over: the hidden Windows PowerShell that outlives this program
 * and updates it (docs/alpha.md, "Updates on Windows"). It waits up to five
 * minutes for this program to end; one still running then has not finished
 * saving, so it installs nothing, says so for the kept copy, and opens that
 * copy again once it ends. Otherwise it runs the installer silently as an
 * update and reads how it ended. A finished installer opens the new copy:
 * the person's own data folder through the Start menu entry, as the
 * installer's own `--force-run` does, and a data folder the copy was opened
 * on (`--user-data-dir`) opened again on that folder. An installer that
 * stopped leaves the copy in place, which the hand-over opens again and
 * which then says so; one that left no copy is said in a message with
 * where to download the installer, which opens next.
 */
export function windowsHandOverScript(values: {
  pid: number;
  installer: string;
  executable: string;
  /** The data folder the copy was opened on, absent for the person's own. */
  dataDir?: string;
  resultFile: string;
  result: Omit<WindowsHandOverResult, "outcome">;
  page: string;
}): string {
  const said = (outcome: WindowsHandOverResult["outcome"]) =>
    literal(JSON.stringify({ outcome, ...values.result }));
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${literal(values.executable)}`,
    `$dataDir = ${literal(values.dataDir ?? "")}`,
    `$result = ${literal(values.resultFile)}`,
    "function Say([string]$what) { try { [IO.File]::WriteAllText($result, $what) } catch {} }",
    // The copy's windows on this data folder still open end first, as the
    // installer ends them, so the copy opens fresh and starts its command
    // again; a command or a work run is never one of them.
    "function OnThisFolder($p) { if ($dataDir) { $p.CommandLine.Contains('--user-data-dir=' + $dataDir) } else { -not $p.CommandLine.Contains('--user-data-dir') } }",
    "function Reopen {",
    "  $all = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine })",
    "  $ids = @($all | ForEach-Object { $_.ProcessId })",
    "  $all | Where-Object { $ids -notcontains $_.ParentProcessId -and $_.CommandLine -notmatch '\\s\"?run\"?(\\s|$)' -and (OnThisFolder $_) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }",
    "  if ($dataDir) { Start-Process -FilePath $exe -ArgumentList ('\"--user-data-dir=' + $dataDir + '\"') } else { Start-Process -FilePath $exe }",
    "}",
    `$old = Get-Process -Id ${values.pid} -ErrorAction SilentlyContinue`,
    `if ($old -and -not $old.WaitForExit(${WINDOWS_SHUTDOWN_WAIT_SECONDS * 1000})) { Say ${said("shutdown-timeout")}; $old.WaitForExit(); Reopen; exit }`,
    "$info = New-Object System.Diagnostics.ProcessStartInfo",
    `$info.FileName = ${literal(values.installer)}`,
    `$info.Arguments = ${literal(values.dataDir ? "--updated /S" : "--updated /S --force-run")}`,
    "$info.UseShellExecute = $false",
    "try { $installer = [System.Diagnostics.Process]::Start($info); $installer.WaitForExit(); $code = $installer.ExitCode } catch { $code = -1 }",
    "if ($code -eq 0) { if ($dataDir) { Reopen }; exit }",
    `Say ${said("install-failed")}`,
    "if (Test-Path -LiteralPath $exe) { Reopen; exit }",
    "Add-Type -AssemblyName System.Windows.Forms",
    `[void][System.Windows.Forms.MessageBox]::Show(${literal(WINDOWS_HAND_OVER_WORDS.noCopy(values.page))}, 'Infinitary')`,
    `Start-Process ${literal(values.page)}`,
  ].join("\n");
}

/**
 * What starts the hand-over. A command Task Scheduler started is in that
 * task's group of processes, which Windows ends with the command, and a
 * detached child stays in it: a hand-over started directly died with the
 * command before the installer ran. So this script, run directly, only asks
 * Windows' own process service (`Win32_Process.Create`) to start the
 * hand-over (`windowsHandOverScript`, riding this script's environment
 * encoded, never the command's text), which then belongs to no task and
 * outlives this program. It exits 1 when Windows refused to start it.
 */
export const RUN_INSTALLER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$encoded = $env:INFINITARY_UPDATE_HAND_OVER",
  "$shell = Join-Path $PSHOME 'powershell.exe'",
  "$hidden = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
  '$started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$shell`" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"; ProcessStartupInformation = $hidden }',
  "if ($started.ReturnValue -ne 0) { exit 1 }",
].join("\n");

/**
 * What the hand-over said of an update it did not finish, for this copy,
 * read once: the file goes as it is read, and one written for another
 * version (a copy installed since) says nothing.
 */
export function takeWindowsHandOverResult(
  dataRoot: string,
  currentVersion: string,
): WindowsHandOverResult["outcome"] | null {
  const file = join(dataRoot, WINDOWS_HAND_OVER_RESULT);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  try {
    const result = JSON.parse(text.replace(/^\uFEFF/, "")) as Partial<WindowsHandOverResult>;
    if (result.from !== currentVersion) return null;
    return result.outcome === "shutdown-timeout" || result.outcome === "install-failed"
      ? result.outcome
      : null;
  } catch {
    return null;
  }
}

/** What the Version row says of an update the hand-over did not finish. */
export function windowsHandOverProblem(outcome: WindowsHandOverResult["outcome"]): string {
  return outcome === "shutdown-timeout"
    ? WINDOWS_HAND_OVER_WORDS.shutdownTimeout
    : WINDOWS_HAND_OVER_WORDS.installFailed;
}

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
  /** This program's process, which the hand-over waits for. */
  pid?: number;
  /** The version running, which a hand-over that did not finish keeps. */
  currentVersion: string;
  /** The program the hand-over opens again: this copy's own. */
  executable: string;
  /** The data folder this copy was opened on (`--user-data-dir`), absent for the person's own. */
  openedOn?: string;
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

  function handOver(file: string, plan: WindowsInstallPlan): Promise<void> {
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
              INFINITARY_UPDATE_HAND_OVER: Buffer.from(
                windowsHandOverScript({
                  pid: options.pid ?? process.pid,
                  installer: file,
                  executable: options.executable,
                  ...(options.openedOn ? { dataDir: options.openedOn } : {}),
                  resultFile: join(options.dataRoot, WINDOWS_HAND_OVER_RESULT),
                  result: { from: options.currentVersion, to: plan.version },
                  page: plan.page,
                }),
                "utf16le",
              ).toString("base64"),
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
    // The new copy follows the channel it came from, as on Linux. The marker
    // is written before the hand-over, since the installer runs after this
    // program ends: a marker that cannot be written hands nothing over, and
    // a hand-over that fails puts the earlier marker back, or says it could not.
    let earlier: string | null = null;
    let remembered = false;
    try {
      await downloadChecked(options.fetchImpl, plan.download, file);
      await beforeReplace?.();
      try {
        earlier = await readChannelMarker(options.dataRoot);
        await rememberUpdateChannel(options.dataRoot, plan.channel, plan.version);
      } catch {
        throw new UpdateInstallProblem(
          "Infinitary could not record the update's channel, so nothing was installed.",
        );
      }
      remembered = true;
      await handOver(file, plan);
    } catch (caught) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      if (remembered) {
        try {
          await restoreChannelMarker(options.dataRoot, earlier);
        } catch {
          const said = caught instanceof UpdateInstallProblem ? `${caught.message} ` : "";
          throw new UpdateInstallProblem(
            `${said}Infinitary could not put back the update channel it followed before, so check the channel in Settings → General.`,
          );
        }
      }
      throw caught;
    }
    options.end();
  };
}
