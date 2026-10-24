import { randomUUID } from "node:crypto";
import { GUARD_SIGN_IN_HOST } from "@core/browser/connectionGuard";
import type { BrowserKey } from "@core/browser/keys";
import type { BrowserNode } from "@core/browser/outline";
import {
  applyMarks,
  applyScreen,
  fullPageClip,
  marksFromSnapshot,
  type PageSnapshot,
  screenFromSnapshot,
} from "@core/browser/reading";
import {
  FORM_RESEND,
  type HostBrowserBox,
  type HostBrowserCookies,
  type HostBrowserFrame,
  type HostBrowserOpen,
  type HostBrowserPage,
  type HostBrowserProxy,
  type HostBrowserRefusal,
  type HostBrowserViewport,
  type HostCookie,
  type HostLoadOutcome,
  type HostPageEvents,
  type HostPageStorage,
  type HostPopup,
  type HostTaskBrowser,
} from "@core/host";
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  session as electronSession,
  nativeImage,
  net,
  type Session,
  type WebContents,
} from "electron";
import { type ProtocolSend, wheelScroll } from "./wheelScroll";

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

/** Whether a window is a task browser page rather than one of the app's own. */
export function isTaskBrowserWindow(win: BrowserWindow): boolean {
  return taskWindows.has(win);
}

/** Each open browser's guard sign-in, by the guard's port: its session's proxy challenge. */
const guardSignIns = new Map<number, { username: string; password: string }>();
/** Where each task page's refusals go, for the app-wide sign-in event. */
const pageRefusals = new WeakMap<WebContents, (refusal: HostBrowserRefusal) => void>();
/**
 * How each task page last asked for a document of its own (`GET`, or
 * `POST` for a form it sent): read when the document commits, so the page
 * knows whether it is the answer to a form, which a reload would send again.
 */
const documentMethods = new WeakMap<WebContents, string>();
let signInsAnswered = false;

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
/** The tallest whole-page picture, so one long page cannot make an unreadable one. */
const FULL_PAGE_MAX_HEIGHT = 8_000;
/** The watched page's pictures: sharp enough to read, small enough to stream. */
const WATCH_QUALITY = 80;

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const KEYS: Record<BrowserKey, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

/** Select what a field holds, so the text typed next replaces it. */
const SELECT_ALL = `function () {
  if (typeof this.select === "function") { this.select(); return; }
  const range = document.createRange();
  range.selectNodeContents(this);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

/** Choose a list's option by label (or value), as a person's pick would announce it. */
const CHOOSE_OPTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { kind: "not-a-list" };
  const norm = (text) => String(text).replace(/\\s+/g, " ").trim().toLowerCase();
  const options = Array.from(this.options);
  const match =
    options.find((option) => norm(option.label) === norm(wanted)) ||
    options.find((option) => option.value === wanted);
  if (!match) return { kind: "no-match", options: options.map((option) => option.label.trim()) };
  match.selected = true;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { kind: "chosen" };
}`;

type RawAxValue = { value?: unknown };
type RawAxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: RawAxValue;
  name?: RawAxValue;
  value?: RawAxValue;
  properties?: { name: string; value?: RawAxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

function nodeOf(raw: RawAxNode): BrowserNode {
  const properties: Record<string, string | number | boolean> = {};
  for (const property of raw.properties ?? []) {
    const value = property.value?.value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      properties[property.name] = value;
    }
  }
  const value = raw.value?.value;
  return {
    id: raw.nodeId,
    role: typeof raw.role?.value === "string" ? raw.role.value : "",
    name: typeof raw.name?.value === "string" ? raw.name.value : "",
    ...(value === undefined || value === null ? {} : { value: String(value) }),
    ignored: raw.ignored === true,
    childIds: raw.childIds ?? [],
    ...(raw.backendDOMNodeId !== undefined ? { target: raw.backendDOMNodeId } : {}),
    properties,
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code) return code;
  return error instanceof Error ? error.message : String(error);
}

/** Resolves when the page stops loading, with how the top frame's load ended. */
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

function textOfArgs(args: { value?: unknown; description?: string }[] | undefined): string {
  return (args ?? [])
    .map((arg) =>
      typeof arg.value === "string" ? arg.value : (arg.description ?? JSON.stringify(arg.value)),
    )
    .join(" ");
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

/** A task page's preferences: sandboxed, isolated, no bridge, no Node. */
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

async function openTaskPage(input: HostBrowserOpen): Promise<HostBrowserPage> {
  const { width, height } = input.viewport;
  const partition = `${PARTITION_PREFIX}${randomUUID()}`;
  const ses = electronSession.fromPartition(partition);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (details.resourceType === "mainFrame" && details.webContents) {
      documentMethods.set(details.webContents, details.method);
    }
    callback({
      cancel: !input.allow({ url: details.url, topLevel: details.resourceType === "mainFrame" }),
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
): Promise<HostBrowserPage> {
  // The size it lays out at now: its own, until the core resizes it.
  let size: HostBrowserViewport = { width: viewport.width, height: viewport.height };
  taskWindows.add(win);
  const contents = win.webContents;
  pageRefusals.set(contents, open.onRefused);
  // The page sees an ordinary browser, not this app's name and version.
  contents.setUserAgent(ordinaryUserAgent(contents.getUserAgent()));
  // WebRTC reaches its peers only through the proxy, so never around the guard.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  const refuse = (event: { preventDefault: () => void }, url: string): void => {
    if (!open.allow({ url, topLevel: true })) event.preventDefault();
  };
  contents.on("will-navigate", (event) => refuse(event, event.url));
  contents.on("will-redirect", (event) => refuse(event, event.url));
  contents.on("will-frame-navigate", (event) => {
    if (!open.allow({ url: event.url, topLevel: event.isMainFrame })) event.preventDefault();
  });
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
    void drivePage(child, popup.events, open, popup.viewport).then(
      (page) => popup.opened(page),
      () => {
        if (!child.isDestroyed()) child.destroy();
      },
    );
  });

  const protocol = contents.debugger;
  protocol.attach("1.3");
  const send: ProtocolSend = async <T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => (await protocol.sendCommand(method, params)) as T;
  let watcher: ((frame: HostBrowserFrame) => void) | undefined;
  protocol.on("message", (_event, method, params: Record<string, unknown>) => {
    if (method === "Page.screencastFrame") {
      // Acknowledged at once, so the stream never stalls on a slow window:
      // the window keeps only the newest picture it has not drawn yet.
      void send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
      const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number };
      watcher?.({
        data: String(params.data ?? ""),
        width: Math.round(metadata?.deviceWidth ?? size.width),
        height: Math.round(metadata?.deviceHeight ?? size.height),
      });
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      const kind = String(params.type ?? "dialog");
      events.onDialog(kind, String(params.message ?? ""));
      // A page leaving is let go; every other dialog is answered no.
      void send("Page.handleJavaScriptDialog", { accept: kind === "beforeunload" }).catch(
        () => undefined,
      );
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const request = params.request as { url: string; method: string };
      events.onNetwork({
        kind: "request",
        id: String(params.requestId),
        url: request.url,
        method: request.method,
        type: String(params.type ?? "Other"),
      });
      return;
    }
    if (method === "Network.responseReceived") {
      const response = params.response as { status: number };
      events.onNetwork({ kind: "response", id: String(params.requestId), status: response.status });
      return;
    }
    if (method === "Network.loadingFailed") {
      events.onNetwork({ kind: "failed", id: String(params.requestId) });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      const text = details?.exception?.description ?? details?.text ?? "an uncaught error";
      events.onPageError(text);
      events.onConsole("error", text);
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const text = textOfArgs(params.args as { value?: unknown; description?: string }[]);
      const level =
        params.type === "error"
          ? "error"
          : params.type === "warning"
            ? "warning"
            : params.type === "debug"
              ? "debug"
              : params.type === "info"
                ? "info"
                : "log";
      events.onConsole(level, text);
      if (level === "error") events.onPageError(text);
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
      if (entry?.level === "error") {
        const text = `${entry.text ?? ""}${entry.url ? ` (${entry.url})` : ""}`;
        events.onPageError(text);
        events.onConsole("error", text);
      }
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("DOM.enable");
  // The page is laid out at its own size whatever shows it, at one pixel per point.
  const layOut = (): Promise<unknown> =>
    send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  await layOut();

  let lastStatus: number | undefined;
  // The answer to a form that was sent is never loaded again: a reload
  // would send the form again (docs/task-browser.md, "A final submission").
  // A redirect after the form is an ordinary page, and so is a failed load
  // the form never reached.
  let formAnswer = false;
  const sentForm = (): boolean => documentMethods.get(contents) === "POST";
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    // A load replaced by another (-3) leaves the page where it was.
    if (isMainFrame && code !== -3) formAnswer = sentForm();
  });
  // A picture stream asked for while a new document commits may be lost
  // with the old one, so a watched page asks again once its document is in.
  const screencast = (): void => {
    void send("Page.startScreencast", {
      format: "jpeg",
      quality: WATCH_QUALITY,
      maxWidth: size.width,
      maxHeight: size.height,
    }).catch(() => undefined);
  };
  let lastNav = "";
  contents.on("did-navigate", (_event, url, status) => {
    lastStatus = status > 0 ? status : undefined;
    formAnswer = sentForm();
    // A full load is a new document even at the same address, so refs from
    // before a reload are gone.
    lastNav = url;
    events.onNavigated(url);
    if (watcher) screencast();
  });
  // A same-document move (history.pushState, a site's own navigation) does
  // not load a new document, and did-navigate does not fire for it. The
  // same address twice is one move.
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame || url === lastNav) return;
    lastNav = url;
    events.onNavigated(url);
  });
  contents.on("did-finish-load", () => {
    if (watcher) screencast();
  });
  contents.on("render-process-gone", (_event, details) => events.onGone(details.reason));
  let closed = false;
  // A page another page opened may close itself, as a bank's check does once
  // it is answered; the first page goes with its browser.
  win.on("closed", () => {
    if (!closed && !end) events.onClosed();
    closed = true;
  });

  const objectOf = async (target: number): Promise<string | undefined> => {
    const resolved = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", {
      backendNodeId: target,
    });
    return resolved.object?.objectId;
  };

  const boxOf = async (target: number, scroll = true): Promise<HostBrowserBox | null> => {
    try {
      if (scroll) await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target });
      const { quads } = await send<{ quads?: number[][] }>("DOM.getContentQuads", {
        backendNodeId: target,
      });
      const quad = quads?.[0];
      if (!quad || quad.length < 8) return null;
      const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
      const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
      // The part of it the window shows: a click lands there, never off the page.
      const left = Math.max(0, Math.min(...xs));
      const top = Math.max(0, Math.min(...ys));
      const right = Math.min(size.width, Math.max(...xs));
      const bottom = Math.min(size.height, Math.max(...ys));
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch {
      return null;
    }
  };

  return {
    cookies: cookieJar(contents.session),
    storage: pageStorage(contents.session, send),
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
      if (formAnswer) return { ok: false, code: FORM_RESEND };
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
    nodes: async () => {
      if (contents.isDestroyed()) return [];
      const tree = await send<{ nodes?: RawAxNode[] }>("Accessibility.getFullAXTree");
      const nodes = (tree.nodes ?? []).map(nodeOf);
      try {
        const snapshot = await send<PageSnapshot>("DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includeDOMRects: false,
        });
        return applyScreen(
          applyMarks(nodes, marksFromSnapshot(snapshot)),
          screenFromSnapshot(snapshot, size),
        );
      } catch {
        return nodes;
      }
    },
    box: boxOf,
    click: async ({ x, y }) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    },
    hover: async ({ x, y }) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    },
    drag: async (source, destination) => {
      // Scroll first, then measure both without moving the viewport again.
      await boxOf(destination);
      let from = await boxOf(source, false);
      let to = await boxOf(destination, false);
      if (!from || !to) return false;
      let a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
      // Hover can close a menu and move both elements. Measure after moving
      // the pointer, before pressing, rather than dragging from an old box.
      from = await boxOf(source, false);
      to = await boxOf(destination, false);
      if (!from || !to) return false;
      a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...a,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      try {
        for (let step = 1; step <= 12; step++) {
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: a.x + ((b.x - a.x) * step) / 12,
            y: a.y + ((b.y - a.y) * step) / 12,
            button: "left",
            buttons: 1,
          });
        }
      } finally {
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...b,
          button: "left",
          clickCount: 1,
        });
      }
      return true;
    },
    focus: async (target, options) => {
      await send("DOM.focus", { backendNodeId: target });
      if (!options?.selectAll) return;
      const objectId = await objectOf(target);
      if (objectId)
        await send("Runtime.callFunctionOn", { objectId, functionDeclaration: SELECT_ALL });
    },
    insertText: async (text) => {
      await send("Input.insertText", { text });
    },
    press: async (key) => {
      const def = KEYS[key];
      const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode };
      await send("Input.dispatchKeyEvent", {
        ...base,
        type: def.text ? "keyDown" : "rawKeyDown",
        ...(def.text ? { text: def.text } : {}),
      });
      await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    },
    scroll: async (direction) => {
      if (direction === "top" || direction === "bottom") {
        const { root } = await send<{
          root: { children?: { nodeName: string; backendNodeId: number }[] };
        }>("DOM.getDocument", { depth: 1 });
        const document = root.children?.find((node) => node.nodeName === "HTML");
        if (!document) throw new Error("The page has no document to scroll.");
        const { cssContentSize } = await send<{
          cssContentSize: { width: number; height: number };
        }>("Page.getLayoutMetrics");
        await send("DOM.scrollIntoViewIfNeeded", {
          backendNodeId: document.backendNodeId,
          rect: {
            x: 0,
            y: direction === "top" ? 0 : Math.max(0, cssContentSize.height - 1),
            width: 1,
            height: 1,
          },
        });
        return;
      }
      // The wheel lands on a later frame than this call returns, later
      // still on a busy computer. Wait for that scroll before the answer
      // reads the page (wheelScroll).
      await wheelScroll(send, direction, size);
    },
    choose: async (target, option) => {
      const objectId = await objectOf(target);
      if (!objectId) return { kind: "not-a-list" };
      const result = await send<{ result?: { value?: unknown } }>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: CHOOSE_OPTION,
        arguments: [{ value: option }],
        returnByValue: true,
      });
      const value = result.result?.value as
        | { kind: "chosen" }
        | { kind: "no-match"; options: string[] }
        | { kind: "not-a-list" }
        | undefined;
      return value ?? { kind: "not-a-list" };
    },
    capture: async ({ fullPage, target }) => {
      let clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      if (target !== undefined) {
        const box = await boxOf(target);
        if (!box) return null;
        const { cssVisualViewport } = await send<{
          cssVisualViewport: { pageX: number; pageY: number };
        }>("Page.getLayoutMetrics");
        clip = {
          ...box,
          x: box.x + cssVisualViewport.pageX,
          y: box.y + cssVisualViewport.pageY,
          scale: 1,
        };
      }
      if (fullPage) {
        const metrics = await send<{ cssContentSize?: { width: number; height: number } }>(
          "Page.getLayoutMetrics",
        );
        const content = metrics.cssContentSize ?? size;
        const fitted = fullPageClip(size, content, FULL_PAGE_MAX_HEIGHT);
        clip = { ...clip, width: fitted.width, height: fitted.height };
      }
      const shot = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip,
        captureBeyondViewport: fullPage,
      });
      const png = Buffer.from(shot.data, "base64");
      const picture = nativeImage.createFromBuffer(png).getSize();
      return { png, width: picture.width, height: picture.height };
    },
    watch: (onFrame) => {
      watcher = onFrame;
      screencast();
      return () => {
        if (watcher !== onFrame) return;
        watcher = undefined;
        if (!closed && protocol.isAttached()) {
          void send("Page.stopScreencast").catch(() => undefined);
        }
      };
    },
    input: async (input) => {
      switch (input.kind) {
        case "pointer":
          await send("Input.dispatchMouseEvent", {
            type:
              input.type === "move"
                ? "mouseMoved"
                : input.type === "down"
                  ? "mousePressed"
                  : "mouseReleased",
            x: input.x,
            y: input.y,
            button: input.button,
            clickCount: input.clickCount,
            modifiers: input.modifiers,
          });
          return;
        case "wheel":
          await send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            modifiers: input.modifiers,
          });
          return;
        case "key":
          await send("Input.dispatchKeyEvent", {
            type: input.type === "up" ? "keyUp" : input.text ? "keyDown" : "rawKeyDown",
            key: input.key,
            code: input.code,
            windowsVirtualKeyCode: input.keyCode,
            modifiers: input.modifiers,
            ...(input.type === "down" && input.text
              ? { text: input.text, unmodifiedText: input.text }
              : {}),
            ...(input.type === "down" && input.command ? { commands: [input.command] } : {}),
          });
          return;
      }
    },
    resize: async (next) => {
      if (closed || contents.isDestroyed()) return;
      if (next.width === size.width && next.height === size.height) return;
      size = { width: next.width, height: next.height };
      // The hidden window and the page's own viewport take the size together,
      // and a watched page streams its pictures at it.
      if (!win.isDestroyed()) win.setContentSize(size.width, size.height);
      await layOut();
      if (watcher) screencast();
    },
    close: () => {
      if (closed) return;
      closed = true;
      watcher = undefined;
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

/** A cookie's own address: where the browser would send it, which is where it is set and removed. */
function cookieUrl(cookie: HostCookie): string {
  const name = cookie.domain.replace(/^\./, "");
  const host = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

/**
 * A task browser's cookies (docs/task-browser.md, "Saved sign-ins"): its
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
 * The storage key a page's top document keeps its own storage under: its
 * origin and a closing slash (`http://127.0.0.1:5173/`). A frame's key, a
 * partitioned one and an opaque origin's have another shape, and are never
 * a page's own.
 */
const FIRST_PARTY_KEY = /^https?:\/\/[^/^\s]+\/$/;

/**
 * A page's own local storage (docs/task-browser.md, "Saved sign-ins"),
 * over the page's protocol by its top frame's own storage key. The
 * protocol finds that storage in this page alone, by that key, so a
 * frame's storage, another origin's, or a page that moved on is never
 * read or written. A clear goes through the browser's site data, whether
 * or not a page is on the origin.
 */
function pageStorage(ses: Session, send: ProtocolSend): HostPageStorage {
  const ownKey = async (): Promise<string | undefined> => {
    const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { storageKey } = await send<{ storageKey?: string }>("Storage.getStorageKey", {
      frameId: frameTree.frame.id,
    });
    return storageKey && FIRST_PARTY_KEY.test(storageKey) ? storageKey : undefined;
  };
  return {
    read: async () => {
      const key = await ownKey().catch(() => undefined);
      if (!key) return undefined;
      const { entries } = await send<{ entries?: string[][] }>("DOMStorage.getDOMStorageItems", {
        storageId: { storageKey: key, isLocalStorage: true },
      });
      return {
        origin: key.slice(0, -1),
        items: (entries ?? []).flatMap(([name, value]) =>
          typeof name === "string" && typeof value === "string"
            ? [[name, value] as [string, string]]
            : [],
        ),
      };
    },
    write: async (storage) => {
      const key = await ownKey();
      if (!key || key !== `${storage.origin}/`) throw new Error("the page is not on that origin");
      for (const [name, value] of storage.items) {
        await send("DOMStorage.setDOMStorageItem", {
          storageId: { storageKey: key, isLocalStorage: true },
          key: name,
          value,
        });
      }
    },
    clear: async (origin) => {
      await ses.clearStorageData({ origin, storages: ["localstorage"] });
    },
  };
}

/** The desktop's task browser: a fresh hidden page per open. */
export function createTaskBrowserHost(): HostTaskBrowser {
  // A page a website opens loads its first document with the identity its
  // renderer and session start from: Electron's per-page override does not
  // reach it (electron/electron#45897), and the page's protocol reaches a
  // page with no opener only after that document commits. So the ordinary
  // identity is Electron's fallback, set before any page opens. The app's
  // own windows show only its own files, which do not read it.
  app.userAgentFallback = ordinaryUserAgent(app.userAgentFallback);
  return { open: openTaskPage };
}
