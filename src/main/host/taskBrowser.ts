import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GUARD_SIGN_IN_HOST } from "@core/browser/connectionGuard";
import {
  FORM_RESEND,
  type HostBrowserCookies,
  type HostBrowserOpen,
  type HostBrowserPage,
  type HostBrowserProxy,
  type HostBrowserRefusal,
  type HostBrowserViewport,
  type HostCookie,
  type HostLoadOutcome,
  type HostPageEvents,
  type HostPopup,
  type HostTaskBrowser,
  type InstalledBrowser,
} from "@core/host";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { KEPT_PARTITION } from "@shared/taskBrowser";
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  clipboard,
  session as electronSession,
  net,
  type Session,
  type WebContents,
} from "electron";
import { deferCoreDisposal } from "../lifecycle";
import { type ChromeEngine, ChromeUnavailable, createChromeEngine } from "./chrome/chromeEngine";
import { findInstalledBrowser } from "./chrome/findChrome";
import { installedEngineOrder, openInEngine } from "./engineChoice";
import {
  AskGrants,
  cookieUrl,
  endAsks,
  layOut,
  type ProtocolPage,
  pageSend,
  pageStorage,
  prepareProtocolPage,
  protocolCommands,
  protocolMessage,
  protocolState,
  screencast,
} from "./pageProtocol";

/**
 * The task browser's pages (docs/task-browser.md; docs/architecture.md
 * section 4, "The task browser"): one hidden window per task browser, each
 * with its own in-memory site data, sandboxed, with no preload and so no
 * app bridge, every permission and download refused, and no other window
 * it may open but a second page the core lets in. Every request the page
 * makes asks the core's `allow` before it leaves, and every connection that
 * is not to this Mac's own loopback goes through the browser's connection
 * guard (`src/core/browser/connectionGuard.ts`), the session's one proxy,
 * which it signs in to with the guard's own secret. A certificate that does
 * not verify, a site's sign-in box and a request for a client certificate
 * are refused and told to the core; nothing ever goes to the person's own
 * browser.
 *
 * The page is driven over the browser's own protocol, attached to this one
 * page and nothing else: its accessibility tree, real mouse and keyboard
 * input at a point, and its picture. Nothing the crewmate sends reaches
 * that protocol directly; the host runs a fixed list of commands for the
 * core. A hidden window, not a view in the app's window, because only a
 * window's own page paints and takes input while nobody can see it.
 *
 * The captain watches it the same way (docs/task-browser.md, "The view"):
 * the protocol's own picture stream of the page, one picture whenever it
 * changes, which the app's window draws. The page itself never enters the
 * app's window, so nothing native covers the app's own menus.
 *
 * These windows are not the app's: `appWindows()` (../windows.ts) leaves
 * them out, so no app push, reload or focus ever reaches one.
 */

const taskWindows = new WeakSet<BrowserWindow>();

export function isTaskBrowserWindow(win: BrowserWindow): boolean {
  return taskWindows.has(win);
}

/** Each open browser's guard sign-in, by the guard's port: its session's proxy challenge. */
const guardSignIns = new Map<number, { username: string; password: string }>();
/** Where each task page's refusals go, for the app-wide sign-in event. */
const pageRefusals = new WeakMap<WebContents, (refusal: HostBrowserRefusal) => void>();
/** The last document request and whether the page answers a sent form. */
const documentRequests = new WeakMap<WebContents, { method: string; formAnswer: boolean }>();

/**
 * Track from the session's request hook, before the document can commit.
 * A popup without an opener can commit before did-create-window gives it
 * to drivePage; installing these listeners there misses its first POST.
 */
function noteDocumentRequest(contents: WebContents, method: string): void {
  const previous = documentRequests.get(contents);
  if (previous) {
    previous.method = method;
    return;
  }
  const state = { method, formAnswer: false };
  documentRequests.set(contents, state);
  contents.on("did-navigate", () => {
    // A redirect that changes POST to GET is an ordinary page again.
    state.formAnswer = state.method === "POST";
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    // A load replaced by another (-3) leaves the page where it was.
    if (isMainFrame && code !== -3) state.formAnswer = state.method === "POST";
  });
}
let signInsAnswered = false;

/** An address a page's navigation reaches over the network, where its request is judged. */
const WEB_NAVIGATION = /^https?:/i;

/**
 * The address of the document a request came from: a page's own requests to
 * a server on this computer its top-level move reached go through, and no
 * other's. The browser names the document that started a request (its
 * initiator, which no page sets and no referrer policy hides), and that
 * decides; a frame's recorded address can still read the page before a new
 * document, or nothing, while that document asks for its parts, so it
 * decides only a request the browser started with no initiator. An opaque
 * initiator ("null") names no page.
 */
function topPageOf(details: { initiatorOrigin?: string; frame?: Electron.WebFrameMain | null }): {
  page?: string;
} {
  if (details.initiatorOrigin !== undefined) {
    return details.initiatorOrigin && details.initiatorOrigin !== "null"
      ? { page: details.initiatorOrigin }
      : {};
  }
  try {
    const page = details.frame?.top?.url;
    return page ? { page } : {};
  } catch {
    // A frame that went away mid-request has no address to read.
    return {};
  }
}

/** An identity without this app's name and version: an ordinary Chrome's. */
function ordinaryUserAgent(userAgent: string): string {
  return userAgent
    .split(" ")
    .filter((part) => !/^(Electron|firstmate|infinitary)/i.test(part))
    .join(" ");
}

/**
 * Answer a task browser's session when its guard asks it to sign in, and
 * refuse a site's own sign-in box on a task page. Any other sign-in is not
 * a task browser's and is left as it was.
 */
function answerSignIns(): void {
  if (signInsAnswered) return;
  signInsAnswered = true;
  app.on("login", (event, contents, details, authInfo, callback) => {
    if (authInfo.isProxy) {
      const signIn = authInfo.host === "127.0.0.1" ? guardSignIns.get(authInfo.port) : undefined;
      if (!signIn) return;
      event.preventDefault();
      callback(signIn.username, signIn.password);
      return;
    }
    const refuse = contents ? pageRefusals.get(contents) : undefined;
    if (!refuse) return;
    event.preventDefault();
    callback();
    refuse({ kind: "sign-in-box", url: details.url });
  });
}

/** How long the session's sign-in to its guard may take before the page loads anyway. */
const SIGN_IN_MS = 5_000;

/**
 * Sign a browser's session in to its guard before its page loads. The
 * browser never answers a sign-in challenge for a page's cross-origin
 * picture, which may be its first connection off this Mac; signed in once,
 * the session sends the guard's sign-in with every connection after.
 */
function signInToGuard(ses: Session, proxy: HostBrowserProxy): Promise<void> {
  return new Promise((resolve) => {
    const request = net.request({ url: `https://${GUARD_SIGN_IN_HOST}/`, session: ses });
    const timer = setTimeout(() => request.abort(), SIGN_IN_MS);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    request.on("login", (_authInfo, callback) => callback(proxy.username, proxy.password));
    // The guard answers with no tunnel, so this ends in an error, as it should.
    request.on("response", (response) => {
      response.on("data", () => undefined);
      response.on("end", done);
      response.on("error", done);
    });
    request.on("error", done);
    request.on("abort", done);
    request.end();
  });
}

/** Without the `persist:` prefix a partition's site data lives in memory only. */
const PARTITION_PREFIX = "fm-task-browser-";
/** How long a load the page started on its own is waited for. */
const SETTLE_MS = 10_000;

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code) return code;
  return error instanceof Error ? error.message : String(error);
}

function nextLoad(contents: WebContents, bound: number): Promise<HostLoadOutcome> {
  return new Promise((resolve) => {
    let failed: string | undefined;
    const onFail = (
      _event: unknown,
      _code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) failed = description;
    };
    const finish = (): void => {
      clearTimeout(timer);
      contents.off("did-fail-load", onFail);
      contents.off("did-stop-loading", finish);
      resolve(failed ? { ok: false, code: failed } : { ok: true });
    };
    const timer = setTimeout(finish, bound);
    contents.on("did-fail-load", onFail);
    contents.on("did-stop-loading", finish);
  });
}

/**
 * A task page's window: hidden, at the page's own size, never the app's.
 * Only the core resizes it, to the room the captain's maximized view gives
 * the page (docs/task-browser.md, "The view").
 */
function windowOptions(width: number, height: number): BrowserWindowConstructorOptions {
  return {
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
  };
}

const PAGE_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  backgroundThrottling: false,
  spellcheck: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
} as const;

/**
 * Each page in the built-in engine's kept profile (`KEPT_PARTITION`), by its
 * contents' id: the browser it belongs to. Every browser opened in the
 * profile shares it; its hooks are set once and ask, for each request, the
 * browser whose page made it; a request no page of a browser made, such as a
 * service worker's, goes only where some browser in it would let it.
 */
const keptPages = new Map<number, HostBrowserOpen>();
let keptSession: { ses: Session; proxy?: string } | undefined;

function keptOpenOf(contents: WebContents | undefined | null): HostBrowserOpen | undefined {
  return contents ? keptPages.get(contents.id) : undefined;
}

/** The kept profile's session, its hooks set and its proxy the kept guard's. */
async function keptProfileSession(proxy: HostBrowserOpen["proxy"]): Promise<Session> {
  if (!keptSession) {
    const ses = electronSession.fromPartition(KEPT_PARTITION);
    refuseEveryPermission(ses);
    ses.on("will-download", (event, item, contents) => {
      const open = keptOpenOf(contents);
      const target = open?.onDownload({
        url: item.getURL(),
        name: item.getFilename(),
        bytes: Math.max(0, item.getTotalBytes()),
      });
      if (!target) {
        event.preventDefault();
        return;
      }
      item.setSavePath(target.path);
      item.once("done", (_event, state) => target.done({ state, bytes: item.getReceivedBytes() }));
    });
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      if (details.resourceType === "mainFrame" && details.webContents) {
        noteDocumentRequest(details.webContents, details.method);
      }
      const request = {
        url: details.url,
        topLevel: details.resourceType === "mainFrame",
        ...topPageOf(details),
      };
      const open = keptOpenOf(details.webContents);
      const allowed = open
        ? open.allow(request)
        : [...new Set(keptPages.values())].some((each) => each.allow(request));
      callback({ cancel: !allowed });
    });
    ses.setSpellCheckerEnabled(false);
    keptSession = { ses };
  }
  const rules = `${proxy.host}:${proxy.port}`;
  if (keptSession.proxy !== rules) {
    answerSignIns();
    guardSignIns.set(proxy.port, { username: proxy.username, password: proxy.password });
    await keptSession.ses.setProxy({ mode: "fixed_servers", proxyRules: rules });
    await signInToGuard(keptSession.ses, proxy);
    keptSession.proxy = rules;
  }
  return keptSession.ses;
}

/** What each page's browser was let use (docs/task-browser.md, "A site's asks"), by page. */
const pageGrants = new WeakMap<WebContents, AskGrants>();
/** Each session's browsers' grants: a permission check may name no page. */
const sessionGrants = new WeakMap<Session, Set<AskGrants>>();

/** Whether grants let a site use a permission: a camera and microphone together need both. */
function grantsAllow(
  grants: AskGrants,
  permission: string,
  origin: string,
  media: readonly string[],
): boolean {
  if (permission === "notifications" || permission === "clipboard-read") {
    return grants.has(permission, origin);
  }
  if (permission !== "media" || media.length === 0) return false;
  return media.every(
    (type) =>
      (type === "video" && grants.has("camera", origin)) ||
      (type === "audio" && grants.has("microphone", origin)),
  );
}

/** Whether the page's browser, or with no page any browser of the session, was let use it. */
function granted(
  ses: Session,
  contents: WebContents | null,
  permission: string,
  origin: string,
  media: readonly string[],
): boolean {
  const own = contents ? pageGrants.get(contents) : undefined;
  const each = own ? [own] : contents ? [] : [...(sessionGrants.get(ses) ?? [])];
  return each.some((grants) => grantsAllow(grants, permission, origin, media));
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Every permission and device permission refused, as a task page's always
 * are, but what the captain let a site use for now (`pageGrants`).
 */
function refuseEveryPermission(ses: Session): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      granted(
        ses,
        contents,
        permission,
        originOf(details.requestingUrl),
        "mediaTypes" in details ? (details.mediaTypes ?? []) : [],
      ),
    ),
  );
  // The check names the origin as a URL ("http://site/"), not an origin.
  ses.setPermissionCheckHandler((contents, permission, origin, details) =>
    granted(
      ses,
      contents,
      permission,
      originOf(origin),
      details.mediaType ? [details.mediaType] : [],
    ),
  );
  ses.setDevicePermissionHandler(() => false);
}

async function forgetAllInKeptProfile(): Promise<void> {
  const ses = keptSession?.ses ?? electronSession.fromPartition(KEPT_PARTITION);
  const jar = cookieJar(ses);
  await jar.remove(await jar.all());
  await ses.clearStorageData({
    storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
  });
  await ses.clearCache();
}

/**
 * The built-in engine's kept profile, signed out of sites: the cookies the
 * core picks, and each origin's own site data.
 */
async function forgetInKeptProfile(
  pick: (cookies: readonly HostCookie[]) => HostCookie[],
  origins: readonly string[],
): Promise<void> {
  const ses = keptSession?.ses ?? electronSession.fromPartition(KEPT_PARTITION);
  const jar = cookieJar(ses);
  await jar.remove(pick(await jar.all()));
  for (const origin of origins) {
    await ses.clearStorageData({
      origin,
      storages: ["localstorage", "indexdb", "cachestorage", "serviceworkers"],
    });
  }
}

async function openKeptPage(input: HostBrowserOpen): Promise<HostBrowserPage> {
  await keptProfileSession(input.proxy);
  const win = new BrowserWindow({
    ...windowOptions(input.viewport.width, input.viewport.height),
    webPreferences: { partition: KEPT_PARTITION, ...PAGE_PREFERENCES },
  });
  keptPages.set(win.webContents.id, input);
  const mine = new Set<number>([win.webContents.id]);
  let ended = false;
  // The browser goes, and nothing of the profile with it.
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const id of mine) keptPages.delete(id);
  };
  await win.webContents.loadURL("about:blank");
  try {
    return await drivePage(win, input, input, input.viewport, end, (contents) => {
      keptPages.set(contents.id, input);
      mine.add(contents.id);
    });
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    end();
    throw error;
  }
}

async function openTaskPage(input: HostBrowserOpen): Promise<HostBrowserPage> {
  if (input.kept) return openKeptPage(input);
  const { width, height } = input.viewport;
  const partition = `${PARTITION_PREFIX}${randomUUID()}`;
  const ses = electronSession.fromPartition(partition);
  refuseEveryPermission(ses);
  // A download goes where the core says, in the task's evidence folder, or
  // nowhere (docs/task-browser.md, "A download"); one still running when
  // the browser goes is cancelled.
  const downloads = new Set<Electron.DownloadItem>();
  ses.on("will-download", (event, item) => {
    const target = input.onDownload({
      url: item.getURL(),
      name: item.getFilename(),
      bytes: Math.max(0, item.getTotalBytes()),
    });
    if (!target) {
      event.preventDefault();
      return;
    }
    item.setSavePath(target.path);
    downloads.add(item);
    item.once("done", (_event, state) => {
      downloads.delete(item);
      target.done({ state, bytes: item.getReceivedBytes() });
    });
  });
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (details.resourceType === "mainFrame" && details.webContents) {
      noteDocumentRequest(details.webContents, details.method);
    }
    callback({
      cancel: !input.allow({
        url: details.url,
        topLevel: details.resourceType === "mainFrame",
        ...topPageOf(details),
      }),
    });
  });
  // Every connection off this Mac's loopback goes through the browser's own
  // guard, which connects only to a public address it checked; loopback,
  // which the browser never resolves through a name server, goes direct.
  answerSignIns();
  const { port } = input.proxy;
  guardSignIns.set(port, { username: input.proxy.username, password: input.proxy.password });
  await ses.setProxy({ mode: "fixed_servers", proxyRules: `${input.proxy.host}:${port}` });
  await signInToGuard(ses, input.proxy);
  ses.setSpellCheckerEnabled(false);

  const win = new BrowserWindow({
    ...windowOptions(width, height),
    webPreferences: { partition, ...PAGE_PREFERENCES },
  });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    guardSignIns.delete(port);
    for (const item of [...downloads]) item.cancel();
    ses.webRequest.onBeforeRequest(null);
    void ses.clearStorageData().catch(() => undefined);
    void ses.clearCache().catch(() => undefined);
    void ses.clearAuthCache().catch(() => undefined);
  };
  await win.webContents.loadURL("about:blank");
  try {
    return await drivePage(win, input, input, input.viewport, end);
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    end();
    throw error;
  }
}

/**
 * Drive one page of a task browser: its first, or a second one a page
 * opened (`end` absent). Its events go to the core; its session's policy,
 * proxy and refusals are the browser's (`open`).
 */
async function drivePage(
  win: BrowserWindow,
  events: HostPageEvents,
  open: HostBrowserOpen,
  viewport: HostBrowserViewport,
  end?: () => void,
  joined?: (contents: WebContents) => void,
  grants: AskGrants = new AskGrants(),
): Promise<HostBrowserPage> {
  taskWindows.add(win);
  const contents = win.webContents;
  pageRefusals.set(contents, open.onRefused);
  // A page another page opened is let use what its browser was.
  pageGrants.set(contents, grants);
  const inSession = sessionGrants.get(contents.session) ?? new Set<AskGrants>();
  inSession.add(grants);
  sessionGrants.set(contents.session, inSession);
  // The browser's grants leave its session with its first page.
  const leaveSession = (): void => {
    if (end) inSession.delete(grants);
  };
  // The page sees an ordinary browser, not this app's name and version.
  contents.setUserAgent(ordinaryUserAgent(contents.getUserAgent()));
  // WebRTC reaches its peers only through the proxy, so never around the guard.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  // A web address the policy refuses is refused by its request
  // (`onBeforeRequest`), so the page shows the browser's own refusal at that
  // address, as Google Chrome's does, and never stays put as if nothing was
  // asked (docs/task-browser.md, "A page on a refused address"); any other
  // scheme never reaches the network, so it is refused here.
  const refuse = (event: { preventDefault: () => void }, url: string, topLevel: boolean): void => {
    if (WEB_NAVIGATION.test(url)) return;
    if (!open.allow({ url, topLevel })) event.preventDefault();
  };
  contents.on("will-navigate", (event) => refuse(event, event.url, true));
  contents.on("will-redirect", (event) => refuse(event, event.url, true));
  contents.on("will-frame-navigate", (event) => refuse(event, event.url, event.isMainFrame));
  contents.on("certificate-error", (event, url, error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
    open.onRefused({ kind: "certificate", url, code: error });
  });
  contents.on("select-client-certificate", (event, url, _list, callback) => {
    event.preventDefault();
    // No certificate: Electron's typing asks for one, its behavior takes none.
    (callback as (certificate?: Electron.Certificate) => void)();
    open.onRefused({ kind: "client-certificate", url: url.toString() });
  });
  // A page another page opens joins the browser when the core lets it: a
  // hidden window of the same session, so its opener and sign-in carry.
  const popups: HostPopup[] = [];
  contents.setWindowOpenHandler(({ url }) => {
    const popup = events.onPopup(url);
    if (!popup) return { action: "deny" };
    popups.push(popup);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...windowOptions(popup.viewport.width, popup.viewport.height),
        webPreferences: { ...PAGE_PREFERENCES },
      },
    };
  });
  contents.on("did-create-window", (child) => {
    const popup = popups.shift();
    if (!popup) {
      child.destroy();
      return;
    }
    // A page of a browser in the kept profile is that browser's too.
    joined?.(child.webContents);
    void drivePage(child, popup.events, open, popup.viewport, undefined, joined, grants).then(
      (page) => popup.opened(page),
      () => {
        if (!child.isDestroyed()) child.destroy();
      },
    );
  });

  const protocol = contents.debugger;
  protocol.attach("1.3");
  const shared: ProtocolPage = {
    // A frame from another site is a target of its own, reached through its own session.
    sendTo: async <T = Record<string, unknown>>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ): Promise<T> => (await protocol.sendCommand(method, params, sessionId)) as T,
    events,
    onRefused: open.onRefused,
    grants,
    alive: () => !contents.isDestroyed(),
    clipboardText: () => clipboard.readText(),
  };
  const send = pageSend(shared);
  // The size it lays out at now: its own, until the core resizes it.
  const state = protocolState(shared, viewport);
  protocol.on("message", (_event, method, params: Record<string, unknown>, sessionId?: string) => {
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
      void state.frames.onEvent(method, params, sessionId || undefined).catch(() => undefined);
      return;
    }
    protocolMessage(shared, state, method, params, sessionId || undefined);
  });
  await prepareProtocolPage(shared, state);

  let lastStatus: number | undefined;
  const watchAgain = (): void => {
    if (state.watcher) screencast(send, state);
  };
  let lastNav = "";
  contents.on("did-navigate", (_event, url, status) => {
    lastStatus = status > 0 ? status : undefined;
    // A full load is a new document even at the same address, so refs from
    // before a reload are gone.
    lastNav = url;
    events.onNavigated(url);
    watchAgain();
  });
  // A same-document move (history.pushState, a site's own navigation) does
  // not load a new document, and did-navigate does not fire for it. The
  // same address twice is one move.
  // A load the browser refused or could not make shows its own error page at
  // that address; a load replaced by another (-3) leaves the page where it was.
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) events.onLoadFailed(url);
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame || url === lastNav) return;
    lastNav = url;
    events.onNavigated(url);
  });
  contents.on("did-finish-load", watchAgain);
  contents.on("render-process-gone", (_event, details) => events.onGone(details.reason));
  let closed = false;
  // A page another page opened may close itself, as a bank's check does once
  // it is answered; the first page goes with its browser.
  win.on("closed", () => {
    if (!closed && !end) events.onClosed();
    closed = true;
    endAsks(state);
    leaveSession();
  });

  return {
    cookies: cookieJar(contents.session),
    storage: pageStorage(send, true, (origin) =>
      contents.session.clearStorageData({ origin, storages: ["localstorage"] }),
    ),
    session: pageStorage(send, false, async () => undefined),
    url: () => (contents.isDestroyed() ? "" : contents.getURL()),
    title: () => (contents.isDestroyed() ? "" : contents.getTitle()),
    load: async (url) => {
      lastStatus = undefined;
      try {
        await contents.loadURL(url);
        return lastStatus === undefined ? { ok: true } : { ok: true, status: lastStatus };
      } catch (error) {
        return { ok: false, code: codeOf(error) };
      }
    },
    history: async (direction) => {
      const history = contents.navigationHistory;
      const can = direction === "back" ? history.canGoBack() : history.canGoForward();
      if (!can) return { ok: false, code: "no-history" };
      const done = nextLoad(contents, SETTLE_MS);
      if (direction === "back") history.goBack();
      else history.goForward();
      return done;
    },
    reload: async () => {
      if (documentRequests.get(contents)?.formAnswer) return { ok: false, code: FORM_RESEND };
      const done = nextLoad(contents, SETTLE_MS);
      contents.reload();
      return done;
    },
    settle: async () => {
      // A page that closed itself during the wait, as a bank's check does
      // once it is answered, has nothing left to settle.
      if (contents.isDestroyed() || !contents.isLoading()) return;
      await nextLoad(contents, SETTLE_MS);
    },
    ...protocolCommands(shared, state),
    watch: (onFrame) => {
      state.watcher = onFrame;
      screencast(send, state);
      return () => {
        if (state.watcher !== onFrame) return;
        state.watcher = undefined;
        if (!closed && protocol.isAttached()) {
          void send("Page.stopScreencast").catch(() => undefined);
        }
      };
    },
    resize: async (next) => {
      if (closed || contents.isDestroyed()) return;
      if (next.width === state.size.width && next.height === state.size.height) return;
      state.size = { width: next.width, height: next.height };
      // The hidden window and the page's own viewport take the size together,
      // and a watched page streams its pictures at it.
      if (!win.isDestroyed()) win.setContentSize(state.size.width, state.size.height);
      await layOut(send, state);
      watchAgain();
    },
    revokeAsks: () => grants.revoke(),
    close: () => {
      if (closed) return;
      closed = true;
      state.watcher = undefined;
      endAsks(state);
      leaveSession();
      try {
        if (!contents.isDestroyed() && protocol.isAttached()) protocol.detach();
      } catch {
        // A page that is already gone has no protocol left to detach.
      }
      if (!win.isDestroyed()) win.destroy();
      end?.();
    },
  };
}

/**
 * A task browser's cookies (docs/task-browser.md, "Signed-in sites"): its
 * in-memory session's own, read whole, written and removed as the core
 * asks. A cookie for one name is written without a domain, so it stays that
 * name's alone. A cookie the browser will not take is skipped; a write that
 * takes none fails.
 */
function cookieJar(ses: Session): HostBrowserCookies {
  return {
    all: async () =>
      (await ses.cookies.get({})).map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? "",
        hostOnly: cookie.hostOnly ?? false,
        path: cookie.path ?? "/",
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        ...(cookie.session || cookie.expirationDate === undefined
          ? {}
          : { expirationDate: cookie.expirationDate }),
        sameSite: cookie.sameSite,
      })),
    set: async (cookies) => {
      let taken = 0;
      for (const cookie of cookies) {
        try {
          await ses.cookies.set({
            url: cookieUrl(cookie),
            name: cookie.name,
            value: cookie.value,
            ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            ...(cookie.expirationDate === undefined
              ? {}
              : { expirationDate: cookie.expirationDate }),
            sameSite: cookie.sameSite,
          });
          taken += 1;
        } catch {
          // The browser refused this one; the site may still take the rest.
        }
      }
      if (cookies.length > 0 && taken === 0) throw new Error("the browser took none of them");
    },
    remove: async (cookies) => {
      for (const cookie of cookies) {
        await ses.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => undefined);
      }
    },
  };
}

/**
 * The desktop's task browser: a fresh page per open, in the engine this
 * computer chooses for it ("./engineChoice.ts"): the built-in engine's
 * hidden window, or Google Chrome's when the switch asks for it and Chrome
 * can open it. `chooseFiles` is the captain's own picker, over the app's
 * window; a computer that runs work with no window of the app's has none.
 */
export function createTaskBrowserHost(
  chooseFiles?: HostTaskBrowser["chooseFiles"],
): HostTaskBrowser {
  // A page a website opens loads its first document with the identity its
  // renderer and session start from: Electron's per-page override does not
  // reach it (electron/electron#45897), and the page's protocol reaches a
  // page with no opener only after that document commits. So the ordinary
  // identity is Electron's fallback, set before any page opens. The app's
  // own windows show only its own files, which do not read it.
  app.userAgentFallback = ordinaryUserAgent(app.userAgentFallback);
  const installed = installedEngineOrder(process.env).map((kind) => ({
    kind,
    empty: chromeEngine(kind),
    // A separate process routes the kept default context through its own guard.
    kept: chromeEngine(kind, { kept: true }),
  }));
  return {
    open: (input) => {
      return openInEngine(input, {
        installed: installed.map(({ kind, empty, kept }) => ({
          kind,
          open: (input.kept ? kept : empty).open,
        })),
        builtIn: openTaskPage,
        declined: (error) =>
          error instanceof ChromeUnavailable ? { reason: error.reason } : undefined,
        log: (line) => console.info(line),
      });
    },
    ...(chooseFiles ? { chooseFiles } : {}),
    kept: {
      // Each engine keeps separate sign-ins, even after the preferred engine changes.
      forget: async (pick, origins) => {
        await forgetInKeptProfile(pick, origins);
        for (const { kept } of installed) await kept.forget?.(pick, origins);
      },
      forgetAll: async () => {
        await forgetAllInKeptProfile();
        for (const kind of ["chrome", "edge"] as const) {
          const forget = installed.find((entry) => entry.kind === kind)?.kept.forgetAll;
          if (forget) await forget();
          else await rm(keptBrowserProfile(kind), { recursive: true, force: true });
        }
      },
    },
  };
}

/** An installed browser's kept profile folder under the app's data (docs/task-browser.md, "Signed-in sites"). */
function keptBrowserProfile(browser: InstalledBrowser): string {
  return join(app.getPath("userData"), `task-browser-${browser}-kept`);
}

/**
 * An installed browser, in a profile folder under the app's data,
 * ended with the app: the empty contexts' Chrome, or the kept profile's.
 */
function chromeEngine(browser: InstalledBrowser, options: { kept?: true } = {}): ChromeEngine {
  const data = app.getPath("userData");
  const engine = createChromeEngine({
    browser,
    executable: () => findInstalledBrowser(browser, hostPlatform(), process.env, homedir()),
    platform: hostPlatform(),
    profileDir: options.kept ? keptBrowserProfile(browser) : join(data, `task-browser-${browser}`),
    downloadsDir: join(
      app.getPath("temp"),
      `infinitary-task-downloads-${process.pid}-${browser}${options.kept ? "-kept" : ""}`,
    ),
    env: () => hostEnv(),
    clipboardText: () => clipboard.readText(),
    log: (line) => console.info(line),
    ...options,
  });
  // The quit waits until Chrome has let go of its profile under the app's data,
  // so nothing writes there once the app is gone.
  deferCoreDisposal(app, () => engine.stop());
  // A source build lets its journeys read Chrome's pages as they read the
  // built-in engine's through Electron (docs/task-browser.md, "Tests"); a
  // packaged app publishes nothing.
  if (!app.isPackaged) {
    const shared = globalThis as typeof globalThis & { [CHROME_ENGINES]?: Set<ChromeEngine> };
    shared[CHROME_ENGINES] ??= new Set();
    shared[CHROME_ENGINES].add(engine);
  }
  return engine;
}

/** Where a source build keeps its Chrome engines for its journeys: `globalThis[Symbol.for(...)]`. */
export const CHROME_ENGINES = Symbol.for("infinitary.taskBrowser.chromeEngines");
