import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivate } from "../devices/identity";
import {
  bootPlist,
  bootUnit,
  type InBackgroundNow,
  type Launcher,
  launchctlOf,
  loadAgent,
  runAgentEnv,
  type ServiceManager,
  systemctlOf,
  wantedBy,
} from "./background";
import { linuxStartup } from "./linuxStartup";
import { processAlive, STOPPED_RUN_WAIT_MS } from "./lock";
import {
  type RunInstance,
  readRunTask,
  registerRunTask,
  removeRunTask,
  requestRunStop,
  runTaskFile,
  runTaskXml,
  type Schtasks,
  startRunTask,
} from "./windowsTask";

/**
 * The command the window starts (docs/run.md, "The window starts it";
 * INF-1352's plan, piece 7, the captain's answer starter=login-agent: "The
 * window sets it up in the background through the seam a work computer
 * uses, so a crash restarts it and Start at login keeps it"). Opening
 * Infinitary's window with no command running sets `<app> run` up with this
 * account's own service manager, as a computer that runs work sets up
 * `<app> work run` (./background.ts), and the window opens beside it:
 *
 * - **launchd** on a Mac: an agent in this user's session, the same one
 *   `start-at-boot` writes. Its file is in `~/Library/LaunchAgents` while
 *   Start at login is on, so every login starts it; otherwise in the data
 *   folder, which launchd never reads by itself, so it runs until this
 *   session ends.
 * - **systemd** on Linux: the same user service `start-at-boot` writes,
 *   started now, and wanted by the user's login while Start at login is on.
 * - **Task Scheduler** on Windows: the same task `start-at-boot` writes
 *   (./windowsTask.ts), started now, with its sign-in trigger on while Start
 *   at login is on.
 *
 * launchd and systemd start the run again after a failure - a crash, or an
 * update's exit 75 - and never after a clean stop, so Stop ends it until it
 * is started again. Task Scheduler never starts it again by itself.
 */

/** This user's Task Scheduler, and the account its task runs as (`windowsAccount`). */
export type TaskScheduler = { schtasks: Schtasks; account: string };

/** Whichever of the three keeps the run: launchd, systemd or Task Scheduler. */
export type RunManager = ServiceManager | TaskScheduler;

export type RunAgentContext = {
  /** The run's label (`runLabelOf`), the one `start-at-boot` uses too. */
  label: string;
  dataDir: string;
  homeDir: string;
  uid: number;
  /** Where this user's own systemd reads their services (Linux). */
  unitsDir: string;
  launcher: Launcher;
  /** What the run carries of the window's environment: a development run's stand-ins alone. */
  env: Readonly<Record<string, string>>;
  /** How a Windows run's process is read and ended by force: the system's own unless a test stands in. */
  processes?: { alive: (pid: number) => boolean; end: (pid: number) => void };
} & RunManager;

/** Where this user's own systemd reads their services. */
export function userUnitsDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(homeDir, ".config"), "systemd", "user");
}

/** The agent's file in the data folder while Start at login is off. */
export const SESSION_AGENT_FILE = "run-agent.plist";

/** What the run started by a Mac's agent says, in the data folder. */
export const RUN_AGENT_LOG = "run.log";

/** A Mac's agent file while Start at login is on: read by launchd at every login. */
export function loginAgentFile(context: Pick<RunAgentContext, "homeDir" | "label">): string {
  return join(context.homeDir, "Library", "LaunchAgents", `${context.label}.plist`);
}

/** A Mac's agent file while Start at login is off: the data folder's, read only when loaded. */
export function sessionAgentFile(context: Pick<RunAgentContext, "dataDir">): string {
  return join(context.dataDir, SESSION_AGENT_FILE);
}

/** The Linux user service, the one `start-at-boot` writes. */
function unitFile(context: Pick<RunAgentContext, "unitsDir" | "label">): string {
  return join(context.unitsDir, `${context.label}.service`);
}

/** Whether the agent the window set up is in place: either file of a Mac's agent, or the Linux unit. */
export function runAgentInPlace(context: RunAgentContext): boolean {
  if ("schtasks" in context) return existsSync(runTaskFile(context.dataDir));
  return "launchctl" in context
    ? existsSync(loginAgentFile(context)) || existsSync(sessionAgentFile(context))
    : existsSync(unitFile(context));
}

/** One `<string>` of a plist as `bootPlist` escapes it, read back. */
function plistText(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * What a Mac's agent file keeps when it is written again: the `--settings`
 * file and the log `start-at-boot` gave the same agent, if it wrote this one
 * (`bootPlist`), as a Linux unit keeps its settings file (`ensureUnit`).
 */
function macAgentKept(file: string): { settings?: string; log?: string } {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const settings = /<string>--settings<\/string>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  const log = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  return {
    ...(settings === undefined ? {} : { settings: plistText(settings) }),
    ...(log === undefined ? {} : { log: plistText(log) }),
  };
}

/** Writes a Mac's agent at `file`, keeping what the agent at `from` kept (`macAgentKept`). */
function writeMacAgent(context: RunAgentContext, file: string, from = file): void {
  const kept = macAgentKept(from);
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(
    file,
    // The boot entry's run as an agent in this user's own session: no UserName or HOME.
    bootPlist({
      label: context.label,
      launcher: context.launcher,
      settings: kept.settings,
      log: kept.log ?? join(context.dataDir, RUN_AGENT_LOG),
      env: runAgentEnv(context.label, context.env),
    }),
  );
}

/** Registers the Windows task for this window's program, its sign-in trigger as asked. */
function registerWindowsTask(
  context: RunAgentContext & TaskScheduler,
  atLogin: boolean,
  settings?: string,
): Promise<boolean> {
  return registerRunTask(context.schtasks, {
    label: context.label,
    file: runTaskFile(context.dataDir),
    xml: runTaskXml({
      launcher: context.launcher,
      account: context.account,
      atLogin,
      settings,
      agent: context.label,
    }),
  });
}

/** The `--settings` file a unit's command names, as `bootUnit` quotes it, if any. */
function unitSettings(text: string): string | undefined {
  const quoted = /"--settings" "((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  return quoted?.replace(/\$\$/g, "$").replace(/\\(.)/g, "$1").replace(/%%/g, "%");
}

/**
 * The Linux unit, written again whenever it is not the one this window
 * would write, as a Mac's agent is: a moved AppImage or a collected Nix path
 * leaves another program in its command, and a run for another data folder
 * leaves that folder in its settings. It keeps the settings file a unit
 * `start-at-boot` wrote names.
 */
function ensureUnit(context: RunAgentContext): void {
  const file = unitFile(context);
  const was = existsSync(file) ? readFileSync(file, "utf8") : null;
  const settings = was === null ? undefined : unitSettings(was);
  const text = bootUnit({
    launcher: context.launcher,
    env: runAgentEnv(context.label, context.env),
    settings,
  });
  if (was === text) return;
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(file, text);
}

/**
 * Sets the agent up and starts the run now: `running` once the service
 * manager took it, `at-login` with no login session to give it to, and
 * `failed`, `unavailable` or `unknown` when it cannot start here, where the
 * window runs its first mate itself instead. A Mac's file is written anew
 * where it is, so it starts the program this window is, keeping the
 * settings file and log `start-at-boot` gave it.
 */
export async function startRunAgent(context: RunAgentContext): Promise<InBackgroundNow> {
  if ("schtasks" in context) {
    // Registered anew, so it runs the program this window is, keeping the
    // settings file and sign-in trigger the task in place had.
    const kept = readRunTask(runTaskFile(context.dataDir));
    if (!(await registerWindowsTask(context, kept?.atLogin ?? false, kept?.settings)))
      return "failed";
    return (await startRunTask(context.schtasks, context.label)) ? "running" : "failed";
  }
  if ("launchctl" in context) {
    const atLogin = existsSync(loginAgentFile(context));
    const file = atLogin ? loginAgentFile(context) : sessionAgentFile(context);
    writeMacAgent(context, file);
    // A run that ended stays loaded: launchd reads the file again only once it is let go.
    return loadAgent(context.launchctl, context.uid, { label: context.label, file });
  }
  const readiness = await linuxStartup(context.systemctl, context.uid, context.runtime);
  if (readiness !== "available") return readiness;
  ensureUnit(context);
  const systemctl = systemctlOf(context);
  if (!(await systemctl(["daemon-reload"])).ok) return "failed";
  return (await systemctl(["start", context.label])).ok ? "running" : "failed";
}

/** Whether the run starts at this user's login: what Start at login says while the window stands beside it. */
export function runAgentAtLogin(context: RunAgentContext): boolean {
  if ("schtasks" in context) return readRunTask(runTaskFile(context.dataDir))?.atLogin === true;
  return "launchctl" in context
    ? existsSync(loginAgentFile(context))
    : existsSync(wantedBy(unitFile(context)));
}

/**
 * Start at login, for the command: a Mac's agent file moves between
 * `~/Library/LaunchAgents` and the data folder, and a Linux unit gains or
 * loses the link its user's login reads. The run going now is left as it is.
 */
export function setRunAgentAtLogin(context: RunAgentContext, enabled: boolean): void {
  if ("schtasks" in context) {
    const kept = readRunTask(runTaskFile(context.dataDir));
    // The file says the switch at once; Task Scheduler takes it in the background.
    void registerWindowsTask(context, enabled, kept?.settings).catch(() => false);
    return;
  }
  if ("launchctl" in context) {
    const [to, from] = enabled
      ? [loginAgentFile(context), sessionAgentFile(context)]
      : [sessionAgentFile(context), loginAgentFile(context)];
    writeMacAgent(context, to, existsSync(from) ? from : to);
    rmSync(from, { force: true });
    return;
  }
  const wants = wantedBy(unitFile(context));
  if (!enabled) {
    rmSync(wants, { force: true });
    return;
  }
  ensureUnit(context);
  mkdirSync(dirname(wants), { recursive: true });
  rmSync(wants, { force: true });
  symlinkSync(unitFile(context), wants);
}

/**
 * Takes the agent's files away and leaves its run going, for a run whose
 * first mate moved to another computer (docs/devices.md, "Moving the first
 * mate"): the run ends by itself with 0, which nothing starts again, and no
 * login starts one here again.
 */
export function forgetRunAgentFiles(
  context: Pick<RunAgentContext, "label" | "dataDir" | "homeDir" | "unitsDir">,
): void {
  rmSync(loginAgentFile(context), { force: true });
  rmSync(sessionAgentFile(context), { force: true });
  rmSync(wantedBy(unitFile(context)), { force: true });
  rmSync(unitFile(context), { force: true });
}

/**
 * Lets the agent go, which stops its run: for a window that runs its first
 * mate itself after all, so the agent never starts the run beside it, and,
 * with `forget`, for a window that joined a first mate on another computer,
 * so no login starts a run here again. With `run`, a stop asked through the
 * folder is for that run alone, so a run started by hand there stays.
 */
export async function stopRunAgent(
  context: RunAgentContext,
  options: { forget: boolean; force?: EndedRun; run?: RunInstance },
): Promise<void> {
  if ("schtasks" in context) {
    // Task Scheduler's own end of a task ends its program with no clean stop,
    // so the run is asked to stop itself, as a signal asks it elsewhere; one
    // that does not answer never reads that ask, so `force` ends it.
    if (options.force) await endWindowsRun(context, options.force.pid);
    else requestRunStop(context.dataDir, new Date(), options.run);
    if (options.forget)
      await removeRunTask(context.schtasks, {
        label: context.label,
        file: runTaskFile(context.dataDir),
      });
    return;
  }
  if ("launchctl" in context) {
    if (options.forget) {
      rmSync(loginAgentFile(context), { force: true });
      rmSync(sessionAgentFile(context), { force: true });
    }
    await launchctlOf(context)(["bootout", `gui/${context.uid}/${context.label}`]);
    return;
  }
  const systemctl = systemctlOf(context);
  if (options.forget) {
    rmSync(wantedBy(unitFile(context)), { force: true });
    rmSync(unitFile(context), { force: true });
    await systemctl(["daemon-reload"]);
  }
  await systemctl(["stop", context.label]);
}

/**
 * Restart it, on the notice over a window whose command runs and does not
 * answer (docs/run.md, "When the command does not answer"): the run is
 * ended by force, since one that does not answer may never act on a polite
 * stop, and the agent starts it again at once, keeping its place for the
 * next login. On a Mac launchd's own kickstart ends the run and starts it
 * again; on Linux systemd ends it with SIGKILL and starts the unit; on
 * Windows the run is ended by force and the task runs again once its
 * process is gone (`endWindowsRun`). An agent its service manager no longer holds is
 * set up and started anew. True once a run was started again.
 */
export async function restartRunAgent(
  context: RunAgentContext,
  run: EndedRun = {},
): Promise<boolean> {
  if ("schtasks" in context) {
    // The task runs no second copy beside one still going, so a run that has not gone yet is not restarted.
    if (!(await endWindowsRun(context, run.pid))) return false;
    if (await startRunTask(context.schtasks, context.label)) return true;
    return (await startRunAgent(context)) === "running";
  }
  if ("launchctl" in context) {
    const launchctl = launchctlOf(context);
    const restarted = await launchctl(["kickstart", "-k", `gui/${context.uid}/${context.label}`]);
    if (restarted.ok) return true;
    return (await startRunAgent(context)) === "running";
  }
  const systemctl = systemctlOf(context);
  await systemctl(["kill", "--signal=SIGKILL", context.label]);
  if ((await systemctl(["start", context.label])).ok) return true;
  return (await startRunAgent(context)) === "running";
}

/** How often a Windows run that was ended is read until its process is gone. */
const ENDED_RUN_READ_MS = 100;

/**
 * The run to end by force, by the process its own record names (the run's
 * `run.json`, which the window reads as the command's status); none where
 * no run is recorded.
 */
export type EndedRun = { pid?: number };

/**
 * Ends a Windows run by force: Task Scheduler's own end, which first asks
 * the program to close and returns before it has, then the run's recorded
 * process ended at once. Waits until that process is gone, for as long as
 * a command waits for a stopped run to let its folder go, since the task
 * runs no second copy beside one still going. True once it is gone.
 */
async function endWindowsRun(
  context: RunAgentContext & TaskScheduler,
  pid: number | undefined,
): Promise<boolean> {
  const alive = context.processes?.alive ?? processAlive;
  const end = context.processes?.end ?? ((pid: number) => process.kill(pid));
  await context.schtasks(["/End", "/TN", context.label]);
  if (pid === undefined || !alive(pid)) return true;
  try {
    end(pid);
  } catch {
    // Gone already, or not this account's to end: the wait below says which.
  }
  const until = Date.now() + STOPPED_RUN_WAIT_MS;
  while (alive(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, ENDED_RUN_READ_MS));
  }
  return true;
}
