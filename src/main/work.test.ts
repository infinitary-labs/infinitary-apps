import { APP_FRAME_SCHEME } from "@shared/csp";
import { afterEach, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => vi.fn());

/** Electron's app as the work mode uses it, with its listeners kept to emit. */
const electronApp = vi.hoisted(() => {
  const listeners = new Map<string, (() => void)[]>();
  return {
    listeners,
    isPackaged: true,
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    setActivationPolicy: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    setPath: vi.fn(),
    getAppPath: vi.fn(() => "/Applications/Infinitary.app/Contents/Resources/app.asar"),
    getVersion: vi.fn(() => "0.0.0"),
    exit: vi.fn(),
  };
});
const platform = vi.hoisted(() => ({ current: process.platform as NodeJS.Platform }));
const execFile = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: electronApp,
  protocol: { registerSchemesAsPrivileged: registered },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));
vi.mock("../core/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/platform")>()),
  hostPlatform: () => platform.current,
}));
// The command itself never ends here, so the work mode never exits the test.
vi.mock("@core/helper/cli", () => ({ runCli: vi.fn(() => new Promise(() => {})) }));
vi.mock("./workContext", () => ({
  workContext: vi.fn(() => ({
    place: { dataDir: "/nowhere/work" },
    launcher: {},
    serviceManager: {},
    backgroundEnv: {},
  })),
}));
vi.mock("./mediaProbe", () => ({ createMediaProbe: vi.fn(), createTypefaceProbe: vi.fn() }));
vi.mock("./host/taskBrowser", () => ({ createTaskBrowserHost: vi.fn() }));
vi.mock("./host/axiProcess", () => ({ createAxiProcessSpawner: vi.fn() }));
vi.mock("./host/setAsideProcess", () => ({ createSetAsideProcessSpawner: vi.fn() }));
vi.mock("./host/resourceMemory", () => ({ readResourceMemory: vi.fn() }));
vi.mock("./host/nativeSecrets", () => ({ nativeStandbyLock: vi.fn() }));
vi.mock("./userDataDir", () => ({ packagedFlavor: vi.fn(), readPackageJsonAt: vi.fn() }));
vi.mock("./ownDisplay", () => ({ startOwnDisplay: vi.fn() }));

import { frameScheme } from "./frames/frameScheme";
import { runWorkMode } from "./work";

/**
 * A crewmate on another computer attaches a valid H.264 demo (INF-124).
 * The work mode must register the frame scheme when its module loads, before
 * the app is ready, or the media probe reports that this player cannot play
 * the recording's format.
 */
it("registers the frame scheme's stream privileges when the work mode loads", () => {
  expect(registered).toHaveBeenCalledOnce();
  expect(registered).toHaveBeenCalledWith([frameScheme]);
  expect(frameScheme.scheme).toBe(APP_FRAME_SCHEME);
  expect(frameScheme.privileges).toMatchObject({
    standard: true,
    secure: true,
    stream: true,
  });
});

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const process_ = process as NodeJS.Process & { resourcesPath?: string };
const before = {
  execPath: process.execPath,
  resourcesPath: process_.resourcesPath,
  console: { log: console.log, info: console.info, debug: console.debug, warn: console.warn },
  signals: Object.fromEntries(STOP_SIGNALS.map((signal) => [signal, process.listeners(signal)])),
};

afterEach(() => {
  process.execPath = before.execPath;
  Object.defineProperty(process, "resourcesPath", {
    value: before.resourcesPath,
    configurable: true,
    writable: true,
  });
  Object.assign(console, before.console);
  for (const signal of STOP_SIGNALS)
    for (const listener of process.listeners(signal))
      if (!before.signals[signal]?.includes(listener)) process.off(signal, listener);
  platform.current = process.platform;
  electronApp.listeners.clear();
  vi.clearAllMocks();
});

/**
 * A reporter's MacBook does crew work for their other Mac: it joined that home
 * at its window's first launch, so its work runs the app they click, and macOS
 * hands their click in the Dock or Finder to that work, which opened nothing
 * (INF-4776). The work now opens the app's window beside itself, as the
 * home's own background command does (INF-4118).
 * Data: the installed app's executable, which a Mac joined at its first launch
 * runs, and the copy a home's first update keeps in the work folder's `app/`.
 */
it.each([
  {
    runs: "the installed app",
    execPath: "/Applications/Infinitary.app/Contents/MacOS/Infinitary",
    bundle: "/Applications/Infinitary.app",
  },
  {
    runs: "the copy its home keeps in the work folder",
    execPath:
      "/Users/person/Library/Application Support/infinitary/work/app/Infinitary.app/Contents/MacOS/Infinitary",
    bundle: "/Users/person/Library/Application Support/infinitary/work/app/Infinitary.app",
  },
])(
  "a click that reaches the work on a Mac, running $runs, opens the app's window beside it",
  ({ execPath, bundle }) => {
    platform.current = "darwin";
    process.execPath = execPath;
    Object.defineProperty(process, "resourcesPath", {
      value: `${bundle}/Contents/Resources`,
      configurable: true,
      writable: true,
    });
    runWorkMode(["run"], "/main");
    // Its own start opens nothing: it is background-only.
    expect(electronApp.setActivationPolicy.mock.calls).toEqual([["prohibited"]]);
    expect(execFile).not.toHaveBeenCalled();

    // macOS hands it the click as a reopen, which Electron calls `activate`.
    for (const listener of electronApp.listeners.get("activate") ?? []) listener();
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual(["/usr/bin/open", ["-n", bundle]]);
    // Back in the background, with no Dock icon or menu bar of its own.
    expect(electronApp.setActivationPolicy.mock.calls).toEqual([["prohibited"], ["prohibited"]]);
  },
);
