import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { isatty } from "node:tty";
import { openCommandDoor } from "@core/axi/commandDoor";
import { defaultClaudeConfigDir } from "@core/claude/claudeQuota";
import { startConnection } from "@core/connection/connection";
import type { LocalDoorRun } from "@core/connection/localDoor";
import { ownComputerName } from "@core/devices/computerName";
import { homeFinder } from "@core/devices/findHome";
import { JoinedHome } from "@core/devices/joinedHome";
import { dueMove, type FolderMove } from "@core/folderMove/due";
import type { MoveDeps } from "@core/folderMove/move";
import { olderRunAgent, type TakeOverDeps } from "@core/folderMove/takeOver";
import { pauseInBackground, resumeInBackground, startInBackground } from "@core/helper/background";
import { windowFromWork } from "@core/helper/fromWindow";
import { STOPPED_RUN_WAIT_MS } from "@core/helper/lock";
import { handBackgroundOver } from "@core/helper/moveWork";
import { forgetRunAgentFiles, userUnitsDir } from "@core/helper/runAgent";
import { type RunPipes, watchRunForce } from "@core/helper/runForce";
import { watchRunStop } from "@core/helper/windowsTask";
import { configureSettingsPath, hostPath } from "@core/hostEnv";
import { type Core, startCore } from "@core/index";
import { isAllowedOpenExternalUrl } from "@core/openExternal";
import { appPathsFor } from "@core/paths";
import { ownWindowsBirth } from "@core/placed/windowsProcesses";
import { dataFolderRefusal } from "@core/storage/dataFolderRefusal";
import { clearPrivateTemp, keepDataFolderPrivate } from "@core/storage/ownerOnly";
import {
  SAVED_DATA_REFUSAL_TITLE,
  UnsupportedSavedDataError,
} from "@core/storage/savedDataCompatibility";
import { keepRecordBeforeSourceRun } from "@core/storage/sourceRunCopy";
import { createInstalledUpdateChecker } from "@core/update/updateChecker";
import { crewWorkHeldThere } from "@core/update/updateHold";
import { configureWindowsGit, findWindowsGit } from "@core/windowsGit";
import { APP_IDENTITIES, OWN_IDENTITY, readSpellings, runLabelOf } from "@shared/codeNames";
import { settingFrom } from "@shared/envSettings";
import { computerLanguagesArgument } from "@shared/fonts";
import { setComputerLocale, setCurrentLanguage } from "@shared/i18n/current";
import {
  languageArgument,
  localeArgument,
  readableLocale,
  SOURCE_LANGUAGE,
} from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
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
import { installAppMenu, nameAppMenu, resetAllKeysAfterAsking } from "./appMenu";
import {
  betweenStops,
  entryWaitMs,
  LET_GO_JOB_ARG,
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
import type { HandOverNames } from "./handOverPage";
import {
  createElectronHost,
  type ElectronHostOptions,
  forgetAutostart,
  startAtLoginFor,
} from "./host/electronHost";
import { createElectronKeychainFile, readElectronKeychainStatus } from "./host/electronKeychain";
import { nativeApprover, nativeSecrets, nativeStandbyLock } from "./host/nativeSecrets";
import { openWindowStandIn } from "./host/openWindowStandIn";
import { broadcast, registerIpc } from "./ipc";
import { followWindowCommands, moveCommands, shellCommands } from "./keyboard";
import { KeyReminderStore } from "./keyReminders";
import { deferCoreDisposal } from "./lifecycle";
import { answerStartupAsks, STARTUP_ASK_BUTTONS, startupAsks } from "./linuxStartup";
import { startOwnDisplay } from "./ownDisplay";
import { followPresence } from "./presence";
import { followRendererRecovery } from "./rendererRecovery";
import {
  answerLaunch,
  bringWindowForward,
  clearWindowAnswers,
  commandHolding,
  commandPipe,
  commandPipeHeld,
  followInstalledProgram,
  holdCommandPipe,
  holderIsWindow,
  keepsStarterBesideGrant,
  lockHolder,
  lockHolderKind,
  markRunning,
  ownedRunOf,
  processAlive,
  programIdentity,
  RUN_SETTINGS_EXIT,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
  type RunEnd,
  runningByCommand,
  runOptions,
  stopRunningCommand,
  windowAnswerAsked,
  windowAnswerAsker,
  windowAnswerFile,
  windowProfileDir,
  writeWindowAnswer,
} from "./runCommand";
import {
  type RunEnvironment,
  readKeychainLock,
  runEnvironment,
  startedByAgent,
} from "./runEnvironment";
import { type RunHandOver, runHandOverInTerminal, terminalQuestion } from "./runHandOver";
import { bundleOf, openNewCopy, openWindowOnReopen, reopenOlderWindow } from "./runReopen";
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
import {
  appWindows,
  confirmationWindow,
  mainWindowOpen,
  markMainWindow,
  openMainWindows,
  personWindows,
} from "./windows";
import { ensureWindowsGit, GIT_SETUP_WORDS, windowsGitDeps } from "./windowsGitSetup";
import { windowsAppUserModelId } from "./windowsStartup";
import { windowsStdin } from "./windowsStdin";
import { type WorkContext, workContext } from "./workContext";

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
// Windows files the app's windows and notifications under the identity its
// Start menu entry carries (./windowsStartup.ts).
if (hostPlatform() === "win32") app.setAppUserModelId(windowsAppUserModelId(isRelease));

/** The app a data folder belongs to, by the name a person knows it (`@shared/codeNames`). */
function appNameOfFolder(dir: string): string {
  return APP_IDENTITIES[spellingOfUserDataFolder(basename(dir)) ?? "fm"].app.release;
}

/** The two apps of the one-time move, by the names a person knows them. */
function handOverNames(move: FolderMove): HandOverNames {
  return { from: appNameOfFolder(move.from), to: appNameOfFolder(move.to) };
}

/**
 * What the one-time move's hand-over reaches, the window's and a run's
 * alike: the move itself, the take-over from an older copy with no window
 * still holding the older folder, its background agent let go first
 * (src/core/folderMove/takeOver.ts), and once the work is in, the older
 * agent's hand-over to this app's label, as the work run's move hands it
 * over, so its file starts nothing on the frozen older folder.
 */
function handOverReach(
  move: FolderMove,
  work: WorkContext,
): {
  deps: Pick<MoveDeps, "platform" | "claudeConfigDir" | "hostname">;
  takeOver: TakeOverDeps;
  handBackground?: () => Promise<unknown>;
} {
  const serviceManager = work.serviceManager;
  // The older copy's names follow the folder it moves from, never where
  // this computer's work happens to be (`folderSpelling` names this app's
  // own folder whenever its work is not still in the older one).
  const olderSpelling = spellingOfUserDataFolder(basename(move.from)) ?? "fm";
  // The start entry a run of the older copy may have, let go before a forced end.
  const olderRun = olderRunAgent({
    spelling: olderSpelling,
    flavor: work.place.flavor,
    platform: hostPlatform(),
    homeDir: homedir(),
    unitsDir: userUnitsDir(process.env, homedir()),
    dataDir: move.from,
  });
  const olderBackground = serviceManager && {
    flavor: work.place.flavor,
    dataDir: join(move.from, "work"),
    spelling: olderSpelling,
    homeDir: homedir(),
    uid: process.getuid?.() ?? userInfo().uid,
    ...serviceManager,
  };
  return {
    deps: {
      platform: hostPlatform(),
      claudeConfigDir: defaultClaudeConfigDir(),
      hostname: hostname(),
    },
    takeOver: {
      platform: hostPlatform(),
      hostname: hostname(),
      ...(olderBackground
        ? {
            unloadAgent: (service) => pauseInBackground(olderBackground, service),
            resumeAgent: (service) => resumeInBackground(olderBackground, service),
          }
        : {}),
      ...(olderRun ? { runAgent: olderRun } : {}),
    },
    ...(serviceManager
      ? {
          handBackground: async () => {
            const dataDir = join(move.to, "work");
            const { workLog } = await import("@core/helper/run");
            return handBackgroundOver(dataDir, {
              spelling: work.place.spelling,
              flavor: work.place.flavor,
              background: (dir, spelling) => ({
                flavor: work.place.flavor,
                dataDir: dir,
                spelling,
                homeDir: homedir(),
                uid: process.getuid?.() ?? userInfo().uid,
                ...serviceManager,
              }),
              launcher: work.launcher,
              env: work.backgroundEnv,
              log: workLog(dataDir),
            });
          },
        }
      : {}),
  };
}

/**
 * Turns start at login on for this app once the work is in, as the older
 * app had it, and forgets the older app's own entry, which would start the
 * same program again. A development run's rehearsal leaves this computer's
 * login items alone.
 */
function carryStartAtLogin(move: FolderMove): void {
  if (isDev) return;
  startAtLoginFor(basename(move.to)).set(true);
  forgetAutostart(basename(move.from));
}

/**
 * The one-time move for a run a command started (docs/run.md, "Before it
 * starts"): in the terminal, before Electron is ready, so the run goes on
 * from this app's own folder once the work is in. A stop the run is asked
 * for meanwhile ends the hand-over as it ends the move, with nothing changed
 * once the copy is not yet checked; the older copy is ended only on a yes
 * typed at a terminal.
 */
async function handOverInRun(move: FolderMove, work: WorkContext): Promise<RunHandOver> {
  const stop = new AbortController();
  const onStop = () => stop.abort();
  for (const signal of STOP_SIGNALS) process.on(signal, onStop);
  // Only a person at a terminal can answer; a run a service manager started has none.
  const ask = (lines: readonly string[], prompt: string) => {
    const input = hostPlatform() === "win32" ? windowsStdin() : process.stdin;
    const question = terminalQuestion({
      input,
      output: process.stdout,
      interrupted: onStop,
      signal: stop.signal,
    });
    return question(lines, prompt).finally(() => input.pause());
  };
  try {
    return await runHandOverInTerminal(move, {
      names: handOverNames(move),
      ...handOverReach(move, work),
      say: (lines) => process.stdout.write(`${lines.join("\n")}\n`),
      ...(isatty(0) ? { ask } : {}),
      signal: stop.signal,
      // At once, as the work comes in: a run that ends before Electron is
      // ready never reaches the move again, so a later carry would be lost.
      startAtLogin: () => carryStartAtLogin(move),
    });
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, onStop);
  }
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

/**
 * Every language the computer prefers, most preferred first, read with its
 * language: a window puts their scripts' faces after the chosen font in that
 * order (docs/fonts.md, "Letters in other scripts").
 */
let computerLanguages: readonly string[] = [];

/** The key reminder's switch and the keys pressed, made once userData is decided (./keyReminders.ts). */
let keyReminders: KeyReminderStore | null = null;

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
        computerLanguagesArgument(computerLanguages),
      ],
      ...REQUIRED_WEB_PREFERENCES,
      devTools: !isRelease,
    },
  });

  followRendererRecovery(win.webContents);
  followWindowSize(win, shell.preferences);
  if (desktop.windowControls === "app") followWindowState(win);
  followPresence(win);
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
    (id) => keyReminders?.pressed(id, shell.keymap.bindings()),
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

  markMainWindow(win);
  return win;
}

/** The app started as `<app> run` (./runCommand.ts): the words after `run`. */
/** A run's words after `run`, and the mark its agent gave it (`takeRunAgentMark`), already taken. */
export type RunStart = { args: readonly string[]; agentMark?: string };

/** The signals that stop a run: Ctrl-C, its starter stopping it, its terminal closing. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** How often a run reads whether the installed app was updated. */
const PROGRAM_READ_EVERY_MS = 60_000;

/** Records why an owned run ended and removes its live marker. */
let leaveRun: (end?: RunEnd) => void = () => {};

/** This run as its record names it, for its local door to name it too; none without a command. */
let ownRun: LocalDoorRun | undefined;

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
  // A click on the app that reaches the run - a development run's, or one
  // that runs from the main executable (./runReopen.ts) - opens the window beside it.
  if (windowless && hostPlatform() === "darwin") {
    app.setActivationPolicy("prohibited");
    openWindowOnReopen({
      app,
      execPath: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  }
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
  // release and pnpm dev open <appData>/infinitary, the person's own saved
  // data; the local dev bundle opens <appData>/infinitary-dev. In dev, an
  // isolated dir can be requested via INFINITARY_USER_DATA_DIR so e2e runs
  // get fresh state without touching real data; packaged builds ignore it.
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
  let move =
    userDataChoice.kind === "flavor"
      ? dueMove({
          appData: app.getPath("appData"),
          spelling: folderSpelling,
          flavor: userDataChoice.flavor,
        })
      : null;
  // A run hands over in its terminal before Chromium opens either folder,
  // taking over from an older copy with no window that still holds the
  // older one, and then goes on from its own (./runHandOver.ts).
  if (move && windowless) {
    let handed: RunHandOver;
    try {
      handed = await handOverInRun(move, workContext());
    } catch (error) {
      // A step that throws ends the run as a start that failed, with its reason.
      endRun(1, RUN_WORDS.couldNotStart(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (handed.kind === "ended") {
      const { end } = handed;
      // A stop ends cleanly, as a run's stop does; anything else ends as a start that failed.
      if (end.reason === "signal")
        process.stdout.write(`${end.lines.join("\n")}\n`, () => app.exit(end.exitCode));
      else endRun(end.exitCode, end.lines);
      return;
    }
    move = null;
  }
  if (move) {
    app.setPath("userData", handOverProfileDir(move.to));
  } else if (userDataChoice.kind !== "switch") {
    app.setPath("userData", userDataChoice.dir);
  }
  const isolatedUserDataDir = userDataChoice.kind === "isolated" ? userDataChoice.dir : undefined;
  // An isolated run is started from outside, which starts it again; only a person's app starts
  // itself again. A development one notes the words it would start with in the file
  // `INFINITARY_RELAUNCH_NOTE` names, so a journey starts what it asked for
  // (tests/e2e/window-starts-run.spec.ts).
  const relaunchNote =
    isDev && isolatedUserDataDir ? settingFrom(process.env, "RELAUNCH_NOTE") : undefined;
  const relaunchWith = (args: string[], execPath?: string) => {
    if (!isolatedUserDataDir) app.relaunch({ args, ...(execPath ? { execPath } : {}) });
    else if (relaunchNote) writeFileSync(relaunchNote, JSON.stringify(args));
  };
  // The e2e that launches the dev flavor without an isolated dir still keeps
  // its window hidden (captain directive: e2e runs are windowless).
  const hideWindow =
    Boolean(isolatedUserDataDir) || (isDev && settingFrom(process.env, "HIDE_WINDOW") === "1");

  let ownDisplay = false;
  if (windowless) {
    // On Linux a run draws its hidden pages - a task's browser, a card's
    // demo checked before it goes up - on a display of its own, which
    // outlives any desktop session, as the work mode does (./ownDisplay.ts).
    ownDisplay = Boolean(
      await startOwnDisplay({
        platform: hostPlatform(),
        env: process.env,
        chromiumPlatform: app.commandLine.getSwitchValue("ozone-platform"),
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
  // On Windows the data folder takes an owner-only access list before
  // anything writes it, or is refused as an unsafe place; a system temporary
  // folder another account can read gives way to one inside it
  // (src/core/storage/ownerOnly.ts, docs/windows-private-files.md).
  const privacy = move
    ? null
    : await keepDataFolderPrivate({
        platform: hostPlatform(),
        dataDir,
        env: process.env,
        tempDir: tmpdir(),
      });
  if (privacy?.refused) {
    const { why, detail } = privacy.refused;
    console.warn(`[data folder] not kept private (${why})${detail ? `: ${detail}` : ""}`);
  }
  // It joins too when it opens between two commands, where a start entry
  // will start the next: it waits for that one, under its notice, and
  // starts no first mate of its own unless the person chose Start it here
  // (docs/run.md, "When the command stops").
  // The start entry's own restart wait; a development run may stand in a shorter one.
  const restartWaitMs =
    isDev && Number(settingFrom(process.env, "RUN_RESTART_WAIT_MS")) > 0
      ? Number(settingFrom(process.env, "RUN_RESTART_WAIT_MS"))
      : undefined;
  // How long a running command gets to answer the window; a development run may stand in a shorter one.
  const answerWaitMs =
    isDev && Number(settingFrom(process.env, "RUN_ANSWER_WAIT_MS")) > 0
      ? Number(settingFrom(process.env, "RUN_ANSWER_WAIT_MS"))
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
  // A grant an address add left in the work folder keeps the window's
  // starter: with no command running it starts one as ever, and beside the
  // command this app's own agent started it keeps that agent, so the window
  // opens beside the command and follows along, stopping it only where
  // nothing was done here. A home that keeps its own first mate goes on
  // running it in the background. A command the person started by hand
  // keeps running, with no starter beside it (docs/view.md, "Following along").
  const starterOptions = {
    work,
    flavor: work.place.flavor,
    dataDir,
    isolated: Boolean(isolatedUserDataDir),
    switched: userDataChoice.kind === "switch",
    packaged: app.isPackaged,
  };
  // Start it here over a run that its own agent started again since (the job's own start after a
  // force stop, or one that came in its place): the window opens beside that run as its own, with its
  // starter, and neither starts nor stops it; over a run started by hand, or none, it has no starter.
  // One reading decides both whether a command holds the folder and whether it is the agent's own,
  // so the window never opens beside an owned run with no starter, nor keeps a starter for none.
  // The same reading decides whether a grant waiting keeps the starter (`keepsStarterBesideGrant`).
  const holding = commandHolding(dataDir);
  // A command holds the folder that is not known to be the noted run, as where Windows cannot read
  // its birth: it may be a window's lock beside a stale note. The window keeps its starter, opens
  // beside nothing yet and asks whoever holds the lock to answer (`lockHolderKind`), starting again
  // once a run is known to hold it.
  const unknownHolder = holding.running && !holding.known;
  const starter =
    windowless ||
    move ||
    (startsHere && holding.owned === null && !unknownHolder) ||
    ownStartEntry(dataDir) === "mac-daemon" ||
    dataFolderRefusal(dataDir, privacy) ||
    joinedHere.read() ||
    !keepsStarterBesideGrant(holding, grantFollowed(work.place.dataDir, joinedHere))
      ? null
      : commandStarter(starterOptions);
  let besideRun = !windowless && holding.running && holding.known;
  // When this window started the command it opens beside, until that one welcomes it.
  let startedAt: number | undefined;
  // A window already running its first mate here holds the folder's lock:
  // this launch only focuses it, and a command started now could not open it.
  // Where the lock names no holder (Windows' own lock), a held one is a window's too.
  const holder = lockHolder(dataDir);
  const heldByWindow =
    holder === undefined
      ? hostPlatform() === "win32"
      : typeof holder === "number" && processAlive(holder);
  // An installed app on a Windows PC with no Git yet offers it first
  // (./windowsGitSetup.ts), which a run cannot: this window runs its own
  // first mate, and the next window starts the command once Git is there.
  const gitForRun =
    hostPlatform() !== "win32" ||
    !app.isPackaged ||
    !starter ||
    besideRun ||
    Boolean(await findWindowsGit(process.env));
  // Start it here never starts the command: its starter only keeps the run it opens beside.
  if (!besideRun && starter && !startsHere && !heldByWindow && gitForRun) {
    startedAt = Date.now();
    besideRun = await starter.start();
    if (!besideRun) {
      // It runs its first mate itself: the agent never starts a run beside it.
      startedAt = undefined;
      await starter.stop({ forget: false }).catch(() => {});
    }
  } else if (!besideRun && !windowless && !startsHere)
    besideRun = betweenStops(readRunStatus(dataDir), ownStartEntry(dataDir), {
      now: Date.now(),
      waitMs: entryWaitMs(restartWaitMs),
      startedHere: startedHere(dataDir),
    });
  if (besideRun) app.setPath("userData", windowProfileDir(dataDir));
  // A window launch on the folder's own lock that opens beside no run asks a window that holds the
  // lock to answer, which a run never does (`lockHolderKind`), so a refused launch knows a window is
  // there before it quits: a run may hold the lock before it notes itself, or with a note this
  // launch cannot tell, and ignores a second launch. Never during a folder move, whose lock is a
  // throwaway profile's.
  const answerAsk = !windowless && !move && !besideRun ? randomBytes(8).toString("hex") : null;
  const lockAsk = answerAsk ? { windowAnswers: answerAsk, asker: process.pid } : undefined;
  /** The live program the folder's lock names, by its link: null for none, undefined unnamed. */
  const lockHolderNow = () => {
    const pid = lockHolder(dataDir);
    return typeof pid === "number" && !processAlive(pid) ? null : pid;
  };
  // The holder this launch's own ask reaches, read just before it, so a holder that takes the
  // lock after is asked too (`lockHolderKind`).
  const askedHolder = answerAsk ? lockHolderNow() : undefined;
  // On a Windows PC, whose lock names no holder, a command holds a pipe of its own from before it
  // asks for the lock until it ends, so a window launch refused the lock tells it from a window
  // (`commandPipe`). Never during a folder move, nor on a folder it would refuse.
  const onWindows = hostPlatform() === "win32";
  if (windowless && !move && onWindows && !dataFolderRefusal(dataDir, privacy))
    holdCommandPipe(commandPipe(dataDir));
  // Single instance: a second launch focuses the existing window instead,
  // or, where closing kept Firstmate working with no window, opens it again.
  // A second run says so and exits.
  if (!app.requestSingleInstanceLock(lockAsk)) {
    if (windowless) endRun(1, RUN_WORDS.alreadyOpen);
    // A run took the folder after this window read it, as the agent's job starting its run again
    // after Start it here's force stop: a run ignores a second launch, so this window starts again
    // and opens beside it, never quitting with no window and never starting or stopping that run.
    // A run notes that it holds the folder in the same step as it takes the lock, and one that
    // ends before then lets the lock go, which this window then starts again on as well; a window
    // that holds the lock answers and focuses itself, and this launch quits, as it does once the
    // holder its ask reached shows it is no command by what it runs as (`holderIsWindow`): a window
    // from before that answer, which brought its window forward at the ask as every version does.
    // A holder that shows nothing yet, as one with no command's pipe on Windows, is waited for,
    // never taken for a window, and never asked again unless it changes. An answer wins over a
    // run's note and a lock taken, so a window the person quit after it answered stays quit. An ordinary launch waits the same way, for a run known to hold
    // the folder or a window, and starts again beside such a run.
    else if (answerAsk) {
      const answer = join(dataDir, windowAnswerFile(answerAsk));
      // macOS's reopen reached this launch rather than the window it was meant for (`reopenOlderWindow`).
      let activatedSelf = false;
      app.once("activate", () => {
        activatedSelf = true;
      });
      const kind = await lockHolderKind({
        running: () => runningByCommand(dataDir),
        answered: () => existsSync(answer),
        holder: lockHolderNow,
        asked: askedHolder,
        windowHolder: (holder) =>
          holderIsWindow(
            holder,
            onWindows ? { commandPipe: () => commandPipeHeld(commandPipe(dataDir)) } : {},
          ),
        lockFree: () => app.requestSingleInstanceLock(lockAsk),
        // A pipe is read again each second, so a command's pipe gone is seen and its next holder asked.
        readEveryMs: onWindows ? 1_000 : STOPPED_RUN_WAIT_MS,
      });
      const answeredByWindow = existsSync(answer);
      rmSync(answer, { force: true });
      console.warn(
        `[app] ${startsHere ? "Start it here" : "the launch"} found the folder held by ${kind === "free" ? "nothing now" : `a ${kind}`}`,
      );
      // A window told only by what it runs as is one from before the answer: on a Mac it may have
      // closed its last window and opened none at the ask, so it is asked once to reopen as a click
      // in the Dock does, and the person is told to click it there where that is not confirmed.
      const reopened =
        kind === "window" && !answeredByWindow && hostPlatform() === "darwin"
          ? await reopenOlderWindow({
              bundle: app.isPackaged ? bundleOf(process.execPath) : null,
              holderAlive: () => typeof lockHolderNow() === "number",
              reachedSelf: () => activatedSelf,
            })
          : null;
      if (reopened === "unconfirmed") {
        await app.whenReady();
        setCurrentLanguage(
          startLanguage(
            app.getPreferredSystemLanguages(),
            languageOverride(process.env, app.isPackaged),
          ),
        );
        app.focus({ steal: true });
        await dialog.showMessageBox({
          type: "info",
          title: "Infinitary",
          message: m.dialogOpenInDock(),
          detail: m.dialogOpenInDockDetail(),
        });
      }
      if (kind !== "window" || reopened === "gone") relaunchWith(process.argv.slice(1));
      app.quit();
    } else app.quit();
  } else {
    // The launch that holds the folder clears what earlier ones left in its
    // own temporary folder; a window beside a run leaves it to the run, and
    // a run clears it once it noted that it holds the folder (below), in the
    // same step as it took the lock.
    if (privacy?.temp && !besideRun && !windowless) await clearPrivateTemp(privacy.temp);
    // What a launch on an accepted folder recovers once it is known to open there (`recover`, below).
    const recoveries: (() => void)[] = [];
    // Start it here over a run that did not answer ended that run alone and asked its service
    // manager nothing, so its job may start the run again (`stopRunAgent`'s force). Now that this
    // window holds the folder, whatever that job runs is a start the folder refuses, so the job is
    // let go and stops starting one; the agent stays in place for the next login.
    // Only after a force stop of the agent's own run, and only on the folder's own lock: never during
    // a folder move, whose lock is a throwaway profile's. A job that refuses to let go is reported;
    // the window goes on as this computer's first mate either way.
    // Only once the folder was accepted, saved data included, which a refused launch opens nothing
    // on (`recover`, below).
    if (
      startsHere &&
      process.argv.includes(LET_GO_JOB_ARG) &&
      !besideRun &&
      !move &&
      app.getPath("userData") === dataDir
    )
      recoveries.push(() =>
        commandStarter(starterOptions)
          ?.stop({ forget: false, run: null })
          .catch((error: unknown) => {
            console.warn(
              `[app] the background job did not stop starting its run: ${(error as Error).message}`,
            );
          }),
      );
    // A run notes that it holds the folder, for a window opened beside it,
    // and stops cleanly on a signal (below).
    let stopRun: () => void = () => {};
    // 0 for a stop; an update ends the run with a code its starter starts again on.
    let runExitCode = 0;
    let runEnd: RunEnd = { reason: "quit", exitCode: 0, lines: [RUN_WORDS.stopped] };
    // The installed program was replaced, by its package or by this run's
    // own updater: the run stops its crew as a quit does and ends with the
    // code its starter starts the new version on.
    // A run that ends to start its first mate again here ends the same
    // way, with words of its own (docs/devices.md, "Moving the first mate").
    let endedUpdated = false;
    const endToStartAgain = (reason: "updated" | "restart") => {
      if (endedUpdated) return;
      endedUpdated = true;
      const lines = reason === "updated" ? RUN_WORDS.updated : RUN_WORDS.restart;
      process.stdout.write(`${lines.join("\n")}\n`);
      runExitCode = RUN_UPDATED_EXIT;
      runEnd = { reason, exitCode: RUN_UPDATED_EXIT, lines: [...lines] };
      stopRun();
    };
    const endUpdated = () => endToStartAgain("updated");
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
      // A development run may hold its note back while a file it names is there, so a journey sees
      // a run that holds the lock and has not noted it yet (tests/e2e/window-starts-run.spec.ts).
      const noteHold = isDev ? settingFrom(process.env, "RUN_NOTE_HOLD") : undefined;
      while (noteHold && existsSync(noteHold))
        await new Promise((resolve) => setTimeout(resolve, 100));
      const runStartedAt = new Date();
      ownRun = { pid: process.pid, startedAt: runStartedAt.toISOString() };
      const byAgent = startedByAgent({
        mark: run?.agentMark,
        word: options.agent,
        label: runLabelOf(work.place.flavor),
      });
      // Restart it is offered over this run only while a force stop can end it (`watchRunForce`):
      // on Windows only with the birth a wake goes through, without which a frozen run stays frozen.
      const birth = byAgent && hostPlatform() === "win32" ? ownWindowsBirth() : null;
      let noteRecovers: (can: boolean, pipes?: RunPipes) => void = () => {};
      const finish = markRunning(
        app.getPath("userData"),
        process.pid,
        runStartedAt,
        isolatedUserDataDir || userDataChoice.kind === "switch"
          ? observed("unknown")
          : hostPlatform() !== "darwin"
            ? observed("not-applicable")
            : readKeychainLock(async (path) => {
                await app.whenReady();
                return readElectronKeychainStatus(join(mainDir, "keychainProcessMain.js"), path);
              }).then(observed),
        byAgent,
        birth,
        byAgent && (hostPlatform() !== "win32" || birth !== null)
          ? (note) => {
              noteRecovers = note;
            }
          : undefined,
      );
      leaveRun = (end) => {
        try {
          finish(end);
        } catch {
          process.stderr.write("[infinitary] Could not record why the command stopped.\n");
        }
      };
      // Noted first, so a launch refused the lock meanwhile reads a run here (`lockHolderKind`).
      if (privacy?.temp) await clearPrivateTemp(privacy.temp);
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
      // Windows ends a program another one signals with no clean stop, so a
      // stop is asked through the data folder there (docs/run.md, "On Windows");
      // everywhere, a stop for this run alone is asked so, by its process and
      // start, since a signal's process number may have passed to another.
      // A stop asked of another run by its process leaves this one going.
      recoveries.push(() =>
        watchRunStop(
          app.getPath("userData"),
          runStartedAt,
          () => {
            if (stopping) return;
            runEnd = { reason: "signal", exitCode: 0, lines: [RUN_WORDS.stopAsked] };
            stopRun();
          },
          undefined,
          { pid: process.pid, startedAt: runStartedAt.toISOString() },
          hostPlatform() === "win32",
        ),
      );
      // Restart it and Start it here end a run that does not answer by asking it to end itself, by
      // its process and start, on a thread a stuck first mate does not hold up (`endRunByForce`).
      // Only a run this app's own agent started is ever asked so; one started by hand reads nothing,
      // and nor does a run on a folder it refuses, which ends below with nothing started on it.
      let stopForceWatch = () => {};
      if (byAgent)
        recoveries.push(() => {
          stopForceWatch = watchRunForce(
            app.getPath("userData"),
            runStartedAt.toISOString(),
            undefined,
            (can, pipes) => noteRecovers(can, pipes),
          );
        });
      // The last line once the core stopped, then the process ends with its code.
      let ended = false;
      app.on("will-quit", (event) => {
        if (ended) return;
        ended = true;
        event.preventDefault();
        stopForceWatch();
        leaveRun(runEnd);
        process.stdout.write(`${RUN_WORDS.stopped}\n`, () => app.exit(runExitCode));
      });
    }
    // A Start it here launch refused the lock asks whether a window holds it (`lockHolderKind`).
    const asked = new Set<string>();
    // The answers this window wrote, with the launch that asked: as it quits, it takes away those
    // whose launch is gone, as one that told this window from what it runs as before the answer
    // came, and leaves one whose launch is still there to read it (`clearWindowAnswers`).
    const answers = new Map<string, number | null>();
    if (!windowless) app.on("will-quit", () => clearWindowAnswers(answers));
    app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
      if (windowless) return;
      const asker = windowAnswerAsker(additionalData);
      answerLaunch(windowAnswerAsked(additionalData), {
        asked,
        // A window the person uses, a refusal shown in its place included, never a hidden helper such
        // as a panel's capture; with none, where closing the last window left the app working, as on
        // a Mac, a second launch opens it again.
        bringForward: () => bringWindowForward(personWindows(), keepsWorkingClosed ? reopen : null),
        shown: () => personWindows().length > 0,
        whenMade: (then) => app.once("browser-window-created", () => setImmediate(then)),
        answer: (word) => {
          try {
            return writeWindowAnswer(app.getPath("userData"), word, asker, answers);
          } catch (error) {
            console.warn(`[app] could not answer a launch: ${(error as Error).message}`);
            return false;
          }
        },
        later: (then) => setTimeout(then, 1_000),
      });
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
      computerLanguages = preferred;
      setComputerLocale(computerLocale);
      // Electron's own menu names the app as macOS does in every start that
      // may show it: the window, and a run macOS brings forward (./runReopen.ts).
      if (hostPlatform() === "darwin")
        nameAppMenu({
          electron: app.name,
          app: APP_IDENTITIES[OWN_IDENTITY].app[isRelease ? "release" : "dev"],
        });
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
      // A Windows PC needs Git for Windows: the app uses a suitable one it
      // finds, and an installed app with none offers to install it before
      // it opens (./windowsGitSetup.ts). A run has nobody to ask, and a run
      // from source keeps Pi's own lookup.
      if (hostPlatform() === "win32") {
        const setup = await ensureWindowsGit(
          windowsGitDeps(process.env, app.getPath("temp"), async (words) => {
            if (windowless || !app.isPackaged) {
              process.stderr.write(`${words.message}\n${words.detail}\n`);
              return words.buttons.length - 1;
            }
            const { response } = await dialog.showMessageBox({
              type: "question",
              title: "Infinitary",
              message: words.message,
              detail: words.detail,
              buttons: [...words.buttons],
              defaultId: 0,
              cancelId: words.buttons.length - 1,
              noLink: true,
              ...(words.signal ? { signal: words.signal } : {}),
            });
            return response;
          }),
        );
        if ("git" in setup) configureWindowsGit(setup.git);
        else if (app.isPackaged) {
          if (windowless) {
            runExitCode = 1;
            runEnd = {
              reason: "start-failed",
              exitCode: 1,
              lines: [GIT_SETUP_WORDS.ask.message],
            };
          }
          app.quit();
          return;
        }
      }
      if (move) {
        await runHandOver(move, {
          names: handOverNames(move),
          hidden: hideWindow,
          ...handOverReach(move, work),
          startAtLogin: () => carryStartAtLogin(move),
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
      const ownSecrets = nativeSecrets({
        platform: hostPlatform(),
        choice: userDataChoice,
        // Unlock's own child processes: only a fresh one may still show
        // macOS's unlock dialog (./host/nativeSecrets.ts).
        keychainFile: createElectronKeychainFile(join(mainDir, "keychainProcessMain.js")),
        window: confirmationWindow,
      });
      // This computer's own lock, should the first mate start here from a
      // copy it kept (docs/devices.md, "Secrets on a computer that keeps a copy").
      const standbyLock =
        ownSecrets &&
        nativeStandbyLock({
          platform: hostPlatform(),
          flavor: userDataChoice.kind === "flavor" ? userDataChoice.flavor : undefined,
          window: confirmationWindow,
        });
      const secrets =
        capabilities.secrets ??
        (ownSecrets && standbyLock
          ? { ...ownSecrets, standbyLock: standbyLock.custody }
          : ownSecrets);
      const host = createElectronHost({
        // Beside a command's first mate, that first mate ends first, with its
        // crew's work saved, before this window's update replaces the copy.
        prepareUpdateRestart: async () => {
          await shell.updateReplacing();
          await shell.dispose();
        },
        // A run has no window to reopen: it ends for its starter to start the new copy.
        ...(windowless ? { relaunch: endUpdated } : {}),
        // The keys the window installed, which the first mate reads as Keyboard
        // settings shows them, asked at each read: with no main window open now,
        // as in a run or after the last one closed, it reads the saved keys; a
        // hidden helper window, such as a panel's capture, installs no keys.
        installedKeys: () => (mainWindowOpen() ? shell.keymap.current() : null),
        // A paired view's update needs the window on a Mac: the run opens it
        // beside itself, as a click on the app does (docs/view.md, "Updating
        // the first mate's computer").
        // A development or test run may stand in that opening (./host/openWindowStandIn.ts).
        ...(() => {
          if (!windowless) return {};
          const standIn = openWindowStandIn(process.env, app.isPackaged);
          if (standIn) return { openOwnWindow: standIn };
          if (hostPlatform() !== "darwin" || !bundleOf(process.execPath)) return {};
          return {
            openOwnWindow: () => {
              const bundle = bundleOf(process.execPath);
              if (bundle) openNewCopy(bundle, app.isPackaged ? [] : [app.getAppPath()]);
            },
          };
        })(),
        // Protected Secrets: the caller's own capability (a check's disposable
        // one), else this platform's native custody on the person's own data
        // folder only (./host/nativeSecrets.ts, docs/secrets.md).
        ...(secrets ? { secrets } : {}),
        isolatedUserDataDir,
        ...(userDataChoice.kind === "flavor"
          ? { autostartName: basename(userDataChoice.dir) }
          : {}),
        sourceOnOwnData,
        flavor: work.place.flavor,
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
      // A view that cannot reach its home at any address it keeps listens
      // for the home's announcement (docs/devices.md, "Finding the home
      // again"): through a development run's dns-sd stand-in, so a test never
      // listens on this computer's own network; a packaged app ignores it.
      const findHome = homeFinder(
        isDev ? settingFrom(process.env, "DNS_SD")?.trim() || undefined : undefined,
      );
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
        keyReminders: () => keyReminders,
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
                  ownStartEntry(dataDir) ??
                  (starter?.inPlace()
                    ? hostPlatform() === "linux"
                      ? "linux-unit"
                      : hostPlatform() === "win32"
                        ? "windows-task"
                        : "mac-agent"
                    : null),
                ...(restartWaitMs === undefined ? {} : { restartWaitMs }),
                ...(answerWaitMs === undefined ? {} : { answerWaitMs }),
                presence: host.presence,
                chooseFiles: async (choice) => (await host.browser?.chooseFiles?.(choice)) ?? [],
                // Only a window installs an update on a Mac that updates itself.
                installsUpdates: Boolean(host.macUpdates),
                programReplaced,
                ...(starter ? { starter } : {}),
                ...(startedAt === undefined ? {} : { startedAt }),
                ownedRun: ownedRunOf,
                stopCommand: (only) => stopRunningCommand(dataDir, undefined, undefined, only),
              },
            }
          : {}),
        work: {
          dataDir: work.place.dataDir,
          // A disk image or a copy macOS moved aside cannot be started later (`placeDoesNotLast`).
          appPath: process.execPath,
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
        // A run whose first mate moved to another computer ends for good:
        // nothing here starts it again, at login or after (docs/devices.md,
        // "Moving the first mate"). One whose move failed, or that the
        // captain started here again, ends for its starter to start again.
        // A run never opens a grant waiting in the work folder; the window beside it does.
        ...(windowless ? { headless: true } : {}),
        ...(windowless
          ? {
              endRun: (how: "moved" | "restart") => {
                if (how === "restart") {
                  endToStartAgain("restart");
                  return;
                }
                forgetRunAgentFiles({
                  label: runLabelOf(work.place.flavor),
                  dataDir,
                  homeDir: homedir(),
                  unitsDir: userUnitsDir(process.env, homedir()),
                });
                process.stdout.write(`${RUN_WORDS.movedAway}\n`);
                runEnd = { reason: "quit", exitCode: 0, lines: [RUN_WORDS.movedAway] };
                stopRun();
              },
            }
          : {}),
        // Started by a command, a page the core would open goes to each
        // computer that controls it (docs/run.md, "Control from another computer").
        startCore: async (hooks) => {
          const core = await startCore(voiceHost, {
            startedByCommand: windowless,
            computerLanguage: systemLanguage,
            ...(hooks?.onHomeMoved ? { onHomeMoved: hooks.onHomeMoved } : {}),
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
            // The window beside this run knows by it which run admitted it (docs/view.md, "Joining").
            ...(ownRun ? { localDoorRun: ownRun } : {}),
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
        // A run that is not the packaged app may stand in its installed
        // version, as its own updater does (`createInstalledUpdateChecker`), so
        // its connection says the version it follows its home from.
        appVersion:
          (!app.isPackaged && settingFrom(process.env, "UPDATE_CURRENT_VERSION")?.trim()) ||
          app.getVersion(),
        restartWindows: () => {
          for (const win of appWindows()) if (!win.isDestroyed()) win.webContents.reload();
        },
        relaunch: (how) => {
          // Start it here is asked for one start: no later one carries it on.
          const args = process.argv
            .slice(1)
            .filter((arg) => arg !== START_HERE_ARG && arg !== LET_GO_JOB_ARG);
          if (how?.startHere) args.push(START_HERE_ARG);
          if (how?.startHere && how.letGoJob) args.push(LET_GO_JOB_ARG);
          // A window following a replaced AppImage starts from the new file.
          relaunchWith(args, besideRun ? process.env.APPIMAGE : undefined);
          app.quit();
        },
        // A page the first mate would open for this view opens here, where
        // the person is (docs/view.md, "Pages it would open").
        openPage: async (url) => {
          if (isAllowedOpenExternalUrl(url)) await host.openExternal(url);
        },
        ...(standInReturnHost ? { returnHost: standInReturnHost } : {}),
        // A Mac viewing another computer may approve its Secrets uses with its
        // own key and Touch ID (docs/secrets.md, "Remote decisions"). A start
        // that brings its own Secrets custody and confirmation, as a check's
        // does, approves with those: a view keeps no Secrets of its own.
        approver: () => {
          const own = capabilities.secrets;
          return own?.authentication
            ? { custody: own.custody, authentication: own.authentication }
            : nativeApprover({ platform: hostPlatform(), choice: userDataChoice });
        },
        // A Windows PC that keeps a copy confirms Take over with its own
        // Windows Hello or Windows password, as its Secrets confirm a use; it
        // approves no other computer's Secrets uses (docs/devices.md, "Taking over").
        ...(hostPlatform() === "win32"
          ? { takeOverAuthentication: () => secrets?.authentication }
          : {}),
        ...(findHome ? { findHome } : {}),
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
      const refusal = dataFolderRefusal(dataDir, privacy);
      if (refusal) {
        if (windowless) endRun(1, RUN_WORDS.refusal(refusal));
        else await showDataRefusal(hideWindow, refusal);
        return;
      }
      // Before a run from source first opens the person's own record, and
      // before any run whose build would migrate it past what the installed
      // app opens, it keeps a copy to go back to
      // (src/core/storage/sourceRunCopy.ts); beside a command,
      // the command's first mate holds the record and this window opens none.
      if (sourceOnOwnData && !besideRun) {
        try {
          const kept = keepRecordBeforeSourceRun(dataDir);
          if (kept)
            console.warn(
              `[data folder] Kept a copy of your saved record from before this source run in ${kept}. To go back, quit Infinitary and copy its files back into ${dataDir}.`,
            );
        } catch (error) {
          console.warn(
            `[data folder] Could not keep a copy of your saved record: ${(error as Error).message}`,
          );
          app.quit();
          return;
        }
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
      // Only now, the folder and its saved data accepted, does a launch recover anything on it: a
      // run reads a stop or force stop asked of it, and Start it here lets the job go. A refused
      // launch ends above with the folder's job and stop and recovery files as they were.
      for (const recover of recoveries.splice(0)) recover();
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
      const reminders = new KeyReminderStore(join(app.getPath("userData"), "key-reminders.json"));
      keyReminders = reminders;
      reminders.subscribe((value) => broadcast("inf:keyboard:reminders", value));
      registerIpc({
        rendererSource,
        dataDir,
        shell,
        keyReminders: reminders,
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
      // Each window says when it comes to the front and when it leaves it:
      // a first mate in another program pushes no card to a phone while one
      // is in front (docs/phone-push.md).
      const followFront = (window: BrowserWindow) => {
        window.on("focus", () => {
          shell.windowFocused();
          shell.windowFront(true);
        });
        const left = () =>
          shell.windowFront(
            appWindows().some(
              (other) => other !== window && !other.isDestroyed() && other.isFocused(),
            ),
          );
        window.on("blur", left);
        window.on("closed", left);
      };
      followFront(win);
      if (win.isFocused()) shell.windowFront(true);
      app.on("activate", () => {
        // A panel's hidden capture is no window the person can use.
        if (openMainWindows().length === 0) {
          followFront(createMainWindow(mainDir, rendererSource, frameMounts, shell, hideWindow));
        }
      });
      // The window again, from the top bar's icon or a second launch, where
      // closing it kept Firstmate working (design skill readme, "Linux
      // desktop conventions"). A development run quits instead, as on a Mac.
      reopen = () => {
        const shown = openMainWindows()[0];
        if (shown) {
          if (shown.isMinimized()) shown.restore();
          shown.show();
          shown.focus();
          return;
        }
        followFront(createMainWindow(mainDir, rendererSource, frameMounts, shell, hideWindow));
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

/**
 * Whether this computer's work keeps a grant its window would follow: one
 * neither left nor kept beside its own first mate (`JoinedHome.keepOwn`).
 */
function grantFollowed(workDir: string, joined: JoinedHome): boolean {
  const found = windowFromWork(workDir, joined.leftDeviceId());
  return Boolean(found && found.grant.deviceId !== joined.keptOwnDeviceId());
}
