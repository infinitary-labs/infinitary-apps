import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivate } from "@core/devices/identity";
import {
  bootPlist,
  bootUnit,
  type Launchctl,
  type Launcher,
  loadAgent,
  runAgentEnv,
  wantedBy,
} from "@core/helper/background";
import { type SystemdRuntime, systemdRuntime } from "@core/helper/linuxStartup";
import { loginAgentFile, sessionAgentFile } from "@core/helper/runAgent";
import {
  registerRunTask,
  removeRunTask,
  runTaskFile,
  runTaskXml,
  type Schtasks,
  startRunTask,
} from "@core/helper/windowsTask";
import { lingerStays } from "@core/helper/words";
import { HERE } from "@shared/deviceNames";
import type { StartEntry } from "./besideRun";
import {
  lockHolder,
  processAlive,
  RUN_SETTINGS_EXIT,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
} from "./runCommand";
import { readRunSettings } from "./runSettings";
import { commandWords } from "./workCommand";

/**
 * `infinitary start-at-boot` (docs/run.md, "Starting at boot"; INF-1228's
 * approved plan, piece 7, the captain's answer boot=both: "start-at-boot
 * writes what the account may and prints the one administrator line"). On
 * Linux it sets up `<app> run` as this user's own systemd service and has
 * the user linger where systemd lets them, so it starts at boot with nobody
 * logged in; where it does not, it prints the one line an administrator
 * runs, as the Linux join does (`afterLogout`). Where systemd does not run,
 * or whether it does cannot be read, it sets nothing up and promises
 * nothing (INF-1601). On a Mac it writes a login
 * agent in this user's own session and asks for automatic log in, so it
 * starts whenever the Mac starts and can use the login keychain; a system job
 * started before anyone logs in never can (the captain's choice on INF-1659,
 * replacing INF-1362's administrator line). On Windows it registers a task
 * in this user's own Task Scheduler that starts it whenever they sign in
 * (INF-4243's plan, piece 5; @core/helper/windowsTask). `infinitary help
 * run` prints the other ways to start the command.
 */

export const BOOT_WORDS = {
  usage: [
    "Usage: infinitary start-at-boot [--settings <file>] | --off",
    "Starts Infinitary with no window whenever this computer starts, as this user.",
    "With --settings, that run reads the file (infinitary help run). --off undoes it.",
  ],
  /** Set up, and whether it starts before anyone logs in. */
  set: (user: string, lingers: boolean) =>
    lingers
      ? [`Infinitary now starts whenever ${HERE.this} starts, as ${user}, before anyone logs in.`]
      : [
          `Infinitary now starts whenever ${user} logs in.`,
          `To start it whenever ${HERE.this} starts, before anyone logs in, an administrator runs this once:`,
          `sudo loginctl enable-linger ${user}`,
        ],
  startedNow: "It is starting now.",
  openNow: [
    "Infinitary is open here now, so it starts the next time instead.",
    "To start it sooner, quit Infinitary, then run this again.",
  ],
  log: (label: string) => `What it says: journalctl --user -u ${label}`,
  macLog: (file: string) => `What it says: ${file}`,
  off: (user: string) => [`Infinitary no longer starts at boot as ${user}.`],
  wasOff: (user: string) => [`Infinitary was not set to start at boot as ${user}.`],
  /** No systemctl to ask, or systemd does not run here: nothing can start the service. */
  noSystemd: [
    `${HERE.This} has no systemd for this user, so Infinitary cannot start at boot here.`,
    "infinitary help run lists other ways to start it.",
  ],
  /** Whether systemd runs here could not be read, so nothing was set up. */
  systemdUnknown: (user: string) => [
    `Infinitary could not check whether systemd runs on ${HERE.this}, so it set nothing up.`,
    `Run this again where ${user} is logged in, such as over SSH, or see infinitary help run for other ways to start it.`,
  ],
  /** A Mac's login agent, written, and how it starts whenever the Mac starts. */
  macSet: (user: string) => [
    `Infinitary now starts whenever ${user} logs in.`,
    `It stops when ${user} logs out, and nothing runs while ${HERE.this} waits at its login window.`,
    `To start it whenever ${HERE.this} starts, turn on automatic log in for ${user} in System Settings > Users & Groups.`,
    `macOS offers automatic log in only with FileVault off; with FileVault on, the password typed when ${HERE.this} starts logs ${user} in.`,
  ],
  /** A Mac's login agent, not started now: no one is logged in, or launchd did not start it. */
  macNextLogIn: (user: string) => `It starts the next time ${user} logs in.`,
  /** The login agent an earlier `infinitary help run` showed how to save by hand, which starts it too. */
  macHandAgent: (file: string) =>
    `A login agent saved by hand, ${file}, also starts Infinitary; remove that file so only this one does.`,
  /** That agent, left after --off, which still starts it. */
  macHandAgentOff: (file: string) =>
    `A login agent saved by hand, ${file}, still starts Infinitary; remove that file to stop it.`,
  /** The system job an administrator put in place earlier, which still starts first, and the one line that takes it away. */
  macEarlier: (line: string) => [
    "An administrator set Infinitary up earlier to start before anyone logs in. That run cannot use the Keychain, and it keeps this one from starting.",
    "To take it away, an administrator runs this once:",
    line,
  ],
  /** The system job an administrator put in place earlier, and the one line that takes it away. */
  macOff: (user: string, line: string) => [
    `To stop Infinitary starting at boot as ${user}, an administrator runs this once:`,
    line,
  ],
  couldNot: (reason: string) => [`Infinitary could not set up its start at boot: ${reason}`],
  /** Windows' task, registered, and what starts it. */
  windowsSet: (user: string) => [
    `Infinitary now starts whenever ${user} signs in to Windows.`,
    `It stops when ${user} signs out, and nothing runs while ${HERE.this} waits at its sign-in screen.`,
    `If it stops on its own, it starts again the next time ${user} signs in, or when Infinitary's window opens.`,
  ],
  /** Windows' task, not started now: Task Scheduler refused to start it. */
  windowsNextSignIn: (user: string) => `It starts the next time ${user} signs in.`,
  /** Windows' task, taken away while a run it started may still be going. */
  windowsOff: (user: string) => [
    `Infinitary no longer starts when ${user} signs in.`,
    "A run going now keeps going until it is stopped.",
  ],
  noTaskScheduler: [
    `${HERE.This} has no Task Scheduler for this user, so Infinitary cannot start at sign-in here.`,
    "infinitary help run lists other ways to start it.",
  ],
} as const;

/** Whether the app was started as `<app> start-at-boot`, and the words after it when it was. */
export function startAtBootCommand(argv: readonly string[], defaultApp: boolean): string[] | null {
  const words = commandWords(argv, defaultApp);
  return words?.[0] === "start-at-boot" ? words.slice(1) : null;
}

export type BootAsked = { off: true } | { off: false; settings?: string };

/** What the words after `start-at-boot` ask for, or null for words it does not take. */
export function bootAsked(words: readonly string[]): BootAsked | null {
  if (words.length === 0) return { off: false };
  if (words.length === 1 && words[0] === "--off") return { off: true };
  const [word, file, ...rest] = words;
  if (word === "--settings" && file && rest.length === 0) return { off: false, settings: file };
  return null;
}

export type BootContext = {
  platform: string;
  /** This user's name, which linger and the administrator's line name. */
  user: string;
  /** This user's number: a Mac's login agent runs in their own session (`gui/<uid>`). */
  uid: number;
  /** This user's home folder, which a Mac's entry and its log are in. */
  homeDir: string;
  /** Where this user's own systemd reads their services (`~/.config/systemd/user`). */
  unitsDir: string;
  /**
   * Where a Mac's launchd reads the system's jobs at boot
   * (`/Library/LaunchDaemons`), where an earlier version's entry may still be.
   */
  daemonsDir: string;
  /** The service's label: `runLabelOf`, `@shared/codeNames`. */
  label: string;
  /** How this app starts itself (`appLauncher`). */
  launcher: Launcher;
  /** The data folder `run` opens, whose lock says whether Infinitary is open now. */
  dataDir: string;
  /** What the service carries of this process's environment: a development run's stand-ins alone. */
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** This user's systemctl, which it asks with `--user`; null where the search path has none. */
  systemctl: Launchctl | null;
  /** Whether systemd runs here (`systemdRuntime`, read when absent); a test stands in its own. */
  runtime?: () => SystemdRuntime;
  loginctl: Launchctl | null;
  /** A Mac's launchctl; null elsewhere, or where the search path has none. */
  launchctl: Launchctl | null;
  /** Windows' schtasks; null elsewhere. */
  schtasks?: Schtasks | null;
  /** Who Windows' task runs as and whose sign-in starts it (`windowsAccount`). */
  account?: string;
  alive?: (pid: number) => boolean;
};

export type BootResult = { code: number; out: string; error: string };

/** Where a Mac's launchd reads the system's jobs at boot. */
export const MAC_DAEMONS_DIR = "/Library/LaunchDaemons";

export { userUnitsDir } from "@core/helper/runAgent";

/**
 * The login agent an earlier `infinitary help run` showed how to save by
 * hand, under the name it gave: it starts the same run, so the command says
 * when it is there and leaves the person's own file alone.
 */
export function macHandAgentFile(homeDir: string): string {
  return join(homeDir, "Library", "LaunchAgents", "infinitary.run.plist");
}

/**
 * Which start entry this command wrote is in place now: the unit in this
 * user's systemd folder, or on a Mac the system job an administrator copied
 * into place for an earlier version, which starts first, or else the login
 * agent, which the window's Start at login writes too (`loginAgentFile`), or
 * on Windows the task registered from the data folder (`runTaskFile`). An
 * entry a person wrote by hand, under another name, is not recognised
 * (docs/run.md, "When the command stops").
 */
export function startEntryInPlace(
  context: Pick<
    BootContext,
    "platform" | "unitsDir" | "daemonsDir" | "homeDir" | "label" | "dataDir"
  >,
): StartEntry {
  if (context.platform === "win32")
    return existsSync(runTaskFile(context.dataDir)) ? "windows-task" : null;
  if (context.platform === "linux")
    return existsSync(join(context.unitsDir, `${context.label}.service`)) ? "linux-unit" : null;
  if (context.platform === "darwin") {
    if (existsSync(join(context.daemonsDir, `${context.label}.plist`))) return "mac-daemon";
    return existsSync(loginAgentFile(context)) ? "mac-agent" : null;
  }
  return null;
}

const said = (lines: readonly string[]) => (lines.length > 0 ? `${lines.join("\n")}\n` : "");

export async function runStartAtBoot(asked: BootAsked, context: BootContext): Promise<BootResult> {
  const fail = (code: number, lines: readonly string[]): BootResult => ({
    code,
    out: "",
    error: said(lines),
  });
  if (context.platform === "darwin") return macStartAtBoot(asked, context);
  if (context.platform === "win32") return windowsStartAtBoot(asked, context);
  if (context.platform !== "linux" || !context.systemctl) return fail(1, BOOT_WORDS.noSystemd);
  const systemctl = context.systemctl;
  const user = (args: readonly string[]) => systemctl(["--user", ...args]);
  const file = join(context.unitsDir, `${context.label}.service`);
  const wants = wantedBy(file);

  if (asked.off) {
    const lingers = await lingering(context);
    const was = existsSync(file) || existsSync(wants);
    rmSync(wants, { force: true });
    rmSync(file, { force: true });
    await user(["daemon-reload"]);
    await user(["stop", `${context.label}.service`]);
    const lines = was ? BOOT_WORDS.off(context.user) : BOOT_WORDS.wasOff(context.user);
    return {
      code: 0,
      out: said([...lines, ...(lingers ? lingerStays(context.user) : [])]),
      error: "",
    };
  }

  // A systemctl on the search path is not systemd running. The service
  // starts where this user's own systemd answers, even under an unusual
  // system startup, or where systemd runs here, whose user manager starts at
  // their login or with linger; this shell may not reach that manager now
  // (`su` with no login of the user's own). Where systemd does not run, no
  // login and no linger starts it, and an unread runtime is no promise, so
  // nothing is written and no linger is asked for. The facts are the join's
  // (`linuxStartup`), asked of a later start rather than one now.
  const reached = (await user(["show-environment"])).ok;
  const runtime = reached ? "systemd" : (context.runtime ?? systemdRuntime)();
  if (runtime === "unavailable") return fail(1, BOOT_WORDS.noSystemd);
  if (runtime === "unknown") return fail(1, BOOT_WORDS.systemdUnknown(context.user));
  const settings = settingsOf(asked, context);
  if (typeof settings === "object") return settings;
  const lingers = await lingering(context);
  try {
    mkdirSync(dirname(wants), { recursive: true });
    writePrivate(
      file,
      bootUnit({
        launcher: context.launcher,
        settings,
        env: runAgentEnv(context.label, context.env),
      }),
    );
    // What `systemctl --user enable` makes, made here so the service starts
    // at the next login or boot even when this user's systemd cannot be asked now.
    rmSync(wants, { force: true });
    symlinkSync(file, wants);
  } catch (error) {
    return fail(1, BOOT_WORDS.couldNot(error instanceof Error ? error.message : String(error)));
  }
  const on = lingers || (await lingerOn(context));
  const lines: string[] = [...BOOT_WORDS.set(context.user, on)];
  // Its user's systemd reads the file again. A run of this service restarts
  // with the new file; any other Infinitary open here keeps the folder, so
  // the service waits for the next start rather than failing beside it.
  if ((await user(["daemon-reload"])).ok) {
    const holder = lockHolder(context.dataDir);
    const open = typeof holder === "number" && (context.alive ?? processAlive)(holder);
    const main = open
      ? Number(
          (await user(["show", "--property=MainPID", "--value", `${context.label}.service`]))
            .output,
        )
      : 0;
    if (open && main !== holder) lines.push(...BOOT_WORDS.openNow);
    else if ((await user(["restart", `${context.label}.service`])).ok)
      lines.push(BOOT_WORDS.startedNow);
  }
  lines.push(BOOT_WORDS.log(`${context.label}.service`));
  return { code: 0, out: said(lines), error: "" };
}

/**
 * The settings file's full path, read now so a file to fix is said here
 * rather than at boot; or the run's own refusal, with nothing written.
 */
function settingsOf(asked: BootAsked, context: BootContext): string | undefined | BootResult {
  if (asked.off || !asked.settings) return undefined;
  const reading = readRunSettings(asked.settings, context.cwd);
  if (reading.ok) return reading.file;
  return {
    code: RUN_SETTINGS_EXIT,
    out: "",
    error: said(RUN_WORDS.settings(reading.file, reading.reason)),
  };
}

/**
 * A Mac's start at boot: a login agent in this user's own session, which
 * launchd starts whenever they log in, at boot too once the Mac logs them in
 * automatically, so the run sees their login keychain unlocked. It takes the
 * place of an earlier version's system job: the account's own copy of it goes,
 * and one an administrator put in place gets the one line that takes it away,
 * since it starts first and holds the data folder where the keychain stays
 * locked. It starts the agent now when this user is logged in, unless another
 * Infinitary holds the data folder, as on Linux.
 */
async function macStartAtBoot(asked: BootAsked, context: BootContext): Promise<BootResult> {
  const name = `${context.label}.plist`;
  const agent = loginAgentFile(context);
  // What an earlier version wrote for an administrator to copy; launchd never reads it.
  const prepared = join(context.homeDir, "Library", "LaunchDaemons", name);
  const placed = join(context.daemonsDir, name);
  const removal = `sudo launchctl bootout system/${shellWord(context.label)} 2>/dev/null; sudo rm -f ${shellWord(placed)}`;
  const domain = `gui/${context.uid}`;
  const launchctl = context.launchctl;
  if (asked.off) {
    const loaded = existsSync(agent);
    const was = loaded || existsSync(prepared);
    rmSync(agent, { force: true });
    rmSync(prepared, { force: true });
    // Its run stops with it. A run started another way keeps running, the one
    // the window's agent in the data folder started under this same label too.
    if (launchctl && loaded) await launchctl(["bootout", `${domain}/${context.label}`]);
    const lines = existsSync(placed)
      ? BOOT_WORDS.macOff(context.user, removal)
      : was
        ? BOOT_WORDS.off(context.user)
        : BOOT_WORDS.wasOff(context.user);
    const hand = macHandAgentFile(context.homeDir);
    const also = existsSync(hand) ? [BOOT_WORDS.macHandAgentOff(hand)] : [];
    return { code: 0, out: said([...lines, ...also]), error: "" };
  }
  const settings = settingsOf(asked, context);
  if (typeof settings === "object") return settings;
  const log = join(context.homeDir, "Library", "Logs", `${context.label}.log`);
  try {
    mkdirSync(dirname(agent), { recursive: true });
    mkdirSync(dirname(log), { recursive: true });
    writePrivate(
      agent,
      bootPlist({
        label: context.label,
        launcher: context.launcher,
        settings,
        log,
        env: runAgentEnv(context.label, context.env),
      }),
    );
    rmSync(prepared, { force: true });
    // The window's own agent for this run, kept in the data folder while Start
    // at login is off, gives way to this one: the same agent, read at every
    // log in, so only one starts the run (docs/run.md, "The window starts it").
    rmSync(sessionAgentFile(context), { force: true });
  } catch (error) {
    return {
      code: 1,
      out: "",
      error: said(BOOT_WORDS.couldNot(error instanceof Error ? error.message : String(error))),
    };
  }
  const lines: string[] = [...BOOT_WORDS.macSet(context.user)];
  if (existsSync(placed)) lines.push(...BOOT_WORDS.macEarlier(removal));
  const hand = macHandAgentFile(context.homeDir);
  if (existsSync(hand)) lines.push(BOOT_WORDS.macHandAgent(hand));
  lines.push(...(await macStartNow(context, agent, domain)));
  lines.push(BOOT_WORDS.macLog(log));
  return { code: 0, out: said(lines), error: "" };
}

/**
 * Starts the login agent now when this user is logged in, so launchd reads
 * the new file: a run of the agent itself starts again with it. Any other
 * Infinitary open here keeps the folder, so the agent waits for the next log
 * in rather than failing beside it. launchd knows this user's session only
 * while they are logged in, so asking for it tells whether there is one.
 */
async function macStartNow(context: BootContext, agent: string, domain: string): Promise<string[]> {
  const launchctl = context.launchctl;
  const later = [BOOT_WORDS.macNextLogIn(context.user)];
  if (!launchctl || !(await launchctl(["print", domain])).ok) return later;
  const job = `${domain}/${context.label}`;
  const holder = lockHolder(context.dataDir);
  const open = typeof holder === "number" && (context.alive ?? processAlive)(holder);
  if (open && !(await launchctl(["print", job])).ok) return [...BOOT_WORDS.openNow];
  // As the window loads its own agent, this same one (`loadAgent`).
  const loaded = await loadAgent(launchctl, context.uid, { label: context.label, file: agent });
  return loaded === "running" ? [BOOT_WORDS.startedNow] : later;
}

/**
 * Windows' start at sign-in: a task in this user's own Task Scheduler,
 * registered from the data folder's `run-task.xml`, that runs `<app> run`
 * as them whenever they sign in, in that session (@core/helper/windowsTask).
 * It is the task the window's own starter registers too, so the window's
 * Start at login reads it as on. Task Scheduler never starts the run again
 * after it ends, so the next sign-in or the window starts it. It starts the
 * task now unless an Infinitary holds the data folder already, as on a Mac
 * and Linux; that Infinitary may be the task's own run, which Task
 * Scheduler can end only with no clean stop, so the new task waits for the
 * next start.
 */
async function windowsStartAtBoot(asked: BootAsked, context: BootContext): Promise<BootResult> {
  const schtasks = context.schtasks;
  if (!schtasks) return { code: 1, out: "", error: said(BOOT_WORDS.noTaskScheduler) };
  const file = runTaskFile(context.dataDir);
  if (asked.off) {
    const was = await removeRunTask(schtasks, { label: context.label, file });
    const lines = was ? BOOT_WORDS.windowsOff(context.user) : BOOT_WORDS.wasOff(context.user);
    return { code: 0, out: said(lines), error: "" };
  }
  const settings = settingsOf(asked, context);
  if (typeof settings === "object") return settings;
  const xml = runTaskXml({
    launcher: context.launcher,
    account: context.account ?? context.user,
    atLogin: true,
    settings,
    agent: context.label,
  });
  let registered: boolean;
  try {
    registered = await registerRunTask(schtasks, { label: context.label, file, xml });
  } catch (error) {
    return {
      code: 1,
      out: "",
      error: said(BOOT_WORDS.couldNot(error instanceof Error ? error.message : String(error))),
    };
  }
  if (!registered) {
    rmSync(file, { force: true });
    return {
      code: 1,
      out: "",
      error: said(BOOT_WORDS.couldNot("Task Scheduler did not take the task.")),
    };
  }
  const lines: string[] = [...BOOT_WORDS.windowsSet(context.user)];
  const holder = lockHolder(context.dataDir, context.platform);
  const open = holder === undefined || (holder !== null && (context.alive ?? processAlive)(holder));
  if (open) lines.push(...BOOT_WORDS.openNow);
  else if (await startRunTask(schtasks, context.label)) lines.push(BOOT_WORDS.startedNow);
  else lines.push(BOOT_WORDS.windowsNextSignIn(context.user));
  return { code: 0, out: said(lines), error: "" };
}

/** One word as a shell reads it: quoted where it has a space or a character the shell reads. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** Whether systemd keeps this user's services running with nobody logged in (linger). */
async function lingering(context: BootContext): Promise<boolean> {
  if (!context.loginctl) return false;
  const shown = await context.loginctl(["show-user", context.user, "--property=Linger", "--value"]);
  return shown.ok && shown.output.trim() === "yes";
}

/** Turns linger on where systemd lets this user do it without an administrator. */
async function lingerOn(context: BootContext): Promise<boolean> {
  if (!context.loginctl) return false;
  return (await context.loginctl(["enable-linger", "--no-ask-password", context.user])).ok;
}

/** Whether the app was started as `<app> help`, and the words after it when it was. */
export function helpCommand(argv: readonly string[], defaultApp: boolean): string[] | null {
  const words = commandWords(argv, defaultApp);
  return words?.[0] === "help" ? words.slice(1) : null;
}

/**
 * `infinitary help` and `infinitary help run`: the commands, and two ways to
 * start `run`: by hand, and through start-at-boot (INF-1228's plan, piece 7:
 * "infinitary help run prints examples for other setups"). Whatever starts
 * the command owns when, as whom and how often it starts (docs/run.md, "Who
 * owns what"), so these are examples, each starting the same command.
 */
export function helpWords(
  words: readonly string[],
  launcher: Launcher,
): { code: number; lines: string[] } {
  const own = [launcher.executable, ...launcher.args];
  // A word a shell would split or read is quoted, as a path with a space.
  const app = own.map(shellWord).join(" ");
  if (words.length === 1 && words[0] === "run")
    return {
      code: 0,
      lines: [
        ...RUN_WORDS.usage,
        "",
        "Whatever starts it decides when, as which user, and whether it starts again. For example:",
        "",
        "  By hand, in a terminal here or over SSH:",
        `    ${app} run`,
        "",
        "  Whenever this computer starts, as this user (on a Mac, when this user logs in):",
        `    ${app} start-at-boot`,
        "",
        `It ends with ${RUN_UPDATED_EXIT} after an update, so a starter that starts it again after a failure runs the new version, and with ${RUN_SETTINGS_EXIT} when its settings file needs fixing.`,
      ],
    };
  const usage = [
    "Usage: infinitary <command>",
    "  run              Starts Infinitary here with no window, until it is stopped.",
    "  status           Says whether it runs, and why it last stopped.",
    "  link             Prints a link for another computer, or a code for a phone.",
    "  start-at-boot    Starts it with no window whenever this computer starts.",
    "  help run         Lists ways to start it.",
  ];
  return { code: words.length === 0 ? 0 : 2, lines: usage };
}
