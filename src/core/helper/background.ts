import { execFile, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { OWN_IDENTITY, type Spelling, workLabelOf, workLabels } from "@shared/codeNames";
import { automaticStartupSchema } from "@shared/devices";
import type { BuildFlavor } from "@shared/userDataFolders";
import { z } from "zod";
import { writePrivate } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { pathsOf } from "../folderMove/due";
import { readMoveRecord } from "../folderMove/record";
import { hostEnv } from "../hostEnv";
import { moveLockPathFor, moveLockRunning } from "../storage/moveLock";
import { onHomeMac } from "./homePlace";
import { linuxStartup, type SystemdRuntime } from "./linuxStartup";
import { folderHolder } from "./lock";

/**
 * Running in the background (docs/helper.md, "In the background"): once a
 * user joins, the system's own service manager starts `<app> work run` as
 * that user whenever they are logged in - at login, and again whenever it
 * ends while they are still joined - including while another user is at the
 * screen (captain's pick on FI3-673). Nothing needs an administrator and
 * nothing runs as anyone else. One seam, two adapters:
 *
 * - **launchd** on a Mac: a LaunchAgent in that user's own
 *   `~/Library/LaunchAgents`.
 * - **systemd** on Linux: a user service in that user's own
 *   `~/.config/systemd/user`, wanted by their login (`default.target`).
 *
 * The agent, and the copy of Firstmate a command fetched from its home, are
 * the only things Firstmate puts outside its own data folder. `installed.json`
 * there records both, so removing what Firstmate set up removes exactly
 * those and nothing the person put there.
 */

/** How this app starts itself: its executable, and before `work` the folder an unpackaged run loads. */
export type Launcher = { executable: string; args: readonly string[] };

/** What one call to the service manager answered: `launchctl`, or `systemctl --user`. */
export type LaunchctlResult = { ok: boolean; output: string };

/**
 * Asks the service manager; `program` names the one it runs, which a
 * process of its own can run too (`reloadInBackground`), and is absent for
 * a stand-in asked in this process.
 */
export type Launchctl = ((args: readonly string[]) => Promise<LaunchctlResult>) & {
  readonly program?: string;
};

/** `systemctl`, which the systemd adapter always asks with `--user` first. */
export type Systemctl = Launchctl;

/**
 * The system's own service manager for this user's background work: launchd
 * on a Mac, or this user's own systemd on Linux, whose units live under
 * `configHome` (`$XDG_CONFIG_HOME`, `~/.config` unless the person moved it).
 */
export type ServiceManager =
  | { launchctl: Launchctl }
  | { systemctl: Systemctl; configHome: string; runtime?: () => SystemdRuntime };

export type BackgroundContext = {
  flavor: BuildFlavor;
  dataDir: string;
  /**
   * The spelling whose folder `dataDir` is in (`HelperPlace.folderSpelling`):
   * the agent's label follows the folder, so an agent set up while the work
   * is still in an older spelling's folder keeps that spelling's label, and
   * the one-time move hands it to this app's own. This app's own when absent.
   */
  spelling?: Spelling;
  /** The user's home folder, whose `Library/LaunchAgents` holds a Mac's agent. */
  homeDir: string;
  /** The user's number: the agent runs in that user's own session. */
  uid: number;
} & ServiceManager;

/** The agent as `installed.json` records it: its label, and the file it is set up by. */
export type Service = { label: string; file: string };

const INSTALLED_FILE = "installed.json";

const installedSchema = z.strictObject({
  version: z.literal(1),
  /** The agent, by its label and its file. */
  service: z.strictObject({ label: z.string().min(1), file: z.string().min(1) }).nullable(),
  /** The copy of Firstmate a command fetched from its home; null when this user runs one already here. */
  app: z.string().min(1).nullable(),
});
export type Installed = Omit<z.infer<typeof installedSchema>, "version">;

/** Kept separately so an older app can still read and remove its installed service. */
const AUTOMATIC_STARTUP_FILE = "automatic-startup.json";
const automaticStartupFileSchema = z.strictObject({
  version: z.literal(1),
  state: automaticStartupSchema,
});

export function readAutomaticStartup(dataDir: string) {
  try {
    return automaticStartupFileSchema.parse(
      JSON.parse(readFileSync(join(dataDir, AUTOMATIC_STARTUP_FILE), "utf8")),
    ).state;
  } catch {
    return undefined;
  }
}

function writeAutomaticStartup(
  dataDir: string,
  state: z.infer<typeof automaticStartupSchema>,
): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writePrivate(join(dataDir, AUTOMATIC_STARTUP_FILE), `${JSON.stringify({ version: 1, state })}\n`);
}

/**
 * This app's agent label: one per flavor, so a development copy never
 * stands in for the installed one (`workLabelOf`, `@shared/codeNames`); for
 * a work folder of another spelling, that spelling's.
 */
export function serviceLabel(flavor: BuildFlavor, spelling: Spelling = OWN_IDENTITY): string {
  return workLabelOf(spelling, flavor);
}

/** What Firstmate set up outside its data folder here, or nothing when it set up nothing. */
export function readInstalled(dataDir: string): Installed {
  try {
    const { version: _version, ...installed } = installedSchema.parse(
      JSON.parse(readFileSync(join(dataDir, INSTALLED_FILE), "utf8")),
    );
    return installed;
  } catch {
    return { service: null, app: null };
  }
}

export function writeInstalled(dataDir: string, installed: Installed): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writePrivate(
    join(dataDir, INSTALLED_FILE),
    `${JSON.stringify({ version: 1, ...installed }, null, 2)}\n`,
  );
}

export function forgetInstalled(dataDir: string): void {
  rmSync(join(dataDir, INSTALLED_FILE), { force: true });
  rmSync(join(dataDir, AUTOMATIC_STARTUP_FILE), { force: true });
}

/** The lines that start an agent's run as an app: a separate Mac's. */
const STARTS_AS_APP = ["\t<key>ProcessType</key>", "\t<string>Interactive</string>"];

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The agent: `<app> work run` at login, kept running while the user is
 * joined - while its grant (`home.json`) is in the data folder - so a stop
 * after the home removes it is the last. `interactive` starts it at the
 * priority of an app the person started: a separate Mac's. What it says
 * goes to the folder's own `service.log`. `env` is what it carries of the
 * joining process's environment: a development run's stand-ins alone.
 */
export function servicePlist(options: {
  label: string;
  launcher: Launcher;
  dataDir: string;
  env: Readonly<Record<string, string>>;
  interactive?: boolean;
}): string {
  const strings = (values: readonly string[]) =>
    values.map((value) => `\t\t<string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(options.env);
  const log = join(options.dataDir, "service.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xml(options.label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    strings([options.launcher.executable, ...options.launcher.args, "work", "run"]),
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>PathState</key>",
    "\t\t<dict>",
    `\t\t\t<key>${xml(join(options.dataDir, "home.json"))}</key>`,
    "\t\t\t<true/>",
    "\t\t</dict>",
    "\t</dict>",
    // Named, launchd starts the run as an app the person started; unnamed, as
    // a throttled daemon, where it and every process under it - a crewmate's
    // builds and tests among them - run below the computer's other work and
    // starve while it is busy (INF-247). Another user's work on the home's own
    // Mac keeps that low priority (`separateMac`).
    ...(options.interactive ? STARTS_AS_APP : []),
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(log)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(log)}</string>`,
    ...(env.length > 0
      ? [
          "\t<key>EnvironmentVariables</key>",
          "\t<dict>",
          ...env.flatMap(([key, value]) => [
            `\t\t<key>${xml(key)}</key>`,
            `\t\t<string>${xml(value)}</string>`,
          ]),
          "\t</dict>",
        ]
      : []),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * A Linux user's service: `<app> work run` started by that user's own
 * systemd whenever they are logged in (`WantedBy=default.target`), and again
 * ten seconds after it ends, as launchd keeps a Mac's agent alive. Like the
 * Mac's agent, it runs only while the folder holds its grant (`home.json`) or
 * a removal it has yet to finish (`left.json`), so a finished removal is its
 * last stop. What it says goes to the folder's own `service.log`. `env` is
 * what it carries of the joining process's environment: a development run's
 * stand-ins alone.
 */
export function serviceUnit(options: {
  launcher: Launcher;
  dataDir: string;
  env: Readonly<Record<string, string>>;
}): string {
  const log = unitValue(join(options.dataDir, "service.log"));
  const words = [options.launcher.executable, ...options.launcher.args, "work", "run"];
  return [
    '# Infinitary\'s work for this user (docs/helper.md, "In the background").',
    "[Unit]",
    "Description=Infinitary work",
    // Never give up starting it while the user is joined, as launchd does not.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    // Its run draws on a display of its own rather than a Wayland session's,
    // which goes when that session does (src/main/ownDisplay.ts).
    "UnsetEnvironment=WAYLAND_DISPLAY",
    `ExecCondition=/bin/sh -c ${unitWord('test -e "$1" || test -e "$2"')} sh ${unitWord(join(options.dataDir, "home.json"))} ${unitWord(join(options.dataDir, "left.json"))}`,
    `ExecStart=${words.map(unitWord).join(" ")}`,
    "Restart=always",
    "RestartSec=10",
    // launchd's own wait before it ends an agent that does not stop. The
    // run hears the stop first; its display goes once the run has.
    "TimeoutStopSec=20",
    "KillMode=mixed",
    ...Object.entries(options.env).map(
      ([key, value]) => `Environment=${unitQuoted(`${key}=${value}`)}`,
    ),
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * The service `infinitary start-at-boot` sets up (docs/run.md, "Starting at
 * boot"): `<app> run` started by this user's own systemd at their login, and
 * at boot once the user lingers. A failure starts it again ten seconds later,
 * an update's exit 75 among them, so the new version runs; a clean stop
 * (exit 0) and a settings file to fix (exit 78) do not. What it says goes to
 * this user's journal.
 */
export function bootUnit(options: {
  launcher: Launcher;
  settings?: string;
  env: Readonly<Record<string, string>>;
}): string {
  const words = [
    options.launcher.executable,
    ...options.launcher.args,
    "run",
    ...(options.settings ? ["--settings", options.settings] : []),
  ];
  return [
    '# Infinitary started at boot for this user (docs/run.md, "Starting at boot").',
    "[Unit]",
    "Description=Infinitary",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    // Its run draws on a display of its own rather than a Wayland session's,
    // which goes when that session does (src/main/ownDisplay.ts).
    "UnsetEnvironment=WAYLAND_DISPLAY",
    `ExecStart=${words.map(unitWord).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=10",
    "RestartPreventExitStatus=78",
    "TimeoutStopSec=20",
    "KillMode=mixed",
    ...Object.entries(options.env).map(
      ([key, value]) => `Environment=${unitQuoted(`${key}=${value}`)}`,
    ),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * A Mac's boot entry for `infinitary start-at-boot` (docs/run.md, "Starting
 * at boot"): a system job an administrator copies into `/Library/LaunchDaemons`,
 * which launchd starts at boot as `user` (`UserName`), with nobody logged in,
 * since macOS has no linger. A failure starts it again, an update's exit 75
 * among them, so the new version runs; a clean stop (exit 0) does not. It
 * runs at the priority of an app the person started, as the home's own work
 * does (INF-247). What it says goes to `log`, which launchd opens as `user`.
 * With no `user` it is an agent in the session of the user who loads it, as
 * the window loads the run it starts (`startRunAgent`, ./runAgent.ts).
 */
export function bootPlist(options: {
  label: string;
  user?: string;
  homeDir?: string;
  launcher: Launcher;
  settings?: string;
  log: string;
  env: Readonly<Record<string, string>>;
}): string {
  const words = [
    options.launcher.executable,
    ...options.launcher.args,
    "run",
    ...(options.settings ? ["--settings", options.settings] : []),
  ];
  // Named, so the run finds its data folder in this account's home whatever a system job is given.
  const env = Object.entries({
    ...(options.homeDir ? { HOME: options.homeDir } : {}),
    ...options.env,
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xml(options.label)}</string>`,
    ...(options.user ? ["\t<key>UserName</key>", `\t<string>${xml(options.user)}</string>`] : []),
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...words.map((word) => `\t\t<string>${xml(word)}</string>`),
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    ...STARTS_AS_APP,
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(options.log)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(options.log)}</string>`,
    ...(env.length > 0
      ? [
          "\t<key>EnvironmentVariables</key>",
          "\t<dict>",
          ...env.flatMap(([key, value]) => [
            `\t\t<key>${xml(key)}</key>`,
            `\t\t<string>${xml(value)}</string>`,
          ]),
          "\t</dict>",
        ]
      : []),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** A value a unit file holds as it is: one line, with systemd's specifiers kept literal. */
function unitValue(text: string): string {
  if (/[\n\r\0]/.test(text)) throw new Error("A unit file cannot hold a line break.");
  return text.replace(/%/g, "%%");
}

/** A quoted string in a unit file, its escapes and specifiers kept literal. */
function unitQuoted(text: string): string {
  return `"${unitValue(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One word of a unit file's command line: quoted, and its variables kept literal too. */
function unitWord(text: string): string {
  return unitQuoted(text).replace(/\$/g, "$$$$");
}

/** One system's way of keeping the agent: launchd's or systemd's. */
type Adapter = {
  /** The agent under a label (this app's own unless named), and the file it is set up by. */
  service: (context: BackgroundContext, label?: string) => Service;
  /** Writes the agent's file, and whatever makes it start at login. */
  write: (context: BackgroundContext, service: Service, text: AgentText) => void;
  /** Starts it now, as the system answers: running, at the next login, or failed. */
  load: (context: BackgroundContext, service: Service) => Promise<InBackgroundNow>;
  /** Lets it go once its files are gone; run from the agent itself, this ends its process. */
  unload: (context: BackgroundContext, service: Service) => Promise<void>;
  /** Stops its run without taking it away. */
  pause: (context: BackgroundContext, service: Service) => Promise<void>;
  /** Starts it again after a pause that changed nothing. */
  resume: (context: BackgroundContext, service: Service) => Promise<void>;
  /** Whether it runs now. */
  state: (context: BackgroundContext, service: Service) => Promise<InBackgroundNow>;
};

type AgentText = { launcher: Launcher; env: Readonly<Record<string, string>> };

/** Startup outcome: running, verified next login, refusal, unsupported setup, or unreadable facts. */
export type InBackgroundNow = "running" | "at-login" | "failed" | "unavailable" | "unknown";

/**
 * Loads a Mac agent from its file in this user's session: running once
 * launchd took it, failed when it refused, and at-login with no session.
 * The window's run agent loads this way too (./runAgent.ts).
 */
export async function loadAgent(
  launchctl: Launchctl,
  uid: number,
  service: Service,
): Promise<InBackgroundNow> {
  const domain = `gui/${uid}`;
  // One left loaded goes first, so launchd reads this file again.
  await launchctl(["bootout", `${domain}/${service.label}`]);
  const started = await launchctl(["bootstrap", domain, service.file]);
  if (started.ok) return "running";
  // launchd knows the domain only while the user is logged in: asking for it
  // tells an absent session from a refusal, without reading launchctl's words.
  const session = await launchctl(["print", domain]);
  return session.ok ? "failed" : "at-login";
}

const launchd: Adapter = {
  service: (context, named) => {
    const label = named ?? serviceLabel(context.flavor, context.spelling);
    return { label, file: join(context.homeDir, "Library", "LaunchAgents", `${label}.plist`) };
  },
  write: (context, service, text) => {
    mkdirSync(dirname(service.file), { recursive: true });
    writePrivate(
      service.file,
      servicePlist({
        label: service.label,
        dataDir: context.dataDir,
        interactive: separateMac(context.dataDir),
        ...text,
      }),
    );
  },
  load: (context, service) => loadAgent(launchctlOf(context), context.uid, service),
  unload: async (context, service) => {
    await launchctlOf(context)(["bootout", `gui/${context.uid}/${service.label}`]);
  },
  pause: async (context, service) => {
    await launchctlOf(context)(["bootout", `gui/${context.uid}/${service.label}`]);
  },
  resume: async (context, service) => {
    await launchctlOf(context)(["bootstrap", `gui/${context.uid}`, service.file]);
  },
  state: async (context, service) => {
    const launchctl = launchctlOf(context);
    const domain = `gui/${context.uid}`;
    if (!(await launchctl(["print", domain])).ok) return "at-login";
    return (await launchctl(["print", `${domain}/${service.label}`])).ok ? "running" : "failed";
  },
};

/**
 * Whether the folder runs work for a home on a separate Mac: its agent then
 * starts the run as an app, and its crewmates' builds and tests run at the
 * run's own priority. On the home's own Mac, or with no grant to read, the
 * run keeps low priority (captain on INF-255). The grant tells
 * (`onHomeMac`): what the home's welcome said and the grant keeps, read
 * each time the agent's file is written and each time the run starts.
 */
export function separateMac(
  dataDir: string,
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): boolean {
  const joined = new JoinedHome(dataDir, () => {}).read();
  return joined ? !onHomeMac(joined.grant, interfaces) : false;
}

/** The states in which this user's systemd holds the service as running or about to. */
const SYSTEMD_RUNNING = new Set(["active", "activating", "reloading", "deactivating"]);

const systemd: Adapter = {
  service: (context, named) => {
    const label = `${named ?? serviceLabel(context.flavor, context.spelling)}.service`;
    return { label, file: join(systemdUnits(context), label) };
  },
  write: (context, service, text) => {
    mkdirSync(dirname(service.file), { recursive: true });
    writePrivate(service.file, serviceUnit({ dataDir: context.dataDir, ...text }));
    // What `systemctl --user enable` makes, made here so the service starts at
    // the next login even when this user's systemd cannot be asked now.
    const wants = wantedBy(service.file);
    mkdirSync(dirname(wants), { recursive: true });
    rmSync(wants, { force: true });
    symlinkSync(service.file, wants);
  },
  load: async (context, service) => {
    const readiness = await linuxReadiness(context);
    if (readiness !== "available") return readiness;
    const systemctl = systemctlOf(context);
    // Its user's systemd reads the file again; one an earlier join started
    // stops first, so the new one runs.
    const read = (await systemctl(["daemon-reload"])).ok;
    if (read && (await systemctl(["restart", service.label])).ok) return "running";
    // Re-read the runtime/session facts if the user manager stopped during startup.
    // A failed manager read alone never promises a later login.
    const after = await linuxReadiness(context);
    return after === "available" ? "failed" : after;
  },
  unload: async (context, service) => {
    const systemctl = systemctlOf(context);
    await systemctl(["daemon-reload"]);
    await systemctl(["reset-failed", service.label]);
    // Not waited for: run from the service itself, the stop ends this process.
    await systemctl(["stop", "--no-block", service.label]);
  },
  pause: async (context, service) => {
    await systemctlOf(context)(["stop", service.label]);
  },
  resume: async (context, service) => {
    await systemctlOf(context)(["start", service.label]);
  },
  state: async (context, service) => {
    const systemctl = systemctlOf(context);
    const readiness = await linuxReadiness(context);
    if (readiness !== "available") return readiness;
    const active = await systemctl(["show", "--property=ActiveState", "--value", service.label]);
    if (!active.ok) return "unknown";
    const state = active.output.trim();
    return SYSTEMD_RUNNING.has(state)
      ? "running"
      : state === "inactive" || state === "failed"
        ? "failed"
        : "unknown";
  },
};

/** The Linux adapter's runtime/session facts, shared by start, status and reconnect. */
export function linuxReadiness(context: BackgroundContext) {
  if (!("systemctl" in context)) throw new Error("Not a Linux background context.");
  return linuxStartup(context.systemctl, context.uid, context.runtime);
}

function adapterOf(context: BackgroundContext): Adapter {
  return "systemctl" in context ? systemd : launchd;
}

export function launchctlOf(context: ServiceManager): Launchctl {
  if (!("launchctl" in context)) throw new Error("launchd is not this computer's service manager.");
  return context.launchctl;
}

/** systemd's own, always about this user's services. */
export function systemctlOf(context: ServiceManager): Systemctl {
  if (!("systemctl" in context)) throw new Error("systemd is not this computer's service manager.");
  const { systemctl } = context;
  return (args) => systemctl(["--user", ...args]);
}

/** Where this user's own systemd reads their services. */
function systemdUnits(context: BackgroundContext): string {
  return join(
    "configHome" in context ? context.configHome : join(context.homeDir, ".config"),
    "systemd",
    "user",
  );
}

/** The link that has a user's login start a service: beside its file, in `default.target.wants`. */
export function wantedBy(file: string): string {
  return join(dirname(file), "default.target.wants", basename(file));
}

/**
 * The files a removal takes away for the agent, in order: a Linux service's
 * link from the login first, so it never starts at another login, then its
 * file; a Mac's agent is its file alone.
 */
export function serviceFiles(service: Service): string[] {
  return service.file.endsWith(".service")
    ? [wantedBy(service.file), service.file]
    : [service.file];
}

/**
 * Sets up the agent and starts it now: `running` once the service manager
 * took it, `at-login` when the user has no login session to give it to (a
 * Terminal reached over SSH while they are not logged in), so it starts the
 * next time they log in, and `failed` when their session is there and still
 * refused it, which no login mends. An agent `installed.json` records under
 * another of the app's labels moves to this app's own (`moveInBackground`).
 * Never run from that agent itself: taking it away would end this process.
 */
export async function startInBackground(
  context: BackgroundContext,
  options: { launcher: Launcher; env: Readonly<Record<string, string>>; app: string | null },
): Promise<InBackgroundNow> {
  const moved = await moveInBackground(context, {
    ...options,
    label: serviceLabel(context.flavor, context.spelling),
  });
  await moved.retire();
  return moved.state;
}

/** What a move answers: how the agent it set up started, and what takes the one before it away. */
export type MovedInBackground = {
  state: InBackgroundNow;
  /**
   * Takes away the agent `installed.json` recorded before, when the move put
   * another in its place: its files, then the service manager lets it go.
   * Run from that agent itself, the second step ends this process, so it
   * comes last. Nothing when nothing moved.
   */
  retire: () => Promise<void>;
};

/**
 * Sets up the agent under `label` and starts it. Under the label
 * `installed.json` records already, or with none recorded, that is all, as
 * a join or an update always did. Under another label it is a move, in one
 * step (the Infinitary rename, FI3-1780 step 2): a renamed app's agent, or
 * one coming back to this app, takes the place of the one recorded. The
 * new one is set up and started first, and recorded only once the service
 * manager took it; the old one goes last (`retire`). Their runs never
 * overlap: each works only while it holds the data folder
 * (`src/core/helper/lock.ts`). A new one the service manager refuses is
 * taken away again and the old one started again as it was, so a move
 * that fails changes nothing.
 */
export async function moveInBackground(
  context: BackgroundContext,
  options: {
    label: string;
    launcher: Launcher;
    env: Readonly<Record<string, string>>;
    app: string | null;
  },
): Promise<MovedInBackground> {
  if ("systemctl" in context) {
    const readiness = await linuxReadiness(context);
    if (readiness === "unavailable" || readiness === "unknown") {
      const installed = readInstalled(context.dataDir);
      if (!installed.service) writeInstalled(context.dataDir, { ...installed, app: options.app });
      writeAutomaticStartup(context.dataDir, readiness);
      return { state: readiness, retire: async () => {} };
    }
  }
  const adapter = adapterOf(context);
  const service = adapter.service(context, options.label);
  const text = { launcher: options.launcher, env: options.env };
  const before = readInstalled(context.dataDir).service;
  const nothing = async () => {};
  if (!before || before.label === service.label) {
    adapter.write(context, service, text);
    writeInstalled(context.dataDir, {
      service,
      app: options.app,
    });
    const state = await adapter.load(context, service);
    if ("systemctl" in context)
      writeAutomaticStartup(context.dataDir, state === "running" ? "available" : state);
    return { state, retire: nothing };
  }
  const takeAway = async () => {
    for (const file of serviceFiles(service)) rmSync(file, { force: true });
    await adapter.unload(context, service);
  };
  let state: InBackgroundNow;
  try {
    adapter.write(context, service, text);
    state = await adapter.load(context, service);
    if ("systemctl" in context)
      writeAutomaticStartup(context.dataDir, state === "running" ? "available" : state);
  } catch (error) {
    await takeAway().catch(() => undefined);
    throw error;
  }
  if (state === "failed" || state === "unavailable" || state === "unknown") {
    await takeAway();
    await adapter.resume(context, before);
    return { state, retire: nothing };
  }
  writeInstalled(context.dataDir, {
    service,
    app: options.app,
  });
  return {
    state,
    retire: async () => {
      for (const file of serviceFiles(before)) rmSync(file, { force: true });
      await adapter.unload(context, before);
    },
  };
}

/**
 * The grants an agent of this work folder may name: its own, and, once the
 * one-time move brought its data folder over from an older one, the older
 * folder's, as named and as the disk resolves it (`pathsOf`).
 */
function grantsOf(dataDir: string): string[] {
  const from = readMoveRecord(dirname(dataDir))?.from;
  return [
    join(dataDir, "home.json"),
    ...(from ? pathsOf(from).map((older) => join(older, basename(dataDir), "home.json")) : []),
  ];
}

/**
 * Writes the agent's file anew for this work folder and records it, without
 * asking the service manager, which reads the file at its next load - the
 * next login: for an agent whose own run cannot set it up anew now, after
 * the one-time move took its folder elsewhere and the agent under this app's
 * own label was refused.
 */
export function rewriteInBackground(
  context: BackgroundContext,
  service: Service,
  options: { launcher: Launcher; env: Readonly<Record<string, string>>; app: string | null },
): void {
  adapterOf(context).write(context, service, { launcher: options.launcher, env: options.env });
  writeInstalled(context.dataDir, {
    service,
    app: options.app,
  });
}

/**
 * Has launchd read a Mac's agent file anew and start it, from outside the
 * agent's own run: what an update that rewrote the agent of the run asking
 * does last (`./update.ts`, "Kept here first"). Taking the agent away ends
 * every process of its run but one in a session of its own, so a shell in
 * its own session takes it away and sets it up again, outliving the run; a
 * stand-in asked in this process is asked here, in the same order. Nothing
 * is waited for: run from that agent, the first step ends this process.
 */
export async function reloadInBackground(
  context: BackgroundContext,
  service: Service,
): Promise<void> {
  if (!("launchctl" in context)) throw new Error("Only a Mac's agent is read anew this way.");
  const domain = `gui/${context.uid}`;
  const { launchctl } = context;
  if (!launchctl.program) {
    await launchctl(["bootout", `${domain}/${service.label}`]);
    await launchctl(["bootstrap", domain, service.file]);
    return;
  }
  spawn(
    "/bin/sh",
    [
      "-c",
      '"$0" bootout "$1"; "$0" bootstrap "$2" "$3"',
      launchctl.program,
      `${domain}/${service.label}`,
      domain,
      service.file,
    ],
    { detached: true, stdio: "ignore", env: hostEnv() },
  ).unref();
}

/**
 * What a move that stopped partway left beside the agent `installed.json`
 * records, taken away by the run once it holds the data folder: an agent of
 * this flavor under another of the app's labels whose file still names this
 * folder - or the older folder the one-time move brought it from - and a
 * copy of Firstmate in `app/` other than the one recorded. It reads only
 * those labels' files and that folder, so another folder's agent stays.
 * Run from such an agent, letting it go ends this process, as a retire
 * does; the recorded one then runs.
 */
export async function retireStrays(context: BackgroundContext): Promise<void> {
  const { service, app } = readInstalled(context.dataDir);
  if (app) {
    const kept = dirname(app);
    let entries: string[] = [];
    try {
      entries = readdirSync(kept);
    } catch {
      // Nothing kept there.
    }
    for (const entry of entries)
      if (join(kept, entry) !== app && /\.app(\.next)?$/.test(entry))
        rmSync(join(kept, entry), { recursive: true, force: true });
  }
  if (!service) return;
  const adapter = adapterOf(context);
  const grants = grantsOf(context.dataDir);
  for (const label of workLabels(context.flavor)) {
    const stray = adapter.service(context, label);
    if (stray.label === service.label) continue;
    let text = "";
    try {
      text = readFileSync(stray.file, "utf8");
    } catch {
      continue;
    }
    if (!grants.some((home) => text.includes(xml(home)) || text.includes(unitWord(home)))) continue;
    for (const file of serviceFiles(stray)) rmSync(file, { force: true });
    await adapter.unload(context, stray);
  }
}

/**
 * Takes the agent away: its files first, so it never starts at another
 * login, then the service manager lets it go. Run from the agent itself,
 * the second step ends this process, so it comes last.
 */
export async function stopInBackground(
  context: BackgroundContext,
  service: Service,
): Promise<void> {
  for (const file of serviceFiles(service)) rmSync(file, { force: true });
  await adapterOf(context).unload(context, service);
}

/**
 * Stops the agent's run without taking the agent away, so a running `work
 * run` lets the folder go: what the home's update and removal over Remote
 * Login do first. The file stays; `resumeInBackground` starts it again.
 */
export async function pauseInBackground(
  context: BackgroundContext,
  service: Service,
): Promise<void> {
  await adapterOf(context).pause(context, service);
}

/** Starts the agent again after a pause that changed nothing. */
export async function resumeInBackground(
  context: BackgroundContext,
  service: Service,
): Promise<void> {
  await adapterOf(context).resume(context, service);
}

/**
 * Whether the agent runs now, as the home's SSH connection asks it
 * (docs/helper.md, "Through the home's SSH"): `running` while the service
 * manager holds it in this user's session, `at-login` when this user has no
 * login session for it, and `failed` when the session is there and holds no
 * agent, which no login mends. The manager is asked, never its words read.
 */
export async function backgroundState(
  context: BackgroundContext,
  service: Service,
): Promise<InBackgroundNow> {
  return adapterOf(context).state(context, service);
}

/** The system's own launchctl, which a test never reaches. */
export const systemLaunchctl: Launchctl = launchctlAt("/bin/launchctl");

/** A development run's stand-in for launchctl or systemctl, which tests use so no real agent is ever loaded. */
export function launchctlAt(program: string): Launchctl {
  return Object.assign((args: readonly string[]) => runManager(program, args), { program });
}

/** This Linux computer's own systemctl, where its search path finds it. */
export function systemSystemctl(program: string): Systemctl {
  return (args) => runManager(program, args);
}

function runManager(program: string, args: readonly string[]): Promise<LaunchctlResult> {
  return new Promise((resolve) => {
    execFile(program, [...args], { env: hostEnv(), timeout: 15_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${String(stdout)}${String(stderr)}`.trim() }),
    );
  });
}

/** How many beats in a row a loaded agent may hold no run before the work is said not to start. */
const IDLE_BEATS_BEFORE_FAILED = 2;

/**
 * `backgroundState` for the connection's beats: an agent the service manager holds that
 * leaves the data folder with no live run on two beats in a row keeps
 * exiting, so the work cannot start (`failed`) rather than `running`.
 * One beat with no run is a start in progress and answers `unknown`, and so
 * does a live move of the data folder: the run moves it before it takes the
 * folder, and a move of a large folder outlasts both beats. A move that has
 * run past `MOVE_LOCK_TRUST_MS` no longer counts, so a stuck one reads failed.
 */
export function agentProbe(
  context: BackgroundContext,
  service: Service,
  now: () => number = Date.now,
): () => Promise<InBackgroundNow> {
  let idle = 0;
  return async () => {
    const state = await backgroundState(context, service);
    if (state !== "running") {
      idle = 0;
      return state;
    }
    if (folderHolder(context.dataDir) !== null) {
      idle = 0;
      return "running";
    }
    if (moveLockRunning(moveLockPathFor(dirname(context.dataDir)), now)) {
      idle = 0;
      return "unknown";
    }
    idle += 1;
    return idle >= IDLE_BEATS_BEFORE_FAILED ? "failed" : "unknown";
  };
}
