import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * What the Windows installer check reads of the PC it installed on, through
 * Windows PowerShell (docs/windows.md, "The checks"). Each read's inputs
 * ride the environment, never a script's text, and it answers JSON.
 */

/** Windows PowerShell 5.1, which every Windows 11 carries. */
export const powershellPath = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function run(command: string, env: Record<string, string>): string {
  return execFileSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", command], {
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

/** Each running `Infinitary.exe run`, the command with no window, with the name of what started it; never a `work run`. */
export function runProcesses(): { readonly pid: number; readonly parent: string }[] {
  return psList(`
    $all = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $all | Where-Object { $_.Name -eq 'Infinitary.exe' -and $_.CommandLine -match '\\s"?run"?(\\s|$)' -and $_.CommandLine -notmatch '\\s"?work"?\\s+"?run' } | ForEach-Object {
      $parent = $byId[[int]$_.ParentProcessId]
      if (-not $parent -or $parent.Name -ne 'Infinitary.exe') {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = if ($parent) { $parent.Name } else { '' } }
      }
    }`);
}

/** Each running `Infinitary.exe work run`, the work a home gives this computer, with the name of what started it. */
export function workRunProcesses(): { readonly pid: number; readonly parent: string }[] {
  return psList(`
    $all = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $all | Where-Object { $_.Name -eq 'Infinitary.exe' -and $_.CommandLine -match '\\s"?work"?\\s+"?run"?(\\s|$)' } | ForEach-Object {
      $parent = $byId[[int]$_.ParentProcessId]
      if (-not $parent -or $parent.Name -ne 'Infinitary.exe') {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = if ($parent) { $parent.Name } else { '' } }
      }
    }`);
}

/** The run's task in this person's Task Scheduler, as Task Scheduler reads it; null for none. */
export type RunTask = {
  readonly state: string;
  /** What the task's last run ended with, as Task Scheduler records it. */
  readonly lastResult: string;
  readonly execute: string;
  readonly arguments: string;
  readonly userId: string;
  readonly logonType: string;
  /** Each sign-in trigger, on or off, one word each: Windows PowerShell 5.1 mangles a list in JSON. */
  readonly signInTriggers: string;
};

export function runTask(name: string): RunTask | null {
  return ps<RunTask | null>(
    `
    $task = Get-ScheduledTask -TaskPath '\\' -TaskName $env:RUN_TASK -ErrorAction SilentlyContinue
    if (-not $task) { $null } else {
      [pscustomobject]@{
        state = [string]$task.State
        lastResult = [string]($task | Get-ScheduledTaskInfo).LastTaskResult
        execute = [string]$task.Actions[0].Execute
        arguments = [string]$task.Actions[0].Arguments
        userId = [string]$task.Principal.UserId
        logonType = [string]$task.Principal.LogonType
        signInTriggers = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' } | ForEach-Object { if ($_.Enabled) { 'on' } else { 'off' } }) -join ' '
      }
    }`,
    { RUN_TASK: name },
  );
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
 * element that can be pressed; a classic dialog's button that offers no
 * such pattern gets its window's own click message; failing both, the
 * press focuses it and presses Enter as a person's keyboard would. When nothing could be pressed and
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
        # A classic dialog's button, which offers no pattern while its
        # window keeps it: the window's own click message presses it.
        if (-not $pressed -and $candidate.Current.ClassName -eq 'Button' -and $candidate.Current.NativeWindowHandle -ne 0) {
          if (-not ('InfDialog.Button' -as [type])) {
            Add-Type -Name Button -Namespace InfDialog -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);'
          }
          $pressed = [InfDialog.Button]::PostMessage([System.IntPtr]$candidate.Current.NativeWindowHandle, 0x00F5, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
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
/** The words of every window `pid` shows, as Windows' accessibility tree reads them. */
export function dialogWords(pid: number): string[] {
  return psList<string>(
    `
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $byProcess = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$env:DIALOG_PID)
    foreach ($window in $A::RootElement.FindAll('Children', $byProcess)) {
      foreach ($e in $window.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $e.Current.Name) { $e.Current.Name }
      }
    }`,
    { DIALOG_PID: String(pid) },
  );
}

/** The installed copy's top processes opened on `dataDir` with `--user-data-dir`. */
export function appProcessesOn(executable: string, dataDir: string): number[] {
  return psList<number>(
    `
    $all = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:APP_EXE })
    $ids = @($all | ForEach-Object { $_.ProcessId })
    $all | Where-Object { $ids -notcontains $_.ParentProcessId -and ([string]$_.CommandLine).Contains('"--user-data-dir=' + $env:APP_DATA + '"') } |
      ForEach-Object { [int]$_.ProcessId }`,
    { APP_EXE: executable, APP_DATA: dataDir },
  );
}

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

/**
 * Opens a Windows PowerShell console window, as a person opens one from the
 * Start menu, running the one line given there as a person's paste does;
 * answers its process number. `-NoExit` keeps the window and its words once
 * the line is done, for the check to read.
 */
export function openConsole(line: string): number {
  return ps<number>(
    "(Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NoExit','-Command','Invoke-Expression $env:CONSOLE_LINE' -PassThru).Id",
    { CONSOLE_LINE: line },
  );
}

/**
 * The console's own parts in Windows: its input takes key presses as a
 * keyboard's reach it, and its screen holds the words it shows. The check
 * leaves its own console and enters the one the process owns.
 */
const CONSOLE_PARTS = `
  Add-Type -TypeDefinition @'
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  public static class ConsoleParts {
    [StructLayout(LayoutKind.Explicit, Size = 20, CharSet = CharSet.Unicode)]
    public struct Key {
      [FieldOffset(0)] public ushort EventType;
      [FieldOffset(4)] public int KeyDown;
      [FieldOffset(8)] public ushort Repeat;
      [FieldOffset(10)] public ushort VirtualKey;
      [FieldOffset(12)] public ushort ScanCode;
      [FieldOffset(14)] public char Char;
      [FieldOffset(16)] public uint ControlKeys;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Info { public short Width; public short Height; public short CursorX; public short CursorY; public ushort Attributes; public short Left; public short Top; public short Right; public short Bottom; public short MaxX; public short MaxY; }
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteConsoleInputW(IntPtr input, Key[] keys, uint count, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out Info info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr output, StringBuilder into, uint length, uint at, out uint read);
    static IntPtr Open(string name) { return CreateFileW(name, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); }
    static Key Press(char c, ushort vk, bool down) { Key k = new Key(); k.EventType = 1; k.KeyDown = down ? 1 : 0; k.Repeat = 1; k.VirtualKey = vk; k.Char = c; return k; }
    public static bool Type(string words) {
      var keys = new System.Collections.Generic.List<Key>();
      foreach (char c in words) { ushort vk = (ushort)Char.ToUpperInvariant(c); keys.Add(Press(c, vk, true)); keys.Add(Press(c, vk, false)); }
      keys.Add(Press('\\r', 0x0D, true)); keys.Add(Press('\\r', 0x0D, false));
      uint written;
      return WriteConsoleInputW(Open("CONIN$"), keys.ToArray(), (uint)keys.Count, out written) && written == keys.Count;
    }
    public static string Screen() {
      IntPtr output = Open("CONOUT$");
      Info info;
      if (!GetConsoleScreenBufferInfo(output, out info)) return "";
      var into = new StringBuilder(info.Width * (info.CursorY + 1));
      uint read;
      ReadConsoleOutputCharacterW(output, into, (uint)(info.Width * (info.CursorY + 1)), 0, out read);
      var text = into.ToString();
      var lines = new StringBuilder();
      for (int at = 0; at + info.Width <= text.Length; at += info.Width) lines.AppendLine(text.Substring(at, info.Width).TrimEnd());
      return lines.ToString();
    }
  }
'@
  [void][ConsoleParts]::FreeConsole()
  if (-not [ConsoleParts]::AttachConsole([uint32]$env:CONSOLE_PID)) { throw "could not enter the console of $env:CONSOLE_PID" }`;

/** Types words and then Enter into the console the process owns, as a person's keys do. */
export function typeInConsole(pid: number, words: string): boolean {
  return ps<boolean>(`${CONSOLE_PARTS}\n[ConsoleParts]::Type($env:CONSOLE_WORDS)`, {
    CONSOLE_PID: String(pid),
    CONSOLE_WORDS: words,
  });
}

/** The words the console the process owns shows, line by line. */
export function consoleText(pid: number): string {
  return ps<string>(`${CONSOLE_PARTS}\n[ConsoleParts]::Screen()`, { CONSOLE_PID: String(pid) });
}
