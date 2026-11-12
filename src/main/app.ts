import { rm } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { openCommandDoor } from "@core/axi/commandDoor";
import { defaultClaudeConfigDir } from "@core/claude/claudeQuota";
import { startConnection } from "@core/connection/connection";
import { ownComputerName } from "@core/devices/computerName";
import { JoinedHome } from "@core/devices/joinedHome";
import { dueMove } from "@core/folderMove/due";
import { startInBackground } from "@core/helper/background";
import { windowFromWork } from "@core/helper/fromWindow";
import { configureSettingsPath, hostPath } from "@core/hostEnv";
import { type Core, startCore } from "@core/index";
import { isAllowedOpenExternalUrl } from "@core/openExternal";
import { appPathsFor } from "@core/paths";
import { dataFolderRefusal } from "@core/storage/dataFolderRefusal";
import {
  SAVED_DATA_REFUSAL_TITLE,
  UnsupportedSavedDataError,
} from "@core/storage/savedDataCompatibility";
import { createInstalledUpdateChecker } from "@core/update/updateChecker";
import { crewWorkHeldThere } from "@core/update/updateHold";
import { APP_IDENTITIES, readSpellings } from "@shared/codeNames";
import { settingFrom } from "@shared/envSettings";
import { setComputerLocale, setCurrentLanguage } from "@shared/i18n/current";
import {
  languageArgument,
  localeArgument,
  readableLocale,
  SOURCE_LANGUAGE,
} from "@shared/i18n/languages";
import {
  chosenLanguage,
  defaultLanguage,
  languageOverride,
  startLanguage,
} from "@shared/i18n/start";
import { platformArgument } from "@shared/platform";
import { FRAME_FOCUS_BLINK_FEATURE } from "@shared/plugins/containment";
import type { ReleaseNotesView } from "@shared/releaseTracking";
import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { checksUpdates } from "@shared/update";
import { spellingOfUserDataFolder } from "@shared/userDataFolders";
import { app, BrowserWindow, dialog, Menu, nativeTheme, powerMonitor, session } from "electron";
import { hostDesktop, hostPlatform } from "../core/platform";
import { installAppMenu, resetAllKeysAfterAsking } from "./appMenu";
import {
  betweenStops,
  entryWaitMs,
  noteStartedHere,
  START_HERE_ARG,
  startedHere,
} from "./besideRun";
import { disableChromiumFeatures } from "./chromiumFeatures";
import { commandStarter } from "./commandStarter";
import { frameFontFiles } from "./frames/fontFiles";
import { frameLibPins } from "./frames/frameLibFiles";
import { FrameMountRegistry } from "./frames/frameMounts";
import { handleFrameProtocol } from "./frames/frameProtocol";
import { handOverProfileDir, runHandOver } from "./handOver";
import {
  createElectronHost,
  type ElectronHostOptions,
  forgetAutostart,
  startAtLoginFor,
} from "./host/electronHost";
import { createElectronKeychainFile, readElectronKeychainStatus } from "./host/electronKeychain";
import { nativeSecrets } from "./host/nativeSecrets";
import { broadcast, registerIpc } from "./ipc";
import { followWindowCommands, moveCommands, shellCommands } from "./keyboard";
import { deferCoreDisposal } from "./lifecycle";
import { answerStartupAsks, STARTUP_ASK_BUTTONS, startupAsks } from "./linuxStartup";
import { startOwnDisplay } from "./ownDisplay";
import { followRendererRecovery } from "./rendererRecovery";
import {
  followInstalledProgram,
  lockHolder,
  markRunning,
  processAlive,
  programIdentity,
  RUN_SETTINGS_EXIT,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
  type RunEnd,
  runningByCommand,
  runOptions,
  stopRunningCommand,
  windowProfileDir,
} from "./runCommand";
import { type RunEnvironment, readKeychainLock, runEnvironment } from "./runEnvironment";
import { readRunSettings } from "./runSettings";
import { readRunStatus } from "./runStatus";
import { showDataRefusal, showSavedDataRefusal } from "./savedDataRefusal";
import { registerPrivilegedSchemes } from "./schemes";
import { assertSecurityBaseline, installCsp, REQUIRED_WEB_PREFERENCES } from "./security/baseline";
import { lockdownNavigation } from "./security/navigation";
import { configurePermissions } from "./security/permissions";
import {
  defaultRendererSourceOptions,
  type RendererSourceOptions,
} from "./security/rendererSource";
import { Shell } from "./shell";
import { ownStartEntry } from "./startAtBootContext";
import { showTrayIcon } from "./trayIcon";
import {
  chooseUserDataDir,
  folderSpellingFor,
  packagedFlavor,
  readPackageJsonAt,
} from "./userDataDir";
import { createVoiceHelper, speechPlace } from "./voice/voiceHelper";
import { VoiceModelService } from "./voice/voiceModelService";
import { handleVoiceModelProtocol } from "./voice/voiceProtocol";
import { followWindowState } from "./windowControls";
import { mainWindowMaterial, windowMaterialOptions } from "./windowMaterial";
import { followWindowSize } from "./windowSize";
import { appWindows } from "./windows";
import { workContext } from "./workContext";

/**
 * The Electron host (daemon study D1): the window, the security lockdown,
 * the voice plumbing, and the IPC adapter. Everything the app DOES lives in
 * src/core/, which this process starts as its first client - or, when this
 * app controls Firstmate on another Mac, does not start at all, and asks
 * that Mac instead (./shell.ts, docs/view.md). The main entry (./index.ts)
 * loads this module only when the app starts as itself, never when it runs
 * work for another Mac (./work.ts, docs/helper.md).
 */

const isDev = !app.isPackaged;
const isRelease = !isDev && packagedFlavor(readPackageJsonAt(app.getAppPath())) === "release";

/** The app a data folder belongs to, by the name a person knows it (`@shared/codeNames`). */
function appNameOfFolder(dir: string): string {
  return APP_IDENTITIES[spellingOfUserDataFolder(basename(dir)) ?? "fm"].app.release;
}

// This desktop's conventions (design skill readme, "Linux desktop
// conventions"): a Mac keeps its inset window buttons, menu and Dock.
const desktop = hostDesktop();
/**
 * The catalog language the operating system asks for, read once the app is
 * ready (docs/i18n.md, "The language fact"): what a saved choice is weighed
 * against, and what the default language is once the app follows the
 * computer ("The default language").
 */
let systemLanguage: string = SOURCE_LANGUAGE;

/**
 * The computer's own preferred locale, the first of its preferred languages,
 * read with its language: English writes dates and times in it (docs/i18n.md,
 * "Dates and times").
 */
let computerLocale: string | undefined;

function createMainWindow(
  mainDir: string,
  rendererSource: RendererSourceOptions,
  frameMounts: FrameMountRegistry,
  shell: Pick<Shell, "preferences" | "keymap" | "size">,
  hideWindow: boolean,
): BrowserWindow {
  const windowMaterial = mainWindowMaterial({
    platform: hostPlatform(),
    hidden: hideWindow,
  });
  const { additionalArguments, ...material } = windowMaterialOptions(windowMaterial);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: SMALLEST_WINDOW.width,
    minHeight: SMALLEST_WINDOW.height,
    // A shown macOS window is the system material under the renderer's tint
    // (docs/translucent-window.md); every other window is the opaque void.
    ...material,
    show: false,
    // A Mac's window buttons sit inset in the top bar's left; on any other
    // desktop the window has no system frame or menu bar, and the top bar
    // draws its own buttons at its right (./windowControls.ts).
    ...(desktop.windowControls === "system"
      ? { titleBarStyle: "hiddenInset" as const }
      : { frame: false }),
    webPreferences: {
      preload: join(mainDir, "../preload/index.cjs"),
      // Empty share data spends activation locally, then fails validation
      // before any browser/OS request (frameActivation.ts). Enable it only
      // for the app window, never task browsers or the media probe.
      enableBlinkFeatures: "WebShare",
      // The page learns the material and the desktop from its preload's
      // argv, before its first paint (src/shared/windowMaterial.ts,
      // src/shared/platform.ts), and its language the same way (docs/i18n.md).
      additionalArguments: [
        ...additionalArguments,
        platformArgument(hostPlatform()),
        languageArgument(defaultLanguage(systemLanguage)),
        ...(computerLocale ? [localeArgument(computerLocale)] : []),
      ],
      ...REQUIRED_WEB_PREFERENCES,
      devTools: !isRelease,
    },
  });

  followRendererRecovery(win.webContents);
  followWindowSize(win, shell.preferences);
  if (desktop.windowControls === "app") followWindowState(win);
  const { panel: panelCommand, ...pageCommands } = shellCommands(win);
  followWindowCommands(
    win,
    { ...shell.size, ...moveCommands(win.webContents), ...pageCommands },
    shell.keymap,
    panelCommand,
    {
      system: desktop.keys,
      run: (action) => (action === "quit" ? app.quit() : win.close()),
    },
  );

  win.once("ready-to-show", () => {
    // E2E runs (isolated userData) stay hidden: the tests only need the
    // page, DOM, and IPC, and a flashing window disrupts the desktop.
    if (!hideWindow) {
      win.show();
    }
  });

  win.webContents.once("did-finish-load", () => {
    void assertSecurityBaseline(win, isDev);
  });

  lockdownNavigation(win, rendererSource);

  // A renderer that navigates (a dev reload) abandons every frame it
  // mounted; the shell forgets those documents rather than serving them
  // to nobody.
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) frameMounts.clear();
  });

  if (isDev && rendererSource.devServerUrl) {
    void win.loadURL(rendererSource.devServerUrl);
  } else {
    void win.loadFile(join(mainDir, "../renderer/index.html"));
  }

  return win;
}

/** The app started as `<app> run` (./runCommand.ts): the words after `run`. */
export type RunStart = { args: readonly string[] };

/** The signals that stop a run: Ctrl-C, its starter stopping it, its terminal closing. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** How often a run reads whether the installed app was updated. */
const PROGRAM_READ_EVERY_MS = 60_000;

/** Records why an owned run ended and removes its live marker. */
let leaveRun: (end?: RunEnd) => void = () => {};

/**
 * Ends a run that cannot go on: its lines reach whoever reads its output
 * before the process ends, with its code.
 */
function endRun(code: number, lines: readonly string[]): void {
  leaveRun({ reason: "start-failed", exitCode: code, lines: [...lines] });
  process.stderr.write(`${lines.join("\n")}\n`, () => app.exit(code));
}

/**
 * The app itself, with its core and, unless a command started it with no
 * window (`run`, ./runCommand.ts, docs/run.md), its window. `mainDir` is
 * where the main build lives (out/main): the entry says it, since this
 * module is a chunk of its own beneath it. A run awaits its display on Linux
 * before Chromium opens one, so the entry awaits this.
 */
export async function startApp(
  mainDir: string,
  run: RunStart | null = null,
  capabilities: Pick<ElectronHostOptions, "secrets"> & { started?: (core: Core) => void } = {},
): Promise<void> {
  const windowless = run !== null;
  const options = run ? runOptions(run.args) : {};
  if (!options) {
    process.stderr.write(`${RUN_WORDS.usage.join("\n")}\n`, () => process.exit(2));
    return;
  }
  // No Dock icon, no menu bar, never brought forward: macOS lists a run as
  // background-only, as it does the work mode.
  if (windowless && hostPlatform() === "darwin") app.setActivationPolicy("prohibited");
  const rendererSource = defaultRendererSourceOptions(mainDir);

  // Privileged schemes must be registered before the app is ready, all in
  // one call: the voice model's and the plugin frames' (./schemes.ts).
  // The work mode registers the frame scheme alone (./work.ts); a process
  // calls this once.
  registerPrivilegedSchemes();

  // A card's or a panel's frame takes focus only from the captain's own
  // click or key (FRAME_ALLOW, docs/ui-plugins.md "Focus and the frames"):
  // Chromium honours that policy only with this feature on, and every
  // renderer, each frame's own included, reads it from the switches it
  // starts with, so it is set before the app is ready.
  app.commandLine.appendSwitch("enable-blink-features", FRAME_FOCUS_BLINK_FEATURE);

  // Chromium features the app never uses, off before Chromium reads its
  // feature list, so a quit never waits on one of them (./chromiumFeatures.ts).
  disableChromiumFeatures(app.commandLine);

  // userData is decided before anything reads it - above all before the
  // single-instance lock, which lives inside it (./userDataDir.ts). The
  // release opens <appData>/infinitary; every other run - pnpm dev, the
  // local dev bundle - opens <appData>/infinitary-dev. In dev, an isolated
  // dir can be requested via INFINITARY_USER_DATA_DIR so e2e runs get fresh state
  // without touching real data (hi-bit's pattern); packaged builds ignore it.
  const folderSpelling = folderSpellingFor({ packaged: app.isPackaged, env: process.env });
  const userDataChoice = chooseUserDataDir({
    packaged: app.isPackaged,
    env: process.env,
    hasUserDataDirSwitch: app.commandLine.hasSwitch("user-data-dir"),
    appData: app.getPath("appData"),
    readAppPackageJson: readPackageJsonAt(app.getAppPath()),
    spelling: folderSpelling,
  });
  // The one-time move (src/core/folderMove/move.ts): an app with a new
  // identity that finds an older app's folder of its flavor brings that work
  // into its own before anything opens either: this build is Infinitary, so
  // it moves Firstmate 3000's folder of its flavor. An isolated or switched
  // folder never moves. While a move is due, Chromium runs on a
  // throwaway profile beside the folders (./handOver.ts).
  const move =
    userDataChoice.kind === "flavor"
      ? dueMove({
          appData: app.getPath("appData"),
          spelling: folderSpelling,
          flavor: userDataChoice.flavor,
        })
      : null;
  if (move) {
    app.setPath("userData", handOverProfileDir(move.to));
  } else if (userDataChoice.kind !== "switch") {
    app.setPath("userData", userDataChoice.dir);
  }
  const isolatedUserDataDir = userDataChoice.kind === "isolated" ? userDataChoice.dir : undefined;
  // The e2e that launches the dev flavor without an isolated dir still keeps
  // its window hidden (captain directive: e2e runs are windowless).
  const hideWindow =
    Boolean(isolatedUserDataDir) || (isDev && settingFrom(process.env, "HIDE_WINDOW") === "1");

  let ownDisplay = false;
  if (windowless) {
    // The one-time move asks its person in a window of its own, so a run
    // leaves it to the window.
    if (move) {
      endRun(1, RUN_WORDS.handOver);
      return;
    }
    // On Linux a run draws its hidden pages - a task's browser, a card's
    // demo checked before it goes up - on a display of its own, which
    // outlives any desktop session, as the work mode does (./ownDisplay.ts).
    ownDisplay = Boolean(
      await startOwnDisplay({
        platform: hostPlatform(),
        env: process.env,
        dataDir: app.getPath("userData"),
      }),
    );
    if (
      !ownDisplay &&
      hostPlatform() === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    ) {
      endRun(1, RUN_WORDS.needsDisplay);
      return;
    }
  }

  // A Mac keeps Firstmate in its Dock with the window closed; another
  // desktop keeps it working with its icon in the top bar (./trayIcon.ts).
  const keepsWorkingClosed = hostPlatform() === "darwin" || desktop.closeToIcon;
  // Opens the window again where closing it left Firstmate working with none.
  let reopen: () => void = () => {};

  // The data folder: the record and everything a first mate keeps. Beside a
  // run the window joins it as a view of its first mate (docs/run.md, "The
  // window opened beside it") and keeps a browser profile of its own, since
  // the run's holds the folder's; it asks before it asks for the lock.
  const dataDir = app.getPath("userData");
  // It joins too when it opens between two commands, where a start entry
  // will start the next: it waits for that one, under its notice, and
  // starts no first mate of its own unless the person chose Start it here
  // (docs/run.md, "When the command stops").
  // The start entry's own restart wait; a development run may stand in a shorter one.
  const restartWaitMs =
    isDev && Number(settingFrom(process.env, "RUN_RESTART_WAIT_MS")) > 0
      ? Number(settingFrom(process.env, "RUN_RESTART_WAIT_MS"))
      : undefined;
  // Start it here: the person chose this window's own first mate over waiting
  // for the command that ended, which no later launch waits for again.
  const startsHere = !windowless && process.argv.includes(START_HERE_ARG);
  if (startsHere) noteStartedHere(dataDir, readRunStatus(dataDir));
  // This user's work: a computer that joins here runs its home's work
  // there, and a computer a command or its address added controls its
  // home with the grant its work keeps (docs/view.md, "A Mac that runs work").
  const work = workContext(isolatedUserDataDir);
  // The window starts the command itself (docs/run.md, "The window starts
  // it"; the captain's answer on INF-1352's plan, starter=login-agent): with
  // none running, it sets `<app> run` up with this account's service manager
  // and opens beside it. Never where that run would not open the folder or
  // would control another computer, beside an earlier version's system job
  // (`mac-daemon`), which starts the run itself, or once the person chose
  // Start it here. A Mac's login agent `start-at-boot` writes is the window's
  // own, so the window starts the run with it as it does on Linux.
  const joinedHere = new JoinedHome(join(dataDir, "joined"));
  const starter =
    windowless ||
    move ||
    startsHere ||
    ownStartEntry() === "mac-daemon" ||
    dataFolderRefusal(dataDir) ||
    joinedHere.read() ||
    windowFromWork(work.place.dataDir, joinedHere.leftDeviceId())
      ? null
      : commandStarter({
          work,
          flavor: work.place.flavor,
          dataDir,
          isolated: Boolean(isolatedUserDataDir),
          switched: userDataChoice.kind === "switch",
          packaged: app.isPackaged,
        });
  let besideRun = !windowless && runningByCommand(dataDir);
  // When this window started the command it opens beside, until that one welcomes it.
  let startedAt: number | undefined;
  // A window already running its first mate here holds the folder's lock:
  // this launch only focuses it, and a command started now could not open it.
  const holder = lockHolder(dataDir);
  const heldByWindow = typeof holder === "number" && processAlive(holder);
  if (!besideRun && starter && !heldByWindow) {
    startedAt = Date.now();
    besideRun = await starter.start();
    if (!besideRun) {
      // It runs its first mate itself: the agent never starts a run beside it.
      startedAt = undefined;
      await starter.stop({ forget: false }).catch(() => {});
    }
  } else if (!besideRun && !windowless && !startsHere)
    besideRun = betweenStops(readRunStatus(dataDir), ownStartEntry(), {
      now: Date.now(),
      waitMs: entryWaitMs(restartWaitMs),
      startedHere: startedHere(dataDir),
    });
  if (besideRun) app.setPath("userData", windowProfileDir(dataDir));
  // Single instance: a second launch focuses the existing window instead,
  // or, where closing kept Firstmate working with no window, opens it again.
  // A second run says so and exits.
  if (!app.requestSingleInstanceLock()) {
    if (windowless) endRun(1, RUN_WORDS.alreadyOpen);
    else app.quit();
  } else {
    // A run notes that it holds the folder, for a window opened beside it,
    // and stops cleanly on a signal (below).
    let stopRun: () => void = () => {};
    // 0 for a stop; an update ends the run with a code its starter starts again on.
    let runExitCode = 0;
    let runEnd: RunEnd = { reason: "quit", exitCode: 0, lines: [RUN_WORDS.stopped] };
    // The installed program was replaced, by its package or by this run's
    // own updater: the run stops its crew as a quit does and ends with the
    // code its starter starts the new version on.
    let endedUpdated = false;
    const endUpdated = () => {
      if (endedUpdated) return;
      endedUpdated = true;
      process.stdout.write(`${RUN_WORDS.updated.join("\n")}\n`);
      runExitCode = RUN_UPDATED_EXIT;
      runEnd = {
        reason: "updated",
        exitCode: RUN_UPDATED_EXIT,
        lines: [...RUN_WORDS.updated],
      };
      stopRun();
    };
    if (windowless) {
      const observed = (keychain: RunEnvironment["keychain"]) =>
        runEnvironment({
          platform: hostPlatform(),
          env: process.env,
          ownDisplay,
          keychain: () => keychain,
        });
      // Scratch data is not a sandbox for the Mac's Keychain. Never query it in an isolated launch.
      // The Keychain's reading needs a utility process, so the app ready; the
      // app is ready only once this start has returned to ./index.ts, so the
      // note is written now and takes the reading when it arrives, never
      // waited for here. Elsewhere there is no Keychain to read, and the
      // reading goes in at once, so a run that ends right away keeps it.
      const finish = markRunning(
        app.getPath("userData"),
        process.pid,
        new Date(),
        isolatedUserDataDir || userDataChoice.kind === "switch"
          ? observed("unknown")
          : hostPlatform() !== "darwin"
            ? observed("not-applicable")
            : readKeychainLock(async (path) => {
                await app.whenReady();
                return readElectronKeychainStatus(join(mainDir, "keychainProcessMain.js"), path);
              }).then(observed),
      );
      leaveRun = (end) => {
        try {
          finish(end);
        } catch {
          process.stderr.write("[infinitary] Could not record why the command stopped.\n");
        }
      };
      // A settings file names where programs are, so no shell is asked
      // before the core starts (./runSettings.ts); one it cannot use ends
      // the run, kept as its last stop for status to read.
      if (options.settings !== undefined) {
        const reading = readRunSettings(options.settings);
        if (!reading.ok) {
          endRun(RUN_SETTINGS_EXIT, RUN_WORDS.settings(reading.file, reading.reason));
          return;
        }
        configureSettingsPath(reading.settings.path);
      }
      // Electron quits on the first of these; a module loaded later that
      // listens itself (Pi's sign-in store, through signal-exit) would
      // otherwise take the signal and end the process before the core
      // stops, as it would in the work mode (./work.ts).
      let stopping = false;
      stopRun = () => {
        if (stopping) return;
        stopping = true;
        app.quit();
      };
      for (const signal of STOP_SIGNALS)
        process.on(signal, () => {
          if (stopping) return;
          runEnd = {
            reason: "signal",
            exitCode: 0,
            lines: [`Infinitary stopped after ${signal}.`],
          };
          stopRun();
        });
      // The last line once the core stopped, then the process ends with its code.
      let ended = false;
      app.on("will-quit", (event) => {
        if (ended) return;
        ended = true;
        event.preventDefault();
        leaveRun(runEnd);
        process.stdout.write(`${RUN_WORDS.stopped}\n`, () => app.exit(runExitCode));
      });
    }
    app.on("second-instance", () => {
      if (windowless) return;
      const win = appWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      } else if (desktop.closeToIcon) {
        reopen();
      }
    });

    // No window may ever attach a <webview> or open a child window
    // (docs/architecture.md section 4).
    app.on("web-contents-created", (_event, contents) => {
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
    });

    const starting = app.whenReady().then(async () => {
      // The language this process speaks, from the computer's own languages,
      // before anything is worded or any window opens (docs/i18n.md).
      const preferred = app.getPreferredSystemLanguages();
      systemLanguage = startLanguage(preferred, languageOverride(process.env, app.isPackaged));
      computerLocale = readableLocale(preferred[0]);
      setComputerLocale(computerLocale);
      // An installed Linux app with no git, or with its sandbox off (an
      // AppImage promises neither), asks before it opens (./linuxStartup.ts).
      // A run has nobody to ask: with no git it says so and exits, and with
      // its sandbox off it says so and runs, as its starter chose.
      const opens = await answerStartupAsks(
        startupAsks({
          platform: hostPlatform(),
          packaged: app.isPackaged,
          searchPath: hostPath(),
          sandboxOff: app.commandLine.hasSwitch("no-sandbox"),
        }),
        async (question) => {
          if (windowless) {
            process.stderr.write(`${question.message}\n${question.detail}\n`);
            if (question.id === "git")
              runEnd = {
                reason: "start-failed",
                exitCode: 1,
                lines: [question.message, question.detail],
              };
            return question.id === "git" ? "quit" : "open";
          }
          const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "Infinitary",
            message: question.message,
            detail: question.detail,
            buttons: [STARTUP_ASK_BUTTONS.quit, STARTUP_ASK_BUTTONS.open],
            defaultId: 0,
            cancelId: 0,
          });
          return response === 1 ? "open" : "quit";
        },
      );
      if (!opens) {
        if (windowless) runExitCode = 1;
        app.quit();
        return;
      }
      if (move) {
        await runHandOver(move, {
          names: { from: appNameOfFolder(move.from), to: appNameOfFolder(move.to) },
          hidden: hideWindow,
          deps: {
            platform: hostPlatform(),
            claudeConfigDir: defaultClaudeConfigDir(),
            hostname: hostname(),
          },
          startAtLogin: () => {
            // A development run's rehearsal leaves this computer's login items alone.
            if (isDev) return;
            startAtLoginFor(basename(move.to)).set(true);
            // The older app's own entry would start the same program again.
            forgetAutostart(basename(move.from));
          },
          relaunch: () => {
            app.relaunch();
            app.quit();
          },
          quit: () => app.quit(),
        });
        return;
      }
      // A hand-over that finished left its throwaway profile behind.
      if (userDataChoice.kind === "flavor")
        void rm(handOverProfileDir(userDataChoice.dir), {
          recursive: true,
          force: true,
        });
      // A desktop with no menu bar has no app menu either: the window takes
      // the menu's keys itself (./keyboard.ts) and Settings is the top bar's
      // gear, so no window carries Electron's default menu or its keys.
      if (desktop.windowControls === "app") Menu.setApplicationMenu(null);
      installCsp(session.defaultSession, rendererSource);
      // The frame realm's lib this build made (out/frame-lib, beside
      // out/main), which the shell serves its own frames and the first mate
      // answers a phone (docs/view.md, "Panels on the phone").
      const frameLib = { dir: join(mainDir, "../frame-lib"), pins: frameLibPins };
      const secrets =
        capabilities.secrets ??
        nativeSecrets({
          platform: hostPlatform(),
          choice: userDataChoice,
          // Unlock's own child processes: only a fresh one may still show
          // macOS's unlock dialog (./host/nativeSecrets.ts).
          keychainFile: createElectronKeychainFile(join(mainDir, "keychainProcessMain.js")),
        });
      const host = createElectronHost({
        // Beside a command's first mate, that first mate ends first, with its
        // crew's work saved, before this window's update replaces the copy.
        prepareUpdateRestart: async () => {
          await shell.updateReplacing();
          await shell.dispose();
        },
        // A run has no window to reopen: it ends for its starter to start the new copy.
        ...(windowless ? { relaunch: endUpdated } : {}),
        // Protected Secrets: the caller's own capability (a check's disposable
        // one), else this platform's native custody on the person's own data
        // folder only (./host/nativeSecrets.ts, docs/secrets.md).
        ...(secrets ? { secrets } : {}),
        isolatedUserDataDir,
        ...(userDataChoice.kind === "flavor"
          ? { autostartName: basename(userDataChoice.dir) }
          : {}),
        frameLib,
        keychainProcessPath: join(mainDir, "keychainProcessMain.js"),
        sqlProcessPath: join(mainDir, "sqlProcess.js"),
        recordProcessPath: join(mainDir, "recordProcess.js"),
        axiProcessPath: join(mainDir, "axiProcess.js"),
        programProcessPath: join(mainDir, "programProcess.js"),
        panelProcessPath: join(mainDir, "panelProcess.js"),
        setAsideProcessPath: join(mainDir, "setAsideProcess.js"),
        ...(desktop.closeToIcon ? { openWindow: () => reopen() } : {}),
      });
      // Voice models live in the data folder, which the window beside a run reads too.
      const voiceModel = new VoiceModelService(join(dataDir, "models"));
      // The voice helper (docs/architecture.md section 8): Whisper in a
      // process of its own, started on the first recording. A development
      // run may name another entry that speaks its messages, as the
      // end-to-end suite does in place of the 1.6 GB model.
      const voiceHelperOptions = {
        entryPath:
          (isDev && settingFrom(process.env, "VOICE_HELPER_ENTRY")) ||
          join(mainDir, "voiceHelper.js"),
        modelsDir: join(dataDir, "models"),
      };
      const voiceHelper = createVoiceHelper(voiceHelperOptions);
      app.once("will-quit", () => voiceHelper.release());
      // Where this computer transcribes, asked now so the answer is ready
      // when the window first asks (docs/architecture.md section 8, "Where
      // speech runs").
      const voicePlace = speechPlace(voiceHelperOptions);
      // A run has nobody to speak to it.
      if (!windowless) void voicePlace();
      const voiceHost = {
        ...host,
        voice: {
          modelReady: () => voiceModel.modelReady(),
          ensureModel: (progress: Parameters<VoiceModelService["ensureModel"]>[0]) =>
            voiceModel.ensureModel(progress),
        },
      };
      // This Mac's own name, which a device says it joined from and a paired
      // view says it controls (docs/devices.md). A development run may stand
      // in another, so two apps on one Mac read as two Macs.
      const ownName = ownComputerName({ packaged: !isDev, env: process.env });
      let nameNow: string | undefined;
      void ownName.then((name) => {
        nameNow = name;
      });
      // Whether a release note was shown, for the Help menu's What's New;
      // followed once the menu is installed below.
      let notesShown = false;
      // Whether this copy can check for updates, for the app menu's Check for Updates….
      let updatesChecked = true;
      let followReleaseNotes: (view: ReleaseNotesView) => void = () => {};
      // A development run may stand in another contract version for the Mac
      // where Firstmate lives, so a view on this build reads the two as too
      // far apart (docs/view.md); a packaged app ignores it.
      const standInContract = isDev
        ? settingFrom(process.env, "CONTRACT_VERSION")?.trim() || undefined
        : undefined;
      // ...and its view floor, so a stand-in newer contract can be one whose
      // major broke views (docs/contract.md, "The version rule").
      const standInViewFloor = isDev
        ? Number.parseInt(settingFrom(process.env, "VIEW_FLOOR")?.trim() ?? "", 10)
        : Number.NaN;
      // ...and Infinitary's spelling of channel names, so two development
      // runs rehearse a home and a device on two sides of the rename
      // (docs/connection.md, "Two spellings"); a packaged app ignores it.
      const standInSpelling = isDev
        ? readSpellings([settingFrom(process.env, "WIRE_SPELLING")?.trim() ?? ""])?.[0]
        : undefined;
      // ...and the loopback address a view catches a sign-in's return on, so
      // two development runs on one Linux PC each play a computer of their
      // own (docs/view.md, "A sign-in that returns to the first mate's
      // computer"); a packaged app ignores it.
      const standInReturnHost = isDev
        ? settingFrom(process.env, "SIGN_IN_RETURN_HOST")?.trim() || undefined
        : undefined;
      const { serviceManager } = work;
      // Whether the program this window runs was replaced since it started,
      // read where a run follows it (`followInstalledProgram`).
      const programPath =
        (isDev && settingFrom(process.env, "RUN_PROGRAM")) ||
        process.env.APPIMAGE ||
        process.execPath;
      const programAtStart = programIdentity(programPath);
      const programReplaced = () => {
        const now = programIdentity(programPath);
        return programAtStart !== null && now !== null && now !== programAtStart;
      };
      const shell: Shell = new Shell({
        keySystem: desktop.keys,
        joined: new JoinedHome(join(dataDir, "joined")),
        // Beside a run: its local door, its pictures, and this window's own look.
        ...(besideRun
          ? {
              beside: {
                door: appPathsFor(dataDir).localDoorDir,
                crewmatesDir: appPathsFor(dataDir).crewmatesDir,
                look: new JoinedHome(join(app.getPath("userData"), "look")),
                status: () => readRunStatus(dataDir),
                // The agent this window set up starts the command again too.
                startEntry: () =>
                  ownStartEntry() ??
                  (starter?.inPlace()
                    ? hostPlatform() === "linux"
                      ? "linux-unit"
                      : "mac-agent"
                    : null),
                ...(restartWaitMs === undefined ? {} : { restartWaitMs }),
                presence: host.presence,
                chooseFiles: async (choice) => (await host.browser?.chooseFiles?.(choice)) ?? [],
                // Only a window installs an update on a Mac that updates itself.
                installsUpdates: Boolean(host.macUpdates),
                programReplaced,
                ...(starter ? { starter } : {}),
                ...(startedAt === undefined ? {} : { startedAt }),
                stopCommand: () => stopRunningCommand(dataDir),
              },
            }
          : {}),
        work: {
          dataDir: work.place.dataDir,
          ...(serviceManager
            ? {
                background: ({ launcher, app: kept }) =>
                  startInBackground(
                    {
                      flavor: work.place.flavor,
                      dataDir: work.place.dataDir,
                      spelling: work.place.folderSpelling,
                      homeDir: homedir(),
                      uid: process.getuid?.() ?? userInfo().uid,
                      ...serviceManager,
                    },
                    { launcher: launcher ?? work.launcher, env: work.backgroundEnv, app: kept },
                  ),
              }
            : {}),
        },
        // Started by a command, a page the core would open goes to each
        // computer that controls it (docs/run.md, "Control from another computer").
        startCore: async () => {
          const core = await startCore(voiceHost, {
            startedByCommand: windowless,
            computerLanguage: systemLanguage,
          });
          capabilities.started?.(core);
          return core;
        },
        // The same core for paired devices (docs/connection.md). It listens
        // for them only while a device is paired or a link to pair one is
        // open (docs/devices.md), and on its local door for as long as it
        // runs, windowed or started by a command.
        startConnection: (core) => {
          // The captain's own command enters at the local door, as the
          // captain, while its switch in Integrations is on (docs/axi-commands.md).
          const commandDoor = openCommandDoor(core);
          const connection = startConnection({
            dispatch: core.dispatch,
            events: core.events,
            devices: core.services.devices,
            localDoor: core.paths.localDoorDir,
            // Where devices find this computer: every address a link may carry.
            address: () => core.services.devices.listenHosts(),
            port: core.services.devices.port,
            name: () => nameNow,
            // What a command on another Mac gets from this one, and what a
            // computer that names its system gets (docs/devices.md).
            app: () => core.services.appBundle(),
            build: (system, chip, kind) => core.services.farBuild(system, chip, kind),
            ...(standInContract ? { protocolVersion: standInContract } : {}),
            ...(Number.isInteger(standInViewFloor) ? { viewFloor: standInViewFloor } : {}),
            ...(standInSpelling ? { speaks: standInSpelling } : {}),
            ...(commandDoor ? { command: commandDoor.serve } : {}),
          });
          return {
            ...connection,
            close: async () => {
              commandDoor?.close();
              await connection.close();
            },
          };
        },
        // The window here reaches its first mate through that door, as a
        // view of it (docs/view.md); a command's run has no window to.
        ...(windowless ? {} : { localDoor: (core: Core) => core.paths.localDoorDir }),
        broadcast: (channel, payload) => {
          broadcast(channel, payload as never);
          if (channel === "inf:release-notes") followReleaseNotes(payload as ReleaseNotesView);
        },
        notifications: host.notifications,
        deviceName: () => ownName,
        restartWindows: () => {
          for (const win of appWindows()) if (!win.isDestroyed()) win.webContents.reload();
        },
        relaunch: (how) => {
          // An isolated run is started from outside, which starts it again;
          // only a person's app starts itself again.
          if (!isolatedUserDataDir) {
            // Start it here is asked for one start: no later one carries it on.
            const args = process.argv.slice(1).filter((arg) => arg !== START_HERE_ARG);
            if (how?.startHere) args.push(START_HERE_ARG);
            app.relaunch({
              args,
              // A window following a replaced AppImage starts from the new file.
              ...(besideRun && process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {}),
            });
          }
          app.quit();
        },
        // A page the first mate would open for this view opens here, where
        // the person is (docs/view.md, "Pages it would open").
        openPage: async (url) => {
          if (isAllowedOpenExternalUrl(url)) await host.openExternal(url);
        },
        ...(standInReturnHost ? { returnHost: standInReturnHost } : {}),
        // A view runs no core, and still tells this Mac when its own app has an update.
        // Its update channel is kept in the data folder, beside a run too.
        updates: createInstalledUpdateChecker({
          app: { ...host.app, userDataDir: dataDir },
          ...(host.macUpdates ? { macDriver: host.macUpdates } : {}),
          openExternal: (url) => host.openExternal(url),
          ...(host.relaunch ? { relaunch: host.relaunch } : {}),
          // Beside a command's first mate, an update this window installs waits for
          // that first mate to save its crew's work, and holds it saved meanwhile.
          ...(besideRun && host.macUpdates
            ? {
                work: crewWorkHeldThere((step) => shell.dispatch("inf:update:hold", [step])),
              }
            : {}),
        }),
      });
      // Start at login starts the command where the window starts it, never
      // the window: a login item the window had moves to the command.
      if (besideRun && starter && host.presence.getStartAtLogin()) {
        try {
          starter.atLogin.set(true);
          host.presence.setStartAtLogin(false);
        } catch (error) {
          console.warn(`[run] Start at login stays the window's: ${(error as Error).message}`);
        }
      }
      configurePermissions(session.defaultSession, rendererSource, () => shell.dictationEnabled());
      // A folder that moved to Infinitary, or one a move holds, is never opened
      // here: nothing is started on it (./savedDataRefusal.ts).
      const refusal = dataFolderRefusal(dataDir);
      if (refusal) {
        if (windowless) endRun(1, RUN_WORDS.refusal(refusal));
        else await showDataRefusal(hideWindow, refusal);
        return;
      }
      try {
        await shell.start();
      } catch (error) {
        if (!(error instanceof UnsupportedSavedDataError)) throw error;
        if (windowless) {
          endRun(1, RUN_WORDS.refusal({ title: SAVED_DATA_REFUSAL_TITLE, message: error.message }));
          return;
        }
        await showSavedDataRefusal(hideWindow);
        return;
      }
      // A run is this computer's own first mate: an app that controls one
      // elsewhere has nothing to run with no window.
      if (windowless && !shell.core()) {
        endRun(1, RUN_WORDS.controls);
        return;
      }
      // The language the captain chose in Settings → Appearance, or the
      // computer's own: the menus, the tray, the dialogs and the crew follow
      // each change (docs/i18n.md, "The language choice"), and a window
      // follows it from the same saved look.
      setCurrentLanguage(
        chosenLanguage(shell.preferences.get().appearance.language, systemLanguage),
      );
      shell.preferences.subscribe((value) => {
        setCurrentLanguage(chosenLanguage(value.appearance.language, systemLanguage));
      });
      // The host serves model files; download policy and the trail run through core dispatch.
      // A panel drawn in the frame realm reads the lib this build made
      // (out/frame-lib, beside out/main) and, for one of the captain's own or
      // one he added, the built files the first mate answers at exactly the
      // version asked for, whichever computer it is on.
      const frameMounts = new FrameMountRegistry({
        panels: {
          libPins: frameLibPins,
          version: app.getVersion(),
          panelFiles: (request) => shell.panelFiles(request),
        },
      });
      registerIpc({
        rendererSource,
        shell,
        host,
        frameMounts,
        voice: { place: voicePlace, helper: voiceHelper },
      });
      handleVoiceModelProtocol(voiceModel);
      handleFrameProtocol({
        mounts: frameMounts,
        fonts: frameFontFiles,
        pictures: () => shell.pictures(),
        lib: frameLib,
      });
      // A 5-minute setInterval fires once late after a sleep and then drifts,
      // which is exactly when a reading is most likely to be both wrong and
      // fixable. The shell owns this trigger because only the shell can see the
      // machine wake; the core just gets told. (Coming back online is the
      // renderer's own `online` event, which already has a refresh channel.)
      powerMonitor.on("resume", () => shell.resumed());
      powerMonitor.on("suspend", () => shell.suspended());
      if (windowless) {
        deferCoreDisposal(app, () => shell.dispose());
        // Both a run and the app a person updates are this one installed
        // program: once it is replaced, the run stops its crew as a quit does
        // and ends, so its starter starts the new version.
        followInstalledProgram({
          path:
            (isDev && settingFrom(process.env, "RUN_PROGRAM")) ||
            process.env.APPIMAGE ||
            process.execPath,
          every:
            (isDev && Number(settingFrom(process.env, "RUN_PROGRAM_EVERY_MS"))) ||
            PROGRAM_READ_EVERY_MS,
          updated: endUpdated,
        });
        process.stdout.write(`${RUN_WORDS.started}\n`);
        return;
      }
      const ownCore = shell.core();
      if (ownCore) host.presence.setShowInDock(ownCore.services.settings.getShowInDock());
      // The window material follows the window's appearance, so the captain's
      // theme is also the window's: a dark material under dark tokens, light
      // under light. Seeded before the window exists, then kept in step.
      nativeTheme.themeSource = shell.preferences.get().appearance.theme;
      shell.preferences.subscribe((value) => {
        nativeTheme.themeSource = value.appearance.theme;
      });
      // The core's start and the window's creation, most of it Electron's
      // own native work, are each a long stretch of the main thread on a
      // slow processor. Waiting for a timer turn between them runs every
      // timer that came due during the core's start before the window is
      // made, not after it; an immediate would run in the same turn as the
      // input that finished the start, with no timer between (INF-2338).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const win = createMainWindow(mainDir, rendererSource, frameMounts, shell, hideWindow);
      // Every reader of the window's keys follows each install (docs/keyboard.md):
      // the page through its push, and the app menu, built again.
      shell.keymap.subscribe((snapshot) => broadcast("inf:keyboard:keymap", snapshot));
      const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? appWindows()[0];
      const rebuildMenu =
        desktop.windowControls === "system"
          ? installAppMenu(
              shell.keymap,
              {
                size: shell.size,
                shell: (command) => {
                  const target = focusedWindow();
                  if (target) shellCommands(target)[command]();
                },
                resetAllKeys: () => resetAllKeysAfterAsking(shell.keymap, focusedWindow()),
                whatsNew: () => notesShown,
                checksUpdates: () => updatesChecked,
              },
              isRelease,
            )
          : () => {};
      // The Help menu's What's New is greyed out until a release note was
      // shown (docs/release-notes.md "Reading a note again"): read now, then
      // followed through the push that says a new one was shown.
      followReleaseNotes = (view) => {
        if (notesShown === view.notes.length > 0) return;
        notesShown = view.notes.length > 0;
        rebuildMenu();
      };
      void shell
        .dispatch("inf:release-notes:list", [])
        .then(followReleaseNotes)
        .catch(() => {});
      // Check for Updates… is greyed out on a copy whose installation the app
      // could not confirm, which cannot check (docs/keyboard.md, "The app menu").
      void shell
        .dispatch("inf:update:status", [])
        .then((status) => {
          if (updatesChecked === checksUpdates(status)) return;
          updatesChecked = checksUpdates(status);
          rebuildMenu();
        })
        .catch(() => {});
      win.on("focus", () => shell.windowFocused());
      app.on("activate", () => {
        if (appWindows().length === 0) {
          createMainWindow(mainDir, rendererSource, frameMounts, shell, hideWindow);
        }
      });
      // The window again, from the top bar's icon or a second launch, where
      // closing it kept Firstmate working (design skill readme, "Linux
      // desktop conventions"). A development run quits instead, as on a Mac.
      reopen = () => {
        const shown = appWindows()[0];
        if (shown) {
          if (shown.isMinimized()) shown.restore();
          shown.show();
          shown.focus();
          return;
        }
        const opened = createMainWindow(mainDir, rendererSource, frameMounts, shell, hideWindow);
        opened.on("focus", () => shell.windowFocused());
      };
      if (desktop.closeToIcon && !isDev) showTrayIcon(reopen);

      deferCoreDisposal(app, () => shell.dispose());
    });
    // The window's start leaves a failure to the process's own handlers
    // (./processErrors.ts); a run that could not start ends with its reason,
    // never as a process with no core.
    if (windowless)
      starting.catch((error: unknown) => {
        endRun(1, RUN_WORDS.couldNotStart(error instanceof Error ? error.message : String(error)));
      });
    else void starting;

    app.on("window-all-closed", () => {
      // A run's only windows are hidden pages: the last of them closing is no reason to quit.
      if (windowless) return;
      if (isDev || !keepsWorkingClosed) {
        app.quit();
      }
    });
    // A task browser's hidden page is a window too, so the last of the
    // app's own closing is told apart from "all closed" (./windows.ts).
    app.on("browser-window-created", (_event, created) => {
      created.once("closed", () => {
        if (windowless) return;
        if (appWindows().length > 0 || BrowserWindow.getAllWindows().length === 0) return;
        if (isDev || !keepsWorkingClosed) app.quit();
      });
    });
  }
}
