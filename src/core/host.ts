import type { ResourceMemory } from "@shared/resources";
import type { TaskBrowserInput } from "@shared/taskBrowser";
import type { BuildFlavor } from "@shared/userDataFolders";
import type { VoiceDownloadProgress } from "@shared/voice";
import type { BrowserKey } from "./browser/keys";
import type { BrowserNode } from "./browser/outline";
import type { MediaProbe, TypefaceProbe } from "./pi/cardImages";
import type { MacUpdateDriver } from "./update/macUpdates";
/**
 * The host seam (daemon study D0, data/fm3000-daemon-process-study-s1
 * sections 1.6 and 4.5).
 *
 * Everything the application core needs FROM the desktop shell is named
 * here, once. The core reaches the outside world through plain Node
 * everywhere else - files, sqlite, child processes, http - so this
 * interface is the complete list of effects that are Electron's today and
 * would be a different host's tomorrow: the browser, Notification Center,
 * the login item, the dock, build identity, the userData root, the
 * host Keychain read, and a task's own browser pages. Core code depends on this type; only the shell
 * implements it (src/main/host/electronHost.ts).
 *
 * Deliberately effects, not policy: `openExternal` opens whatever it is
 * handed, and the allowlist that decides what may be opened stays with the
 * caller (security/openExternal.ts), so a host swap cannot quietly widen or
 * narrow what the app is willing to launch.
 */

/** Build and location facts the core reads once at startup. */
export type HostAppInfo = {
  /** The shipped app version, reported over the protocol. */
  readonly version: string;
  /** `process.platform` of the host process. */
  readonly platform: string;
  /** False for dev and e2e runs; gates dev-only affordances. */
  readonly packaged: boolean;
  /** Root the core stores everything under (see paths.ts). */
  readonly userDataDir: string;
  /** The app bundle root, for resolving the packaged self-source tree. */
  readonly appDir: string;
  /** The packaged resources root the self-source bundle sits under. */
  readonly resourcesDir: string;
  /**
   * The build's flavor (src/shared/userDataFolders.ts), which names the data
   * folder its copy keeps on a Mac it adds; absent, a packaged build is the
   * release and every other run the development flavor.
   */
  readonly flavor?: BuildFlavor;
};

/** Native notification display. The core decides WHEN; the host decides HOW. */
export type HostNotifications = {
  /** False when the host cannot (or must not) post notifications at all. */
  supported: () => boolean;
  /** True while a host window has focus - focused means stay quiet. */
  focused: () => boolean;
  show: (notification: { title: string; body: string }) => void;
};

/** Login item and dock: presence the shell owns and the core only toggles. */
export type HostPresence = {
  getStartAtLogin: () => boolean;
  setStartAtLogin: (enabled: boolean) => void;
  setShowInDock: (visible: boolean) => void;
};

/**
 * A generic-password lookup through the host's own capability. Darwin runs
 * metadata, access rules, value reads and unlocks in disposable processes.
 * The core never shells out to `/usr/bin/security`; the host prefers it only
 * when the exact item already permits it. Explicit native fallback grants
 * belong to the utility executable, not the app's main process.
 * INF-2308/INF-2321 amend CD-5=B's in-process-first order, not this seam.
 *
 * Effects only: the host reports what the framework returned. Classification
 * (locked / absent / no-interactive-session) stays in the core.
 */
export type HostKeychainQuery = {
  readonly service: string;
  /**
   * Omitted: any account - the first item of this exact service the store
   * finds. Never a broader match than the service itself.
   */
  readonly account?: string;
  /**
   * When true, the host may raise the one-time grant dialog. Sign-in and an
   * explicit Retry set this; background ticks omit it so a missing grant
   * cannot surprise the captain mid-refresh.
   */
  readonly interactive?: boolean;
};

export type HostKeychainOutcome =
  | { kind: "value"; value: string }
  /**
   * `locked` is whether the store holding the item is locked right now, when
   * the host could tell. Presence answers on a locked store; the VALUE read
   * does not. `account` is the item's own account attribute, when the host
   * could read it: what a later read names to reach this same item.
   */
  | { kind: "found"; modifiedAt?: string; locked?: boolean; account?: string }
  | { kind: "absent" }
  | { kind: "failed"; code?: number; message: string };

export type HostKeychainUnlockOutcome =
  | { kind: "unlocked" }
  | { kind: "failed"; code?: number; message: string };

export type HostKeychain = {
  /** Attribute probe: never reads the secret, so it never raises the grant dialog. */
  findGenericPassword: (query: HostKeychainQuery) => Promise<HostKeychainOutcome>;
  /** Secret read. May raise the grant dialog when `interactive` is true. */
  readGenericPassword: (query: HostKeychainQuery) => Promise<HostKeychainOutcome>;
  /**
   * Ask macOS to unlock the store holding this item, with its own password
   * dialog. Only for an `interactive` query - a background caller is refused
   * without a dialog. A separate effect from the VALUE read because macOS
   * decides, once per process, whether that process may ever show the unlock
   * dialog, at its first touch of the store; a host that cannot offer it
   * again later leaves this out.
   */
  unlockKeychain?: (query: HostKeychainQuery) => Promise<HostKeychainUnlockOutcome>;
};

/** A host with no Keychain: Linux, tests, or a shell that cannot reach one. */
export const absentKeychain: HostKeychain = {
  findGenericPassword: async () => ({ kind: "absent" }),
  readGenericPassword: async () => ({ kind: "absent" }),
};

/**
 * A picture of one docked side panel as the captain sees it (talk-to-
 * personalize Step 4, `capture_panel`): the host finds `[data-side-panel]`
 * with that id and photographs a hidden copy in the asked-for token theme.
 * The live window's theme is not changed. Null when no such panel is
 * docked. An effect, not a policy: what to capture and when is the core's.
 */
export type HostPanelCapture = {
  capturePanel: (input: {
    panelId: string;
    theme: "dark" | "light";
  }) => Promise<{ png: Buffer; width: number; height: number } | null>;
};

/**
 * How a load the host was asked for ended: the server's status when the
 * page came, the browser's own error code when it did not, or
 * `FORM_RESEND` when it would have sent a form again and so never started.
 */
export type HostLoadOutcome = { ok: true; status?: number } | { ok: false; code: string };

/**
 * A load the host refused because it would send a form again
 * (docs/task-browser.md, "A final submission"): a reload of a page that is
 * the answer to a form that was sent. The browser never sends a form twice.
 */
export const FORM_RESEND = "form-resend";

/** An element's place on the page, in the page's own viewport pixels. */
export type HostBrowserBox = { x: number; y: number; width: number; height: number };

export type HostConsoleLevel = "log" | "debug" | "info" | "warning" | "error";
/** Only diagnostic metadata crosses the host seam, never payloads or headers. */
export type HostBrowserNetwork =
  | { kind: "request"; id: string; url: string; method: string; type: string }
  | { kind: "response"; id: string; status: number }
  | { kind: "failed"; id: string };

/**
 * One page's own doings, which the core reports to the crewmate
 * (docs/task-browser.md, "What a crewmate reads"): the first page's, and
 * each second page's that a page opened.
 */
export type HostPageEvents = {
  /** The top frame committed a new document (a link, a redirect, a script). */
  onNavigated: (url: string) => void;
  /** The page raised a dialog; the host dismissed it. */
  onDialog: (kind: string, message: string) => void;
  /**
   * The page asked for a file (docs/task-browser.md, "A page that asks for
   * a file"): the host took the request, so no picker of the Mac's opens on
   * the hidden page, and `target` is the file field to give files with
   * `setFiles`.
   */
  onFileChooser: (chooser: HostFileChooser) => void;
  /** The page asked to print or opened a color picker; the host showed neither. */
  onPicker: (kind: HostPickerKind) => void;
  /**
   * The page asked to open another window at `url`: the new page's events
   * to let it open as another page of this browser, in the same site data,
   * or nothing to refuse it.
   */
  onPopup: (url: string) => HostPopup | undefined;
  /** The page logged an error or threw one. */
  onPageError: (text: string) => void;
  onConsole: (level: HostConsoleLevel, text: string) => void;
  onNetwork: (event: HostBrowserNetwork) => void;
  /** The page is gone on its own (its renderer crashed or was killed). */
  onGone: (reason: string) => void;
  /** A page another page opened closed itself; the first page never closes on its own. */
  onClosed: () => void;
};

/** A page's request for a file: its file field, and whether it takes more than one. */
export type HostFileChooser = { target: number; multiple: boolean };

/** A picker of the Mac's a page asked for and the host never shows. */
export type HostPickerKind = "print" | "color";

/**
 * A page the core let another page open: its events, the size it lays out
 * at (its opener's), and its handle once it exists.
 */
export type HostPopup = {
  events: HostPageEvents;
  viewport: HostBrowserViewport;
  opened: (page: HostBrowserPage) => void;
};

/** The size a page lays out at, in its own pixels at one per point. */
export type HostBrowserViewport = { width: number; height: number };

/**
 * Something a page asked of the browser that it refused on its own and
 * the core tells the crewmate: a certificate that did not verify, a site's
 * sign-in box (HTTP authentication), or a request for a client
 * certificate. None of them is ever answered, and none goes to the
 * person's own browser.
 */
export type HostBrowserRefusal =
  | { kind: "certificate"; url: string; code: string }
  | { kind: "sign-in-box"; url: string }
  | { kind: "client-certificate"; url: string };

/**
 * Where a task browser's session sends every connection that is not to
 * this Mac's own loopback: its connection guard, and the sign-in the
 * session answers it with (`src/core/browser/connectionGuard.ts`).
 */
export type HostBrowserProxy = { host: string; port: number; username: string; password: string };

/**
 * What the core asks of a browser it opens (docs/task-browser.md). Policy
 * is the core's: `allow` decides every request its pages make before it
 * leaves, top level or not, and the host refuses whatever it says no to;
 * every connection to the internet goes through `proxy`. The events are
 * the first page's own doings the core reports to the crewmate.
 */
export type HostBrowserOpen = HostPageEvents & {
  /**
   * The size the first page lays out at: the check's own, or the room the
   * captain's maximized view gives it (docs/task-browser.md, "The view").
   */
  viewport: HostBrowserViewport;
  allow: (request: { url: string; topLevel: boolean }) => boolean;
  proxy: HostBrowserProxy;
  onRefused: (refusal: HostBrowserRefusal) => void;
  /**
   * One of the browser's pages started a download (docs/task-browser.md,
   * "A download"): where the host saves it, or nothing to refuse it. The
   * host writes the file there and tells `done` once how it ended; a
   * download still running when the browser goes is cancelled.
   */
  onDownload: (offer: HostDownloadOffer) => HostDownloadTarget | undefined;
};

/**
 * A download a page started: the address it came from, the file name the
 * site suggested, and its size when the site said it (0 when unknown).
 */
export type HostDownloadOffer = { url: string; name: string; bytes: number };

/** Where the core has the host save a download, and who hears how it ended. */
export type HostDownloadTarget = {
  path: string;
  done: (outcome: HostDownloadOutcome) => void;
};

/** How a download ended, and the bytes the host had written by then. */
export type HostDownloadOutcome = {
  state: "completed" | "cancelled" | "interrupted";
  bytes: number;
};

/**
 * One task browser page, made by the host (docs/task-browser.md). Effects
 * only: it loads what it is told, reads its accessibility tree, sends real
 * input at a point, and photographs itself. It has its own empty site data,
 * no app bridge, and every permission refused; `close` destroys it and that
 * data.
 */
export type HostBrowserPage = {
  url: () => string;
  title: () => string;
  load: (url: string) => Promise<HostLoadOutcome>;
  /**
   * Back or forward in the page's own history; `no-history` when there is
   * nowhere to go, and the browser's `ERR_CACHE_MISS` when the page there
   * answered a form, which going to it again would send.
   */
  history: (direction: "back" | "forward") => Promise<HostLoadOutcome>;
  /** Load the page again; `FORM_RESEND`, without loading, when it answers a form that was sent. */
  reload: () => Promise<HostLoadOutcome>;
  /** Wait, bounded, for a load the page started on its own to finish. */
  settle: () => Promise<void>;
  nodes: () => Promise<BrowserNode[]>;
  /** Scroll an element into view and answer its box; null when it has none. */
  box: (target: number) => Promise<HostBrowserBox | null>;
  /** Give a file field these files, as a person's pick in a picker would. */
  setFiles: (target: number, paths: readonly string[]) => Promise<void>;
  /** A real left click at a point of the viewport. */
  click: (point: { x: number; y: number }) => Promise<void>;
  /** Move the pointer onto a visible point without clicking. */
  hover: (point: { x: number; y: number }) => Promise<void>;
  /** Drag between elements sharing the viewport; false when either is absent. */
  drag: (source: number, destination: number) => Promise<boolean>;
  /** Focus an element; `selectAll` selects what it holds, so typing replaces it. */
  focus: (target: number, options?: { selectAll?: boolean }) => Promise<void>;
  /** Text typed into whatever has focus, as a person's typing would arrive. */
  insertText: (text: string) => Promise<void>;
  press: (key: BrowserKey) => Promise<void>;
  scroll: (direction: "up" | "down" | "top" | "bottom") => Promise<void>;
  /**
   * Choose a list's option by its label or value: `chosen`, the option
   * labels when none matched, or `not-a-list` for an element that is not one.
   */
  choose: (
    target: number,
    option: string,
  ) => Promise<
    { kind: "chosen" } | { kind: "no-match"; options: string[] } | { kind: "not-a-list" }
  >;
  capture: (options: {
    fullPage: boolean;
    /** Photograph only this element; null when it has no visible box. */
    target?: number;
  }) => Promise<{ png: Uint8Array; width: number; height: number } | null>;
  /**
   * Pictures of the page while the captain watches it: one now, then one
   * each time it changes, until the answered stop is called. Watching sends
   * the page nothing.
   */
  watch: (onFrame: (frame: HostBrowserFrame) => void) => () => void;
  /**
   * The captain's own input while he has control (docs/task-browser.md,
   * "Taking control"): a pointer, a wheel or a key, sent to the page as it
   * came. The core decides whether it may; the host keeps none.
   */
  input: (input: HostBrowserInput) => Promise<void>;
  /**
   * Lay the page out at another size: its window, its viewport, every point
   * and picture from now on, and the pictures a watcher gets. The core
   * decides the size (docs/task-browser.md, "The view").
   */
  resize: (viewport: HostBrowserViewport) => Promise<void>;
  /** The browser's cookies, the same whichever of its pages answers. */
  cookies: HostBrowserCookies;
  /** The page's own local storage, read and written through this page alone. */
  storage: HostPageStorage;
  /**
   * The page's own session storage, read and written through this page
   * alone: no other page, even of the same browser, sees it. Its `clear`
   * empties the origin's session storage in this page only, when its top
   * document is on that origin.
   */
  session: HostPageStorage;
  /** The first page's close ends the browser: every page, its site data and its sign-in to the guard. */
  close: () => void;
};

/**
 * One cookie of a task browser's site data, as the browser holds it: what
 * a saved website sign-in is made of (docs/task-browser.md, "Saved
 * sign-ins"). `domain` is the browser's own (a leading dot for a cookie its
 * site shares with every name under it); `hostOnly` is a cookie for that
 * one name. A session cookie has no `expirationDate`.
 */
export type HostCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
};

/**
 * A task browser's cookies, which its pages share: read whole, written,
 * and removed. The core decides which belong to a site; the host keeps none.
 */
export type HostBrowserCookies = {
  all: () => Promise<HostCookie[]>;
  set: (cookies: readonly HostCookie[]) => Promise<void>;
  remove: (cookies: readonly HostCookie[]) => Promise<void>;
};

/**
 * One origin's local or session storage, as a page keeps it (`http://127.0.0.1:5173`,
 * its keys and values): what a saved website sign-in keeps beside its
 * cookies for a site that keeps its sign-in there (docs/task-browser.md,
 * "Saved sign-ins").
 */
export type HostOriginStorage = { origin: string; items: [string, string][] };

/**
 * A page's local storage: only ever its top document's own, first-party
 * storage, never a frame's or another origin's, so a page is never given
 * another site's storage. `read` answers that origin and everything it
 * holds, or nothing when the page shows no web origin of its own (a blank
 * page); `write` sets items in it only while the page's top document is
 * on exactly that origin, and throws otherwise; `clear` empties an
 * origin's storage in the whole browser, a page on it or not. The core
 * decides which site an origin belongs to; the host keeps none.
 */
export type HostPageStorage = {
  read: () => Promise<HostOriginStorage | undefined>;
  write: (storage: HostOriginStorage) => Promise<void>;
  clear: (origin: string) => Promise<void>;
};

/** The captain's input as the host sends it to a page: the shared shape, less navigation and page picks. */
export type HostBrowserInput = Exclude<TaskBrowserInput, { kind: "go" } | { kind: "page" }>;

/** One picture of a watched page: a JPEG as base64, at the page's own size. */
export type HostBrowserFrame = { data: string; width: number; height: number };

/** The host's task browser: absent on a host with no browser engine. */
export type HostTaskBrowser = {
  open: (input: HostBrowserOpen) => Promise<HostBrowserPage>;
  /**
   * The captain's own pick of files for a page they hold, in the app's own
   * picker over the app's window: the files' paths, or none when they
   * cancelled. Absent on a computer with no window of the app's, which
   * runs work for another Mac.
   */
  chooseFiles?: (options: { multiple: boolean }) => Promise<string[]>;
};

export type HostCapabilities = {
  readonly app: HostAppInfo;
  /** Opens an already-vetted url in the user's default browser. */
  openExternal: (url: string) => Promise<void>;
  /**
   * Quits and starts the app again once an update installed itself
   * (docs/alpha.md "Updates on Linux"), from `execPath` when the program
   * itself was replaced, as an AppImage is. Absent on a host that cannot.
   */
  relaunch?: (execPath?: string) => void;
  /** Signed Mac update effects; absent outside an installed release. */
  macUpdates?: MacUpdateDriver;
  readonly notifications: HostNotifications;
  readonly presence: HostPresence;
  /** Desktop-served voice model; absent on hosts without voice capture. */
  readonly voice?: {
    modelReady: () => Promise<boolean>;
    ensureModel: (progress: (value: VoiceDownloadProgress) => void) => Promise<void>;
  };
  /**
   * Generic-password Keychain access in the host's own session. Darwin
   * Electron implements this with disposable Keychain processes; every other host
   * returns `absent`.
   */
  readonly keychain: HostKeychain;
  /** A screenshot of a docked panel; absent on a host with no window. */
  readonly capture?: HostPanelCapture;
  /**
   * The isolated decoder a card's demo recording is played through before
   * the card goes up (docs/card-authoring.md "Demo recordings"); absent on a
   * host that cannot play one, where a card naming a recording is refused.
   */
  readonly mediaProbe?: MediaProbe;
  /**
   * The isolated font loader a preview's project font is loaded through
   * before the card goes up (docs/card-authoring.md "Fonts by reference");
   * absent on a host that cannot load one, where a card naming a font file
   * is refused.
   */
  readonly typefaceProbe?: TypefaceProbe;
  /** Physical memory facts in bytes; absent or unreadable is unknown, never zero. A Mac read awaits the system. */
  readonly resourceMemory?: () => Promise<ResourceMemory | null>;
  /**
   * This process's physical footprint in bytes, compressed and swapped memory
   * included (docs/freeze-recorder.md, "The memory reading"); absent or null
   * is unknown, never zero.
   */
  readonly processFootprint?: () => Promise<number | null>;
  /**
   * Each task's own browser page (docs/task-browser.md). Absent, crewmates
   * have no browser tools.
   */
  readonly browser?: HostTaskBrowser;
  /**
   * Starts the query process behind the `sql` read (src/core/sql/): a real
   * process, because a runaway SQLite statement is stopped only by killing
   * what runs it. Electron spawns a utility process; a headless host or a
   * test forks the same entry with Node (`forkChildProcess`). Absent, the
   * `sql` read has no engine and every query fails.
   */
  readonly sqlProcess?: HostChildSpawner;
  /**
   * Starts the process that runs one task command (`infinitary-browser-axi`,
   * src/core/axi/axiProcess.ts): axi-sdk-js writes `process.exitCode`, so
   * each command runs in a process of its own. Electron spawns a utility
   * process; a test forks the same entry with Node. Absent, no task is
   * given a command, and so no crewmate has a browser.
   */
  readonly axiProcess?: HostChildSpawner;
  /**
   * Starts the process that runs one program's script
   * (src/core/program/programProcess.ts, docs/programs.md). Electron spawns
   * a utility process; a test forks the same entry with Node. Absent, a
   * program cannot be filed.
   */
  readonly programProcess?: HostChildSpawner;
  /**
   * Starts the process that runs one panel's background module
   * (src/core/panels/panelProcess.ts, docs/personal-panels.md "Background
   * work runs apart"). Electron spawns a utility process; a test forks the
   * same entry with Node. Absent, no panel's background work runs.
   */
  readonly panelProcess?: HostChildSpawner;
  /**
   * Starts the process one file the files command copies is set aside in
   * (src/core/files/setAsideProcess.ts, docs/files.md "How a copy
   * travels"): closing a handle to a file drops every lock its process holds
   * on it, so the copy never runs in the process that holds the record open.
   * Electron spawns a utility process; a test forks the same entry with
   * Node. Absent, a file is set aside in the core's own process.
   */
  readonly setAsideProcess?: HostChildSpawner;
};

/** A child process the core talks to by messages and may kill at any moment. */
export type HostChildProcess = {
  postMessage: (message: unknown) => void;
  onMessage: (listener: (message: unknown) => void) => void;
  /** Fires once, however the process ended (its own exit, a crash, `kill`). */
  onExit: (listener: (code: number | null) => void) => void;
  /**
   * Hears each line the process prints, on either stream, until its streams
   * close - after it ended too. Absent: what it prints is not read, as for
   * a process whose output goes to the terminal or nowhere.
   */
  onOutput?: (listener: (stream: "stdout" | "stderr", line: string) => void) => void;
  kill: () => void;
  readonly pid: number | undefined;
};

export type HostChildSpawner = {
  spawn: () => HostChildProcess;
};
