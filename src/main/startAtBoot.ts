import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivate } from "@core/devices/identity";
import { bootUnit, type Launchctl, type Launcher, wantedBy } from "@core/helper/background";
import { lingerStays } from "@core/helper/words";
import { HERE } from "@shared/deviceNames";
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
 * runs, as the Linux join does (`afterLogout`). A Mac's boot entry waits for
 * its check on a disposable Mac, so there it changes nothing and says so.
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
  off: (user: string) => [`Infinitary no longer starts at boot as ${user}.`],
  wasOff: (user: string) => [`Infinitary was not set to start at boot as ${user}.`],
  noSystemd: [
    `${HERE.This} has no systemd for this user, so Infinitary cannot start at boot here.`,
    "infinitary help run lists other ways to start it.",
  ],
  mac: [
    "Infinitary cannot start at boot on a Mac yet.",
    "infinitary help run lists other ways to start it, such as when you log in.",
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
  /** Where this user's own systemd reads their services (`~/.config/systemd/user`). */
  unitsDir: string;
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

const said = (lines: readonly string[]) => (lines.length > 0 ? `${lines.join("\n")}\n` : "");

export async function runStartAtBoot(asked: BootAsked, context: BootContext): Promise<BootResult> {
  const fail = (code: number, lines: readonly string[]): BootResult => ({
    code,
    out: "",
    error: said(lines),
  });
  if (context.platform === "darwin") return fail(1, BOOT_WORDS.mac);
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

  let settings: string | undefined;
  if (asked.settings) {
    // Read now, so a file to fix is said here rather than in the journal at boot.
    const reading = readRunSettings(asked.settings, context.cwd);
    if (!reading.ok)
      return fail(RUN_SETTINGS_EXIT, RUN_WORDS.settings(reading.file, reading.reason));
    settings = reading.file;
  }
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
  const app = own
    .map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`))
    .join(" ");
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
        "  At boot on Linux, as this user, with nobody logged in:",
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
