import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivate } from "../devices/identity";
import { windowsRunHolds } from "../placed/windowsProcesses";
import { hostPlatformProfile } from "../platform";
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
import { holderAlive, processAlive } from "./lock";
import { endRunByForce, wakeRun } from "./runForce";
import {
  RUN_RECORD_FILE,
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
  /**
   * Whether a process runs, the system's own unless a test stands in, how
   * long a force stop waits for its run to end (`endRunByForce`), and how a
   * suspended run is let go on to read it.
   */
  processes?: {
    /**
     * Whether a program runs under `pid`; with `birth`, the run's recorded
     * Windows birth, whether that same program still does.
     */
    alive: (pid: number, birth?: string) => boolean;
    forceWaitMs?: number;
    /** Lets a suspended run go on to read its force stop (`wakeRun`). */
    wake?: (run: RunInstance, birth?: string) => void;
  };
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
 * folder is for that run alone, so a run started by hand there stays. On a
 * Mac or Linux the agent's job is ended whichever run it holds. With
 * `force`, Start it here over a run that does not answer: only the run
 * named ends, by its own hand (`endAgentRun`), and the service manager is
 * asked nothing, so a run its job starts again meanwhile keeps going; the
 * window that starts here lets the job go once it holds the folder itself
 * (`retireBesideOwnRun`). Letting it
 * go for good (`forget`), a job the service manager would not end, or a task
 * Task Scheduler would not take away, rejects, so the joining window says so,
 * unless the service manager or Task Scheduler says it holds no such job, or the job is stopped,
 * which is let go quietly; any other stop answers as it always has. A
 * force stop answers what it did (`endAgentRun`), and only `ended` lets the
 * window starting here retire the job.
 */
export async function stopRunAgent(
  context: RunAgentContext,
  options: { forget: boolean; force?: RunInstance; run?: RunInstance | null },
): Promise<AgentRunEnd | undefined> {
  if (options.force) return await endAgentRun(context, options.force);
  if ("schtasks" in context) {
    // Task Scheduler's own end of a task ends its program with no clean stop,
    // so the run is asked to stop itself, as a signal asks it elsewhere. A
    // null `run` names no run: the task is taken away and no stop is asked.
    if (options.run !== null) requestRunStop(context.dataDir, new Date(), options.run);
    if (options.forget)
      await removeRunTask(context.schtasks, {
        label: context.label,
        file: runTaskFile(context.dataDir),
      });
    return;
  }
  // A stop that forgets the agent, or one that names no run and only lets the job go, is a job the
  // caller needs stopped: a refusal is reported to it. An ordinary stop of a run leaves the job to
  // its own rules.
  const checked = options.forget || options.run === null;
  if ("launchctl" in context) {
    if (options.forget) {
      rmSync(loginAgentFile(context), { force: true });
      rmSync(sessionAgentFile(context), { force: true });
    }
    const launchctl = launchctlOf(context);
    const service = `gui/${context.uid}/${context.label}`;
    const out = await launchctl(["bootout", service]);
    // Only a job launchd says it does not hold is let go quietly; one it still
    // holds may start its run again, and one it cannot say about may too.
    if (
      checked &&
      !out.ok &&
      (await launchctl(["print", service])).code !== LAUNCHD_NO_SUCH_SERVICE
    )
      throw new Error(`launchd did not stop the agent: ${out.output}`);
    return;
  }
  const systemctl = systemctlOf(context);
  if (options.forget) {
    rmSync(wantedBy(unitFile(context)), { force: true });
    rmSync(unitFile(context), { force: true });
    await systemctl(["daemon-reload"]);
  }
  const out = await systemctl(["stop", context.label]);
  if (checked && !out.ok) {
    // As background.ts reads a service's state: by its ActiveState, which says
    // a unit waiting to start again is activating, never by is-active's status.
    const state = await systemctl(["show", "--property=ActiveState", "--value", context.label]);
    if (!state.ok || !SYSTEMD_STOPPED.has(state.output.trim()))
      throw new Error(`systemd did not stop the agent: ${out.output}`);
  }
}

/** launchctl's exit status for a service its domain does not hold (`launchctl print`). */
const LAUNCHD_NO_SUCH_SERVICE = 113;
/**
 * The ActiveState of a unit that is not running and will not start again on
 * its own: inactive, which a unit systemd does not hold reads too, or failed
 * (systemd.unit(5)); activating, its wait to start again included, and
 * deactivating say it may still run.
 */
const SYSTEMD_STOPPED: ReadonlySet<string> = new Set(["inactive", "failed"]);

/**
 * What Restart it did: started a run again; did nothing at all, where the
 * run named is not one this app's own agent started that still runs, or its
 * program cannot be shown to be that run; or ended or asked something and
 * did not start a run again, so the run named may or may not still run.
 */
export type RestartOutcome = "restarted" | "untouched" | "failed";

/**
 * Restart it, on the notice over a window whose command runs and does not
 * answer (docs/run.md, "When the command does not answer"): the run named
 * ends itself by force (`endAgentRun`), since one that does not answer may
 * never act on a polite stop, and once no program runs under its number the
 * agent is asked to start its run, as it would at login: launchd's
 * `kickstart` without `-k`, systemd's `start` or Task Scheduler's `/Run`,
 * each of which starts nothing where the job already runs, so a run started
 * again in the named one's place is never ended.
 */
export async function restartRunAgent(
  context: RunAgentContext,
  run?: RunInstance,
): Promise<RestartOutcome> {
  if (!run) return "untouched";
  const ended = await endAgentRun(context, run);
  if (ended === "untouched") return "untouched";
  // Withdrawn, the run named still runs and its stop never acts: no run is started again. A stop
  // it claimed was waited for until it ended, so a run its end leaves no job to start is started
  // here; one gone on its own is started again as well.
  if (ended === "withdrawn") return "failed";
  if ("schtasks" in context) {
    if (await startRunTask(context.schtasks, context.label)) return "restarted";
    return (await startRunAgent(context)) === "running" ? "restarted" : "failed";
  }
  if ("launchctl" in context) {
    const started = await launchctlOf(context)([
      "kickstart",
      `gui/${context.uid}/${context.label}`,
    ]);
    return started.ok ? "restarted" : "failed";
  }
  return (await systemctlOf(context)(["start", context.label])).ok ? "restarted" : "failed";
}

/**
 * Whether the run on this data folder is still `run`, by its own record: the
 * same process and start, a process that still runs, and a record written
 * since this computer last started; with whether this app's own agent
 * started it, and on Windows its process's own birth, as the run wrote. Null for any other run, a process number
 * reused included, and while none is recorded or its record cannot be read.
 */
function recordedRun(
  context: RunAgentContext,
  run: RunInstance,
): { agent: boolean; birth?: string } | null {
  const path = join(context.dataDir, RUN_RECORD_FILE);
  let record: { pid?: unknown; startedAt?: unknown; agent?: unknown; birth?: unknown } | null;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (record?.pid !== run.pid || record.startedAt !== run.startedAt) return null;
  if (!holderAlive(path, run.pid, context.processes?.alive ?? processAlive)) return null;
  return {
    agent: record.agent === true,
    ...(typeof record.birth === "string" ? { birth: record.birth } : {}),
  };
}

/**
 * Ends `run` by force where it is the run this app's own agent started, as
 * its own record says (`recordedRun`): the run is asked to end itself, by
 * its process and start (`endRunByForce`), which no other program reads, so
 * a program that took its number and a run its job started again both keep
 * going, and nothing is asked of the service manager. Untouched for any
 * other run, and where the stop could not be asked; otherwise as
 * `endRunByForce` answers (`AgentRunEnd`).
 */
async function endAgentRun(context: RunAgentContext, run: RunInstance): Promise<AgentRunEnd> {
  const recorded = recordedRun(context, run);
  if (!recorded?.agent) return "untouched";
  const wake =
    context.processes?.wake ?? ((named, birth) => wakeRun(context.dataDir, named, birth));
  const alive = context.processes?.alive ?? runAlive;
  const ended = await endRunByForce(
    context.dataDir,
    run,
    (pid) => alive(pid, recorded.birth),
    context.processes?.forceWaitMs,
    () => wake(run, recorded.birth),
  );
  return ended === "unasked" ? "untouched" : ended;
}

/**
 * Whether the run under `pid` still runs: on Windows, with the birth its
 * record keeps, only while that same program holds the number, so a program
 * that took the number after the run ended is not waited for. Where Windows
 * cannot say, the run is taken to run.
 */
function runAlive(pid: number, birth?: string): boolean {
  if (!processAlive(pid)) return false;
  return !birth || !hostPlatformProfile().windows || windowsRunHolds(pid, birth) !== false;
}

/**
 * What a force stop of the agent's own run did, as `endRunByForce` answers:
 * `ended` by its stop, `gone` on its own with its stop never acted on,
 * `withdrawn` where it still runs and its stop never acts; `untouched`
 * where nothing was asked of it. A stop it claimed is waited for until one
 * of these is known.
 */
export type AgentRunEnd = "ended" | "gone" | "untouched" | "withdrawn";
