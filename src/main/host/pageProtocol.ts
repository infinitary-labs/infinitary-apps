import { randomUUID } from "node:crypto";
import type { BrowserKey } from "@core/browser/keys";
import {
  applyMarks,
  applyScreen,
  fullPageClip,
  marksFromSnapshot,
  type PageSnapshot,
  screenFromSnapshot,
} from "@core/browser/reading";
import {
  HOST_ASK_KINDS,
  type HostAskKind,
  type HostBrowserBox,
  type HostBrowserFrame,
  type HostBrowserOpen,
  type HostBrowserPage,
  type HostBrowserViewport,
  type HostCookie,
  type HostPageEvents,
  type HostPageStorage,
} from "@core/host";
import { PageFrames, type SessionSend } from "./taskBrowserFrames";
import { type ProtocolSend, wheelScroll } from "./wheelScroll";

/**
 * What a task page does over the browser's own protocol, whichever engine
 * draws it (docs/task-browser.md, "The page itself"): the built-in engine's
 * hidden window (`./taskBrowser.ts`) and Google Chrome's (`./chrome/`) send
 * the same commands for reading, input, pictures and a page's own storage,
 * and hear the same events. Nothing here knows which engine answers.
 */

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

/**
 * What a page may not open on the Mac (docs/task-browser.md, "A page that
 * asks for a file"): printing and the color picker each put a window of
 * the Mac's on the desktop, and printing holds the whole app until it is
 * answered. What needs a yes is asked of the host first (docs/task-browser.md,
 * "A site's asks"): a passkey, the camera or microphone, notifications and
 * the clipboard's words, and whether the device has a passkey of its own. A
 * yes lets the page's own call run, the permission granted first; a no ends
 * it as not allowed, as a browser with no passkey or a refused permission
 * answers, and the site offers its other ways. A request that waits quietly
 * for a passkey to be picked (`mediation: "conditional"`) is left to wait,
 * and the page is told the browser offers no such request, so a site asks
 * through its own passkey button instead.
 * This runs in every document, a frame's too, before the page's own script,
 * tells the host through a binding whose name it removes at once, and hears
 * the host's answer through a function only the host knows the name of.
 */
function pickerGuard(binding: string, answerName: string): string {
  return `(() => {
  const tell = globalThis[${JSON.stringify(binding)}];
  delete globalThis[${JSON.stringify(binding)}];
  const say = (kind) => { try { tell(kind); return true; } catch { return false; } };
  const answers = new Map();
  let asked = 0;
  Object.defineProperty(globalThis, ${JSON.stringify(answerName)}, {
    value: (n, allow) => { const answer = answers.get(n); answers.delete(n); if (answer) answer(allow === true); },
  });
  const ask = (kind) => new Promise((resolve) => {
    const n = ++asked;
    answers.set(n, (allow) => resolve({ n, allow }));
    if (!say("ask " + n + " " + kind + " " + location.origin)) { answers.delete(n); resolve({ n, allow: false }); }
  });
  const done = (n) => say("done " + n);
  const refused = () => new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError");
  const replace = (owner, name, make) => {
    const own = owner && owner[name];
    if (typeof own !== "function") return;
    Object.defineProperty(owner, name, { value: make(own), writable: true, configurable: true });
  };
  const container = globalThis.CredentialsContainer && CredentialsContainer.prototype;
  for (const name of ["get", "create"]) {
    replace(container, name, (own) => ({ [name](options) {
      if (!options || !options.publicKey || options.mediation === "conditional") {
        return own.apply(this, arguments);
      }
      const self = this, args = arguments;
      return ask("passkey").then(({ n, allow }) => {
        if (!allow) { done(n); throw refused(); }
        const call = own.apply(self, args);
        call.then(() => done(n), () => done(n));
        return call;
      });
    } })[name]);
  }
  // The quiet request is never offered: a passkey picked from Chrome's own list
  // would skip the ask, so a site uses its passkey button instead.
  replace(globalThis.PublicKeyCredential, "isConditionalMediationAvailable", () =>
    function isConditionalMediationAvailable() { return Promise.resolve(false); });
  replace(globalThis.PublicKeyCredential, "getClientCapabilities", (own) =>
    function getClientCapabilities() {
      return own.call(PublicKeyCredential).then((found) => ({ ...found, conditionalGet: false, conditionalCreate: false }));
    });
  replace(globalThis.PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", (own) =>
    function isUserVerifyingPlatformAuthenticatorAvailable() {
      return ask("platform").then(({ n, allow }) => { done(n); return allow ? own.call(PublicKeyCredential) : false; });
    });
  const asking = (kind, own, self, args) => ask(kind).then(({ n, allow }) => {
    done(n);
    if (!allow) throw refused();
    return own.apply(self, args);
  });
  replace(globalThis.MediaDevices && MediaDevices.prototype, "getUserMedia", (own) =>
    function getUserMedia(constraints) {
      const video = !!(constraints && constraints.video), audio = !!(constraints && constraints.audio);
      const kind = video && audio ? "camera-microphone" : video ? "camera" : audio ? "microphone" : "";
      if (!kind) return own.apply(this, arguments);
      return asking(kind, own, this, arguments);
    });
  for (const name of ["read", "readText"]) {
    replace(globalThis.Clipboard && Clipboard.prototype, name, (own) =>
      ({ [name]() { return asking("clipboard", own, this, arguments); } })[name]);
  }
  replace(globalThis.Notification, "requestPermission", (own) =>
    function requestPermission(callback) {
      if (Notification.permission === "granted") return own.apply(this, arguments);
      return ask("notifications").then(({ n, allow }) => {
        done(n);
        if (allow) return own.call(Notification, callback);
        if (typeof callback === "function") callback("denied");
        return "denied";
      });
    });
  Object.defineProperty(window, "print", {
    value: function print() { say("print"); },
    writable: true,
    configurable: true,
  });
  const isColor = (el) => el instanceof HTMLInputElement && el.type === "color";
  addEventListener("click", (event) => {
    if (isColor(event.composedPath()[0])) { event.preventDefault(); say("color"); }
  }, true);
  const showPicker = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function () {
    if (isColor(this)) { say("color"); return; }
    return showPicker.call(this);
  };
})();`;
}

/** The engine's own permissions a yes to each ask grants: none for a passkey, which the page's call itself asks. */
const ASK_PERMISSIONS: Record<HostAskKind, readonly AskPermission[]> = {
  passkey: [],
  platform: [],
  camera: ["camera"],
  microphone: ["microphone"],
  "camera-microphone": ["camera", "microphone"],
  notifications: ["notifications"],
  clipboard: ["clipboard-read"],
};

/** A permission an ask may grant, by its name in the browser's own protocol. */
export type AskPermission = "camera" | "microphone" | "notifications" | "clipboard-read";

/**
 * What one browser's pages were let use, each permission by the site it was
 * granted to (docs/task-browser.md, "A site's asks"). `apply` makes each
 * grant and its revoke take effect in the engine; the built-in engine's
 * permission handlers read `has` instead.
 */
export class AskGrants {
  private readonly held = new Set<string>();

  constructor(
    private readonly apply: (
      permission: AskPermission,
      origin: string,
      granted: boolean,
    ) => Promise<void> = async () => undefined,
  ) {}

  /** Whether a site already holds every permission the ask would grant. */
  granted(kind: HostAskKind, origin: string): boolean {
    const wanted = ASK_PERMISSIONS[kind];
    return wanted.length > 0 && wanted.every((permission) => this.has(permission, origin));
  }

  has(permission: AskPermission, origin: string): boolean {
    return this.held.has(`${origin} ${permission}`);
  }

  async grant(kind: HostAskKind, origin: string): Promise<void> {
    for (const permission of ASK_PERMISSIONS[kind]) {
      await this.apply(permission, origin, true);
      this.held.add(`${origin} ${permission}`);
    }
  }

  async revoke(): Promise<void> {
    const held = [...this.held];
    this.held.clear();
    for (const each of held) {
      const at = each.lastIndexOf(" ");
      await this.apply(each.slice(at + 1) as AskPermission, each.slice(0, at), false).catch(
        () => undefined,
      );
    }
  }
}

function isAskKind(kind: string): kind is HostAskKind {
  return (HOST_ASK_KINDS as readonly string[]).includes(kind);
}

/**
 * Every page draws its dropdowns' lists itself, Chromium's in-page list,
 * rather than as a Mac's own menu: that menu is a window of its own, which
 * closes at once beside a hidden page and is never in the page's pictures
 * (docs/task-browser.md, "The page itself"). The rule sits in a layer and is
 * important, so a site's own styles do not win it back.
 */
const IN_PAGE_LISTS = `(() => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("@layer infinitary-lists { select, ::picker(select) { appearance: base-select !important; } }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})();`;

function textOfArgs(args: { value?: unknown; description?: string }[] | undefined): string {
  return (args ?? [])
    .map((arg) =>
      typeof arg.value === "string" ? arg.value : (arg.description ?? JSON.stringify(arg.value)),
    )
    .join(" ");
}

export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * One task page over its protocol: its sessions, where its events and
 * refusals go, and whether it is still there. `sendTo` with no session
 * reaches the page's own document, and with one a frame's from another site
 * (`./taskBrowserFrames.ts`). `alive` is false once the page is gone, so a
 * read answers nothing.
 */
export type ProtocolPage = {
  sendTo: SessionSend;
  events: HostPageEvents;
  /** The browser's refusals: a certificate that did not verify is one. */
  onRefused: HostBrowserOpen["onRefused"];
  /** What this page's browser was let use: an ask a site already holds is answered yes at once. */
  grants: AskGrants;
  alive: () => boolean;
  /** The words a paste would type, read from the clipboard of the computer that runs the page. */
  clipboardText: () => string;
};

/**
 * What the engine's own page keeps for the shared commands: its size, its
 * watcher, the binding its guard tells the host through, and its frames
 * from other sites.
 */
export type ProtocolState = {
  size: HostBrowserViewport;
  watcher: ((frame: HostBrowserFrame) => void) | undefined;
  pickerBinding: string;
  /** The guard's function the host answers an ask through, in the asking document. */
  answerName: string;
  /** Each ask let run or still waiting, by its document's session and number. */
  asking: Map<string, { context: number; sessionId?: string; end: () => void }>;
  frames: PageFrames;
};

/** A page's own command, sent to its own document. */
export function pageSend(page: ProtocolPage): ProtocolSend {
  return (method, params) => page.sendTo(method, params);
}

/**
 * A new page's state at its own size, with no frames yet. `holdUnprepared`
 * keeps a frame that could not be prepared from running (`PageFrames`).
 */
export function protocolState(
  page: ProtocolPage,
  size: HostBrowserViewport,
  holdUnprepared = false,
): ProtocolState {
  const state: ProtocolState = {
    size: { width: size.width, height: size.height },
    watcher: undefined,
    pickerBinding: `b${randomUUID().replaceAll("-", "")}`,
    answerName: `a${randomUUID().replaceAll("-", "")}`,
    asking: new Map(),
    frames: new PageFrames(
      page.sendTo,
      (sessionId) => prepareDocument(page, state, sessionId),
      holdUnprepared,
    ),
  };
  return state;
}

/**
 * What every document of the page gets before its own script runs: the
 * guard against the Mac's pickers and passkey prompts, the in-page lists, a
 * request for a file brought to the host, the belief that it is in front,
 * and its own frames from other sites attached the same way.
 */
async function prepareDocument(
  page: ProtocolPage,
  state: ProtocolState,
  sessionId?: string,
): Promise<void> {
  const { sendTo } = page;
  if (sessionId) {
    await sendTo("Page.enable", {}, sessionId);
    await sendTo("Runtime.enable", {}, sessionId);
    await sendTo("DOM.enable", {}, sessionId);
  }
  await sendTo("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
  await sendTo("Runtime.addBinding", { name: state.pickerBinding }, sessionId);
  await sendTo(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: pickerGuard(state.pickerBinding, state.answerName), runImmediately: true },
    sessionId,
  );
  await sendTo(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: IN_PAGE_LISTS, runImmediately: true },
    sessionId,
  );
  // A page nobody looks at is never in front, so it would think it is in
  // the background: no clipboard, and a site that waits to be looked at.
  await sendTo("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  await sendTo(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  );
}

/**
 * Hear the events every engine reports the same way: a file request, a
 * picker or passkey the page asked for, a picture, a dialog, the network
 * list, an error and the console. `sessionId` names a frame from another
 * site, whose own requests and logs are not the crewmate's. Answers whether
 * the event was one of them.
 */
export function protocolMessage(
  page: ProtocolPage,
  state: ProtocolState,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): boolean {
  const { sendTo, events } = page;
  if (method === "Page.fileChooserOpened") {
    events.onFileChooser({
      target: state.frames.targetOf(Number(params.backendNodeId), sessionId),
      multiple: params.mode === "selectMultiple",
    });
    return true;
  }
  if (method === "Runtime.bindingCalled" && params.name === state.pickerBinding) {
    const payload = String(params.payload ?? "");
    if (payload === "print" || payload === "color") events.onPicker(payload);
    else if (payload.startsWith("ask ")) {
      pageAsked(page, state, payload, Number(params.executionContextId), sessionId);
    } else if (payload.startsWith("done ")) {
      endAsk(state, `${sessionId ?? ""} ${payload.slice("done ".length)}`);
    }
    return true;
  }
  // A document that is gone ends what it asked for: its call can no longer finish.
  if (method === "Runtime.executionContextDestroyed") {
    const context = Number(params.executionContextId);
    for (const [key, ask] of state.asking) {
      if (ask.context === context && ask.sessionId === sessionId) endAsk(state, key);
    }
  }
  if (method === "Runtime.executionContextsCleared") {
    for (const [key, ask] of state.asking) if (ask.sessionId === sessionId) endAsk(state, key);
  }
  if (method === "Page.javascriptDialogOpening") {
    const kind = String(params.type ?? "dialog");
    events.onDialog(kind, String(params.message ?? ""));
    // A page leaving is let go; every other dialog is answered no, in the frame that raised it.
    void sendTo(
      "Page.handleJavaScriptDialog",
      { accept: kind === "beforeunload" },
      sessionId,
    ).catch(() => undefined);
    return true;
  }
  // The rest is the page's own: a frame from another site logs nothing to the crewmate.
  if (sessionId) return false;
  if (method === "Page.screencastFrame") {
    // Acknowledged at once, so the stream never stalls on a slow window:
    // the window keeps only the newest picture it has not drawn yet.
    void sendTo("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
    const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number };
    state.watcher?.({
      data: String(params.data ?? ""),
      width: Math.round(metadata?.deviceWidth ?? state.size.width),
      height: Math.round(metadata?.deviceHeight ?? state.size.height),
    });
    return true;
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
    return true;
  }
  if (method === "Network.responseReceived") {
    const response = params.response as { status: number };
    events.onNetwork({ kind: "response", id: String(params.requestId), status: response.status });
    return true;
  }
  if (method === "Network.loadingFailed") {
    events.onNetwork({ kind: "failed", id: String(params.requestId) });
    return true;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    const text = details?.exception?.description ?? details?.text ?? "an uncaught error";
    events.onPageError(text);
    events.onConsole("error", text);
    return true;
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
    return true;
  }
  if (method === "Log.entryAdded") {
    const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
    if (entry?.level === "error") {
      const text = `${entry.text ?? ""}${entry.url ? ` (${entry.url})` : ""}`;
      events.onPageError(text);
      events.onConsole("error", text);
    }
    return true;
  }
  return false;
}

/**
 * One ask a document's guard sent (`ask <n> <kind> <origin>`): answered yes
 * at once when its site already holds what it asks for, otherwise by the
 * core, whose yes grants it before the page's call runs.
 */
function pageAsked(
  page: ProtocolPage,
  state: ProtocolState,
  payload: string,
  context: number,
  sessionId: string | undefined,
): void {
  const [, n = "", kind = "", origin = ""] = payload.split(" ");
  const number = Number(n);
  if (!Number.isSafeInteger(number)) return;
  const key = `${sessionId ?? ""} ${number}`;
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  state.asking.set(key, { context, ...(sessionId ? { sessionId } : {}), end });
  const answer = (allow: boolean): void => {
    if (!state.asking.has(key) || !page.alive()) return;
    void page
      .sendTo(
        "Runtime.evaluate",
        {
          expression: `globalThis[${JSON.stringify(state.answerName)}](${number}, ${allow})`,
          contextId: context,
        },
        sessionId,
      )
      .catch(() => undefined);
  };
  if (!isAskKind(kind)) {
    answer(false);
    return;
  }
  if (page.grants.granted(kind, origin)) {
    answer(true);
    return;
  }
  void page.events
    .onAsk({ kind, url: origin, ended })
    .then(async (allow) => {
      if (allow) await page.grants.grant(kind, origin);
      answer(allow);
    })
    .catch(() => answer(false));
}

/** An ask's call finished, or its document is gone. */
function endAsk(state: ProtocolState, key: string): void {
  const ask = state.asking.get(key);
  if (!ask) return;
  state.asking.delete(key);
  ask.end();
}

/** The page is gone: every ask it still held ends. */
export function endAsks(state: ProtocolState): void {
  for (const key of [...state.asking.keys()]) endAsk(state, key);
}

/**
 * Ready a page's protocol: the domains its events come from, what every
 * document of it gets (`prepareDocument`), and its size.
 */
export async function prepareProtocolPage(page: ProtocolPage, state: ProtocolState): Promise<void> {
  const send = pageSend(page);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("DOM.enable");
  // A page's request for a file comes here rather than to a picker of the
  // Mac's, which would attach to the page's window and put it on the
  // desktop with no way to close it (docs/task-browser.md, "A page that asks
  // for a file"); printing and the color picker never open at all. Each
  // frame from another site is prepared the same way as it starts.
  await prepareDocument(page, state);
  await layOut(send, state);
}

/** The page is laid out at its own size whatever shows it, at one pixel per point. */
export function layOut(send: ProtocolSend, state: ProtocolState): Promise<unknown> {
  return send("Emulation.setDeviceMetricsOverride", {
    width: state.size.width,
    height: state.size.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

/**
 * Ask for the page's picture stream. A stream asked for while a new
 * document commits may be lost with the old one, so a watched page asks
 * again once its document is in.
 */
export function screencast(send: ProtocolSend, state: ProtocolState): void {
  void send("Page.startScreencast", {
    format: "jpeg",
    quality: WATCH_QUALITY,
    maxWidth: state.size.width,
    maxHeight: state.size.height,
  }).catch(() => undefined);
}

/** The commands a task page answers the same way on every engine. */
export type ProtocolCommands = Pick<
  HostBrowserPage,
  | "nodes"
  | "box"
  | "setFiles"
  | "click"
  | "hover"
  | "drag"
  | "focus"
  | "insertText"
  | "press"
  | "scroll"
  | "choose"
  | "capture"
  | "input"
>;

export function protocolCommands(page: ProtocolPage, state: ProtocolState): ProtocolCommands {
  const { sendTo } = page;
  const send = pageSend(page);
  const { frames } = state;

  /** The session and the browser's own number for the element a core number names. */
  const placed = (target: number): { sessionId: string | undefined; node: number } => {
    const at = frames.placeOf(target);
    if (!at) throw new Error("That element's frame is gone.");
    return { sessionId: at.sessionId, node: at.node };
  };

  const objectOf = async (target: number): Promise<string | undefined> => {
    const { sessionId, node } = placed(target);
    const resolved = await sendTo<{ object?: { objectId?: string } }>(
      "DOM.resolveNode",
      { backendNodeId: node },
      sessionId,
    );
    return resolved.object?.objectId;
  };

  const boxOf = async (target: number, scroll = true): Promise<HostBrowserBox | null> => {
    try {
      const at = frames.placeOf(target);
      if (!at) return null;
      // A frame from another site measures in its own viewport: moved by
      // where it sits on the page, and cut to the part of it the page shows.
      const frame = at.chain.length > 0 ? await frames.offset(at.chain, scroll) : undefined;
      if (frame === null) return null;
      if (scroll) {
        await sendTo("DOM.scrollIntoViewIfNeeded", { backendNodeId: at.node }, at.sessionId);
      }
      const { quads } = await sendTo<{ quads?: number[][] }>(
        "DOM.getContentQuads",
        { backendNodeId: at.node },
        at.sessionId,
      );
      const quad = quads?.[0];
      if (!quad || quad.length < 8) return null;
      const dx = frame?.x ?? 0;
      const dy = frame?.y ?? 0;
      const xs = [quad[0], quad[2], quad[4], quad[6]].map((x) => (x ?? 0) + dx);
      const ys = [quad[1], quad[3], quad[5], quad[7]].map((y) => (y ?? 0) + dy);
      const { size } = state;
      const clip = frame?.clip ?? { x: 0, y: 0, width: size.width, height: size.height };
      // The part of it the window shows: a click lands there, never off the page.
      const left = Math.max(0, clip.x, Math.min(...xs));
      const top = Math.max(0, clip.y, Math.min(...ys));
      const right = Math.min(size.width, clip.x + clip.width, Math.max(...xs));
      const bottom = Math.min(size.height, clip.y + clip.height, Math.max(...ys));
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch {
      return null;
    }
  };

  return {
    nodes: async () => {
      if (!page.alive()) return [];
      // The page's own document and each frame's, beneath its frame's node;
      // only the page's own elements are placed on its window, and a
      // frame's read as where their frame is.
      return frames.nodes(async (nodes, sessionId) => {
        try {
          const snapshot = await sendTo<PageSnapshot>(
            "DOMSnapshot.captureSnapshot",
            { computedStyles: [], includeDOMRects: false },
            sessionId,
          );
          const marked = applyMarks(nodes, marksFromSnapshot(snapshot));
          return sessionId ? marked : applyScreen(marked, screenFromSnapshot(snapshot, state.size));
        } catch {
          return nodes;
        }
      });
    },
    box: boxOf,
    setFiles: async (target, paths) => {
      const { sessionId, node } = placed(target);
      await sendTo("DOM.setFileInputFiles", { backendNodeId: node, files: [...paths] }, sessionId);
    },
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
      // Typing then goes to the page's own session, which sends it to the focused frame.
      const { sessionId, node } = placed(target);
      await sendTo("DOM.focus", { backendNodeId: node }, sessionId);
      if (!options?.selectAll) return;
      const objectId = await objectOf(target);
      if (objectId) {
        await sendTo(
          "Runtime.callFunctionOn",
          { objectId, functionDeclaration: SELECT_ALL },
          sessionId,
        );
      }
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
      await wheelScroll(send, direction, state.size);
    },
    choose: async (target, option) => {
      const objectId = await objectOf(target);
      if (!objectId) return { kind: "not-a-list" };
      const result = await sendTo<{ result?: { value?: unknown } }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: CHOOSE_OPTION,
          arguments: [{ value: option }],
          returnByValue: true,
        },
        placed(target).sessionId,
      );
      const value = result.result?.value as
        | { kind: "chosen" }
        | { kind: "no-match"; options: string[] }
        | { kind: "not-a-list" }
        | undefined;
      return value ?? { kind: "not-a-list" };
    },
    capture: async ({ fullPage, target }) => {
      const size = state.size;
      // A clip is in document coordinates, so the visible page starts where
      // the page is scrolled to, never at the document's top: a clip at
      // 0,0 of a scrolled page photographs the rows above the view as blank
      // (INF-2375). A whole page starts at the top.
      let clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      if (target !== undefined || !fullPage) {
        const box = target === undefined ? { x: 0, y: 0, ...size } : await boxOf(target);
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
      return { png, ...pngSize(png) };
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
        case "key": {
          // A paste from a computer whose clipboard holds other words types
          // those words; the page's own paste keeps what only it can read,
          // such as a picture or formatting (docs/task-browser.md, "Paste").
          const typed =
            input.type === "down" &&
            input.command === "paste" &&
            input.clipboard &&
            input.clipboard !== page.clipboardText()
              ? input.clipboard
              : undefined;
          await send("Input.dispatchKeyEvent", {
            type: input.type === "up" ? "keyUp" : input.text ? "keyDown" : "rawKeyDown",
            key: input.key,
            code: input.code,
            windowsVirtualKeyCode: input.keyCode,
            modifiers: input.modifiers,
            ...(input.type === "down" && input.text
              ? { text: input.text, unmodifiedText: input.text }
              : {}),
            ...(input.type === "down" && input.command && !typed
              ? { commands: [input.command] }
              : {}),
          });
          if (typed) await send("Input.insertText", { text: typed });
          return;
        }
      }
    },
  };
}

/** A cookie's own address: where the browser would send it, which is where it is set and removed. */
export function cookieUrl(cookie: HostCookie): string {
  const name = cookie.domain.replace(/^\./, "");
  const host = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

/**
 * The storage key a page's top document keeps its own storage under: its
 * origin and a closing slash (`http://127.0.0.1:5173/`). A frame's key, a
 * partitioned one and an opaque origin's have another shape, and are never
 * a page's own.
 */
const FIRST_PARTY_KEY = /^https?:\/\/[^/^\s]+\/$/;

/**
 * A page's own local or session storage (docs/task-browser.md, "Saved
 * sign-ins"), over the page's protocol by its top frame's own storage key.
 * The protocol finds that storage in this page alone, by that key, so a
 * frame's storage, another origin's, or a page that moved on is never
 * read or written. A local clear goes through the browser's site data
 * (`clearLocal`), whether or not a page is on the origin; that does not
 * reach session storage, which each page keeps for itself, so a session
 * clear empties this page's own when it is on the origin.
 */
export function pageStorage(
  send: ProtocolSend,
  isLocalStorage: boolean,
  clearLocal: (origin: string) => Promise<void>,
): HostPageStorage {
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
        storageId: { storageKey: key, isLocalStorage },
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
          storageId: { storageKey: key, isLocalStorage },
          key: name,
          value,
        });
      }
    },
    clear: async (origin) => {
      if (isLocalStorage) {
        await clearLocal(origin);
        return;
      }
      const key = await ownKey().catch(() => undefined);
      if (key !== `${origin}/`) return;
      await send("DOMStorage.clear", { storageId: { storageKey: key, isLocalStorage } });
    },
  };
}
