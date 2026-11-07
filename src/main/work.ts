import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { runCli } from "@core/helper/cli";
import { helperWords } from "@core/helper/words";
import type { HostKeychain } from "@core/host";
import { settingFrom } from "@shared/envSettings";
import { app } from "electron";
import { hostPlatform } from "../core/platform";
import { readSelfSourceAsync } from "../core/selfSource/resolve";
import { registerFrameScheme } from "./frames/frameScheme";
import { createAxiProcessSpawner } from "./host/axiProcess";
import { memoryPressureStandIn, readResourceMemory } from "./host/resourceMemory";
import { createSetAsideProcessSpawner } from "./host/setAsideProcess";
import { createTaskBrowserHost } from "./host/taskBrowser";
import { createMediaProbe, createTypefaceProbe } from "./mediaProbe";
import { startOwnDisplay } from "./ownDisplay";
import { workContext } from "./workContext";

/**
 * Before `app.ready`. The entry awaits this module's load, and Electron is
 * ready once that entry has finished, so this runs before `prepareWorkMode`
 * can await a display and before `runWorkMode` opens the media probe.
 * Without these privileges Chromium refuses the probe's `app-frame:`
 * recording (`./frames/frameScheme.ts`).
 */
registerFrameScheme();

/**
 * The app started as `<app> work <command> ...` (docs/helper.md): it runs
 * work for another Mac's Firstmate, or for this Mac's as another macOS
 * user, with no window. Only Firstmate's own code runs - the archive the
 * fuses already pin - and the core's windowless composition
 * (src/core/helper/) does the work; this file only gives it the app's
 * version, where its data lives and the Terminal it was started from.
 *
 * Nothing of the app itself starts: the main entry (./index.ts) loads this
 * module instead of the app's (./app.ts), so none of the app's modules are
 * evaluated - no core, no window, no single-instance lock - and nothing in
 * the app's own userData is opened but its `work/` folder.
 */
/**
 * The notes the core's parts leave on the console - the search path it
 * found, a file it could not read - go to `work.log` in the data folder,
 * never to the Terminal the person reads; an error stays on stderr.
 */
function noteToLog(dataDir: () => string): void {
  const note =
    (level: string) =>
    (...parts: unknown[]) => {
      try {
        appendFileSync(
          join(dataDir(), "work.log"),
          `${new Date().toISOString()} ${level} ${parts.map((part) => (typeof part === "string" ? part : inspect(part))).join(" ")}\n`,
          { mode: 0o600 },
        );
      } catch {
        // Before the folder exists, or when it cannot be written, a note is dropped.
      }
    };
  console.log = note("log");
  console.info = note("info");
  console.debug = note("debug");
  console.warn = note("warn");
}

/**
 * This Mac's saved passwords, where Claude Code keeps its login, read the way
 * the app reads its own (./host/keychainProcess.ts) and loaded with the first
 * read, so a computer that never signs in to Claude never loads it. It
 * offers no unlock: nothing here ever lets macOS ask (docs/helper.md, "Its
 * own sign-ins").
 */
function savedPasswords(mainDir: string): HostKeychain {
  let loaded: Promise<HostKeychain> | undefined;
  const keychain = () =>
    (loaded ??= import("./host/electronKeychain").then(({ createElectronKeychain }) =>
      createElectronKeychain(join(mainDir, "keychainProcessMain.js")),
    ));
  return {
    findGenericPassword: async (query) => (await keychain()).findGenericPassword(query),
    readGenericPassword: async (query) => (await keychain()).readGenericPassword(query),
  };
}

/** The commands that live past Chromium's start, and so need a display to draw on. */
const DRAWING_COMMANDS = new Set(["join", "run", "update", "remove", "connect"]);

/**
 * What the work mode needs before Chromium opens a display: on Linux, a
 * display of its own (./ownDisplay.ts), which outlives any desktop session;
 * a Wayland session's own, which Chromium chose at its start; or with no
 * Xvfb, an X session's. With no way to draw it says what to install, ends
 * the work mode, and answers false.
 */
export async function prepareWorkMode(args: readonly string[]): Promise<boolean> {
  const platform = hostPlatform();
  if (platform !== "linux" || !DRAWING_COMMANDS.has(args[0] ?? "")) return true;
  const { place } = workContext();
  if (await startOwnDisplay({ platform, env: process.env, dataDir: place.dataDir })) return true;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  process.stdout.write(`${helperWords.needsDisplay.join("\n")}\n`, () => app.exit(1));
  return false;
}

/** The signals that stop it: Ctrl-C, a service stopping it, its Terminal closing. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** `mainDir` is where the main process's built entries are, the task command's among them. */
export function runWorkMode(args: readonly string[], mainDir: string): void {
  // No Dock icon, no menu bar, never brought forward: macOS lists it as
  // background-only.
  if (hostPlatform() === "darwin") app.setActivationPolicy("prohibited");
  // Nothing is ever drawn, and the connection is Node's own, so Chromium's
  // graphics and network services each run as a thread of this process
  // rather than a process of their own, and graphics never touches the
  // hardware: the work is one process.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
  const { place, launcher, serviceManager, backgroundEnv } = workContext();
  // Chromium's own files, which Electron makes even with no window, go in
  // the work folder, never in the app's own userData: the folder the work is
  // in now, whose `chromium/` the one-time move leaves behind.
  app.setPath("userData", join(place.dataDir, "chromium"));
  // Terminal shows only what the work mode says to its person; the notes
  // its parts leave go to the folder's own log, in the folder the work is
  // in now: an older spelling's until the one-time move brings it over.
  let workingIn = place.dataDir;
  noteToLog(() => workingIn);

  // Ctrl-C, or a service stopping it, quits the app; the command ends
  // first and says so, then the app exits with its code.
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let ending = false;
  // The only windows here are hidden: the media probe's, short-lived
  // (./mediaProbe.ts), and the pages of its tasks' browsers
  // (./host/taskBrowser.ts). The last of them closing is no reason to quit.
  app.on("window-all-closed", () => {});
  app.on("will-quit", (event) => {
    if (ending) return;
    event.preventDefault();
    stop();
  });
  // Electron makes the first Ctrl-C (SIGINT), SIGTERM or SIGHUP that quit.
  // Node hears a signal only once something listens for it, and then in
  // Electron's place; a module loaded later that listens - Pi's sign-in store
  // locks its file through signal-exit - would take the signal from Electron
  // and, hearing no other listener, end the process by the signal itself,
  // before the command ends. A listener of the work mode's own, here before
  // Electron is ready, keeps Electron the one that hears it, and stops the run
  // the same way should Node ever be the one.
  for (const signal of STOP_SIGNALS) process.on(signal, () => stop());

  // A run whose data a test isolated reads no saved passwords.
  const isolated = !app.isPackaged && Boolean(settingFrom(process.env, "HELPER_DATA_DIR")?.trim());

  void runCli(args, {
    version: app.getVersion(),
    source: () =>
      readSelfSourceAsync({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        version: app.getVersion(),
        computer: hostname(),
      }),
    place,
    // The background starts this app again as it was started here: the
    // installed app itself, or Electron with the checkout's folder.
    launcher,
    serviceManager,
    backgroundEnv,
    // The app's own git helper, outside the archive in a packaged app.
    gitAskpass: app.isPackaged
      ? join(process.resourcesPath, "git-askpass")
      : join(app.getAppPath(), "resources", "git-askpass"),
    // The app's own git: beside the archive in an installed app, in the
    // checkout's vendor/ otherwise.
    appGit: {
      packaged: app.isPackaged,
      appDir: app.getAppPath(),
      resourcesDir: process.resourcesPath,
    },
    // A run whose data a test isolated reads no saved passwords, so no test
    // ever reads the Claude login of the person running it.
    ...(hostPlatform() === "darwin" && !isolated ? { keychain: savedPasswords(mainDir) } : {}),
    // A card's demo recording plays in a hidden window of its own before
    // the card goes to the home, as it does on the home (./mediaProbe.ts).
    probeMedia: createMediaProbe(),
    // A preview's project font loads in one the same way (./mediaProbe.ts).
    probeTypeface: createTypefaceProbe(),
    resourceMemory: () => readResourceMemory(memoryPressureStandIn(process.env, app.isPackaged)),
    // Each task's own browser runs here, in hidden windows of its own, and
    // its crewmate reaches it through this computer's own task channel
    // (docs/task-browser.md, "On another computer").
    browser: {
      host: createTaskBrowserHost(),
      spawner: createAxiProcessSpawner(join(mainDir, "axiProcess.js")),
      binDir: app.isPackaged
        ? join(process.resourcesPath, "axi-bin")
        : join(app.getAppPath(), "resources", "axi-bin"),
    },
    // A file the home copies from here is set aside in a process of its
    // own, so the copy never drops this process's locks (docs/files.md).
    setAsideProcess: createSetAsideProcessSpawner(join(mainDir, "setAsideProcess.js")),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stopSignal: () => stopped,
    workingIn: (dataDir) => {
      workingIn = dataDir;
    },
  })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      return 1;
    })
    .then((code) => {
      ending = true;
      // What it said reaches the Terminal before the process ends.
      process.stdout.write("", () => app.exit(code));
    });
}
