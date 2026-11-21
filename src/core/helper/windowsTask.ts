import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivate } from "../devices/identity";
import { hostEnv } from "../hostEnv";
import { encodedCommand, windowsPowerShell } from "../storage/ownerOnly";
import type { Launchctl, Launcher } from "./background";

/**
 * The command's start entry on Windows (docs/run.md, "On Windows"; INF-4243's
 * plan, piece 5): a task in this user's own Task Scheduler that runs
 * `<app> run` as them, in their signed-in session, and whose sign-in trigger
 * is on while Start at login is. `infinitary start-at-boot` and the window's
 * starter write the same task under the run's label (`runLabelOf`), as a
 * Mac's login agent and a Linux unit are one entry for both.
 *
 * The task as it was registered is kept in the data folder
 * (`RUN_TASK_FILE`), the file `schtasks /Create /XML` reads, so whether it
 * is in place and whether it starts at sign-in are read from that file
 * without asking Task Scheduler, as a Mac's agent and a Linux unit are read
 * from theirs. Nothing here needs an administrator: a task that runs as the
 * user who registers it, only while they are signed in, is theirs to make.
 *
 * Task Scheduler starts the run at sign-in and when asked; it never starts
 * it again after it ends, so the window offers Start it here at once after
 * any end (`entryRestarts`, src/main/besideRun.ts). The work's own task
 * (`workTaskXml`, docs/helper.md "In the background") is started again
 * within a minute of any end while its account is signed in, as launchd and
 * systemd keep the work alive on a Mac and Linux.
 */

/**
 * `schtasks.exe`, asked as `launchctl` is: its arguments, then what it
 * answered; with `lookup`, Task Scheduler's own answer for one task, which
 * `schtasks.exe` cannot give, since it fails alike for a task it does not
 * hold and one it will not show, in words that follow the system's language.
 */
export type Schtasks = Launchctl & { lookup?: TaskLookup };

/**
 * One task in Task Scheduler's root folder, as Task Scheduler itself answers
 * for it by name: gone only on its own not-found answer; there; or unknown,
 * a refusal, a timeout or no answer at all.
 */
export type TaskLookup = (label: string) => Promise<"gone" | "there" | "unknown">;

/** The task as it was registered, in the data folder: what `schtasks /Create /XML` reads. */
export const RUN_TASK_FILE = "run-task.xml";

/** The registered task's file in a data folder. */
export function runTaskFile(dataDir: string): string {
  return join(dataDir, RUN_TASK_FILE);
}

/**
 * Who the task runs as and whose sign-in starts it, as Task Scheduler names
 * an account: `DOMAIN\user`, where the domain is this computer's own name
 * for a local account. A sign-in trigger with no account would start it at
 * everyone's sign-in, which only an administrator may set up.
 */
export function windowsAccount(env: NodeJS.ProcessEnv, username: string): string {
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

/**
 * One word of a Windows command line, quoted as the program's own reading
 * of its command line (CommandLineToArgvW) reads it back: a word with a
 * space, a tab or a quote is quoted, a quote inside escaped, and the
 * backslashes before a quote doubled.
 */
export function windowsWord(word: string): string {
  if (word !== "" && !/[\s"]/.test(word)) return word;
  let quoted = '"';
  let slashes = 0;
  for (const char of word) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? slashes * 2 + 1 : slashes) + char;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

/** Text an XML element holds, its markup kept literal. */
function xmlText(text: string): string {
  if (/[\0\r\n]/.test(text)) throw new Error("A task's file cannot hold a line break.");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Text read back from the file, as `xmlText` wrote it. */
function fromXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * The task: `<app> run`, with `--settings <file>` when one is named, as
 * `account`, in their signed-in session only (`InteractiveToken`), never
 * with more than their own rights, at the priority of an app the person
 * started (4; Task Scheduler's own default, 7, is below it), with no time
 * limit, on battery too, and one run at a time. Its sign-in trigger is on
 * while `atLogin` holds.
 */
export function runTaskXml(options: {
  launcher: Launcher;
  account: string;
  atLogin: boolean;
  settings?: string;
  /**
   * The label of this app's own agent the task is, which its run reads as
   * Task Scheduler sets no variable (`--agent`, src/main/runCommand.ts).
   */
  agent?: string;
}): string {
  return taskXml({
    launcher: options.launcher,
    account: options.account,
    atLogin: options.atLogin,
    words: [
      "run",
      ...(options.settings ? ["--settings", options.settings] : []),
      ...(options.agent ? ["--agent", options.agent] : []),
    ],
    description: "Starts Infinitary with no window (docs/run.md).",
    again: false,
  });
}

/**
 * How often Task Scheduler starts the work's task again while its account is
 * signed in: its shortest repetition. A run going already is left alone
 * (`IgnoreNew`), so this only starts one that ended - a crash, or an update
 * that ended it to start again (exit 75) - as launchd and systemd keep theirs
 * alive. Task Scheduler's own restart on failure counts only a task it could
 * not start, never a program that ended.
 */
export const WORK_TASK_AGAIN = "PT1M";

/**
 * The work's task (docs/helper.md, "In the background", "On Windows"):
 * `<app> work run` as `account`, at each of their sign-ins and, while they
 * are signed in, started again within a minute after any end. Otherwise
 * as the command's task (`runTaskXml`): their own session and rights, an
 * app's priority, no time limit and one run at a time.
 */
export function workTaskXml(options: { launcher: Launcher; account: string }): string {
  return taskXml({
    launcher: options.launcher,
    account: options.account,
    atLogin: true,
    words: ["work", "run"],
    description: "Runs Infinitary's work for its home (docs/helper.md).",
    again: true,
  });
}

function taskXml(options: {
  launcher: Launcher;
  account: string;
  atLogin: boolean;
  words: readonly string[];
  description: string;
  again: boolean;
}): string {
  const [executable, ...rest] = [
    options.launcher.executable,
    ...options.launcher.args,
    ...options.words,
  ];
  const account = xmlText(options.account);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlText(options.description)}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    `      <Enabled>${options.atLogin}</Enabled>`,
    `      <UserId>${account}</UserId>`,
    "    </LogonTrigger>",
    // A time trigger that repeats with no end: with the account's own
    // session as the task's only one, it fires only while they are signed in.
    ...(options.again
      ? [
          "    <TimeTrigger>",
          "      <Repetition>",
          `        <Interval>${WORK_TASK_AGAIN}</Interval>`,
          "        <StopAtDurationEnd>false</StopAtDurationEnd>",
          "      </Repetition>",
          "      <StartBoundary>2000-01-01T00:00:00</StartBoundary>",
          "      <Enabled>true</Enabled>",
          "    </TimeTrigger>",
        ]
      : []),
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${account}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>false</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>4</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlText(executable ?? "")}</Command>`,
    `      <Arguments>${xmlText(rest.map(windowsWord).join(" "))}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** What a registered task's file keeps for the next one: its settings file, and whether its sign-in starts it. */
export type RunTaskKept = { settings?: string; atLogin: boolean };

/** The words of a Windows command line, read as `windowsWord` writes them. */
function windowsWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let slashes = 0;
  for (const char of line) {
    if (char === "\\") {
      slashes += 1;
      inWord = true;
      continue;
    }
    if (char === '"') {
      word += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2 === 1) word += '"';
      else quoted = !quoted;
      slashes = 0;
      inWord = true;
      continue;
    }
    word += "\\".repeat(slashes);
    slashes = 0;
    if (/\s/.test(char) && !quoted) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += char;
    inWord = true;
  }
  word += "\\".repeat(slashes);
  if (inWord) words.push(word);
  return words;
}

/** The registered task's file, read back; null where there is none or it cannot be read. */
export function readRunTask(file: string): RunTaskKept | null {
  let text: string;
  try {
    text = readFileSync(file).toString("utf16le").replace(/^﻿/, "");
  } catch {
    return null;
  }
  const trigger = /<LogonTrigger>\s*<Enabled>(true|false)<\/Enabled>/.exec(text)?.[1];
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(text)?.[1];
  if (trigger === undefined || args === undefined) return null;
  const words = windowsWords(fromXml(args));
  const at = words.indexOf("--settings");
  const settings = at >= 0 ? words[at + 1] : undefined;
  return { atLogin: trigger === "true", ...(settings === undefined ? {} : { settings }) };
}

/**
 * Writes the task's file and registers it under `label`, replacing the one
 * there: true once Task Scheduler took it. The file is UTF-16, which
 * `schtasks /XML` reads; it stays as the record of what was registered.
 */
export async function registerRunTask(
  schtasks: Schtasks,
  options: { label: string; file: string; xml: string },
): Promise<boolean> {
  writeTaskFile(options.file, options.xml);
  return createTask(schtasks, options);
}

/** Writes a task's file as `schtasks /XML` reads it: UTF-16 with its mark. */
export function writeTaskFile(file: string, xml: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(file, Buffer.from(`﻿${xml}`, "utf16le"));
}

/** Registers the task its file holds under `label`, replacing the one there: true once Task Scheduler took it. */
export async function createTask(
  schtasks: Schtasks,
  options: { label: string; file: string },
): Promise<boolean> {
  return (await schtasks(["/Create", "/TN", options.label, "/XML", options.file, "/F"])).ok;
}

/** Asks Task Scheduler to start the task now: true once it took the request. */
export async function startRunTask(schtasks: Schtasks, label: string): Promise<boolean> {
  return (await schtasks(["/Run", "/TN", label])).ok;
}

/**
 * Takes the task away and its file with it. A run it started keeps going
 * until it stops: Task Scheduler's own end of a task ends its program at
 * once, with no clean stop, so a stop is asked of the run itself instead.
 * A task Task Scheduler would not take away keeps its file for a later
 * removal and rejects, so its caller says so, unless Task Scheduler answers
 * that it holds no task by that name (`Schtasks.lookup`): a list of tasks
 * leaves out one this account cannot read, and a task still registered may
 * or may not start at sign-in.
 */
export async function removeRunTask(
  schtasks: Schtasks,
  options: { label: string; file: string },
): Promise<boolean> {
  const was = existsSync(options.file);
  const out = await schtasks(["/Delete", "/TN", options.label, "/F"]);
  const record = out.ok
    ? "gone"
    : await (schtasks.lookup?.(options.label) ?? Promise.resolve("unknown" as const)).catch(
        () => "unknown" as const,
      );
  if (record === "there")
    throw new Error(
      `Task Scheduler did not take Infinitary's task away, so it is still registered: ${out.output}`,
    );
  if (record === "unknown")
    throw new Error(
      `Task Scheduler did not take Infinitary's task away, and could not say whether it is still registered: ${out.output}`,
    );
  rmSync(options.file, { force: true });
  return was;
}

/**
 * Task Scheduler's own answer for one task in its root folder, through its
 * scripting interface in Windows' own PowerShell: its not-found error
 * (0x80070002) for that exact task is gone, and any other error, a PowerShell that cannot start
 * included, is unknown (`TaskLookup`).
 */
export function powerShellTaskLookup(
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

/**
 * Asks Task Scheduler for the task its setting names. Only the exact task's
 * lookup can answer gone: an error reaching the service or its root folder,
 * not-found included, is unknown. Each wrapped error is followed to its own code.
 */
const TASK_LOOKUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $root = $service.GetFolder('\')
} catch {
  'unknown'
  exit 0
}
try {
  [void]$root.GetTask($env:INFINITARY_TASK_LABEL)
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

/**
 * A stop asked of the run on this data folder where no signal can ask it
 * (docs/run.md, "On Windows"): Windows ends a program another one signals at
 * once, with no clean stop, so Stop, a window that lets the command go and
 * Ctrl-C's equivalent from another program write this file instead, and the
 * run stops as a signal stops it on a Mac or Linux (`watchRunStop`).
 */
export const RUN_STOP_FILE = "run-stop.json";

/**
 * A stop asked of one run alone, by its process and start: a file of its own,
 * which a run from an earlier version never reads, so only the run it names
 * acts on it (`watchRunStop`).
 */
export const RUN_STOP_FOR_FILE = "run-stop-for.json";

/** The run's own record in its data folder, which the window reads as the command's status. */
export const RUN_RECORD_FILE = "run.json";

/** One run on a data folder: its process and the start its own note keeps, so a reused process number is another run. */
export type RunInstance = { pid: number; startedAt: string };

/**
 * Asks the run on this data folder to stop cleanly; with `run`, only that
 * run, in a file only a run that knows itself reads, so another there, a
 * process number reused or an earlier version included, leaves it alone.
 * False where the request could not be written.
 */
export function requestRunStop(
  dataDir: string,
  now: Date = new Date(),
  run?: RunInstance,
): boolean {
  try {
    if (run)
      writePrivate(
        join(dataDir, RUN_STOP_FOR_FILE),
        `${JSON.stringify({ at: now.toISOString(), pid: run.pid, startedAt: run.startedAt })}\n`,
      );
    else
      writePrivate(join(dataDir, RUN_STOP_FILE), `${JSON.stringify({ at: now.toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}

/** How often a run on Windows reads whether a stop was asked of it. */
export const RUN_STOP_READ_MS = 1_000;

/**
 * A run on Windows reads whether a stop was asked of it once a second and
 * stops once one written after its own start is there: one for whichever
 * runs here (`RUN_STOP_FILE`), or one naming this run, `run`, by its process
 * and start (`RUN_STOP_FOR_FILE`). A request left from before it started, one
 * naming another run, one naming a run when this one knows no identity, and
 * a file that holds no request are taken away. Answers what ends the reading.
 */
export function watchRunStop(
  dataDir: string,
  startedAt: Date,
  stop: () => void,
  every: number = RUN_STOP_READ_MS,
  run?: RunInstance,
): () => void {
  /** The request in `name`, taken away once read; null where there is none. */
  const take = (name: string): Record<string, unknown> | null => {
    const file = join(dataDir, name);
    let request: unknown;
    try {
      request = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    // A request that cannot be taken away still counts; the next reading meets it again.
    try {
      rmSync(file, { force: true });
    } catch {}
    return typeof request === "object" && request !== null
      ? (request as Record<string, unknown>)
      : null;
  };
  const after = (request: Record<string, unknown>): boolean => {
    const when = typeof request.at === "string" ? Date.parse(request.at) : Number.NaN;
    return Number.isFinite(when) && when >= startedAt.getTime();
  };
  const asked = (): boolean => {
    const anyRun = take(RUN_STOP_FILE);
    const named = take(RUN_STOP_FOR_FILE);
    const forThis =
      named !== null &&
      run !== undefined &&
      named.pid === run.pid &&
      named.startedAt === run.startedAt &&
      after(named);
    return forThis || (anyRun !== null && after(anyRun));
  };
  if (asked()) {
    stop();
    return () => {};
  }
  const timer = setInterval(() => {
    if (!asked()) return;
    clearInterval(timer);
    stop();
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}
