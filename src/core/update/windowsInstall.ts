import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import * as m from "@shared/i18n/messages.generated";
import type { UpdateChannel } from "@shared/update";
import { WINDOWS_HAND_OVER_WORDS } from "@shared/updateWords";
import { powerShellWord } from "../devices/joinCommand";
import { windowsPowerShell } from "../storage/ownerOnly";
import { type BuildDownload, UPDATE_CHANNEL_MARKER } from "./updateChannels";
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
  /** False when the hand-over could not put back the channel marker the kept copy followed. */
  channelKept?: boolean;
};

/** How the hand-over waits for this program to end before it gives up on the update. */
export const WINDOWS_SHUTDOWN_WAIT_SECONDS = 300;

/** How long the hand-over waits for a copy it opens to show its window on its data folder. */
export const WINDOWS_REOPEN_READY_SECONDS = 120;

/**
 * A PowerShell literal of `text`, in single quotes: the typographic single
 * quotes a translation holds are doubled too, since PowerShell reads them as
 * quotes and would refuse the whole script.
 */
const literal = powerShellWord;

/**
 * The hand-over: the hidden Windows PowerShell that outlives this program
 * and updates it (docs/alpha.md, "Updates on Windows"). It waits up to five
 * minutes for this program to end; one still running then has not finished
 * saving, so it installs nothing and, once it ends, opens the kept copy
 * again. Otherwise it runs the installer silently as an update and reads
 * how it ended. A finished installer opens the new copy: the person's own
 * data folder through the Start menu entry, as the installer's own
 * `--force-run` does, and a data folder the copy was opened on
 * (`--user-data-dir`) opened again on that folder by the hand-over. An
 * installer that stopped leaves the kept copy, which the hand-over opens
 * again. Before it opens the kept copy it puts back the channel marker
 * that copy followed and says what happened in the result file, which the
 * copy reads as it starts. Opening a copy first ends that data folder's
 * windows still open, as the installer would, and only windows: a command
 * or work run has none. A copy counts as opened only once a new window
 * shows on its data folder, the installer's own restart included; a copy
 * missing its program or its app, or one that shows none in time, is said
 * in a message with where to download the installer, which opens next. It
 * is plain PowerShell, compiling nothing, so a computer that refuses code
 * compiled as it runs still updates.
 */
export function windowsHandOverScript(values: {
  pid: number;
  installer: string;
  executable: string;
  /** The data folder the copy was opened on, absent for the person's own. */
  dataDir?: string;
  resultFile: string;
  result: Omit<WindowsHandOverResult, "outcome" | "channelKept">;
  /** The channel marker, and what it held before this update: null for none. */
  marker: { file: string; earlier: string | null };
  page: string;
  /** How long it waits for this program to end; five minutes but in its own check. */
  waitSeconds?: number;
  /** How long a copy it opens has to show its window; two minutes but in its own check. */
  readySeconds?: number;
}): string {
  const wait = values.waitSeconds ?? WINDOWS_SHUTDOWN_WAIT_SECONDS;
  const ready = values.readySeconds ?? WINDOWS_REOPEN_READY_SECONDS;
  // i18n-exempt: a PowerShell script Windows runs, never shown to a person
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${literal(values.executable)}`,
    `$dataDir = ${literal(values.dataDir ?? "")}`,
    `$result = ${literal(values.resultFile)}`,
    `$marker = ${literal(values.marker.file)}`,
    `$earlier = ${values.marker.earlier === null ? "$null" : literal(values.marker.earlier)}`,
    `$page = ${literal(values.page)}`,
    "$channelKept = $true",
    "function PutChannelBack {",
    "  try {",
    "    if ($null -eq $earlier) { if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force } }",
    "    else { $temp = $marker + '.restore'; [IO.File]::WriteAllText($temp, $earlier); Move-Item -LiteralPath $temp -Destination $marker -Force }",
    "  } catch { $script:channelKept = $false }",
    "}",
    `function Say([string]$outcome) { try { [IO.File]::WriteAllText($result, (ConvertTo-Json -Compress @{ outcome = $outcome; from = ${literal(values.result.from)}; to = ${literal(values.result.to)}; channelKept = $channelKept })) } catch {} }`,
    // A command line split into its arguments after the program's own
    // name, as Windows splits it for the program it starts: spaces or tabs
    // between arguments, quotes around them, and backslashes literal except
    // before a quote; $null for a quote left open, which reads two ways.
    // Plain PowerShell, so nothing is compiled.
    "function Gap($c) { $c -eq [char]32 -or $c -eq [char]9 }",
    "function ArgumentsOf([string]$line) {",
    "  $parts = New-Object System.Collections.Generic.List[string]",
    "  $i = 0; $n = $line.Length",
    "  if ($n -gt 0 -and $line[0] -eq [char]34) { $i = $line.IndexOf([char]34, 1); if ($i -lt 0) { return $null }; $i++ }",
    "  else { while ($i -lt $n -and -not (Gap $line[$i])) { $i++ } }",
    "  while ($true) {",
    "    while ($i -lt $n -and (Gap $line[$i])) { $i++ }",
    "    if ($i -ge $n) { break }",
    "    $part = New-Object System.Text.StringBuilder; $quoted = $false",
    "    while ($i -lt $n -and ($quoted -or -not (Gap $line[$i]))) {",
    "      $slashes = 0; while ($i -lt $n -and $line[$i] -eq [char]92) { $slashes++; $i++ }",
    "      if ($i -lt $n -and $line[$i] -eq [char]34) {",
    "        [void]$part.Append([char]92, [int][math]::Floor($slashes / 2))",
    "        if ($slashes % 2 -eq 1) { [void]$part.Append([char]34) } else { $quoted = -not $quoted }",
    "        $i++",
    "      } else {",
    "        [void]$part.Append([char]92, $slashes)",
    "        if ($i -lt $n -and ($quoted -or -not (Gap $line[$i]))) { [void]$part.Append($line[$i]); $i++ }",
    "      }",
    "    }",
    "    if ($quoted) { return $null }",
    "    $parts.Add($part.ToString())",
    "  }",
    "  ,$parts.ToArray()",
    "}",
    // A data folder in full, or $null for one that names no drive or share:
    // a relative folder means the folder another process started in, which
    // this one cannot know.
    "function Canonical([string]$path) {",
    "  if (-not $path) { return '' }",
    "  if ($path -notmatch '^([A-Za-z]:\\\\|\\\\\\\\)') { return $null }",
    "  try { [IO.Path]::GetFullPath($path).TrimEnd('\\') } catch { $null }",
    "}",
    "$want = Canonical $dataDir",
    // The data folder a process was opened on, as Chromium reads its
    // command line: the last user-data-dir switch (any prefix or case)
    // before a lone --; '' for the person's own, and $null when its command
    // line or folder cannot be read, so the process is never taken for one
    // on this folder.
    "function FolderOf([string]$line) {",
    "  if (-not $line) { return $null }",
    "  $folder = ''",
    "  $parts = ArgumentsOf $line",
    "  if ($null -eq $parts) { return $null }",
    "  foreach ($part in $parts) {",
    "    if ($part -eq '--') { break }",
    "    if ($part -match '^(--|-|/)user-data-dir=(.*)$') { $folder = Canonical $Matches[2]; if ($null -eq $folder) { return $null } }",
    "  }",
    "  $folder",
    "}",
    // The copy's own top processes opened on this data folder that show a
    // window: a command or a work run shows none. Processes that cannot be
    // read are none, so nothing is stopped and no window counts as opened.
    "function OnThisFolder {",
    "  try {",
    "    $all = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe })",
    "    $ids = @($all | ForEach-Object { $_.ProcessId })",
    "    foreach ($p in $all) {",
    "      if ($ids -contains $p.ParentProcessId) { continue }",
    "      $folder = FolderOf ([string]$p.CommandLine)",
    "      if ($null -eq $folder -or $folder -ne $want) { continue }",
    "      $running = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue",
    "      if ($running -and $running.MainWindowHandle -ne [IntPtr]::Zero) { $running }",
    "    }",
    "  } catch {}",
    "}",
    // Whether a window other than those in $before shows on this data
    // folder within the wait: a copy that never shows one, or only the old
    // window still there, has not opened again.
    "function OpenedAgain($before) {",
    `  $deadline = (Get-Date).AddSeconds(${ready})`,
    "  while ((Get-Date) -lt $deadline) {",
    "    if (@(OnThisFolder | Where-Object { $before -notcontains $_.Id }).Count -gt 0) { return $true }",
    "    Start-Sleep -Seconds 1",
    "  }",
    "  $false",
    "}",
    "function Recover {",
    "  try {",
    "    Add-Type -AssemblyName System.Windows.Forms",
    `    [void][System.Windows.Forms.MessageBox]::Show(${literal(WINDOWS_HAND_OVER_WORDS.noCopy(values.page))}, 'Infinitary')`,
    "  } catch {}",
    "  Start-Process $page",
    "}",
    "function Reopen {",
    "  $before = @(OnThisFolder | ForEach-Object { $_.Id })",
    // The old window ends before the copy opens again, or the new one
    // would hand itself to it, as a second window on one folder does.
    "  foreach ($id in $before) {",
    "    $window = Get-Process -Id $id -ErrorAction SilentlyContinue",
    "    if (-not $window) { continue }",
    "    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue",
    "    if (-not $window.WaitForExit(30000)) { Recover; return }",
    "  }",
    "  $app = Join-Path (Split-Path -Parent $exe) 'resources\\app.asar'",
    "  if (-not ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $app))) { Recover; return }",
    "  try {",
    "    if ($dataDir) { Start-Process -FilePath $exe -ArgumentList ('\"--user-data-dir=' + $dataDir + '\"') } else { Start-Process -FilePath $exe }",
    "  } catch { Recover; return }",
    "  if (-not (OpenedAgain $before)) { Recover }",
    "}",
    `$old = Get-Process -Id ${values.pid} -ErrorAction SilentlyContinue`,
    `if ($old -and -not $old.WaitForExit(${wait * 1000})) { PutChannelBack; Say 'shutdown-timeout'; $old.WaitForExit(); Reopen; exit }`,
    "$beforeInstall = @(OnThisFolder | ForEach-Object { $_.Id })",
    "$info = New-Object System.Diagnostics.ProcessStartInfo",
    `$info.FileName = ${literal(values.installer)}`,
    `$info.Arguments = ${literal(values.dataDir ? "--updated /S" : "--updated /S --force-run")}`,
    "$info.UseShellExecute = $false",
    "try { $installer = [System.Diagnostics.Process]::Start($info); $installer.WaitForExit(); $code = $installer.ExitCode } catch { $code = -1 }",
    // The installer's own --force-run opens the person's own folder; a
    // fresh window there shows it did, and none gets the recovery message.
    "if ($code -eq 0) { if ($dataDir) { Reopen } elseif (-not (OpenedAgain $beforeInstall)) { Recover }; exit }",
    "PutChannelBack",
    "Say 'install-failed'",
    "Reopen",
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
// i18n-exempt: a PowerShell script Windows runs, never shown to a person
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
 * version (a copy installed since) says nothing. A file that cannot be
 * removed still says it, and says it again at the next start.
 */
export function takeWindowsHandOverResult(
  dataRoot: string,
  currentVersion: string,
): WindowsHandOverResult | null {
  const file = join(dataRoot, WINDOWS_HAND_OVER_RESULT);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // Said again at the next start rather than not at all.
  }
  try {
    const result = JSON.parse(text.replace(/^\uFEFF/, "")) as Partial<WindowsHandOverResult>;
    if (result.from !== currentVersion) return null;
    if (result.outcome !== "shutdown-timeout" && result.outcome !== "install-failed") return null;
    return {
      outcome: result.outcome,
      from: result.from,
      to: String(result.to ?? ""),
      ...(result.channelKept === false ? { channelKept: false } : {}),
    };
  } catch {
    return null;
  }
}

/** What the Version row says of an update the hand-over did not finish. */
export function windowsHandOverProblem(result: WindowsHandOverResult): string {
  const said =
    result.outcome === "shutdown-timeout"
      ? WINDOWS_HAND_OVER_WORDS.shutdownTimeout
      : WINDOWS_HAND_OVER_WORDS.installFailed;
  return result.channelKept === false
    ? `${said} ${WINDOWS_HAND_OVER_WORDS.channelNotPutBack}`
    : said;
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

  function handOver(file: string, plan: WindowsInstallPlan, earlier: string | null): Promise<void> {
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
                  marker: { file: join(options.dataRoot, UPDATE_CHANNEL_MARKER), earlier },
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
        reject(new UpdateInstallProblem(m.updateInstallerNoStart()));
        return;
      }
      const refused = () => reject(new UpdateInstallProblem(m.updateInstallerNoStart()));
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
        throw new UpdateInstallProblem(m.updateChannelNotRecorded());
      }
      remembered = true;
      await handOver(file, plan, earlier);
    } catch (caught) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      if (remembered) {
        try {
          await restoreChannelMarker(options.dataRoot, earlier);
        } catch {
          const said = caught instanceof UpdateInstallProblem ? `${caught.message} ` : "";
          throw new UpdateInstallProblem(`${said}${WINDOWS_HAND_OVER_WORDS.channelNotPutBack}`);
        }
      }
      throw caught;
    }
    options.end();
  };
}
