import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  type Frame,
  type Page,
} from "@playwright/test";
import { CONNECTION_PORT } from "@shared/connection";
import { budgetTimer } from "../helpers/budgets";
import { claimedPort } from "../helpers/claimedPort";
import { standInDnsSd } from "../helpers/dnsSdStandIn";
import { withoutRunnerSession } from "../helpers/runnerSession";
import { scratchDir } from "../helpers/scratchDirs";
import { launchDiagnostics } from "./launchDiagnostics";
import { readInMain } from "./mainProcess";
import { type MockClaudeTurns, writeMockClaudeClient } from "./mockClaudeClient";
import {
  type MockProviderServer,
  mockModelsJson,
  type Scenario,
  startMockProvider,
} from "./mockProvider";
import { virtualMacSwitches } from "./virtualMac";
import { writeVoiceHelperStandIn } from "./voiceHelperStandIn";
import { untilWindowCommands } from "./windowKeys";
import { stopWithWorker } from "./workerApps";

export type LaunchedApp = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** A fake HOME the app ran under, proving ~/.pi stays untouched. */
  homeDir: string;
  /**
   * The port this app's connection listens at while a device is paired or a
   * link is open: its own loopback port, or the connection's own port for a
   * packaged launch, which ignores that. A probe of this app dials it, never
   * the port an installed app holds.
   */
  connectionPort: number;
  mockProvider?: MockProviderServer;
  diagnosticsDir: string;
  close: () => Promise<void>;
};

/**
 * Refuse before Playwright starts Electron when this checkout has not been
 * built. Otherwise Electron interprets the bare worktree as an app and macOS
 * presents its "Unable to find Electron app" dialog for the missing main
 * entry. `pnpm test:e2e` builds first; this guard also protects direct
 * `playwright test` invocations.
 */
export function builtAppDir(cwd = process.cwd()): string {
  const appDir = resolve(cwd);
  if (!existsSync(join(appDir, "out", "main", "index.js"))) {
    throw new Error(
      `E2E requires a built Electron app at ${join(appDir, "out", "main", "index.js")}. ` +
        "Run `pnpm test:e2e` (or `pnpm build` before `playwright test`) from the repository root.",
    );
  }
  return appDir;
}

/** Test-only bootstrap: exercise the release gate without packaging or signing.
 * Linux host capabilities prevent any macOS Keychain access; HOME and userData
 * remain disposable. The product gets its real built entry and packaged flag,
 * and, when `version` is given, reports that logical version as its own - an
 * alpha or a stable - the way a release stamped with it would. Only the
 * host's composition reads the platform as Linux: the window, its keys and
 * its menu follow this computer's own desktop (docs/architecture.md,
 * "Desktop platform facts").
 */
export function packagedEntry(appDir = builtAppDir(), devFlavor = false, version?: string): string {
  let metadataDir = appDir;
  if (devFlavor) {
    metadataDir = scratchDir("infinitary-dev-package-");
    for (const name of readdirSync(appDir)) {
      if (name !== "package.json") symlinkSync(join(appDir, name), join(metadataDir, name));
    }
    writeFileSync(
      join(metadataDir, "package.json"),
      JSON.stringify({
        ...JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")),
        infinitaryBuildFlavor: "dev",
      }),
    );
  }
  // A released build carries its self-source resources. Model that bundle,
  // rather than reading Electron's own empty Resources folder.
  const resourcesDir = scratchDir("infinitary-packaged-resources-");
  symlinkSync(appDir, join(resourcesDir, "self-source"), "dir");
  const entry = join(scratchDir("infinitary-packaged-entry-"), "entry.mjs");
  writeFileSync(
    entry,
    `
    import { app, BrowserWindow } from "electron";
    // Load the native module for the actual OS before choosing inert host capabilities.
    await import(${JSON.stringify(pathToFileURL(join(appDir, "node_modules/koffi/index.js")).href)});
    const { default: Database } = await import(${JSON.stringify(pathToFileURL(join(appDir, "node_modules/better-sqlite3/lib/index.js")).href)});
    new Database(":memory:").close();
    Object.defineProperty(app, "isPackaged", { value: true });
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(resourcesDir)} });
    const nativePlatform = process.platform;
    // The host's composition reads Linux, so its Keychain stays inert; every
    // other reader - the window, its keys, its menu - reads this computer's.
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => (/\\bcreateElectronHost\\b/.test(new Error().stack ?? "") ? "linux" : nativePlatform),
    });
    app.getAppPath = () => ${JSON.stringify(metadataDir)};
    ${version === undefined ? "" : `app.getVersion = () => ${JSON.stringify(version)};`}
    BrowserWindow.prototype.show = function () {};
    await import(${JSON.stringify(pathToFileURL(join(appDir, "out/main/index.js")).href)});
  `,
  );
  return entry;
}

/**
 * The app's one-minute tick shortened to two seconds, for a journey that
 * waits on one of its passes - a redelivery after a restart, a check's
 * reread, a placement sweep (docs/architecture.md, "One clock"). A spec
 * spreads it into `env`; a packaged launch ignores it.
 */
export const SHORT_TICK = { INFINITARY_TICK_PERIOD_MS: "2000" };

export type LaunchOptions = {
  /** Emulate an installed build through packagedEntry, never the person's Keychain. */
  packaged?: boolean;
  /** Stamp disposable package metadata as the local development package. */
  devFlavor?: boolean;
  /**
   * The logical version an emulated installed build reports (`packaged`
   * only): `0.1.30-alpha.4` runs as an alpha, `0.1.30` as a stable. Test-only;
   * the product has no setting that changes its version.
   */
  version?: string;
  /**
   * Configure an app-scoped mock model provider (models.json + local
   * OpenAI-compatible server) so agent sessions run real Pi pipelines.
   */
  withMockProvider?: boolean;
  /**
   * The journey's own stand-in scenarios (`tests/e2e/scenarios/`), asked
   * in this order before the stand-in's shared answers (`docs/testing.md`,
   * "A journey's own scenarios"). A reused stand-in keeps the scenarios it
   * was started with.
   */
  scenarios?: readonly Scenario[];
  /**
   * The app-scoped models.json to write instead of the default custom
   * provider, given the mock server's port. The first-launch spec uses it
   * to leave the base runtime with no model (so the gate is up) while a
   * real provider's requests still land on the mock.
   */
  modelsJson?: (port: number) => string;
  /**
   * Reuse a still-running mock provider across a relaunch (restart tests).
   * close() leaves a reused provider running for its owner to close.
   */
  reuseMockProvider?: MockProviderServer;
  /** Reuse an existing userData dir across a relaunch (restart tests). */
  userDataDir?: string;
  /**
   * Reuse a throwaway HOME across a relaunch (restart tests): what a
   * Claude client wrote there - its login, its transcripts - is still
   * there. `prepareHome` runs on it again.
   */
  homeDir?: string;
  /**
   * By default e2e runs fake voice-model readiness so the capture UI is
   * exercisable without the 1.6GB model. Set false to test the real
   * first-use consent path.
   */
  voiceModelReady?: boolean;
  /**
   * The words the stand-in voice helper answers for each recording
   * (`tests/e2e/voiceHelperStandIn.ts`): each recording still travels from
   * the window through the main process to a helper process. None by
   * default, as the app's own helper answers without its weights.
   */
  voiceTranscript?: string;
  /**
   * Run the app's own voice helper and this computer's speech library in
   * place of the stand-in, for a check with the real model on disk: what the
   * library lists then decides where speech runs (`voice-freeze.check`).
   */
  useAppVoiceHelper?: boolean;
  /** Keep the fake device but use the app permission handlers instead of Chromium auto-grant. */
  useAppMediaPermissions?: boolean;
  /**
   * Expose `chrome.gpuBenchmarking` (`slidePointer`, `restOnTaskKey`): a pointer
   * Chromium routes between the window and its frames the way a real mouse
   * is, where Playwright's mouse goes straight to the frame under the point.
   */
  gpuBenchmarking?: boolean;
  /**
   * Draw the window at this many device pixels per CSS pixel, as a Retina
   * screen does (2) or a plain one (1). Chromium's own switch, so layout
   * rounds at device pixels the way a real screen's does; the DevTools
   * device-metrics override leaves layout at 1x.
   */
  deviceScaleFactor?: number;
  env?: Record<string, string>;
  /**
   * Seed files into the throwaway HOME before Electron starts. Claude's
   * credential lives at `$HOME/.claude` (CD-1=B); callers that need a
   * signed-in Claude login must write it here, not under userData/accounts.
   */
  prepareHome?: (homeDir: string) => void;
  /**
   * Let a Claude session run real turns: the default stub hands a turn
   * session to the SDK's own client, talking to the mock provider
   * (`tests/e2e/mockClaudeClient.ts`, turn mode). Needs a mock provider;
   * ignored when the spec names its own INFINITARY_CLAUDE_CLI. An object names
   * how the boxed client signs in and how often it retries.
   */
  claudeTurns?: boolean | Omit<MockClaudeTurns, "baseUrl">;
  /**
   * Record the window from launch to close (docs/testing.md, "Recording a
   * demo"): Playwright's own recording, at this size, kept in `dir` once the
   * app has closed. Only a demo asks for it (`tests/e2e/demo.ts`); the suite
   * never records itself.
   */
  recordVideo?: { dir: string; size: { width: number; height: number } };
  /**
   * Whether the window draws the shell, so the launch returns once the
   * shell's window keys reach it (the default). A build that refuses the
   * saved work it finds shows its offline refusal window instead
   * (docs/saved-data-compatibility.md, "Visible refusal"); a launch that
   * expects it passes false and returns once that page has loaded.
   */
  shell?: boolean;
};

/** Where the default Claude stub lives in a run's userData (its Keychain record too). */
export function defaultClaudeStubDir(userDataDir: string): string {
  return join(userDataDir, "claude-stub");
}

/**
 * How long a graceful Electron quit gets before the harness stops waiting,
 * in load time on an ordinary run (`budgetTimer`). Well under Playwright's 60 s hook timeout, so a quit that never lands is
 * reported as one warning rather than failing the file's `afterAll`.
 */
const CLOSE_GRACE_MS = 20_000;

/** A launched app's process, read while Playwright still holds the app, and its one close. */
type Watched = { child: ChildProcess; closing?: Promise<void> };

const watchedApps = new WeakMap<ElectronApplication, Watched>();

/**
 * Playwright answers `app.process()` only while the app is open: once it has
 * closed - closed by a test, or quit by itself - the call throws "Cannot read
 * properties of undefined (reading '_object')". So the process is read once,
 * as the app launches, and every close after that uses the same one.
 */
function watch(app: ElectronApplication): Watched {
  let watched = watchedApps.get(app);
  if (!watched) {
    watched = { child: app.process() };
    watchedApps.set(app, watched);
  }
  return watched;
}

const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * How long a launched window gets to draw its shell, the same as Playwright
 * gives it to appear at all (`firstWindow`).
 */
const SHELL_READY_MS = 30_000;

/**
 * Shuts the app down and RETURNS. A graceful quit is what we want and what
 * usually happens: the app's own quit takes milliseconds, and the rest is
 * Chromium's shutdown, which waits for tasks already running on its
 * lowest-priority threads - the threads a loaded Mac starves first
 * (src/main/chromiumFeatures.ts turns off the features whose stores held
 * it). When the process still has not ended, the app under test is
 * finished either way, so the harness kills it and says so on the log
 * instead of hanging the suite. Two `afterAll` hooks died on that.
 *
 * Closing is once per app: a second close - a `finally` after a step that
 * already closed it, say - waits for the first and never throws, so the
 * step's own failure is the one reported. An app that already quit by
 * itself has nothing left to close.
 */
export function closeApp(app: ElectronApplication): Promise<void> {
  const watched = watch(app);
  watched.closing ??= quit(app, watched.child);
  return watched.closing;
}

async function quit(app: ElectronApplication, child: ChildProcess): Promise<void> {
  if (ended(child)) return;
  let settled = false;
  const graceful = app.close().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([
    graceful,
    new Promise<void>((resolve) => {
      const timer = budgetTimer(resolve, CLOSE_GRACE_MS).unref();
      void graceful.finally(() => timer.cancel());
    }),
  ]);
  if (settled) return;
  console.warn(`[e2e] the app did not quit within ${CLOSE_GRACE_MS}ms; killing it`);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (ended(child)) resolve();
    else child.once("exit", () => resolve());
  });
}

/**
 * Gives every frame of the hidden window the focus a shown, focused window
 * gives it. Playwright emulates that focus for the window's main frame
 * alone, and a card's or a panel's frame in a process of its own then can
 * miss it: `document.hasFocus()` stays false there, so neither the window
 * nor the frame's own script can put the keyboard in it, and a journey that
 * waits for focus in a card waits out its time. Each such frame gets the
 * same emulation as it commits a page.
 */
function emulateFocusInFrames(page: Page): void {
  const focus = (frame: Frame) => {
    if (frame === page.mainFrame()) return;
    void page
      .context()
      .newCDPSession(frame)
      .then((session) => session.send("Emulation.setFocusEmulationEnabled", { enabled: true }))
      // A frame in the page's own process shares the main frame's emulated
      // focus and has no session of its own; one already gone needs none.
      .catch(() => {});
  };
  page.on("framenavigated", focus);
  for (const frame of page.frames()) focus(frame);
}

/**
 * Shows the app's window without giving it focus, on Linux alone. A hidden
 * window there paints about once a second where a hidden Mac window paints
 * at the display's rate (measured on the hosted Ubuntu runner: two frames in
 * two seconds hidden, 121 shown), so a journey that waits on frames or plays
 * Chromium's synthetic pointer waits out its time. Linux journeys run on a
 * virtual display (`xvfb-run`, docs/testing.md "The Linux source desktop"),
 * so a shown window disrupts no desktop.
 */
async function paintLikeAMac(app: ElectronApplication): Promise<void> {
  // The app's own window is its first, as every journey's window helper
  // reads it. Showing it again changes nothing, so `readInMain` may run it
  // again when its answer is lost to a garbage collection. This is the
  // launch's first main-process read, asked while the launch's work still
  // runs, so it is asked until the main process answers.
  await readInMain(() =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.showInactive()),
  );
}

/**
 * Where each home's connection listens (docs/devices.md): loopback alone, at
 * a port kept per userData, so a relaunched home is where its devices left
 * it. A test never listens on this Mac's network, where a firewall can drop
 * the dial (release run 37185124664 timed out at the Mac's own address), or
 * on the port a real app holds. The port is claimed for this worker, so no
 * other process in the run can be listening there when a probe dials it.
 */
const connectionPorts = new Map<string, number>();

async function connectionPort(userDataDir: string): Promise<number> {
  const kept = connectionPorts.get(userDataDir);
  if (kept !== undefined) return kept;
  const port = await claimedPort();
  connectionPorts.set(userDataDir, port);
  return port;
}

/**
 * The environment every hermetic start of the app runs in, whatever starts
 * it: a throwaway data folder and HOME, Pi offline, and every reach to this
 * computer's own network and privacy log stood in. `launchApp` adds its
 * voice, microphone and Claude stand-ins; a spec that starts the built app
 * as a command of its own (`<app> run`) starts it in this one too.
 */
export function hermeticEnv(input: {
  userDataDir: string;
  homeDir: string;
  loopbackPort: string;
}): Record<string, string> {
  const { userDataDir, homeDir, loopbackPort } = input;
  return {
    // Nothing of the session that ran the tests (tests/helpers/runnerSession.ts),
    // even when this launch runs outside the e2e global setup.
    ...(withoutRunnerSession(process.env) as Record<string, string>),
    // Never inherit a leftover Vite dev server: e2e must load the bundle.
    ELECTRON_RENDERER_URL: "",
    INFINITARY_USER_DATA_DIR: userDataDir,
    HOME: homeDir,
    // Chromium's own Linux temporary files belong to this app, not the
    // run root, including when a process aborts during startup.
    TMPDIR: scratchDir("infinitary-app-tmp-"),
    CFFIXED_USER_HOME: homeDir,
    // Linux desktop libraries follow XDG rather than HOME when these are
    // inherited. Keep every app's caches and configuration private too.
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    // Pi's own switch for startup network operations. The app asks Pi for
    // the live pi.dev model catalog (docs/architecture.md §16.3); e2e must
    // stay hermetic, so the suite runs the static-fallback path instead.
    PI_OFFLINE: "1",
    // A seeded Grok API key's allowance read goes to a port nothing
    // listens on (9, discard), never to xAI with a made-up key; a spec
    // that serves the read names its own stub in `env`.
    INFINITARY_GROK_KEY_URL: "http://127.0.0.1:9/v1/api-key",
    // The served starter list is asked of the same unused port, so every
    // journey starts on the shipped starter map (docs/model-lists.md).
    INFINITARY_STARTERS_URL: "http://127.0.0.1:9/infinitary-starters.json",
    // A task browser resolves only the names a spec gives it, so no page
    // reaches a real network (docs/task-browser.md, "Where a page may go").
    INFINITARY_TASK_BROWSER_HOSTS: "{}",
    // Macs nearby listen through a stand-in that finds none unless the spec
    // names its own, so no test listens on this Mac's own network
    // (docs/devices.md, "Macs nearby").
    INFINITARY_DNS_SD: standInDnsSd([]),
    // The privacy watch reads a log reader that prints nothing and ends
    // unless the spec names its own, so no test reads this Mac's own
    // privacy log (docs/macos-privacy.md).
    INFINITARY_PRIVACY_LOG: "/usr/bin/true",
    // No GitHub CLI unless the spec names its own stand-in, so no test finds
    // or asks the one installed on this Mac (docs/forge.md, "GitHub CLI's sign-in").
    INFINITARY_GITHUB_CLI: "none",
    INFINITARY_CONNECTION_LOOPBACK_PORT: loopbackPort,
  };
}

/**
 * Launches the built app (out/) against a throwaway userData dir and a
 * throwaway HOME so e2e runs never touch real state - and provably never
 * touch ~/.pi. Callers use close() to shut everything down.
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const startedAt = performance.now();
  const appDir = builtAppDir();
  // Throwaway dirs survive `close()`: a relaunch test reads the same
  // userData after the first app has quit. scratchDir removes them when this
  // Playwright worker exits, inside the run's private TMPDIR either way.
  const userDataDir = options.userDataDir ?? scratchDir("infinitary-e2e-");
  const homeDir = options.homeDir ?? scratchDir("infinitary-home-");
  options.prepareHome?.(homeDir);

  let mockProvider: MockProviderServer | undefined = options.reuseMockProvider;
  const ownsMockProvider = !mockProvider && Boolean(options.withMockProvider);
  if (options.scenarios && !ownsMockProvider) {
    throw new Error(
      "scenarios need the stand-in this launch starts (withMockProvider); a reused stand-in keeps the scenarios it started with.",
    );
  }
  if (mockProvider || options.withMockProvider) {
    if (!mockProvider) {
      mockProvider = await startMockProvider({ scenarios: options.scenarios });
    }
    mkdirSync(join(userDataDir, "auth"), { recursive: true });
    writeFileSync(
      join(userDataDir, "auth", "models.json"),
      (options.modelsJson ?? mockModelsJson)(mockProvider.port),
    );
  }

  if (options.claudeTurns && !mockProvider) {
    throw new Error("claudeTurns needs a mock provider for the client to talk to.");
  }
  // A spec may name its own loopback port in `env`, which wins below.
  const loopbackPort =
    options.env?.INFINITARY_CONNECTION_LOOPBACK_PORT ?? String(await connectionPort(userDataDir));
  const preparedAt = performance.now();
  // Named before the app starts, so an app whose worker is killed mid-launch
  // stops with it too.
  stopWithWorker(userDataDir);
  const diagnostics = launchDiagnostics(userDataDir, mockProvider);
  const opening = electron.launch({
    // Playwright otherwise inserts --no-sandbox on Linux. Exercise the
    // same sandbox a normal desktop launch uses.
    chromiumSandbox: true,
    // Playwright removes its own artifacts dir only when the app closes
    // cleanly; a scratch one goes even when closeApp has to kill the app.
    artifactsDir: scratchDir("infinitary-pw-artifacts-"),
    ...(options.recordVideo ? { recordVideo: options.recordVideo } : {}),
    // Fake media devices: hold-to-talk opens a synthetic mic, so the app
    // never asks for the real one. macOS still asks for the runner's
    // responsible process, so a runner needs microphone access
    // (docs/testing.md, "The runner's microphone access").
    args: [
      options.packaged ? packagedEntry(appDir, options.devFlavor, options.version) : appDir,
      // Chromium honors this before JavaScript. Playwright's electron loader
      // calls `app.whenReady()` before the main script's `setPath`, so the
      // env-only isolated dir is too late: every parallel electron otherwise
      // shares ~/Library/Application Support/Electron. A peer that finds the
      // singleton lock before the socket is listening SIGTERMs the holder.
      // That is the first-launch failure on verify run 35928921757: the
      // process died after "Debugger attached" and before "DevTools
      // listening", with no SingletonLock line of its own (it was the
      // victim). The path matches INFINITARY_USER_DATA_DIR, which still wins
      // `chooseUserDataDir` and keeps the window hidden.
      `--user-data-dir=${userDataDir}`,
      "--use-fake-device-for-media-stream",
      ...(options.useAppMediaPermissions ? [] : ["--use-fake-ui-for-media-stream"]),
      ...(options.gpuBenchmarking ? ["--enable-gpu-benchmarking"] : []),
      ...(options.deviceScaleFactor !== undefined
        ? [`--force-device-scale-factor=${options.deviceScaleFactor}`]
        : []),
      // Text antialiased in grey, as macOS draws it: Chromium on Linux draws
      // subpixel (LCD) text only on an opaque layer of its own, so the same
      // component would draw different pixels in and out of a panel.
      ...(process.platform === "linux" ? ["--disable-lcd-text"] : []),
      // In a virtual Mac the app draws in software (tests/e2e/virtualMac.ts).
      ...virtualMacSwitches(),
    ],
    env: {
      ...hermeticEnv({ userDataDir, homeDir, loopbackPort }),
      INFINITARY_VOICE_MODEL_READY: options.voiceModelReady === false ? "0" : "1",
      // macOS's microphone answer is the spec's, never this Mac's own
      // (src/main/voice/micAccess.ts); a spec names another in `env`.
      INFINITARY_MIC_ACCESS: "granted",
      // So is whether this computer has a graphics card for speech
      // (src/main/voice/graphicsCard.ts): the hosted Linux runner has none.
      INFINITARY_GRAPHICS_CARD: "present",
      // And what its speech library can do there (docs/architecture.md
      // section 8, "Where speech runs"): the stand-in voice helper lists
      // WebGPU, as the library's builds for Apple silicon and Linux x64 do.
      // Linux arm64's lists none, which leaves speech to the window's own
      // adapter, and a virtual screen has none, so dictation would hide.
      ...(options.useAppVoiceHelper
        ? {}
        : {
            INFINITARY_VOICE_HELPER_ENTRY: writeVoiceHelperStandIn(options.voiceTranscript ?? ""),
          }),
      // The Claude transport runs the client the MACHINE has installed (F14),
      // and a developer's real one must never be spawned by a test. Every
      // run gets the stub unless the spec names its own path.
      ...(options.env?.INFINITARY_CLAUDE_CLI === undefined
        ? {
            INFINITARY_CLAUDE_CLI: writeMockClaudeClient(
              options.claudeTurns ? homeDir : defaultClaudeStubDir(userDataDir),
              options.claudeTurns && mockProvider
                ? {
                    turns: {
                      ...(typeof options.claudeTurns === "object" ? options.claudeTurns : {}),
                      baseUrl: `http://127.0.0.1:${mockProvider.port}`,
                    },
                  }
                : {},
            ),
          }
        : {}),
      ...options.env,
    },
  });
  const app = await opening.catch(async (error: unknown) => {
    diagnostics.snapshot();
    diagnostics.stop();
    if (ownsMockProvider) await mockProvider?.close();
    throw error;
  });
  const launchedAt = performance.now();
  diagnostics.watch(watch(app).child);
  let page: Page;
  try {
    page = await app.firstWindow();
    emulateFocusInFrames(page);
    if (process.platform === "linux") await paintLikeAMac(app);
    await page.waitForLoadState("domcontentloaded");
    // The page loads before the shell has drawn, and the key of a command
    // the shell runs does nothing until the shell follows the window's
    // commands: the launch is ready once the shell marks the keys as its own.
    if (options.shell !== false) await untilWindowCommands(page, SHELL_READY_MS);
  } catch (error) {
    diagnostics.snapshot();
    await closeApp(app);
    diagnostics.snapshot();
    diagnostics.stop();
    if (ownsMockProvider) await mockProvider?.close();
    throw error;
  }
  const readyAt = performance.now();
  let closing: Promise<void> | undefined;
  return {
    app,
    page,
    userDataDir,
    diagnosticsDir: diagnostics.dir,
    homeDir,
    connectionPort: options.packaged ? CONNECTION_PORT : Number(loopbackPort),
    ...(mockProvider ? { mockProvider } : {}),
    // Once, like closeApp: a second close waits for the first.
    close: () => {
      closing ??= (async () => {
        const closingAt = performance.now();
        diagnostics.snapshot();
        await closeApp(app);
        diagnostics.snapshot();
        diagnostics.stop();
        if (ownsMockProvider) {
          await mockProvider?.close();
        }
        if (process.env.INFINITARY_TEST_PROFILE === "1") {
          console.log(
            "[e2e-profile]",
            JSON.stringify({
              setupMs: preparedAt - startedAt,
              launchMs: launchedAt - preparedAt,
              readyMs: readyAt - launchedAt,
              bodyMs: closingAt - readyAt,
              closeMs: performance.now() - closingAt,
            }),
          );
        }
      })();
      return closing;
    },
  };
}
