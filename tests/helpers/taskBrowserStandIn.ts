import { join } from "node:path";
import type { ConnectionGuardOptions } from "../../src/core/browser/connectionGuard";
import type { BrowserNode } from "../../src/core/browser/outline";
import {
  type BrowserReturned,
  type PageUnanswered,
  TaskBrowsers,
  type TaskBrowsersOptions,
} from "../../src/core/browser/taskBrowsers";
import type { WebSignIns } from "../../src/core/browser/webSignIns";
import type {
  HostBrowserCookies,
  HostBrowserFrame,
  HostBrowserInput,
  HostBrowserOpen,
  HostBrowserPage,
  HostCookie,
  HostLoadOutcome,
  HostOriginStorage,
  HostPageStorage,
  HostTaskBrowser,
} from "../../src/core/host";
import { scratchDir } from "./scratchDirs";

/**
 * A stand-in host for the unit tests of each task's own browser
 * (src/core/browser/taskBrowsers.*.test.ts): a page that records every effect
 * it is asked for, a cookie jar and page storage it keeps in memory, and a
 * harness that builds a TaskBrowsers over them with the notes, changes,
 * evidence folder and returned hand-backs a test reads. Every page opened in
 * the computer's kept profile shares one more jar and store, which outlive
 * each browser, as the kept profile's do (docs/task-browser.md, "Signed-in
 * sites"). The host's real page is the desktop's
 * (src/main/host/taskBrowser.ts).
 */

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The picture a crewmate's capture answers with: the stand-in page's PNG, as it travels. */
export const PICTURE = { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" };

export function formNodes(): BrowserNode[] {
  return [
    {
      id: "1",
      role: "RootWebArea",
      name: "Sign up",
      ignored: false,
      childIds: ["2", "3", "4", "5"],
      properties: {},
    },
    {
      id: "2",
      role: "heading",
      name: "Sign up",
      ignored: false,
      childIds: [],
      properties: { level: 1 },
    },
    {
      id: "3",
      role: "textbox",
      name: "Name",
      ignored: false,
      childIds: [],
      target: 12,
      properties: {},
    },
    {
      id: "4",
      role: "combobox",
      name: "Seat",
      ignored: false,
      childIds: [],
      target: 17,
      value: "Aisle",
      properties: {},
    },
    {
      id: "5",
      role: "button",
      name: "Send",
      ignored: false,
      childIds: [],
      target: 30,
      properties: {},
    },
  ];
}

/** A browser's cookies, which all its pages share, as the browser keeps them. */
export class FakeJar implements HostBrowserCookies {
  cookies: HostCookie[] = [];
  /** Set when the browser should take none of what it is given. */
  refuse = false;
  all = async (): Promise<HostCookie[]> => this.cookies.map((cookie) => ({ ...cookie }));
  set = async (cookies: readonly HostCookie[]): Promise<void> => {
    if (this.refuse) throw new Error("the browser took none of them");
    for (const cookie of cookies) {
      this.cookies = this.cookies.filter(
        (held) =>
          !(
            held.name === cookie.name &&
            held.domain === cookie.domain &&
            held.path === cookie.path
          ),
      );
      this.cookies.push({ ...cookie });
    }
  };
  remove = async (cookies: readonly HostCookie[]): Promise<void> => {
    this.cookies = this.cookies.filter(
      (held) => !cookies.some((gone) => gone.name === held.name && gone.domain === held.domain),
    );
  };
}

/** A page's own origin, as the browser keeps its storage under it; nothing for a blank page. */
function pageOrigin(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** A browser's page storage by origin, which all its pages share, as the browser keeps it. */
export class FakeStore {
  origins = new Map<string, Map<string, string>>();
  /** Set when a page should refuse what it is given, as one that moved on would. */
  refuse = false;
  /** What an origin holds, as a plain record. */
  of(origin: string): Record<string, string> {
    return Object.fromEntries(this.origins.get(origin) ?? []);
  }
  put(origin: string, items: Record<string, string>): void {
    this.origins.set(origin, new Map(Object.entries(items)));
  }
}

/** A page that answers like a real one and writes down what it was asked to do. */
export class FakePage implements HostBrowserPage {
  effects: string[] = [];
  closed = false;
  current = "about:blank";
  pageTitle = "Sign up";
  nodeList: BrowserNode[] = formNodes();
  boxes = new Map<number, { x: number; y: number; width: number; height: number }>([
    [12, { x: 100, y: 200, width: 200, height: 20 }],
    [17, { x: 100, y: 240, width: 120, height: 20 }],
    [30, { x: 10, y: 300, width: 60, height: 30 }],
  ]);
  loadOutcome: HostLoadOutcome = { ok: true };
  /** How a reload ends: the real host refuses one of a form's answer without loading. */
  reloadOutcome: HostLoadOutcome = { ok: true };
  /** How back or forward ends; nowhere to go by default. */
  historyOutcome: HostLoadOutcome = { ok: false, code: "no-history" };
  pendingLoad: Promise<HostLoadOutcome> | undefined;
  /** A load still going, which `settle` waits for. */
  pendingSettle: Promise<void> | undefined;
  /** A control's place still being found: `box` answers once it settles. */
  pendingBox: Promise<void> | undefined;
  /** Who watches the page now: the view's pictures go here. */
  watcher: ((frame: HostBrowserFrame) => void) | undefined;
  /** The size it lays out at: the one it opened at, until the core resizes it. */
  size: { width: number; height: number };

  /** A page another page opened takes its session's policy, its site data and its own events. */
  constructor(
    readonly opened: HostBrowserOpen,
    readonly cookies: FakeJar = new FakeJar(),
    readonly store: FakeStore = new FakeStore(),
  ) {
    this.size = { ...opened.viewport };
  }

  /** Its own origin's storage alone, as the real page's protocol reaches it. */
  storage: HostPageStorage = {
    read: async (): Promise<HostOriginStorage | undefined> => {
      const origin = pageOrigin(this.current);
      this.effects.push(`read storage ${origin ?? "none"}`);
      return origin ? { origin, items: [...(this.store.origins.get(origin) ?? [])] } : undefined;
    },
    write: async (storage) => {
      if (this.store.refuse || pageOrigin(this.current) !== storage.origin) {
        throw new Error("the page is not on that origin");
      }
      const held = this.store.origins.get(storage.origin) ?? new Map<string, string>();
      for (const [name, value] of storage.items) held.set(name, value);
      this.store.origins.set(storage.origin, held);
      this.effects.push(`write storage ${storage.origin}`);
    },
    clear: async (origin) => {
      this.store.origins.delete(origin);
    },
  };

  /** Its own session storage by origin, which no other page shares, as a real page keeps it. */
  sessionStore = new FakeStore();

  /** Its own origin's session storage alone, kept by this page only. */
  session: HostPageStorage = {
    read: async (): Promise<HostOriginStorage | undefined> => {
      const origin = pageOrigin(this.current);
      this.effects.push(`read session ${origin ?? "none"}`);
      return origin
        ? { origin, items: [...(this.sessionStore.origins.get(origin) ?? [])] }
        : undefined;
    },
    write: async (storage) => {
      if (this.store.refuse || pageOrigin(this.current) !== storage.origin) {
        throw new Error("the page is not on that origin");
      }
      const held = this.sessionStore.origins.get(storage.origin) ?? new Map<string, string>();
      for (const [name, value] of storage.items) held.set(name, value);
      this.sessionStore.origins.set(storage.origin, held);
      this.effects.push(`write session ${storage.origin}`);
    },
    clear: async (origin) => {
      if (pageOrigin(this.current) === origin) this.sessionStore.origins.delete(origin);
    },
  };

  /** The page changed while watched: one picture to whoever watches. */
  paint(data = "jpeg"): void {
    this.watcher?.({ data, ...this.size });
  }

  url = () => this.current;
  title = () => (this.current === "about:blank" ? "" : this.pageTitle);
  load = async (url: string): Promise<HostLoadOutcome> => {
    this.effects.push(`load ${url}`);
    if (this.pendingLoad) return this.pendingLoad;
    if (!this.opened.allow({ url, topLevel: true }))
      return { ok: false, code: "ERR_BLOCKED_BY_CLIENT" };
    this.current = url;
    this.opened.onNavigated(url);
    return this.loadOutcome;
  };
  history = async (direction: "back" | "forward"): Promise<HostLoadOutcome> => {
    this.effects.push(`history ${direction}`);
    return this.historyOutcome;
  };
  reload = async (): Promise<HostLoadOutcome> => {
    if (this.reloadOutcome.ok) this.effects.push("reload");
    return this.reloadOutcome;
  };
  settle = async () => {
    this.effects.push("settle");
    await this.pendingSettle;
  };
  nodes = async () => this.nodeList;
  box = async (target: number) => {
    await this.pendingBox;
    return this.boxes.get(target) ?? null;
  };
  click = async (point: { x: number; y: number }) => {
    this.effects.push(`click ${point.x},${point.y}`);
  };
  setFiles = async (target: number, paths: readonly string[]) => {
    this.effects.push(`files ${target} ${paths.join(" ")}`);
  };
  hover = async (point: { x: number; y: number }) => {
    this.effects.push(`hover ${point.x},${point.y}`);
  };
  drag = async (source: number, destination: number) => {
    this.effects.push(`drag ${source} ${destination}`);
    return this.boxes.has(source) && this.boxes.has(destination);
  };
  focus = async (target: number, options?: { selectAll?: boolean }) => {
    this.effects.push(`focus ${target}${options?.selectAll ? " select-all" : ""}`);
  };
  insertText = async (text: string) => {
    this.effects.push(`insert ${text}`);
  };
  press = async (key: string) => {
    this.effects.push(`press ${key}`);
  };
  scroll = async (direction: "up" | "down" | "top" | "bottom") => {
    this.effects.push(`scroll ${direction}`);
  };
  choose = async (target: number, option: string) => {
    this.effects.push(`choose ${target} ${option}`);
    if (target !== 17) return { kind: "not-a-list" as const };
    return option === "Window"
      ? { kind: "chosen" as const }
      : { kind: "no-match" as const, options: ["Aisle", "Window"] };
  };
  capture = async ({ fullPage, target }: { fullPage: boolean; target?: number }) => {
    if (target !== undefined && !this.boxes.has(target)) return null;
    this.effects.push(
      `capture${fullPage ? " full" : ""}${target !== undefined ? ` target ${target}` : ""}`,
    );
    return { png: PNG, width: this.size.width, height: fullPage ? 2400 : this.size.height };
  };
  watch = (onFrame: (frame: HostBrowserFrame) => void) => {
    this.effects.push("watch");
    this.watcher = onFrame;
    return () => {
      this.effects.push("unwatch");
      this.watcher = undefined;
    };
  };
  input = async (input: HostBrowserInput) => {
    this.effects.push(`input ${input.kind} ${"type" in input ? input.type : ""}`.trim());
  };
  resize = async (viewport: { width: number; height: number }) => {
    this.effects.push(`resize ${viewport.width}x${viewport.height}`);
    this.size = { ...viewport };
  };
  /** What the captain let its sites use goes back, as the real page sets them back to refused. */
  revokeAsks = async () => {
    this.effects.push("revoke asks");
  };
  /** Set to stand in for Chrome, whose own window shows a passkey's prompt; the built-in engine has none. */
  showWindow?: (shown: boolean) => Promise<void>;
  close = () => {
    this.closed = true;
    this.watcher = undefined;
  };
}

/** Let every step already started run to where it waits next. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A promise the test settles by hand. */

/**
 * The browsers' clock: a short wait (the settle after an action, a wait's
 * poll) passes at once; a long one (the command bound, the idle stop) waits
 * until the test fires it.
 */
export function harness(
  options: {
    max?: number;
    signIns?: WebSignIns;
    now?: () => number;
    workingCopy?: string;
    chooseFiles?: HostTaskBrowser["chooseFiles"];
    serve?: TaskBrowsersOptions["serve"];
    privateSites?: TaskBrowsersOptions["privateSites"];
    /** Set when the host should open no page, as one that cannot start a browser. */
    refuseOpen?: () => boolean;
    /** Where stopped pages are kept across a restart; none when absent. */
    keptPages?: TaskBrowsersOptions["kept"];
    /** What a loopback port answers; unknown, and so nothing, when absent. */
    probe?: TaskBrowsersOptions["probe"];
    /** This run's name, so a test can start the browsers again after a restart. */
    session?: string;
    /** The pages' saved starts; none, so `--start` is refused, when absent. */
    starts?: TaskBrowsersOptions["starts"];
  } = {},
) {
  const pages: FakePage[] = [];
  const notes: string[] = [];
  const changes: string[] = [];
  const returned: { taskId: string; returned: BrowserReturned }[] = [];
  const unanswered: { taskId: string; unanswered: PageUnanswered }[] = [];
  const pending: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const evidence = scratchDir("infinitary-browser-");
  /** Each browser's connection guard, as the stand-in for the real one on loopback. */
  const guards: (ConnectionGuardOptions & { closed: boolean; rechecks: number })[] = [];
  /** The kept profile's site data, which every page opened in it shares and no browser's stop clears. */
  const kept: {
    cookies: FakeJar;
    store: FakeStore;
    /** Set to hold Remove all's emptying, as a real profile takes time, or to make it fail. */
    emptying?: () => Promise<void>;
  } = { cookies: new FakeJar(), store: new FakeStore() };
  const host: HostTaskBrowser = {
    open: async (input) => {
      if (options.refuseOpen?.()) throw new Error("no browser could start");
      const page = input.kept ? new FakePage(input, kept.cookies, kept.store) : new FakePage(input);
      pages.push(page);
      return page;
    },
    ...(options.chooseFiles ? { chooseFiles: options.chooseFiles } : {}),
    kept: {
      forget: async (pick, origins) => {
        await kept.cookies.remove(pick(kept.cookies.cookies));
        for (const origin of origins) kept.store.origins.delete(origin);
      },
      forgetAll: async () => {
        await kept.emptying?.();
        await kept.cookies.remove([...kept.cookies.cookies]);
        kept.store.origins.clear();
      },
    },
  };
  const browsers = new TaskBrowsers({
    host,
    ...(options.workingCopy ? { workingCopy: () => options.workingCopy } : {}),
    evidenceDir: (taskId) => join(evidence, taskId),
    note: (taskId, text) => notes.push(`${taskId}: ${text}`),
    onChange: (taskId) => changes.push(taskId),
    onReturned: (taskId, wake) => returned.push({ taskId, returned: wake }),
    onUnanswered: (taskId, wake) => unanswered.push({ taskId, unanswered: wake }),
    // A unit test never reaches a real port: unknown changes nothing.
    probe: options.probe ?? (async () => "unknown"),
    ...(options.keptPages ? { kept: options.keptPages } : {}),
    ...(options.starts ? { starts: options.starts } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.signIns ? { signIns: options.signIns } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.serve ? { serve: options.serve } : {}),
    ...(options.privateSites ? { privateSites: options.privateSites } : {}),
    guard: async (guardOptions) => {
      const guard = { ...guardOptions, closed: false, rechecks: 0 };
      guards.push(guard);
      return {
        host: "127.0.0.1",
        port: 40_000 + guards.length,
        username: "task",
        password: `secret-${guards.length}`,
        close: () => {
          guard.closed = true;
        },
        recheck: () => {
          guard.rechecks += 1;
        },
      };
    },
    timer: (ms, fn) => {
      if (ms <= 1_000) {
        queueMicrotask(fn);
        return () => undefined;
      }
      const entry = { ms, fn, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  const fire = (ms: number): void => {
    for (const entry of pending.splice(0)) {
      if (entry.cancelled) continue;
      if (entry.ms === ms) entry.fn();
      else pending.push(entry);
    }
  };
  return { browsers, pages, notes, changes, evidence, fire, returned, unanswered, guards, kept };
}

/**
 * The page `opener` opens at `url`, as the host would make it: in the same
 * browser (its policy and site data), with the events the core handed
 * back. Nothing when the core refused it.
 */
export function openPopup(opener: FakePage, url: string): FakePage | undefined {
  const popup = opener.opened.onPopup(url);
  if (!popup) return undefined;
  const page = new FakePage(
    { ...opener.opened, ...popup.events, viewport: popup.viewport },
    opener.cookies,
    opener.store,
  );
  page.current = url;
  popup.opened(page);
  return page;
}
