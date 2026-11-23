import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type {
  HostBrowserCookies,
  HostBrowserOpen,
  HostBrowserPage,
  HostChromeFallback,
  HostCookie,
  HostDownloadTarget,
  HostPageEvents,
  InstalledBrowser,
} from "@core/host";
import { AskGrants, cookieUrl } from "../pageProtocol";
import { CdpPipe } from "./cdpPipe";
import { type ChromePage, driveChromePage } from "./chromePage";
import { browserNames } from "./findChrome";

/**
 * Google Chrome as the task browser's second engine (docs/task-browser.md,
 * "Installed browser engines"): the Chrome installed on the computer
 * that runs the task, started once for every task browser there, with a
 * profile folder of the app's own and no first window, driven over its
 * private pipe. Each browser is a separate empty context of that Chrome,
 * with its own minimized window and the browser's connection guard as its
 * proxy, and goes with everything it holds when it closes; Chrome stops
 * once no browser is open. The kept profile's Chrome is the exception: it
 * runs until the app quits or Remove all empties it.
 */

/**
 * The oldest Chrome the engine drives: the version whose page draws a
 * dropdown's list itself (`appearance: base-select`), which the captain's
 * view needs, since Chrome's own list is never in the page's pictures.
 */
const MIN_CHROME_MAJOR = 135;
/** How long Chrome has to start and answer before the built-in engine opens instead. */
const START_MS = 20_000;
/** How long Chrome has to close on its own before it is ended. */
const STOP_MS = 5_000;

/** Why Chrome could not open a browser: the built-in engine opens it instead. */
export class ChromeUnavailable extends Error {
  constructor(
    readonly reason: HostChromeFallback,
    detail: string,
  ) {
    super(`Installed browser could not open a task browser (${reason}): ${detail}`);
  }
}

/** Chrome's major version from its product name (`Chrome/157.0.8103.51`). */
export function chromeMajor(product: string): number | undefined {
  const match = /^(?:Chrome|Edg)\/(\d+)\./.exec(product);
  return match ? Number(match[1]) : undefined;
}

/**
 * How Chrome starts: its own profile folder, the private pipe, no first
 * window, no first-run page, and pages that keep drawing and running while
 * its window is minimized. The page is not marked as driven by automation
 * (`navigator.webdriver`), which the pipe would otherwise mark. WebRTC
 * reaches its peers only through the proxy, so never around the guard.
 * The profile keeps nothing in the computer's keychain or password store,
 * and binds no site's sign-in to a key in it (device-bound sessions, which
 * Google's sign-in starts): an empty context is in memory only, and a key kept
 * in the keychain would outlive it, or raise the keychain's own dialog where
 * none is reachable. The kept profile's sign-ins are on disk in its folder,
 * encrypted with Chrome's own fixed stand-in key (`--use-mock-keychain`,
 * `--password-store=basic`), never one the system keeps: they are as safe as
 * the computer's login and its disk (docs/task-browser.md, "Signed-in sites").
 * Chrome neither installs nor wakes Google's updater, which would outlive it
 * (the updater the person's own Chrome set up still keeps Chrome current).
 */
export function chromeArguments(
  profileDir: string,
  platform: NodeJS.Platform,
  proxy?: string,
  browser: InstalledBrowser = "chrome",
): string[] {
  return [
    // The kept profile's own pages use its default context, whose one proxy
    // is the kept guard, loopback included, as an empty context's is.
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>"] : []),
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    ...(browser === "chrome" ? ["--disable-blink-features=AutomationControlled"] : []),
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-updater-scheduler",
    "--disable-features=EnableBoundSessionCredentials,DeviceBoundSessions,DeviceBoundSessionCredentialsMac",
    ...(platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(platform === "linux" ? ["--password-store=basic"] : []),
  ];
}

/**
 * Every permission a site may ask for, refused in each context, as the
 * built-in engine refuses them: Chrome would otherwise ask in its own
 * window, where nobody sees it.
 */
const PERMISSIONS = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "clipboard-read",
  "clipboard-write",
  "midi",
  "midi-sysex",
  "background-sync",
  "persistent-storage",
  "local-fonts",
  "window-management",
  "idle-detection",
  "storage-access",
  "top-level-storage-access",
  "display-capture",
  "speaker-selection",
  "screen-wake-lock",
  "keyboard-lock",
  "pointer-lock",
  "captured-surface-control",
  "payment-handler",
  "nfc",
  "accelerometer",
  "gyroscope",
  "magnetometer",
  "ambient-light-sensor",
  "protected-media-identifier",
  "periodic-background-sync",
  "local-network-access",
];

export type ChromeEngineOptions = {
  browser?: InstalledBrowser;
  /** Where Chrome is on this computer, or nothing when it is not installed. */
  executable: () => string | undefined;
  platform: NodeJS.Platform;
  /** The app's own profile folder for Chrome. */
  profileDir: string;
  /** Where a download is written while it runs, before it moves where the core says. */
  downloadsDir: string;
  /** The environment every child the app starts runs with. */
  env: () => NodeJS.ProcessEnv;
  clipboardText: () => string;
  log: (line: string) => void;
  /**
   * The kept profile's Chrome (docs/task-browser.md, "Signed-in sites"): its
   * browsers open in the profile's own default context, which outlives
   * them, rather than each in an empty one.
   */
  kept?: true;
};

/**
 * Where the kept profile's Chrome sends its own connections when it starts
 * only to sign the captain out of a site, with no browser open: nowhere.
 */
const NOWHERE_PROXY = "127.0.0.1:9";

export type ChromeEngine = {
  /** Open a browser in Chrome; `ChromeUnavailable` when Chrome cannot. */
  open: (input: HostBrowserOpen) => Promise<HostBrowserPage>;
  /** End Chrome now, with every browser in it; settles once every Chrome it started has exited. */
  stop: () => Promise<void>;
  /**
   * Every page open in Chrome now, as a journey reads the built-in engine's
   * pages through the app (docs/task-browser.md, "Tests"): its address, what
   * an expression reads in it, and whether its window is on the desktop.
   */
  pages: () => ChromePageReading[];
  /**
   * In the kept profile, remove the cookies `pick` chooses and clear each
   * origin's own site data, starting Chrome for it when no browser is open.
   */
  forget?: (
    pick: (cookies: readonly HostCookie[]) => HostCookie[],
    origins: readonly string[],
  ) => Promise<void>;
  /**
   * Empty the kept profile: stop its Chrome and delete its folder, every
   * cookie and every origin's site data with it. The core asks only once no
   * browser is open in it.
   */
  forgetAll?: () => Promise<void>;
};

export type ChromePageReading = {
  url: () => string;
  evaluate: (expression: string) => Promise<unknown>;
  shown: () => Promise<boolean>;
  /** The names of every cookie its browser holds, as the built-in engine's session lists them. */
  cookieNames: () => Promise<string[]>;
};

type Download = { target: HostDownloadTarget; bytes: number };

/** One task browser: a context of Chrome's, its pages and its downloads. */
type Context = {
  id: string;
  open: HostBrowserOpen;
  first?: ChromePage;
  ready?: (page: ChromePage) => void;
  pages: Map<string, ChromePage>;
  downloads: Map<string, Download>;
  downloadDir: string;
  cookies: HostBrowserCookies;
  /** What the captain let this browser's sites use, set in Chrome for its context. */
  grants: AskGrants;
  ended: boolean;
};

type Running = {
  pipe: CdpPipe;
  child: ChildProcess;
  version: string;
  /** The proxy the kept profile's Chrome started with. */
  proxy?: string;
  /** The kept profile's permissions and downloads, set once for its default context. */
  keptReady?: Promise<void>;
  /** Kept browsers whose first page Chrome has not attached yet, oldest first. */
  awaitingFirst: Context[];
  contexts: Map<string, Context>;
  /** Each attached page's context and session, by its target. */
  targets: Map<string, { context: Context; sessionId: string }>;
  /** Each session Chrome attached, by id: its page, for its events. */
  sessions: Map<string, ChromePage>;
  /** Pages a page asked to open, by opener, with the address it asked for. */
  windowOpens: Map<string, string[]>;
  /**
   * The kept profile's blank pages it opens only to clear a site's data, by
   * address: Chrome clears an origin's data only through a page's session.
   */
  clearingPages: Map<string, (sessionId: string) => void>;
};

/** The address of a blank page the kept profile opens only to clear a site's data. */
const CLEARING_PAGE = "about:blank#infinitary-clearing-";

export function createChromeEngine(options: ChromeEngineOptions): ChromeEngine {
  const browser = options.browser ?? "chrome";
  const name = browserNames[browser];
  /** A context as Chrome names it: the kept profile's is its default, which goes unnamed. */
  const contextOf = (context: Context): { browserContextId?: string } =>
    options.kept ? {} : { browserContextId: context.id };
  let running: Promise<Running> | undefined;
  let current: Running | undefined;
  let opening = 0;
  // Each Chrome still on its way out, so a stop can wait until its profile is let go.
  const exiting = new Set<Promise<void>>();

  const start = async (proxy?: string): Promise<Running> => {
    const executable = options.executable();
    if (!executable) throw new ChromeUnavailable("not-installed", `no ${name} on this computer`);
    await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
    // A Chrome told to stop still holds the profile until it exits.
    await Promise.all([...exiting]);
    let child: ChildProcess;
    try {
      child = spawn(
        executable,
        chromeArguments(options.profileDir, options.platform, proxy, browser),
        {
          // Chrome starts in its own folder, so nothing it starts that outlives
          // it keeps the app's folder as its own.
          cwd: dirname(executable),
          env: options.env(),
          stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw new ChromeUnavailable("would-not-start", String(error));
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    const pipe = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const spawnFailed = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) =>
        reject(new ChromeUnavailable("would-not-start", String(error))),
      );
      child.once("exit", (code, signal) =>
        reject(
          new ChromeUnavailable(
            "would-not-start",
            `Chrome ended at its start (${signal ?? code}): ${stderr.trim()}`,
          ),
        ),
      );
    });
    spawnFailed.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ChromeUnavailable("would-not-start", "Chrome did not answer")),
        START_MS,
      );
    });
    let product: string;
    try {
      ({ product } = await Promise.race([
        pipe.send<{ product: string }>("Browser.getVersion"),
        spawnFailed,
        timedOut,
      ]));
    } catch (error) {
      child.kill();
      pipe.close();
      throw error instanceof ChromeUnavailable
        ? error
        : new ChromeUnavailable("would-not-start", String(error));
    } finally {
      clearTimeout(timer);
    }
    const major = chromeMajor(product);
    if (major === undefined || major < MIN_CHROME_MAJOR) {
      void pipe.send("Browser.close").catch(() => undefined);
      setTimeout(() => child.kill(), STOP_MS).unref();
      throw new ChromeUnavailable("too-old", `${product} is older than ${MIN_CHROME_MAJOR}`);
    }
    const state: Running = {
      pipe,
      child,
      version: product.replace(/^(?:Chrome|Edg)\//, ""),
      ...(proxy ? { proxy } : {}),
      awaitingFirst: [],
      contexts: new Map(),
      targets: new Map(),
      sessions: new Map(),
      clearingPages: new Map(),
      windowOpens: new Map(),
    };
    pipe.on((method, params, sessionId) => event(state, method, params, sessionId));
    pipe.onClose(() => ended(state, `${name} closed`));
    child.once("exit", () => pipe.close());
    // A new page in any context is held until its requests are heard.
    await pipe.send("Target.setDiscoverTargets", { discover: true });
    await pipe.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      // A service or shared worker belongs to a browser, not a page, so
      // Chrome attaches it here; its requests are asked of the core too.
      filter: [{ type: "page" }, { type: "service_worker" }, { type: "shared_worker" }],
    });
    options.log(`[task-browser] ${name} ${state.version} started`);
    return state;
  };

  /** Chrome is gone: every browser in it is gone with it. */
  const ended = (state: Running, reason: string): void => {
    if (current === state) {
      current = undefined;
      running = undefined;
    }
    for (const context of state.contexts.values()) {
      context.ended = true;
      for (const page of context.pages.values()) page.gone(reason);
      for (const download of context.downloads.values()) {
        download.target.done({ state: "cancelled", bytes: download.bytes });
      }
      context.downloads.clear();
    }
    state.contexts.clear();
  };

  const stopChrome = (state: Running): void => {
    const child = state.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())).then(() =>
      rm(options.downloadsDir, { recursive: true, force: true }).catch(() => undefined),
    );
    exiting.add(exited);
    void exited.then(() => exiting.delete(exited));
    void state.pipe.send("Browser.close").catch(() => undefined);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, STOP_MS).unref();
  };

  /** A context ended: Chrome stops once none is open or opening. */
  const release = (state: Running, context: Context): void => {
    if (context.ended) return;
    context.ended = true;
    state.contexts.delete(context.id);
    for (const [guid, download] of context.downloads) {
      void state.pipe
        .send("Browser.cancelDownload", { guid, ...contextOf(context) })
        .catch(() => undefined);
      download.target.done({ state: "cancelled", bytes: download.bytes });
    }
    context.downloads.clear();
    if (options.kept) {
      // The profile outlives the browser: only its pages go.
      state.awaitingFirst = state.awaitingFirst.filter((each) => each !== context);
      for (const targetId of context.pages.keys()) {
        void state.pipe.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    } else {
      void state.pipe
        .send("Target.disposeBrowserContext", { browserContextId: context.id })
        .catch(() => undefined)
        .then(() => rm(context.downloadDir, { recursive: true, force: true }))
        .catch(() => undefined);
    }
    stopIfIdle(state);
  };

  /**
   * Chrome stops once no context is open or opening. The kept profile's
   * Chrome, once it started for a browser behind the kept guard, runs until
   * the app quits or Remove all empties it, as the built-in engine's kept
   * partition does: a sign-in a site keeps only in a cookie for the browser's
   * session lives in that Chrome's memory, and would go with it.
   */
  const stopIfIdle = (state: Running): void => {
    if (options.kept && state.proxy !== NOWHERE_PROXY) return;
    if (state.contexts.size === 0 && opening === 0 && current === state) {
      current = undefined;
      running = undefined;
      stopChrome(state);
    }
  };

  const event = (
    state: Running,
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void => {
    if (sessionId) {
      const page = state.sessions.get(sessionId);
      if (page) {
        if (method === "Page.windowOpen") {
          const target = [...state.targets].find(([, route]) => route.sessionId === sessionId);
          if (target) {
            const asked = state.windowOpens.get(target[0]) ?? [];
            asked.push(String(params.url ?? "about:blank"));
            state.windowOpens.set(target[0], asked);
          }
        }
        page.message(method, params, sessionId);
        // A frame or worker attached under a page sends its events under its own session.
        if (method === "Target.attachedToTarget") {
          state.sessions.set(String(params.sessionId), page);
        } else if (method === "Target.detachedFromTarget") {
          state.sessions.delete(String(params.sessionId));
        }
      }
      return;
    }
    if (method === "Target.attachedToTarget") {
      void attached(state, params);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const info = params.targetInfo as { targetId: string; url?: string; title?: string };
      const route = state.targets.get(info.targetId);
      route?.context.pages.get(info.targetId)?.info({ url: info.url, title: info.title });
      return;
    }
    if (method === "Target.targetDestroyed" || method === "Target.detachedFromTarget") {
      // A worker of a browser's goes with its session.
      if (method === "Target.detachedFromTarget" && !state.targets.has(String(params.targetId))) {
        state.sessions.delete(String(params.sessionId));
      }
      const targetId = String(params.targetId);
      const route = state.targets.get(targetId);
      if (!route) return;
      state.targets.delete(targetId);
      state.sessions.delete(route.sessionId);
      const page = route.context.pages.get(targetId);
      route.context.pages.delete(targetId);
      // A browser that already ended, or never finished opening, tells the core nothing more.
      if (!page || route.context.ended) return;
      if (page === route.context.first) {
        // Closed in Chrome itself rather than by the core: the browser is gone.
        page.gone("closed");
        release(state, route.context);
      } else {
        page.closedItself();
      }
      return;
    }
    if (method === "Browser.downloadWillBegin") {
      downloadBegins(state, params);
      return;
    }
    if (method === "Browser.downloadProgress") {
      downloadProgress(state, params);
    }
  };

  /**
   * A page the app will not run. Closing it while Chrome holds it at its
   * start ends the page that opened it too, so it runs first with every
   * request it makes held, and never let go, until it closes.
   */
  const discard = (state: Running, sessionId: string, targetId: string): void => {
    void state.pipe
      .send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId)
      .then(() => state.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId))
      .catch(() => undefined)
      .then(() => state.pipe.send("Target.closeTarget", { targetId }))
      .catch(() => undefined);
  };

  /** A page Chrome attached and holds before it runs: a browser's first, or one a page opened. */
  const attached = async (state: Running, params: Record<string, unknown>): Promise<void> => {
    const sessionId = String(params.sessionId);
    const info = params.targetInfo as {
      targetId: string;
      type?: string;
      browserContextId?: string;
      openerId?: string;
      url?: string;
    };
    const clearing = info.url ? state.clearingPages.get(info.url) : undefined;
    if (clearing) {
      // Held at its start, so nothing runs in it; it only lends its session,
      // and never takes the place of a kept browser waiting for its first page.
      clearing(sessionId);
      return;
    }
    const context = options.kept
      ? keptContextOf(state, info)
      : info.browserContextId
        ? state.contexts.get(info.browserContextId)
        : undefined;
    const send = (method: string, sent: Record<string, unknown> = {}): Promise<unknown> =>
      state.pipe.send(method, sent, sessionId);
    if (info.type === "service_worker" || info.type === "shared_worker") {
      worker(state, sessionId, context);
      return;
    }
    if (!context || context.ended) {
      // Not a task browser's page: nothing of the app's runs in it.
      discard(state, sessionId, info.targetId);
      return;
    }
    if (!context.first) {
      const page = await driveChromePage({
        pipe: state.pipe,
        sessionId,
        targetId: info.targetId,
        events: context.open,
        open: context.open,
        viewport: context.open.viewport,
        cookies: context.cookies,
        clipboardText: options.clipboardText,
        grants: context.grants,
        restoreForCapture: options.platform === "linux",
        showWindow: (shown) => showWindow(state, info.targetId, sessionId, shown),
        close: () => release(state, context),
      }).catch(() => undefined);
      if (!page) {
        void send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
        return;
      }
      context.first = page;
      context.pages.set(info.targetId, page);
      state.targets.set(info.targetId, { context, sessionId });
      state.sessions.set(sessionId, page);
      await page.run().catch(() => undefined);
      // A page Chrome could not prepare is never handed to the core.
      if (!(await page.prepared.then(() => true).catch(() => false))) return;
      context.ready?.(page);
      return;
    }
    // A page one of its pages opened: it joins the browser when the core lets it.
    const opener = info.openerId ?? [...context.pages.keys()][0] ?? "";
    const asked = state.windowOpens.get(opener)?.shift();
    const popup = context.open.onPopup(asked ?? (info.url || "about:blank"));
    if (!popup) {
      discard(state, sessionId, info.targetId);
      return;
    }
    const page = await driveChromePage({
      pipe: state.pipe,
      sessionId,
      targetId: info.targetId,
      events: popup.events as HostPageEvents,
      open: context.open,
      viewport: popup.viewport,
      cookies: context.cookies,
      clipboardText: options.clipboardText,
      grants: context.grants,
      restoreForCapture: options.platform === "linux",
      showWindow: (shown) => showWindow(state, info.targetId, sessionId, shown),
      close: () => {
        void state.pipe
          .send("Target.closeTarget", { targetId: info.targetId })
          .catch(() => undefined);
      },
    }).catch(() => undefined);
    if (!page) {
      discard(state, sessionId, info.targetId);
      return;
    }
    context.pages.set(info.targetId, page);
    state.targets.set(info.targetId, { context, sessionId });
    state.sessions.set(sessionId, page);
    await page.run().catch(() => undefined);
    if (!(await page.prepared.then(() => true).catch(() => false))) {
      context.pages.delete(info.targetId);
      state.targets.delete(info.targetId);
      state.sessions.delete(sessionId);
      discard(state, sessionId, info.targetId);
      return;
    }
    popup.opened(page.page);
    await minimize(state, info.targetId);
  };

  /**
   * Which kept browser a page Chrome attached in the kept profile's one
   * context belongs to: its opener's, a page opened by another; or the
   * oldest browser still waiting for its first page. A worker belongs to
   * the profile, so it is judged as the first browser's page in it would be.
   */
  const keptContextOf = (
    state: Running,
    info: { type?: string; openerId?: string },
  ): Context | undefined => {
    if (info.type === "service_worker" || info.type === "shared_worker") {
      return [...state.contexts.values()].find((each) => !each.ended && each.first);
    }
    const opener = info.openerId ? state.targets.get(info.openerId)?.context : undefined;
    if (opener) return opener;
    return state.awaitingFirst.shift();
  };

  /**
   * A browser's service or shared worker: its requests go to its browser's
   * first page, to be judged as that page's are. A worker of no task
   * browser's runs with every request held.
   */
  const worker = (state: Running, sessionId: string, context: Context | undefined): void => {
    const page = context && !context.ended ? context.first : undefined;
    if (page) {
      state.sessions.set(sessionId, page);
      page.adopt(sessionId);
      return;
    }
    void state.pipe
      .send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId)
      .catch(() => undefined)
      .then(() => state.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId))
      .catch(() => undefined);
  };

  /** Chrome's window for a page goes to the Dock: the page keeps drawing, nobody sees it there. */
  const minimize = async (state: Running, targetId: string): Promise<void> => {
    try {
      const { windowId } = await state.pipe.send<{ windowId: number }>(
        "Browser.getWindowForTarget",
        { targetId },
      );
      await state.pipe.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch {
      // A tab in a window already minimized has nothing more to do.
    }
  };

  /**
   * Chrome's window for a page comes out of the Dock and to the front, for
   * the captain to answer a passkey's prompt Chrome draws there
   * (docs/task-browser.md, "A passkey in Chrome"), or goes back to the Dock.
   */
  const showWindow = async (
    state: Running,
    targetId: string,
    sessionId: string,
    shown: boolean,
  ): Promise<void> => {
    if (!shown) {
      await minimize(state, targetId);
      return;
    }
    try {
      const { windowId } = await state.pipe.send<{ windowId: number }>(
        "Browser.getWindowForTarget",
        { targetId },
      );
      await state.pipe.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await state.pipe.send("Page.bringToFront", {}, sessionId);
    } catch {
      // A page already gone has no window to show.
    }
  };

  const grantsOf = (state: Running, context: () => Context | undefined): AskGrants =>
    new AskGrants(async (permission, origin, granted) => {
      const made = context();
      await state.pipe.send("Browser.setPermission", {
        permission: { name: permission },
        setting: granted ? "granted" : "denied",
        origin,
        ...(made ? contextOf(made) : {}),
      });
    });

  const contextOfFrame = (state: Running, frameId: string): Context | undefined => {
    for (const context of state.contexts.values()) {
      for (const page of context.pages.values()) if (page.hasFrame(frameId)) return context;
    }
    return undefined;
  };

  /** A page started a download: where the core says it goes, or nowhere. */
  const downloadBegins = (state: Running, params: Record<string, unknown>): void => {
    const guid = String(params.guid);
    const context = contextOfFrame(state, String(params.frameId));
    if (!context) return;
    const target = context.open.onDownload({
      url: String(params.url ?? ""),
      name: String(params.suggestedFilename ?? "download"),
      bytes: 0,
    });
    if (!target) {
      void state.pipe
        .send("Browser.cancelDownload", { guid, ...contextOf(context) })
        .catch(() => undefined);
      return;
    }
    context.downloads.set(guid, { target, bytes: 0 });
  };

  const downloadProgress = (state: Running, params: Record<string, unknown>): void => {
    const guid = String(params.guid);
    for (const context of state.contexts.values()) {
      const download = context.downloads.get(guid);
      if (!download) continue;
      download.bytes = Number(params.receivedBytes ?? download.bytes);
      if (params.state === "inProgress") return;
      context.downloads.delete(guid);
      if (params.state === "canceled") {
        download.target.done({ state: "cancelled", bytes: download.bytes });
        return;
      }
      const written = join(context.downloadDir, guid);
      void moveFile(written, download.target.path).then(
        () => download.target.done({ state: "completed", bytes: download.bytes }),
        () => download.target.done({ state: "interrupted", bytes: download.bytes }),
      );
      return;
    }
  };

  const ensure = async (proxy?: string): Promise<Running> => {
    // The kept profile's Chrome started without the kept guard, only to
    // sign out of a site, starts again with it once nothing is open in it.
    if (options.kept && proxy && running) {
      const state = await running.catch(() => undefined);
      if (state && state.proxy !== proxy && state.contexts.size === 0 && current === state) {
        current = undefined;
        running = undefined;
        stopChrome(state);
      }
    }
    if (!running) {
      const starting = start(options.kept ? (proxy ?? NOWHERE_PROXY) : undefined);
      running = starting;
      starting.then(
        (state) => {
          if (running === starting) current = state;
        },
        () => {
          if (running === starting) running = undefined;
        },
      );
    }
    return running;
  };

  const open = async (input: HostBrowserOpen): Promise<HostBrowserPage> => {
    opening += 1;
    let state: Running | undefined;
    let context: Context | undefined;
    const opened = (async (): Promise<ChromePage> => {
      if (options.kept) {
        const running = await ensure(`${input.proxy.host}:${input.proxy.port}`);
        state = running;
        if (running.proxy !== `${input.proxy.host}:${input.proxy.port}`) {
          throw new ChromeUnavailable(
            "would-not-start",
            "the kept profile is held by another guard",
          );
        }
        await keptReady(running);
        const made: Context = {
          id: `kept-${running.contexts.size}-${Date.now()}-${Math.random()}`,
          open: input,
          pages: new Map(),
          downloads: new Map(),
          downloadDir: join(options.downloadsDir, "kept"),
          cookies: contextCookies(running.pipe, undefined),
          grants: grantsOf(running, () => undefined),
          ended: false,
        };
        context = made;
        running.contexts.set(made.id, made);
        const ready = new Promise<ChromePage>((resolve) => {
          made.ready = resolve;
        });
        running.awaitingFirst.push(made);
        const { targetId } = await running.pipe.send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
          background: true,
          windowState: "minimized",
        });
        const page = await ready;
        await minimize(running, targetId);
        return page;
      }
      const running = await ensure();
      state = running;
      const { browserContextId } = await running.pipe.send<{ browserContextId: string }>(
        "Target.createBrowserContext",
        {
          proxyServer: `${input.proxy.host}:${input.proxy.port}`,
          // Loopback too goes to the guard, which carries only what the
          // browser registered: Chrome's request pausing never sees a
          // websocket open, and loopback would otherwise skip the proxy.
          proxyBypassList: "<-loopback>",
        },
      );
      const downloadDir = join(options.downloadsDir, browserContextId);
      await mkdir(downloadDir, { recursive: true, mode: 0o700 });
      const made: Context = {
        id: browserContextId,
        open: input,
        pages: new Map(),
        downloads: new Map(),
        downloadDir,
        cookies: contextCookies(running.pipe, browserContextId),
        grants: grantsOf(running, () => made),
        ended: false,
      };
      context = made;
      running.contexts.set(browserContextId, made);
      for (const name of PERMISSIONS) {
        await running.pipe
          .send("Browser.setPermission", {
            permission: { name },
            setting: "denied",
            browserContextId,
          })
          .catch(() => undefined);
      }
      await running.pipe.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        browserContextId,
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
      const ready = new Promise<ChromePage>((resolve) => {
        made.ready = resolve;
      });
      const { targetId } = await running.pipe.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
        browserContextId,
        newWindow: true,
        background: true,
        windowState: "minimized",
      });
      const page = await ready;
      await minimize(running, targetId);
      return page;
    })();
    // The whole open is bounded: Chrome's start and then its page each get
    // the start's wait, and a page that never answers is no browser.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ChromeUnavailable("would-not-start", "its page did not answer")),
        2 * START_MS,
      );
    });
    try {
      const page = await Promise.race([opened, late]);
      page.page.engine = { kind: browser, version: (state as Running | undefined)?.version ?? "" };
      return page.page;
    } catch (error) {
      // What the open still makes after it gave up goes as soon as it is made.
      const end = (): void => {
        const ran = state as Running | undefined;
        if (context && ran) release(ran, context);
        else if (ran) stopIfIdle(ran);
      };
      end();
      void opened.then(end, end);
      if (error instanceof ChromeUnavailable) throw error;
      throw new ChromeUnavailable("would-not-start", String(error));
    } finally {
      clearTimeout(timer);
      opening -= 1;
      // An open that failed was the last thing Chrome was kept for.
      const ran = state as Running | undefined;
      if (ran) stopIfIdle(ran);
    }
  };

  const keptReady = (state: Running): Promise<void> => {
    state.keptReady ??= (async () => {
      for (const name of PERMISSIONS) {
        await state.pipe
          .send("Browser.setPermission", { permission: { name }, setting: "denied" })
          .catch(() => undefined);
      }
      const downloadPath = join(options.downloadsDir, "kept");
      await mkdir(downloadPath, { recursive: true, mode: 0o700 });
      await state.pipe.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath,
        eventsEnabled: true,
      });
    })();
    return state.keptReady;
  };

  /**
   * Clear each origin's own site data in the kept profile. Chrome answers
   * the browser's own session with an internal error, so the clearing goes
   * through a page's session: an open page's, or a blank page held at its
   * start for it and closed after.
   */
  const clearOrigins = async (state: Running, origins: readonly string[]): Promise<void> => {
    // Bounded: a page that closes while it clears never answers.
    const clear = async (sessionId: string): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chrome did not clear the site's data")),
          START_MS,
        );
      });
      try {
        for (const origin of origins) {
          await Promise.race([
            state.pipe.send(
              "Storage.clearDataForOrigin",
              { origin, storageTypes: "all" },
              sessionId,
            ),
            late,
          ]);
        }
      } finally {
        clearTimeout(timer);
      }
    };
    // Only a page of a browser still open: Chrome never answers through the
    // session of a page that is closing, and one may have let its session go.
    const open = [...state.targets.values()]
      .filter((route) => !route.context.ended)
      .at(-1)?.sessionId;
    if (
      open &&
      (await clear(open).then(
        () => true,
        () => false,
      ))
    )
      return;
    const address = `${CLEARING_PAGE}${randomUUID()}`;
    const lent = new Promise<string>((resolve) => state.clearingPages.set(address, resolve));
    let targetId: string | undefined;
    try {
      ({ targetId } = await state.pipe.send<{ targetId: string }>("Target.createTarget", {
        url: address,
        newWindow: true,
        background: true,
        windowState: "minimized",
      }));
      const sessionId = await Promise.race([
        lent,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_MS)),
      ]);
      if (!sessionId) throw new Error("Chrome lent no page to clear the site's data");
      await clear(sessionId);
    } finally {
      state.clearingPages.delete(address);
      if (targetId) {
        await state.pipe.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    }
  };

  const forget = async (
    pick: (cookies: readonly HostCookie[]) => HostCookie[],
    origins: readonly string[],
  ): Promise<void> => {
    // A profile never made holds nothing to sign out of.
    if (!options.executable() || !existsSync(options.profileDir)) return;
    opening += 1;
    let state: Running | undefined;
    try {
      state = await ensure();
      const cookies = contextCookies(state.pipe, undefined);
      await cookies.remove(pick(await cookies.all()));
      if (origins.length > 0) await clearOrigins(state, origins);
    } finally {
      opening -= 1;
      if (state) stopIfIdle(state);
    }
  };

  const forgetAll = async (): Promise<void> => {
    const state = current;
    if (state) {
      ended(state, `Infinitary removed every sign-in kept in ${name}`);
      stopChrome(state);
    }
    await Promise.all([...exiting]);
    await rm(options.profileDir, { recursive: true, force: true });
  };

  return {
    open,
    ...(options.kept ? { forget, forgetAll } : {}),
    stop: async () => {
      const state = current;
      if (state) {
        ended(state, `Infinitary stopped ${name}`);
        stopChrome(state);
      }
      await Promise.all([...exiting]);
    },
    pages: () => {
      const state = current;
      if (!state) return [];
      return [...state.targets].map(([targetId, { context }]) => {
        const page = context.pages.get(targetId);
        return {
          url: () => page?.page.url() ?? "",
          evaluate: (expression: string) =>
            page ? page.evaluate(expression) : Promise.resolve(null),
          shown: async () => {
            const { windowId } = await state.pipe.send<{ windowId: number }>(
              "Browser.getWindowForTarget",
              { targetId },
            );
            const { bounds } = await state.pipe.send<{ bounds: { windowState?: string } }>(
              "Browser.getWindowBounds",
              { windowId },
            );
            return bounds.windowState !== "minimized";
          },
          cookieNames: async () => (await context.cookies.all()).map((cookie) => cookie.name),
        };
      });
    },
  };
}

/** Move a finished download where the core said, across disks if it must. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

const SAME_SITE_IN = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;
const SAME_SITE_OUT = { strict: "Strict", lax: "Lax", no_restriction: "None" } as const;

/**
 * A Chrome context's cookies (docs/task-browser.md, "Signed-in sites"), read
 * whole, written and removed as the core asks: every page of the browser
 * shares them. A cookie for one name is written without a domain, so it
 * stays that name's alone. A cookie Chrome will not take is skipped; a
 * write that takes none fails.
 */
export function contextCookies(
  pipe: CdpPipe,
  browserContextId: string | undefined,
): HostBrowserCookies {
  return {
    all: async () => {
      const { cookies } = await pipe.send<{ cookies: CdpCookie[] }>("Storage.getCookies", {
        browserContextId,
      });
      return cookies.map(
        (cookie): HostCookie => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: !cookie.domain.startsWith("."),
          path: cookie.path || "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.session || cookie.expires < 0 ? {} : { expirationDate: cookie.expires }),
          sameSite: cookie.sameSite ? SAME_SITE_IN[cookie.sameSite] : "unspecified",
        }),
      );
    },
    set: async (cookies) => {
      let taken = 0;
      for (const cookie of cookies) {
        try {
          await pipe.send("Storage.setCookies", {
            browserContextId,
            cookies: [
              {
                name: cookie.name,
                value: cookie.value,
                ...(cookie.hostOnly
                  ? { url: cookieUrl(cookie) }
                  : { domain: cookie.domain, url: cookieUrl(cookie) }),
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
                ...(cookie.sameSite === "unspecified"
                  ? {}
                  : { sameSite: SAME_SITE_OUT[cookie.sameSite] }),
              },
            ],
          });
          taken += 1;
        } catch {
          // Chrome refused this one; the site may still take the rest.
        }
      }
      if (cookies.length > 0 && taken === 0) throw new Error("the browser took none of them");
    },
    remove: async (cookies) => {
      for (const cookie of cookies) {
        // A cookie written again as already expired is gone.
        await pipe
          .send("Storage.setCookies", {
            browserContextId,
            cookies: [
              {
                name: cookie.name,
                value: "",
                ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
                url: cookieUrl(cookie),
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                expires: 1,
              },
            ],
          })
          .catch(() => undefined);
      }
    },
  };
}
