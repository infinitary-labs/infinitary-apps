import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * What the Windows installer check reads of the PC it installed on, through
 * Windows PowerShell (docs/windows.md, "The checks"). Each read's inputs
 * ride the environment, never a script's text, and it answers JSON.
 */

const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function run(command: string, env: Record<string, string>): string {
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

/** Runs a Windows PowerShell script that answers one value, and parses its JSON. */
export function ps<T>(script: string, env: Record<string, string> = {}): T {
  // A subexpression, since a script ending in a statement (an if) cannot be piped.
  const out = run(`$(${script}) | ConvertTo-Json -Depth 4 -Compress`, env);
  return (out ? JSON.parse(out) : null) as T;
}

/**
 * Runs a Windows PowerShell script that answers a list, one JSON line per
 * item: Windows PowerShell 5.1 turns a whole array given to ConvertTo-Json
 * into an object of its value and Count, so no array is ever converted.
 */
export function psList<T>(script: string, env: Record<string, string> = {}): T[] {
  const out = run(`@(${script}) | ForEach-Object { $_ | ConvertTo-Json -Depth 4 -Compress }`, env);
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** The app's removal entry in Windows Settings, for this person (HKCU) or for everyone (HKLM). */
export type RemovalEntry = {
  readonly hive: "HKCU" | "HKLM";
  readonly DisplayName: string;
  readonly UninstallString: string;
};

export function removalEntries(): RemovalEntry[] {
  return psList<RemovalEntry>(`
    foreach ($hive in 'HKCU','HKLM') {
      Get-ChildItem "$($hive):\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object { $_.DisplayName -like 'Infinitary*' } |
        ForEach-Object { [pscustomobject]@{ hive = $hive; DisplayName = $_.DisplayName; UninstallString = $_.UninstallString } }
    }`);
}

/** The removal entry's uninstaller, the program its command runs. */
export function uninstallerOf(entry: RemovalEntry): string {
  return /^"([^"]+)"/.exec(entry.UninstallString)?.[1] ?? entry.UninstallString;
}

/** The Start menu entry for this person, and the app identity Windows reads from it. */
export function startMenuEntry(): { readonly link: string; readonly appId: string | null } | null {
  return ps(`
    $link = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Infinitary.lnk'
    if (-not (Test-Path -LiteralPath $link)) { $null } else {
      $app = Get-StartApps | Where-Object { $_.Name -eq 'Infinitary' } | Select-Object -First 1
      [pscustomobject]@{ link = $link; appId = $app.AppID }
    }`);
}

/** Each running Infinitary.exe started by something other than Infinitary itself, with that parent's name. */
export function topAppProcesses(): { readonly pid: number; readonly parent: string }[] {
  return psList(`
    $all = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $all | Where-Object { $_.Name -eq 'Infinitary.exe' } | ForEach-Object {
      $parent = $byId[[int]$_.ParentProcessId]
      if (-not $parent -or $parent.Name -ne 'Infinitary.exe') {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = if ($parent) { $parent.Name } else { '' } }
      }
    }`);
}

/** Which of these process numbers still run. */
export function stillRunning(pids: readonly number[]): number[] {
  return psList<number>(
    `$env:CHECK_PIDS -split ' ' | Where-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue } | ForEach-Object { [int]$_ }`,
    { CHECK_PIDS: pids.join(" ") },
  );
}

/**
 * Presses a button of a system dialog the process shows, by its words,
 * through Windows' accessibility tree, as a person's click would; false
 * while no such button shows. The element carrying the words may be the
 * button's label rather than the button, so the press goes to the nearest
 * element that can be pressed, or, failing that, focuses it and presses
 * Enter as a person's keyboard would. When nothing could be pressed and
 * treeFile is given, the dialog's accessibility tree is written there.
 */
export function pressDialogButton(pid: number, button: string, treeFile?: string): boolean {
  return ps<boolean>(
    `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
    $A = [System.Windows.Automation.AutomationElement]
    $invoke = [System.Windows.Automation.InvokePattern]::Pattern
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $byProcess = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$env:DIALOG_PID)
    $byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:DIALOG_BUTTON)
    $pressed = $false
    $tree = @()
    foreach ($window in $A::RootElement.FindAll('Children', $byProcess)) {
      foreach ($candidate in $window.FindAll('Descendants', $byName)) {
        $e = $candidate
        for ($i = 0; $i -lt 3 -and $e -and -not $pressed; $i++) {
          if (@($e.GetSupportedPatterns() | ForEach-Object { $_.Id }) -contains $invoke.Id) {
            $e.GetCurrentPattern($invoke).Invoke()
            $pressed = $true
          } else { $e = $walker.GetParent($e) }
        }
        if (-not $pressed -and $candidate.Current.IsKeyboardFocusable) {
          $candidate.SetFocus()
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          $pressed = $true
        }
        if ($pressed) { break }
      }
      if ($pressed) { break }
      foreach ($e in $window.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
        $tree += [pscustomobject]@{
          name = $e.Current.Name; type = $e.Current.ControlType.ProgrammaticName; class = $e.Current.ClassName
          focusable = $e.Current.IsKeyboardFocusable
          patterns = (@($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',')
        }
      }
    }
    if (-not $pressed -and $env:DIALOG_TREE -and $tree.Count -gt 0) {
      ConvertTo-Json -InputObject $tree -Depth 3 | Set-Content -LiteralPath $env:DIALOG_TREE
    }
    $pressed`,
    { DIALOG_PID: String(pid), DIALOG_BUTTON: button, DIALOG_TREE: treeFile ?? "" },
  );
}

/** A picture of the whole screen, for the check's evidence. */
export function screenshot(file: string): void {
  ps(
    `
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bitmap.Save($env:SHOT_FILE, [System.Drawing.Imaging.ImageFormat]::Png)
    $true`,
    { SHOT_FILE: file },
  );
}
