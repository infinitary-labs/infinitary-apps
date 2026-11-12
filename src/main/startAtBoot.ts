import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivate } from "@core/devices/identity";
import {
  bootPlist,
  bootUnit,
  type Launchctl,
  type Launcher,
  wantedBy,
} from "@core/helper/background";
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
 * runs, as the Linux join does (`afterLogout`). On a Mac, which has no
 * linger, it prepares the account's boot entry and prints the one line an
 * administrator runs to put it in place (INF-1362, after INF-1416's check on
 * a disposable Mac showed the run works there with nobody logged in).
 * `infinitary help run` prints the other ways to start the command.
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
  noSystemd: [
    `${HERE.This} has no systemd for this user, so Infinitary cannot start at boot here.`,
    "infinitary help run lists other ways to start it.",
  ],
  /** A Mac's entry, prepared, and the one line that puts it in place. */
  macSet: (user: string, line: string) => [
    `Infinitary is ready to start whenever ${HERE.this} starts, as ${user}, before anyone logs in.`,
    "To turn it on, an administrator runs this once:",
    line,
    `It starts the next time ${HERE.this} starts.`,
  ],
  /** A Mac's entry in place, and the one line that takes it away. */
  macOff: (user: string, line: string) => [
    `To stop Infinitary starting at boot as ${user}, an administrator runs this once:`,
    line,
  ],
  couldNot: (reason: string) => [`Infinitary could not set up its start at boot: ${reason}`],
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
  /** This user's home folder, which a Mac's entry and its log are in. */
  homeDir: string;
  /** Where this user's own systemd reads their services (`~/.config/systemd/user`). */
  unitsDir: string;
  /** Where a Mac's launchd reads the system's jobs at boot (`/Library/LaunchDaemons`). */
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
  loginctl: Launchctl | null;
  alive?: (pid: number) => boolean;
};

export type BootResult = { code: number; out: string; error: string };

/** Where a Mac's launchd reads the system's jobs at boot. */
export const MAC_DAEMONS_DIR = "/Library/LaunchDaemons";

/** Where this user's own systemd reads their services. */
export function userUnitsDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(homeDir, ".config"), "systemd", "user");
}

/**
 * Which start entry this command wrote is in place now: the unit in this
 * user's systemd folder, or the job an administrator copied into the
 * system's folder on a Mac. An entry a person wrote by hand, under another
 * name, is not recognised (docs/run.md, "When the command stops").
 */
export function startEntryInPlace(
  context: Pick<BootContext, "platform" | "unitsDir" | "daemonsDir" | "label">,
): StartEntry {
  if (context.platform === "linux")
    return existsSync(join(context.unitsDir, `${context.label}.service`)) ? "linux-unit" : null;
  if (context.platform === "darwin")
    return existsSync(join(context.daemonsDir, `${context.label}.plist`)) ? "mac-daemon" : null;
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
  if (context.platform !== "linux" || !context.systemctl) return fail(1, BOOT_WORDS.noSystemd);
  const systemctl = context.systemctl;
  const user = (args: readonly string[]) => systemctl(["--user", ...args]);
  const file = join(context.unitsDir, `${context.label}.service`);
  const wants = wantedBy(file);
  const lingers = await lingering(context);

  if (asked.off) {
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

  const settings = settingsOf(asked, context);
  if (typeof settings === "object") return settings;
  try {
    mkdirSync(dirname(wants), { recursive: true });
    writePrivate(file, bootUnit({ launcher: context.launcher, settings, env: context.env }));
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
 * A Mac's start at boot. macOS starts a job before anyone logs in only from
 * the system's own folder, which an administrator writes, so the account
 * writes what it may - its entry in `~/Library/LaunchDaemons`, which launchd
 * never reads itself - and prints the one line that copies it into place,
 * owned by root, where launchd starts it at the next boot as this user.
 */
function macStartAtBoot(asked: BootAsked, context: BootContext): BootResult {
  const name = `${context.label}.plist`;
  const prepared = join(context.homeDir, "Library", "LaunchDaemons", name);
  const placed = join(context.daemonsDir, name);
  if (asked.off) {
    const was = existsSync(prepared);
    rmSync(prepared, { force: true });
    if (existsSync(placed)) {
      const line = `sudo launchctl bootout system/${shellWord(context.label)} 2>/dev/null; sudo rm -f ${shellWord(placed)}`;
      return { code: 0, out: said(BOOT_WORDS.macOff(context.user, line)), error: "" };
    }
    const lines = was ? BOOT_WORDS.off(context.user) : BOOT_WORDS.wasOff(context.user);
    return { code: 0, out: said(lines), error: "" };
  }
  const settings = settingsOf(asked, context);
  if (typeof settings === "object") return settings;
  const log = join(context.homeDir, "Library", "Logs", `${context.label}.log`);
  try {
    mkdirSync(dirname(prepared), { recursive: true });
    mkdirSync(dirname(log), { recursive: true });
    writePrivate(
      prepared,
      bootPlist({
        label: context.label,
        user: context.user,
        homeDir: context.homeDir,
        launcher: context.launcher,
        settings,
        log,
        env: context.env,
      }),
    );
  } catch (error) {
    return {
      code: 1,
      out: "",
      error: said(BOOT_WORDS.couldNot(error instanceof Error ? error.message : String(error))),
    };
  }
  const line = `sudo install -o root -g wheel -m 644 ${shellWord(prepared)} ${shellWord(placed)}`;
  return {
    code: 0,
    out: said([...BOOT_WORDS.macSet(context.user, line), BOOT_WORDS.macLog(log)]),
    error: "",
  };
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
 * `infinitary help` and `infinitary help run`: the commands, and the ways to
 * start `run` that the app does not set up itself (INF-1228's plan, piece 7:
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
  const xml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const strings = [...own, "run"].map((word) => `<string>${xml(word)}</string>`).join("");
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
        "  At boot, as this user, with nobody logged in:",
        `    ${app} start-at-boot`,
        "",
        "  When you log in on a Mac: save this as ~/Library/LaunchAgents/infinitary.run.plist,",
        "  then log out and back in.",
        '    <?xml version="1.0" encoding="UTF-8"?>',
        '    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '    <plist version="1.0"><dict>',
        "      <key>Label</key><string>infinitary.run</string>",
        `      <key>ProgramArguments</key><array>${strings}</array>`,
        "      <key>RunAtLoad</key><true/>",
        "      <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "    </dict></plist>",
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
