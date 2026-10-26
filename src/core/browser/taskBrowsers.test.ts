import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  FORM_RESEND,
  type HostBrowserCookies,
  type HostBrowserFrame,
  type HostBrowserInput,
  type HostBrowserOpen,
  type HostBrowserPage,
  type HostCookie,
  type HostLoadOutcome,
  type HostOriginStorage,
  type HostPageStorage,
  type HostTaskBrowser,
} from "../host";
import type { ConnectionGuardOptions } from "./connectionGuard";
import {
  type BrowserNode,
  REF_FROM_BEFORE_HANDBACK,
  REF_FROM_EARLIER_PAGE,
  REF_PATTERN,
} from "./outline";
import {
  type BrowserReturned,
  FORM_RESEND_CAPTAIN_WORDS,
  TASK_BROWSER_COMMAND_MS,
  TASK_BROWSER_IDLE_MS,
  TaskBrowsers,
  type TaskBrowsersOptions,
} from "./taskBrowsers";
import { WebSignIns } from "./webSignIns";

/**
 * Each task's own browser, against a stand-in host whose page records every
 * effect it is asked for. The host's real page is the desktop's
 * (src/main/host/taskBrowser.ts), driven end to end by
 * tests/e2e/task-browser.spec.ts.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function formNodes(): BrowserNode[] {
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
class FakeJar implements HostBrowserCookies {
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
class FakeStore {
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
class FakePage implements HostBrowserPage {
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
  close = () => {
    this.closed = true;
    this.watcher = undefined;
  };
}

/** Let every step already started run to where it waits next. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The browsers' clock: a short wait (the settle after an action, a wait's
 * poll) passes at once; a long one (the command bound, the idle stop) waits
 * until the test fires it.
 */
function harness(
  options: {
    max?: number;
    signIns?: WebSignIns;
    now?: () => number;
    automaticSignIn?: TaskBrowsersOptions["automaticSignIn"];
    workingCopy?: string;
    chooseFiles?: HostTaskBrowser["chooseFiles"];
  } = {},
) {
  const pages: FakePage[] = [];
  const notes: string[] = [];
  const changes: string[] = [];
  const returned: { taskId: string; returned: BrowserReturned }[] = [];
  const pending: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const evidence = scratchDir("infinitary-browser-");
  /** Each browser's connection guard, as the stand-in for the real one on loopback. */
  const guards: (ConnectionGuardOptions & { closed: boolean })[] = [];
  const host: HostTaskBrowser = {
    open: async (input) => {
      const page = new FakePage(input);
      pages.push(page);
      return page;
    },
    ...(options.chooseFiles ? { chooseFiles: options.chooseFiles } : {}),
  };
  const browsers = new TaskBrowsers({
    host,
    ...(options.workingCopy ? { workingCopy: () => options.workingCopy } : {}),
    evidenceDir: (taskId) => join(evidence, taskId),
    note: (taskId, text) => notes.push(`${taskId}: ${text}`),
    onChange: (taskId) => changes.push(taskId),
    onReturned: (taskId, wake) => returned.push({ taskId, returned: wake }),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.signIns ? { signIns: options.signIns } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.automaticSignIn ? { automaticSignIn: options.automaticSignIn } : {}),
    guard: async (guardOptions) => {
      const guard = { ...guardOptions, closed: false };
      guards.push(guard);
      return {
        host: "127.0.0.1",
        port: 40_000 + guards.length,
        username: "task",
        password: `secret-${guards.length}`,
        close: () => {
          guard.closed = true;
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
  return { browsers, pages, notes, changes, evidence, fire, returned, guards };
}

/**
 * The page `opener` opens at `url`, as the host would make it: in the same
 * browser (its policy and site data), with the events the core handed
 * back. Nothing when the core refused it.
 */
function openPopup(opener: FakePage, url: string): FakePage | undefined {
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

describe("guarded diagnostic lists", () => {
  it("reads only the current page, does not consume notices or outlines, and refuses mixed reads", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const first = h.pages[0] as FakePage;
    first.opened.onConsole("info", "first page log");
    first.opened.onPageError("ordinary error notice");
    const listed = await browser.inspect({ show: "console" });
    expect(listed.text).toContain("first page log");
    expect(listed.text).not.toContain("outline:");
    expect((await browser.inspect({})).text).toContain("ordinary error notice");
    expect((await browser.inspect({ show: "console" })).text).toContain("first page log");
    expect((await browser.inspect({ show: "network", find: "something" })).text).toContain(
      "Give show alone",
    );
    const second = openPopup(first, "http://localhost:5173/second") as FakePage;
    second.opened.onConsole("warning", "second page log");
    expect((await browser.inspect({ show: "console" })).text).not.toContain("first page log");
    await browser.navigate({ page: 1 });
    expect((await browser.inspect({ show: "console" })).text).not.toContain("second page log");
  });

  it("forgets diagnostics at control boundaries and counts console messages after return", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    page.opened.onConsole("log", "before control");
    page.opened.onNetwork({
      kind: "request",
      id: "old",
      method: "GET",
      type: "Fetch",
      url: "https://example.com/old",
    });
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    page.opened.onConsole("error", "captain secret");
    page.opened.onNetwork({
      kind: "request",
      id: "captain",
      method: "POST",
      type: "Fetch",
      url: "https://example.com/captain",
    });
    expect((await browser.inspect({ show: "network" })).text).toContain("captain has control");
    await h.browsers.returnControl("t1", handle);
    page.opened.onNetwork({ kind: "response", id: "captain", status: 200 });
    expect((await browser.inspect({ show: "network" })).text).toContain("0 requests; 0 kept");
    page.opened.onConsole("error", "returned secret");
    const console = (await browser.inspect({ show: "console" })).text;
    expect(console).toContain("error: 1");
    for (const secret of ["before control", "captain secret", "returned secret"])
      expect(console).not.toContain(secret);
    await browser.close();
    await browser.navigate({ url: "http://localhost:5173/" });
    expect((await browser.inspect({ show: "console" })).text).toContain("0 messages");
  });
});

describe("a task's own browser", () => {
  it("opens a project's page on this Mac and answers with its outline and refs", async () => {
    const { browsers, pages, notes } = harness();
    const answer = await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    expect(answer.text).toContain("Opened http://localhost:5173/.");
    expect(answer.text).toContain('Page: "Sign up" at http://localhost:5173/');
    expect(answer.text).toContain('textbox "Name" [g1:e1]');
    expect(answer.text).toContain('button "Send" [g1:e3]');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.opened.viewport).toEqual({ width: 1280, height: 800 });
    expect(notes).toEqual(["t1: opened its browser at http://localhost:5173"]);
    expect(browsers.isOpen("t1")).toBe(true);
  });

  it("refuses a website over plain http and a private address without opening a browser", async () => {
    const { browsers, pages, guards } = harness();
    const plain = await browsers.forTask("t1").navigate({ url: "http://skyfare.example/" });
    expect(plain.text).toContain("only over https");
    expect(plain.text).toContain("https://skyfare.example/");
    const router = await browsers.forTask("t1").navigate({ url: "https://192.168.1.1/" });
    expect(router.text).toContain("private network");
    expect(pages).toHaveLength(0);
    expect(guards).toHaveLength(0);
  });

  it("opens a public website over https, its every connection through its own guard", async () => {
    const { browsers, pages, guards, notes } = harness();
    const browser = browsers.forTask("t1");
    const answer = await browser.navigate({ url: "https://skyfare.example/flights" });
    expect(answer.text).toContain("Opened https://skyfare.example/flights.");
    const page = pages[0] as FakePage;
    // The page's session reaches the internet only through this browser's guard.
    expect(page.opened.proxy).toEqual({
      host: "127.0.0.1",
      port: 40_001,
      username: "task",
      password: "secret-1",
    });
    expect(notes).toEqual(["t1: opened its browser at https://skyfare.example"]);
    // Any public website over https goes on to the guard; nothing is registered for it.
    expect(page.opened.allow({ url: "https://cdn.skyfare.example/app.js", topLevel: false })).toBe(
      true,
    );
    expect(page.opened.allow({ url: "wss://live.skyfare.example/", topLevel: false })).toBe(true);
    // A public name that leads to a private address is refused at the connection.
    guards[0]?.onRefused({ host: "rebind.skyfare.example", kind: "private" });
    guards[0]?.onRefused({ host: "rebind.skyfare.example", kind: "private" });
    guards[0]?.onRefused({ host: "ads.nowhere.example", kind: "unresolved" });
    const look = (await browser.inspect({})).text;
    expect(look).toContain(
      "Blocked what the page asked for on this computer's network or another private one: rebind.skyfare.example (2).",
    );
    expect(look).toContain("refused at the connection");
    expect(look).toContain("Could not find what the page asked for: ads.nowhere.example.");
    // Its own load refused at the connection says why, by the guard's word.
    page.loadOutcome = { ok: false, code: "ERR_TUNNEL_CONNECTION_FAILED" };
    guards[0]?.onRefused({ host: "intranet.example", kind: "private" });
    const refused = await browser.navigate({ url: "https://intranet.example/" });
    expect(refused.text).toContain(
      "intranet.example leads to an address on this computer or a private network, so the browser refused it at the connection.",
    );
    // Its lead says it once; the summary does not say it again.
    expect(refused.text).not.toContain("Blocked what the page asked for");
    // The guard goes with the browser.
    await browser.close();
    expect(guards[0]?.closed).toBe(true);
  });

  it("answers a certificate error, a sign-in box and a client certificate as refusals", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "https://skyfare.example/" });
    const page = pages[0] as FakePage;
    page.opened.onRefused({
      kind: "certificate",
      url: "https://pay.skyfare.example/",
      code: "net::ERR_CERT_DATE_INVALID",
    });
    page.opened.onRefused({ kind: "sign-in-box", url: "https://intranet-login.example/" });
    page.opened.onRefused({ kind: "client-certificate", url: "https://bank.example/" });
    const look = (await browser.inspect({})).text;
    expect(look).toContain("The browser refused what a site asked of it:");
    expect(look).toContain(
      "- pay.skyfare.example: its certificate did not verify (net::ERR_CERT_DATE_INVALID)",
    );
    expect(look).toContain("never goes past a certificate error");
    expect(look).toContain("- intranet-login.example: it asked for a browser sign-in box");
    expect(look).toContain("- bank.example: it asked for a client certificate");
    page.loadOutcome = { ok: false, code: "ERR_CERT_AUTHORITY_INVALID" };
    page.opened.onRefused({
      kind: "certificate",
      url: "https://self-signed.example/",
      code: "net::ERR_CERT_AUTHORITY_INVALID",
    });
    const opened = await browser.navigate({ url: "https://self-signed.example/" });
    expect(opened.text).toContain(
      "self-signed.example's certificate did not verify (ERR_CERT_AUTHORITY_INVALID), so the browser did not open it.",
    );
    expect(opened.text).not.toContain("The browser refused what a site asked of it");
  });

  it("refuses what the page asks for elsewhere and says so once", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    expect(page.opened.allow({ url: "http://localhost:5173/app.js", topLevel: false })).toBe(true);
    expect(page.opened.allow({ url: "http://fonts.googleapis.com/a", topLevel: false })).toBe(
      false,
    );
    expect(page.opened.allow({ url: "http://fonts.googleapis.com/b", topLevel: false })).toBe(
      false,
    );
    expect(page.opened.allow({ url: "http://192.168.1.5/router", topLevel: false })).toBe(false);
    expect(page.opened.allow({ url: "http://localhost:3001/api", topLevel: false })).toBe(false);
    expect(page.opened.allow({ url: "msauth://sign-in", topLevel: true })).toBe(false);
    page.opened.onPageError("Failed to load resource: net::ERR_BLOCKED_BY_CLIENT");
    page.opened.onPageError("Failed to load resource: net::ERR_TUNNEL_CONNECTION_FAILED");
    page.opened.onPageError("TypeError: x is undefined");
    page.opened.onDialog("alert", "Saved");
    const first = await browser.inspect({});
    expect(first.text).toContain("websites over plain http: fonts.googleapis.com (2).");
    expect(first.text).toContain("another private one: 192.168.1.5.");
    expect(first.text).toContain("other servers on this computer: localhost:3001");
    expect(first.text).toContain("not a web address: msauth.");
    expect(first.text).not.toContain("ERR_TUNNEL_CONNECTION_FAILED");
    expect(first.text).toContain("- TypeError: x is undefined");
    expect(first.text).not.toContain("ERR_BLOCKED_BY_CLIENT");
    expect(first.text).toContain('- alert "Saved"');
    const second = await browser.inspect({});
    expect(second.text).not.toContain("Blocked");
    expect(second.text).not.toContain("TypeError");
    // Opening the other server lets the page reach it.
    await browser.navigate({ url: "http://localhost:3001/" });
    expect(page.opened.allow({ url: "http://localhost:3001/api", topLevel: false })).toBe(true);
  });

  it("answers same-page actions with changed lines, and explicit reads with a fresh window", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const name = page.nodeList.find((node) => node.target === 12) as BrowserNode;
    name.value = "Sam";
    const changed = await browser.act({ action: "press", key: "Tab" });
    expect(changed.text).toContain("refs: g1\ndid: Pressed Tab. The page did not move.");
    expect(changed.text).toContain('+ line 2: textbox "Name" [g1:e1]: "Sam"');
    expect(changed.text).not.toContain('heading "Sign up"');
    const unchanged = await browser.act({ action: "click", ref: "g1:e3" });
    expect(unchanged.text).toContain("changed: nothing changed in the outline.");
    expect(unchanged.text).not.toContain('combobox "Seat"');
    const read = await browser.inspect({});
    expect(read.text).toContain('heading "Sign up"');
    expect(read.text).toContain('combobox "Seat"');
  });

  it("clicks, types and chooses with real input on the element a ref names", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.effects = [];
    const typed = await browser.act({ action: "type", ref: "g1:e1", text: "Sam", submit: true });
    expect(typed.text).toContain('Typed into textbox "Name" [g1:e1] and pressed Enter.');
    expect(page.effects).toEqual([
      "click 200,210",
      "focus 12 select-all",
      "insert Sam",
      "press Enter",
      "settle",
    ]);
    page.effects = [];
    await browser.act({ action: "click", ref: "g1:e3" });
    expect(page.effects).toEqual(["click 40,315", "settle"]);
    const chosen = await browser.act({ action: "select", ref: "g1:e2", option: "Window" });
    expect(chosen.text).toContain('Chose "Window" in combobox "Seat" [g1:e2].');
    const missing = await browser.act({ action: "select", ref: "g1:e2", option: "Middle" });
    expect(missing.text).toContain('has no option "Middle". Its options: "Aisle", "Window".');
    const notList = await browser.act({ action: "select", ref: "g1:e3", option: "Window" });
    expect(notList.text).toContain("is not a list of options");
    const pressed = await browser.act({ action: "press", key: "escape" });
    expect(pressed.text).toContain("Pressed Escape.");
    const unknown = await browser.act({ action: "press", key: "F13" });
    expect(unknown.text).toContain("press needs key, one of: Enter, Tab");
  });

  it("puts text in a field, or chooses a list's option of that label, with one ask", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.effects = [];
    const chosen = await browser.act({ action: "set", ref: "g1:e2", text: "Window" });
    expect(chosen.text).toContain('Chose "Window" in combobox "Seat" [g1:e2].');
    expect(page.effects).toEqual(["choose 17 Window", "settle"]);
    const missing = await browser.act({ action: "set", ref: "g1:e2", text: "Middle" });
    expect(missing).toMatchObject({ refused: "refused" });
    expect(missing.text).toContain('has no option "Middle". Its options: "Aisle", "Window".');
    page.effects = [];
    const typed = await browser.act({ action: "set", ref: "g1:e1", text: "Sam" });
    expect(typed.text).toContain('Typed into textbox "Name" [g1:e1].');
    expect(page.effects).toEqual([
      "choose 12 Sam",
      "click 200,210",
      "focus 12 select-all",
      "insert Sam",
      "settle",
    ]);
  });

  it("types each answer for a command: a page's facts and what follows them, or a refusal", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    expect(await browser.inspect({})).toMatchObject({ refused: "refused" });
    expect(await browser.navigate({})).toMatchObject({ refused: "invalid" });
    const opened = await browser.navigate({ url: "http://localhost:5173/" });
    expect(opened.page).toEqual({
      title: "Sign up",
      url: "http://localhost:5173/",
      refs: "g1",
      controls: 3,
      errors: 0,
      did: "Opened http://localhost:5173/.",
    });
    expect(opened.refused).toBeUndefined();
    // What follows the facts is the rest of the words, in their order.
    expect(opened.text.endsWith(opened.body ?? "-")).toBe(true);
    expect(opened.body).toContain('textbox "Name" [g1:e1]');
    (pages[0] as FakePage).opened.onPageError("boom");
    const read = await browser.inspect({});
    expect(read.page).toMatchObject({ errors: 1, did: "Read the page." });
    expect(read.body).toContain("- boom");
    expect(await browser.act({ action: "click", ref: "g9:e1" })).toMatchObject({
      refused: "refused",
    });
    expect((await browser.pages()).pages).toEqual([
      { place: 1, title: "Sign up", url: "http://localhost:5173/", current: true },
    ]);
  });

  it("reads every line with full, from the top or from a line", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.nodeList = [
      {
        id: "root",
        role: "RootWebArea",
        name: "Long",
        ignored: false,
        childIds: [],
        properties: {},
      },
      ...Array.from({ length: 900 }, (_, index) => ({
        id: `row-${index}`,
        role: "StaticText",
        name: `Row ${index + 1} of a page too long for one window`,
        ignored: false,
        childIds: [],
        properties: {},
      })),
    ];
    expect((await browser.inspect({})).text).toMatch(/^outline: lines 1-400 of 900$/m);
    const full = await browser.inspect({ full: true });
    expect(full.text).toMatch(/^outline: lines 1-900 of 900$/m);
    expect(full.next).toEqual([]);
    expect((await browser.inspect({ full: true, from: 800 })).text).toMatch(
      /^outline: lines 800-900 of 900$/m,
    );
    expect(await browser.inspect({ full: true, find: "Row 9" })).toMatchObject({
      refused: "invalid",
    });
  });

  it("waits for a link's same-document move and answers with the new page", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/releases" });
    const page = pages[0] as FakePage;
    page.current = "http://localhost:5173/releases";
    page.pageTitle = "Releases";
    page.nodeList = [
      {
        id: "1",
        role: "RootWebArea",
        name: "Releases",
        ignored: false,
        childIds: ["2", "3"],
        properties: {},
      },
      {
        id: "2",
        role: "heading",
        name: "Releases",
        ignored: false,
        childIds: [],
        properties: { level: 1 },
      },
      {
        id: "3",
        role: "link",
        name: "Firstmate 3000 0.2.1-alpha.52",
        ignored: false,
        childIds: [],
        target: 90,
        properties: { url: "http://localhost:5173/releases/tag/alpha" },
      },
    ];
    page.boxes.set(90, { x: 10, y: 40, width: 240, height: 20 });
    const opened = await browser.inspect({});
    const ref = opened.text.match(
      new RegExp(`link "Firstmate 3000 0.2.1-alpha.52" \\[(${REF_PATTERN})\\]`),
    )?.[1];
    expect(ref).toBeTruthy();
    let armed = false;
    let reads = 0;
    const click = page.click;
    page.click = async (point) => {
      await click(point);
      armed = true;
    };
    page.url = () => {
      if (armed) {
        reads += 1;
        if (reads >= 3) {
          page.current = "http://localhost:5173/releases/tag/alpha";
          page.pageTitle = "Firstmate 3000 0.2.1-alpha.52";
          page.nodeList = [
            {
              id: "1",
              role: "RootWebArea",
              name: "Firstmate 3000 0.2.1-alpha.52",
              ignored: false,
              childIds: ["2"],
              properties: {},
            },
            {
              id: "2",
              role: "heading",
              name: "Firstmate 3000 0.2.1-alpha.52",
              ignored: false,
              childIds: [],
              properties: { level: 1 },
            },
          ];
          page.opened.onNavigated(page.current);
          armed = false;
        }
      }
      return page.current;
    };
    const clicked = await browser.act({ action: "click", ref: ref as string });
    expect(clicked.text).toContain("Clicked link");
    expect(clicked.text).toContain("http://localhost:5173/releases/tag/alpha");
    expect(clicked.text).toContain('heading "Firstmate 3000 0.2.1-alpha.52"');
    expect(clicked.text).not.toContain('heading "Releases"');
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThan(16);
  });

  it("waits for a button click's late same-document move too", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    let armed = false;
    let reads = 0;
    const click = page.click;
    page.click = async (point) => {
      await click(point);
      armed = true;
    };
    page.url = () => {
      if (armed) {
        reads += 1;
        if (reads >= 5) {
          page.current = "http://localhost:5173/done";
          page.pageTitle = "Done";
          armed = false;
        }
      }
      return page.current;
    };
    const clicked = await browser.act({ action: "click", ref: "g1:e3" });
    expect(clicked.text).toContain("http://localhost:5173/done");
    expect(clicked.text).toContain('"Done"');
    expect(reads).toBeGreaterThanOrEqual(5);
  });

  it("still reports a click when the page closes itself during the wait", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    let armed = false;
    const click = page.click;
    page.click = async (point) => {
      await click(point);
      armed = true;
    };
    page.url = () => (armed ? "" : page.current);
    page.title = () => (armed ? "" : page.pageTitle);
    page.settle = async () => {
      page.effects.push("settle");
      if (armed) throw new Error("Object has been destroyed");
    };
    const clicked = await browser.act({ action: "click", ref: "g1:e3" });
    expect(clicked.text).toContain('Clicked button "Send"');
    expect(clicked.text).not.toContain("could not click");
  });

  it("reads a cut passage in full, and still hides what the captain typed", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const tail = "anything stays secret in the notes";
    page.nodeList = [
      ...formNodes(),
      {
        id: "9",
        role: "StaticText",
        name: `${"a".repeat(2_000)} ${tail}`,
        ignored: false,
        childIds: [],
        target: 91,
        properties: {},
      },
    ];
    const opened = await browser.inspect({});
    expect(opened.text).toContain("cut short");
    expect(opened.text).not.toContain(tail);
    const ref = opened.text.match(
      new RegExp(`text "[^"]+…" \\[(${REF_PATTERN})\\] \\(cut short\\)`),
    )?.[1];
    expect(ref).toBeTruthy();
    const full = await browser.inspect({ ref: ref as string });
    expect(full.text).toContain(tail);
    expect(full.text).toContain("Full text of");
    page.opened.onPageError(
      "Failed to load resource: the server responded with a status of 404 () (https://github.com/_global-navigation/payloads.json)",
    );
    page.opened.onPageError("TypeError: x is undefined");
    const errors = await browser.inspect({});
    expect(errors.text).not.toContain("payloads.json");
    expect(errors.text).toContain("TypeError: x is undefined");
  });

  it("refuses a ref the page no longer has, after a new document or for an element gone", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.boxes.delete(30);
    expect((await browser.act({ action: "click", ref: "g1:e3" })).text).toContain(
      'button "Send" [g1:e3] is not on the page now',
    );
    expect((await browser.act({ action: "click", ref: "g1:e9" })).text).toContain(
      "There is no g1:e9 on the page now.",
    );
    // The page moves to a new document on its own: its refs are a new page's.
    page.current = "http://localhost:5173/done";
    page.opened.onNavigated(page.current);
    const read = await browser.inspect({});
    expect(read.text).toContain("The page moved to http://localhost:5173/done.");
    expect(read.text).toContain('textbox "Name" [g2:e1]');
  });

  it("never uses a ref from before the page moved on the element that took its place", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const link = (id: string, name: string, target: number): BrowserNode => ({
      id,
      role: "link",
      name,
      ignored: false,
      childIds: [],
      target,
      properties: {},
    });
    const root = (children: string[]): BrowserNode => ({
      id: "1",
      role: "RootWebArea",
      name: "Releases",
      ignored: false,
      childIds: children,
      properties: {},
    });
    page.boxes.set(44, { x: 10, y: 40, width: 200, height: 20 });
    page.boxes.set(45, { x: 10, y: 700, width: 60, height: 20 });
    // The crewmate opens the releases list, its own page's second read.
    page.nodeList = [root(["2"]), link("2", "0.2.1-alpha.53", 44)];
    page.current = "http://localhost:5173/releases";
    page.opened.onNavigated(page.current);
    const listed = (await browser.inspect({})).text;
    expect(listed).toContain('link "0.2.1-alpha.53" [g2:e1]');
    // A click moves the page; the release's page leads with a footer link of its own.
    page.nodeList = [root(["3"]), link("3", "Docs", 45)];
    page.current = "http://localhost:5173/releases/tag/0.1.29";
    page.opened.onNavigated(page.current);
    expect((await browser.inspect({})).text).toContain('link "Docs" [g3:e1]');
    page.effects = [];
    for (const action of ["click", "scroll", "press"] as const) {
      const stale = await browser.act({ action, ref: "g2:e1", key: "Enter" });
      expect(stale.text).toBe(
        `g2:e1 ${REF_FROM_EARLIER_PAGE}, so it is not used on the page now. Use a ref from the latest answer, or run \`infinitary-browser-axi snapshot\` for the page's refs now.`,
      );
    }
    const passage = await browser.inspect({ ref: "g2:e1" });
    expect(passage.text).toContain(`g2:e1 ${REF_FROM_EARLIER_PAGE}`);
    expect(page.effects).toEqual([]);
    // A bare control number, the old way of writing a ref, names no page and nothing.
    expect((await browser.act({ action: "click", ref: "e1" })).text).toContain(
      '"e1" is not a whole ref.',
    );
    expect((await browser.act({ action: "click", ref: "g7:e1" })).text).toContain(
      "There is no g7:e1 in this browser.",
    );
    expect(page.effects).toEqual([]);
    // Its own ref still reaches the element it named, across reads.
    await browser.inspect({});
    await browser.act({ action: "click", ref: "g3:e1" });
    expect(page.effects).toContain("click 40,710");
  });

  it("refuses a ref from a browser the task had before, which stopped", async () => {
    const { browsers } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    await browser.close();
    expect((await browser.navigate({ url: "http://localhost:5173/" })).text).toContain(
      'button "Send" [g2:e3]',
    );
    expect((await browser.act({ action: "click", ref: "g1:e3" })).text).toContain(
      "g1:e3 is from a browser this task had before, which has stopped.",
    );
    // Another task's browser counts its own pages.
    const other = browsers.forTask("t2");
    expect((await other.navigate({ url: "http://localhost:5173/" })).text).toContain(
      'button "Send" [g1:e3]',
    );
  });

  it("reads a long page by windows: from its top, from a line, around words and on screen", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    // Six hundred rows of text, longer than one answer; the window shows rows `from` to `to`.
    const rows = (from: number, to: number): BrowserNode[] => [
      {
        id: "root",
        role: "RootWebArea",
        name: "Rows",
        ignored: false,
        childIds: Array.from({ length: 600 }, (_, index) => `r${index + 1}`),
        properties: {},
      },
      ...Array.from({ length: 600 }, (_, index) => ({
        id: `r${index + 1}`,
        role: "StaticText",
        name: `Row ${index + 1} of the long page, with words enough to fill the line`,
        ignored: false,
        childIds: [],
        target: 1000 + index,
        properties: {},
        onScreen: index + 1 >= from && index + 1 <= to,
      })),
    ];
    page.nodeList = rows(1, 30);
    const top = (await browser.inspect({})).text;
    expect(top).toMatch(/^outline: lines 1-(\d+) of 600$/m);
    const readOn = Number(/`infinitary-browser-axi snapshot --from (\d+)` reads on/.exec(top)?.[1]);
    expect(readOn).toBeGreaterThan(1);
    expect(top).not.toContain('text "Row 600 ');

    const found = (await browser.inspect({ find: "row 590 of" })).text;
    expect(found).toContain('Found "row 590 of" on line 590.');
    expect(found).toContain('text "Row 590 of the long page');
    expect(found).not.toContain('text "Row 1 of');
    expect(found.length).toBeLessThan(top.length / 2);

    const from = (await browser.inspect({ from: readOn })).text;
    expect(from).toMatch(new RegExp(`^outline: lines ${readOn}-\\d+ of 600$`, "m"));

    page.nodeList = rows(300, 330);
    const scrolled = (await browser.act({ action: "scroll", direction: "down" })).text;
    expect(page.effects).toContain("scroll down");
    expect(scrolled).toContain("Scrolled down.");
    expect(scrolled).toContain("outline: lines 300-330 of 600, those on screen");
    expect(scrolled).not.toContain('text "Row 1 of');
  });

  it("answers a wait for words with the part of the page that holds them", async () => {
    const { browsers } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const found = (await browser.inspect({ waitFor: "Send", find: "ignored when waiting" })).text;
    expect(found).toContain('Found "Send" on line 4.');
    expect(found).toContain('button "Send" [g1:e3]');
  });

  it("waits for words to appear, and says when they did not", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const found = await browser.inspect({ waitFor: "send" });
    expect(found.text).toContain('Found "send" on line 4.');
    const page = pages[0] as FakePage;
    let reads = 0;
    page.nodes = async () => {
      reads += 1;
      return formNodes();
    };
    const missing = await browser.inspect({ waitFor: "Booking confirmed" });
    expect(missing.text).toContain('Waited 10 seconds; "Booking confirmed" did not appear.');
    expect(reads).toBeGreaterThan(30);
  });

  it("photographs the page into the task's evidence folder", async () => {
    const { browsers, evidence, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const named = await browser.capture({ name: "Form after Submit.png", fullPage: true });
    const path = join(evidence, "t1", "form-after-submit.png");
    expect(named.text).toContain(`Saved the whole page as ${path} (1280×2400).`);
    expect(named.image).toEqual({
      data: Buffer.from(PNG).toString("base64"),
      mimeType: "image/png",
    });
    expect(readFileSync(path)).toEqual(Buffer.from(PNG));
    const first = await browser.capture({});
    const second = await browser.capture({});
    expect(first.text).toContain(join(evidence, "t1", "page-1.png"));
    expect(second.text).toContain(join(evidence, "t1", "page-2.png"));
    expect((pages[0] as FakePage).effects.filter((effect) => effect.startsWith("capture"))).toEqual(
      ["capture full", "capture", "capture"],
    );
  });

  it("runs at most four at once and refuses the next rather than stopping one", async () => {
    const { browsers, pages } = harness();
    for (const task of ["t1", "t2", "t3", "t4"]) {
      await browsers.forTask(task).navigate({ url: "http://localhost:5173/" });
    }
    const fifth = await browsers.forTask("t5").navigate({ url: "http://localhost:5173/" });
    expect(fifth.text).toContain("Four task browsers are already open on this computer");
    expect(pages).toHaveLength(4);
    expect(pages.every((page) => !page.closed)).toBe(true);
    browsers.closeTask("t2");
    expect(
      (await browsers.forTask("t5").navigate({ url: "http://localhost:5173/" })).text,
    ).toContain("Opened");
  });

  it("keeps each task's browser its own: a fresh page per task, and one closing leaves the rest", async () => {
    const { browsers, pages } = harness();
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    await browsers.forTask("t2").navigate({ url: "http://localhost:4000/" });
    const [one, two] = pages as [FakePage, FakePage];
    // Task two's page reaches only what task two opened.
    expect(two.opened.allow({ url: "http://localhost:5173/", topLevel: false })).toBe(false);
    expect(one.opened.allow({ url: "http://localhost:4000/", topLevel: false })).toBe(false);
    browsers.closeTask("t1");
    expect(one.closed).toBe(true);
    expect(two.closed).toBe(false);
    expect((await browsers.forTask("t1").inspect({})).text).toContain(
      "No browser is open for this task.",
    );
  });

  it("stops a browser left unused for half an hour, tells its crewmate once, and opens fresh", async () => {
    const { browsers, pages, notes, fire } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    fire(TASK_BROWSER_IDLE_MS);
    expect(pages[0]?.closed).toBe(true);
    expect(notes).toContain("t1: its browser stopped after 30 minutes unused");
    expect((await browser.inspect({})).text).toContain(
      "This task's browser was stopped after 30 minutes unused.",
    );
    const reopened = await browser.navigate({ url: "http://localhost:5173/" });
    expect(reopened.text).toContain(
      "Your earlier browser was stopped after 30 minutes unused, so this is a fresh one with nothing signed in.",
    );
    expect(pages).toHaveLength(2);
    expect((await browser.inspect({})).text).not.toContain("earlier browser");
  });

  it("answers in words when a page does not finish within the bound, and runs commands in order", async () => {
    const { browsers, pages, fire } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.pendingLoad = new Promise(() => undefined);
    const stuck = browser.navigate({ url: "http://localhost:5173/slow" });
    const after = browser.inspect({});
    await new Promise((resolve) => setImmediate(resolve));
    fire(TASK_BROWSER_COMMAND_MS);
    expect((await stuck).text).toContain("The browser did not load the page within 30 seconds.");
    expect((await after).text).toContain("Page:");
    expect(page.effects.indexOf("load http://localhost:5173/slow")).toBeGreaterThan(-1);
  });

  it("says why when the page stopped working on its own", async () => {
    const { browsers, pages, notes } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    pages[0]?.opened.onGone("crashed");
    expect(notes).toContain("t1: its browser stopped working and was closed");
    expect((await browser.capture({})).text).toContain(
      "This task's browser stopped working (crashed).",
    );
  });

  it("closes on the crewmate's word, and says when there is nothing to close", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    expect((await browser.close()).text).toBe("No browser is open for this task.");
    await browser.navigate({ url: "http://localhost:5173/" });
    expect((await browser.close()).text).toContain("Stopped this task's browser");
    expect(pages[0]?.closed).toBe(true);
    expect(browsers.openCount).toBe(0);
  });

  it("tells a page the server answered with an error from one that did not load", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.loadOutcome = { ok: true, status: 404 };
    expect((await browser.navigate({ url: "http://localhost:5173/missing" })).text).toContain(
      "The server answered 404.",
    );
    page.load = async () => ({ ok: false, code: "ERR_CONNECTION_REFUSED" });
    expect((await browser.navigate({ url: "http://localhost:5173/" })).text).toContain(
      "Nothing answered at http://localhost:5173/. Start the project's server first",
    );
    expect((await browser.navigate({ go: "back" })).text).toContain(
      "There is no page to go to in that direction.",
    );
  });
});

/**
 * What the captain reads of a task's browser and does with it
 * (docs/task-browser.md, "The view"): the fact the record and the view
 * draw, the pictures a view watches, and Stop browser and Open again.
 */
describe("the captain's view of a task's browser", () => {
  it("reads the site, the page and what the crewmate did last, never what it typed", async () => {
    const { browsers, changes } = harness();
    const browser = browsers.forTask("t1");
    expect(browsers.fact("t1")).toBeUndefined();
    await browser.navigate({ url: "http://localhost:5173/signup?step=1" });
    expect(browsers.fact("t1")).toEqual({
      state: "open",
      site: "localhost:5173",
      url: "http://localhost:5173/signup?step=1",
      title: "Sign up",
      did: "opened /signup?step=1",
      session: browsers.session,
      generation: 1,
    });
    expect(changes).toContain("t1");
    const name = (await browser.inspect({})).text.match(
      new RegExp(`textbox "Name" \\[(${REF_PATTERN})\\]`),
    )?.[1];
    const send = (await browser.inspect({})).text.match(
      new RegExp(`button "Send" \\[(${REF_PATTERN})\\]`),
    )?.[1];
    await browser.act({ action: "type", ref: name as string, text: "hunter2", submit: true });
    expect(browsers.fact("t1")).toMatchObject({ did: 'typed into "Name" and pressed Enter' });
    expect(JSON.stringify(browsers.fact("t1"))).not.toContain("hunter2");
    await browser.act({ action: "click", ref: send as string });
    expect(browsers.fact("t1")).toMatchObject({ did: 'clicked "Send"' });
    await browser.inspect({ waitFor: "Thanks" });
    expect(browsers.fact("t1")).toMatchObject({ did: 'waited for "Thanks"' });
    await browser.navigate({ url: "http://127.0.0.1:4000/" });
    expect(browsers.fact("t1")).toMatchObject({
      did: "opened 127.0.0.1:4000",
      site: "127.0.0.1:4000",
    });
  });

  it("sends pictures to whoever watches, and keeps a watched browser from its idle stop", async () => {
    const { browsers, pages, fire } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const seen: string[] = [];
    const unwatch = browsers.watch("t1", (frame) =>
      seen.push(`${frame.data} ${frame.width}x${frame.height}`),
    );
    expect(page.effects).toContain("watch");
    page.paint("first");
    expect(seen).toEqual(["first 1280x800"]);
    // Half an hour passes while the captain watches: the browser stays.
    fire(TASK_BROWSER_IDLE_MS);
    expect(page.closed).toBe(false);
    unwatch();
    expect(page.effects).toContain("unwatch");
    page.paint("unseen");
    expect(seen).toEqual(["first 1280x800"]);
    // Its half hour starts again once the view goes.
    fire(TASK_BROWSER_IDLE_MS);
    expect(page.closed).toBe(true);
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", stopped: "idle" });
  });

  it("stops on the captain's word, tells the crewmate once, and remembers why for the captain", async () => {
    const { browsers, pages, notes } = harness();
    const browser = browsers.forTask("t1");
    expect(browsers.stopByCaptain("t1")).toEqual({
      ok: false,
      text: "This task's browser is not running.",
    });
    await browser.navigate({ url: "http://localhost:5173/signup" });
    expect(browsers.stopByCaptain("t1")).toEqual({ ok: true });
    expect(pages[0]?.closed).toBe(true);
    expect(notes).toContain("t1: you stopped its browser");
    expect(browsers.fact("t1")).toMatchObject({
      state: "stopped",
      site: "localhost:5173",
      url: "http://localhost:5173/signup",
      stopped: "captain",
    });
    expect((await browser.inspect({})).text).toContain(
      "This task's browser was stopped by the captain.",
    );
  });

  it("opens again fresh at the last page, into a view still watching, and tells the crewmate once", async () => {
    const { browsers, pages, notes } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/signup" });
    const seen: string[] = [];
    browsers.watch("t1", (frame) => seen.push(frame.data));
    browsers.stopByCaptain("t1");
    expect(await browsers.reopen("t1")).toEqual({ ok: true });
    expect(pages).toHaveLength(2);
    const fresh = pages[1] as FakePage;
    expect(fresh.effects).toEqual(["watch", "load http://localhost:5173/signup"]);
    fresh.paint("again");
    expect(seen).toEqual(["again"]);
    expect(notes).toContain("t1: you opened its browser again at http://localhost:5173");
    expect(browsers.fact("t1")).toMatchObject({ state: "open", site: "localhost:5173" });
    const told = (await browser.inspect({})).text;
    expect(told).toContain(
      "Your earlier browser was stopped by the captain. The captain opened this task's browser again at http://localhost:5173/signup: a fresh one, with nothing signed in.",
    );
    expect((await browser.inspect({})).text).not.toContain("opened this task's browser again");
    // Open again on an open browser changes nothing.
    expect(await browsers.reopen("t1")).toEqual({ ok: true });
    expect(pages).toHaveLength(2);
  });

  it("refuses Open again past the cap, with no browser to open, and once the task has closed", async () => {
    const { browsers } = harness({ max: 1 });
    expect(await browsers.reopen("t1")).toEqual({
      ok: false,
      text: "This task has no browser to open again.",
    });
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    browsers.stopByCaptain("t1");
    await browsers.forTask("t2").navigate({ url: "http://localhost:5174/" });
    expect(await browsers.reopen("t1")).toEqual({
      ok: false,
      text: "One task browsers are already open on this computer. Stop one, then open this again.",
    });
    browsers.closeTask("t1");
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", stopped: "task-closed" });
    browsers.closeTask("t2");
    expect(await browsers.reopen("t1")).toEqual({
      ok: false,
      text: "This task has no browser to open again.",
    });
  });

  it("says the crewmate closed it, and a crash stops it with its own reason", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    await browser.close();
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", stopped: "crewmate" });
    await browser.navigate({ url: "http://localhost:5173/" });
    pages[1]?.opened.onGone("crashed");
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", stopped: "gone" });
  });
});

describe("the room the captain's maximized view gives the page", () => {
  const ROOM = { width: 1600, height: 900 };

  it("lays the page out at the room, pictures and photographs included, and back at the check's size once restored", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const seen: string[] = [];
    const sink = (frame: HostBrowserFrame) => seen.push(`${frame.width}x${frame.height}`);
    browsers.watch("t1", sink);
    browsers.sizeView("t1", sink, ROOM);
    await flush();
    // The crewmate's next command finds the page at its new size.
    expect((await browser.capture({})).text).toContain("(1600×900)");
    expect(page.effects).toContain("resize 1600x900");
    page.paint();
    expect(seen).toEqual(["1600x900"]);
    browsers.sizeView("t1", sink, null);
    await flush();
    expect(page.effects.filter((effect) => effect.startsWith("resize"))).toEqual([
      "resize 1600x900",
      "resize 1280x800",
    ]);
  });

  it("gives the page back its own size when the view that asked stops watching, and hears no view that does not watch", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    browsers.sizeView("t1", () => undefined, ROOM);
    await flush();
    expect(page.effects.some((effect) => effect.startsWith("resize"))).toBe(false);
    const sink = () => undefined;
    const unwatch = browsers.watch("t1", sink);
    browsers.sizeView("t1", sink, ROOM);
    // Another view restoring is not the one that asked: the room stands.
    browsers.watch("t1", () => undefined);
    browsers.sizeView("t1", () => undefined, null);
    await flush();
    expect(page.size).toEqual(ROOM);
    unwatch();
    await flush();
    expect(page.size).toEqual({ width: 1280, height: 800 });
  });

  it("lays the page out at once while the crewmate's command loads or waits, at the newest room", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const sink = () => undefined;
    browsers.watch("t1", sink);
    const load = deferred<HostLoadOutcome>();
    page.pendingLoad = load.promise;
    const running = browser.navigate({ url: "http://localhost:5173/slow" });
    await flush();
    browsers.sizeView("t1", sink, { width: 1500, height: 850 });
    browsers.sizeView("t1", sink, ROOM);
    await flush();
    expect(page.effects.filter((effect) => effect.startsWith("resize"))).toEqual([
      "resize 1600x900",
    ]);
    page.pendingLoad = undefined;
    load.resolve({ ok: true });
    expect((await running).text).toContain("Opened http://localhost:5173/slow.");
  });

  it("never moves the page between a click finding its control and pressing it", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    const opened = await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const sink = () => undefined;
    browsers.watch("t1", sink);
    const found = deferred<void>();
    page.pendingBox = found.promise;
    const send = opened.text.match(new RegExp(`button "Send" \\[(${REF_PATTERN})\\]`))?.[1];
    const clicking = browser.act({ action: "click", ref: send as string });
    await flush();
    browsers.sizeView("t1", sink, ROOM);
    await flush();
    expect(page.effects.some((effect) => effect.startsWith("resize"))).toBe(false);
    page.pendingBox = undefined;
    found.resolve();
    expect((await clicking).text).toContain("Clicked button");
    await flush();
    const moves = page.effects.filter(
      (effect) => effect.startsWith("click") || effect.startsWith("resize"),
    );
    expect(moves).toEqual(["click 40,315", "resize 1600x900"]);
  });

  it("opens a browser, a second page and Open again at the room while the view stays maximized", async () => {
    const { browsers, pages } = harness();
    const sink = () => undefined;
    browsers.watch("t1", sink);
    browsers.sizeView("t1", sink, ROOM);
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const first = pages[0] as FakePage;
    expect(first.opened.viewport).toEqual(ROOM);
    const second = openPopup(first, "http://localhost:5173/check") as FakePage;
    expect(second.size).toEqual(ROOM);
    browsers.stopByCaptain("t1");
    expect(await browsers.reopen("t1")).toEqual({ ok: true });
    expect((pages.at(-1) as FakePage).opened.viewport).toEqual(ROOM);
  });

  it("follows a second page that opened while the room changed", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const first = pages[0] as FakePage;
    const sink = () => undefined;
    browsers.watch("t1", sink);
    const popup = first.opened.onPopup("http://localhost:5173/check");
    if (!popup) throw new Error("the second page was refused");
    browsers.sizeView("t1", sink, ROOM);
    await flush();
    const second = new FakePage(
      { ...first.opened, ...popup.events, viewport: popup.viewport },
      first.cookies,
      first.store,
    );
    popup.opened(second);
    await new Promise((resolve) => setImmediate(resolve));
    expect(popup.viewport).toEqual({ width: 1280, height: 800 });
    expect(second.size).toEqual(ROOM);
  });
});

describe('which browser a card names (docs/task-browser.md, "From a card")', () => {
  it("names each of a task's browsers by this run and its generation, open and stopped", async () => {
    const { browsers } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const first = { session: browsers.session, generation: 1 };
    expect(browsers.fact("t1")).toMatchObject({ state: "open", ...first });
    // Moving the page or acting on it keeps the same browser.
    await browser.navigate({ url: "http://localhost:5173/signup" });
    expect(browsers.fact("t1")).toMatchObject(first);
    // A stopped browser is still the one it was.
    browsers.stopByCaptain("t1");
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", ...first });
    // Open again, or the crewmate's next open, is a newer one in the same run.
    await browsers.reopen("t1");
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      session: first.session,
      generation: 2,
    });
    await browser.close();
    await browser.navigate({ url: "http://localhost:5173/" });
    expect(browsers.fact("t1")).toMatchObject({ generation: 3 });
    // Each task counts its own, and the app's next start is another run.
    await browsers.forTask("t2").navigate({ url: "http://localhost:5174/" });
    expect(browsers.fact("t2")).toMatchObject({ session: first.session, generation: 1 });
    expect(harness().browsers.session).not.toBe(first.session);
  });
});

describe('taking control and handing it back (docs/task-browser.md, "Taking control")', () => {
  /** A browser on the sign-up page whose outline the crewmate has read, refs and all. */
  async function opened() {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const handle = { session: h.browsers.session, generation: 1 };
    return { ...h, browser, handle, page: h.pages[0] as FakePage };
  }

  it("never carries a change baseline across the captain's control", async () => {
    const { browsers, browser, page, handle } = await opened();
    const field = page.nodeList.find((node) => node.target === 12) as BrowserNode;
    field.value = "old-public-value";
    await browser.inspect({});
    await browsers.takeControl("t1", handle);
    field.value = "captain-secret";
    await browsers.returnControl("t1", handle);
    // A key needs no old ref and may be the first read after the return.
    const fresh = await browser.act({ action: "press", key: "Tab" });
    expect(fresh.text).toContain("outline:");
    expect(fresh.text).toContain("(value hidden)");
    expect(fresh.text).not.toContain("old-public-value");
    expect(fresh.text).not.toContain("captain-secret");
    const unchanged = await browser.act({ action: "press", key: "Tab" });
    expect(unchanged.text).toContain("changed: nothing changed in the outline.");
    expect(unchanged.text).not.toContain("captain-secret");
  });

  const CAPTAIN_HAS_IT = "The captain has control of this task's browser";

  it("lets the crewmate's running command finish, refuses the rest, then hands the page over", async () => {
    const { browsers, browser, page, notes } = await opened();
    const load = deferred<HostLoadOutcome>();
    page.pendingLoad = load.promise;
    const running = browser.navigate({ url: "http://localhost:5173/slow" });
    const queued = browser.inspect({});
    await new Promise((resolve) => setImmediate(resolve));
    const take = browsers.takeControl("t1");
    // The crewmate's command still runs: the captain waits for it.
    expect(browsers.fact("t1")).toMatchObject({ state: "open", control: "taking" });
    expect(browsers.withCaptain("t1")).toBe(true);
    expect(await browsers.captainInput("t1", { kind: "go", go: "reload" })).toEqual({
      ok: false,
      text: "You do not have control of this browser.",
    });
    page.pendingLoad = undefined;
    load.resolve({ ok: true });
    expect((await running).text).toContain("Opened http://localhost:5173/slow.");
    // Queued behind it before the take, it refuses as it starts.
    expect((await queued).text).toContain(CAPTAIN_HAS_IT);
    expect(await take).toEqual({ ok: true });
    expect(browsers.fact("t1")).toMatchObject({ state: "open", control: "captain" });
    expect(notes).toContain("t1: you took control of its browser");
  });

  it("keeps the crewmate from the page and keeps nothing of the captain's", async () => {
    const { browsers, browser, page, notes, changes, fire, handle, guards } = await opened();
    await browser.act({ action: "type", ref: "g1:e1", text: "Sam" });
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    const before = { notes: notes.length, did: browsers.fact("t1") };
    const changed = changes.length;
    // His typing, his clicks and his wheel reach the page, and nothing writes them down.
    for (const input of [
      { kind: "pointer", type: "down", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 },
      { kind: "key", type: "down", key: "s", code: "KeyS", keyCode: 83, text: "s", modifiers: 0 },
      { kind: "wheel", x: 10, y: 20, deltaX: 0, deltaY: 120, modifiers: 0 },
    ] as const) {
      expect(await browsers.captainInput("t1", input)).toEqual({ ok: true });
    }
    expect(page.effects.slice(-3)).toEqual(["input pointer down", "input key down", "input wheel"]);
    expect(notes).toHaveLength(before.notes);
    expect(browsers.fact("t1")).toEqual(before.did);
    expect(changes).toHaveLength(changed);
    // Every crewmate command refuses, its close too.
    for (const answer of [
      await browser.inspect({}),
      await browser.act({ action: "click", ref: "g1:e3" }),
      await browser.capture({}),
      await browser.navigate({ go: "reload" }),
      await browser.close(),
    ]) {
      expect(answer.text).toContain(CAPTAIN_HAS_IT);
    }
    expect(page.closed).toBe(false);
    // What the page says while he holds it is his: refused requests and
    // connections, errors, refusals, dialogs and its moves are kept for nobody.
    expect(page.opened.allow({ url: "http://bank.example/check", topLevel: false })).toBe(false);
    guards[0]?.onRefused({ host: "bank-intranet.example", kind: "private" });
    page.opened.onRefused({ kind: "sign-in-box", url: "https://bank-login.example/" });
    page.opened.onPageError("Uncaught TypeError: private");
    page.opened.onDialog("alert", "Welcome back, Sam");
    page.opened.onNavigated("http://localhost:5173/account?code=secret");
    // A browser in his hands never stops for being unused.
    fire(TASK_BROWSER_IDLE_MS);
    expect(browsers.isOpen("t1")).toBe(true);
    expect(await browsers.returnControl("t1", handle)).toEqual({ ok: true });
    const look = (await browser.inspect({})).text;
    expect(look).toContain("The captain returned control of this browser");
    for (const kept of [
      "bank.example",
      "bank-intranet",
      "bank-login",
      "private",
      "Welcome back",
      "moved to",
      "code=secret",
    ]) {
      expect(look).not.toContain(kept);
    }
  });

  it("returns once a load he started finishes, forgets every ref and wakes the crewmate once", async () => {
    const { browsers, browser, page, notes, returned, handle } = await opened();
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    expect(await browsers.captainInput("t1", { kind: "go", go: "reload" })).toEqual({ ok: true });
    expect(page.effects.at(-1)).toBe("reload");
    // A return during that reload waits for it: the crewmate's first look is the loaded page.
    const load = deferred<void>();
    page.pendingSettle = load.promise;
    const giving = browsers.returnControl("t1", handle);
    await new Promise((resolve) => setImmediate(resolve));
    expect(browsers.fact("t1")).toMatchObject({ control: "captain" });
    expect(returned).toEqual([]);
    load.resolve();
    expect(await giving).toEqual({ ok: true });
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      did: "fresh look at the page",
      returned: true,
    });
    expect(browsers.fact("t1")).not.toHaveProperty("control");
    expect(browsers.withCaptain("t1")).toBe(false);
    expect(notes).toContain("t1: you returned control of its browser");
    expect(returned).toEqual([
      {
        taskId: "t1",
        returned: { site: "localhost:5173", once: `browser-returned:${browsers.session}:1:1` },
      },
    ]);
    // A ref from before the handoff is refused, never used on the page he handed back.
    page.effects = [];
    expect((await browser.act({ action: "click", ref: "g1:e3" })).text).toContain(
      `g1:e3 ${REF_FROM_BEFORE_HANDBACK}.`,
    );
    expect(page.effects).toEqual([]);
    // Its first read is its fresh look, as the captain's row says; the next is a read.
    expect((await browser.inspect({ waitFor: "Send" })).text).toContain('button "Send" [g2:e3]');
    expect(browsers.fact("t1")).toMatchObject({ did: "fresh look at the page" });
    await browser.inspect({});
    expect(browsers.fact("t1")).toMatchObject({ did: "read the page" });
    // Each return is a wake of its own.
    await browsers.takeControl("t1", handle);
    await browsers.returnControl("t1", handle);
    expect(returned.map((entry) => entry.returned.once)).toEqual([
      `browser-returned:${browsers.session}:1:1`,
      `browser-returned:${browsers.session}:1:2`,
    ]);
  });

  it("takes and returns only the browser the captain was shown", async () => {
    const { browsers, handle, returned } = await opened();
    const stale = { session: handle.session, generation: 2 };
    expect(await browsers.takeControl("t1", stale)).toMatchObject({ ok: false });
    expect(browsers.fact("t1")).not.toHaveProperty("control");
    await browsers.takeControl("t1", handle);
    expect(await browsers.returnControl("t1", stale)).toMatchObject({ ok: false });
    expect(await browsers.returnControl("t1", { ...handle, session: "another-run" })).toMatchObject(
      { ok: false },
    );
    expect(browsers.fact("t1")).toMatchObject({ control: "captain" });
    expect(returned).toEqual([]);
    expect(await browsers.returnControl("t2", handle)).toMatchObject({ ok: false });
  });

  it("ends honestly when the page crashes or the app quits in his hands, and wakes nobody", async () => {
    const { browsers, browser, page, returned, handle } = await opened();
    await browsers.takeControl("t1", handle);
    page.opened.onGone("crashed");
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", stopped: "gone" });
    expect(browsers.withCaptain("t1")).toBe(false);
    expect(await browsers.returnControl("t1", handle)).toMatchObject({ ok: false });
    expect((await browser.inspect({})).text).toContain("stopped working (crashed)");
    // The next one is fresh and the crewmate's.
    await browser.navigate({ url: "http://localhost:5173/" });
    await browsers.takeControl("t1", { session: handle.session, generation: 2 });
    browsers.closeAll();
    expect(browsers.isOpen("t1")).toBe(false);
    expect(browsers.fact("t1")).toBeUndefined();
    expect(returned).toEqual([]);
  });
});

describe('a crewmate asks the captain for help (docs/task-browser.md, "Asking for help")', () => {
  const request = {
    site: "localhost:5173",
    reason: "The page needs your account to hold the fare",
    after: "fill in the passenger details",
  };

  it("pauses its browser on the site it names, until the captain takes and returns it", async () => {
    const { browsers, pages, notes, returned, fire } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/signin" });
    expect(await browsers.requestHelp("t1", { ...request, site: "aurora.example" })).toEqual({
      ok: false,
      text: "browser_handoff names aurora.example, but this task's browser is on localhost:5173. Name the site it is on.",
    });
    expect(browsers.withCaptain("t1")).toBe(false);
    // The site as an address names the same host and port.
    expect(
      await browsers.requestHelp("t1", { ...request, site: "http://LOCALHOST:5173/signin" }),
    ).toEqual({ ok: true, handle: { session: browsers.session, generation: 1 } });
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      control: "waiting",
      request: { reason: request.reason, after: request.after },
    });
    expect(notes).toContain("t1: asked you to take over its browser at localhost:5173");
    expect(browsers.withCaptain("t1")).toBe(true);
    expect((await browser.inspect({})).text).toContain(
      "You asked the captain to take over this task's browser, so it is paused",
    );
    // Waiting on him, it never stops for being unused.
    fire(TASK_BROWSER_IDLE_MS);
    expect(browsers.isOpen("t1")).toBe(true);
    expect(await browsers.takeControl("t1")).toEqual({ ok: true });
    expect(await browsers.requestHelp("t1", request)).toEqual({
      ok: false,
      text: "the captain already has control of this task's browser.",
    });
    expect(browsers.fact("t1")).toMatchObject({
      control: "captain",
      request: { after: request.after },
    });
    expect(
      await browsers.returnControl("t1", { session: browsers.session, generation: 1 }),
    ).toEqual({ ok: true });
    expect(browsers.fact("t1")).not.toHaveProperty("request");
    expect(returned).toEqual([
      {
        taskId: "t1",
        returned: {
          site: "localhost:5173",
          after: request.after,
          once: `browser-returned:${browsers.session}:1:1`,
        },
      },
    ]);
    expect(pages[0]?.closed).toBe(false);
  });

  it("lets the crewmate withdraw a request still waiting by closing, and refuses one with no browser", async () => {
    const { browsers, pages } = harness();
    expect(await browsers.requestHelp("t1", request)).toEqual({
      ok: false,
      text: "this task has no open browser to hand over. Open one with `infinitary-browser-axi open <url>` first.",
    });
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    await browsers.requestHelp("t1", request);
    expect((await browser.close()).text).toContain("Stopped this task's browser");
    expect(pages[0]?.closed).toBe(true);
    expect(browsers.withCaptain("t1")).toBe(false);
  });
});

describe('a page opens a second page (docs/task-browser.md, "A second page")', () => {
  it("opens it inside the task's browser, moves the crewmate's commands to it, and back when it closes itself", async () => {
    const { browsers, pages, changes } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/pay" });
    const first = pages[0] as FakePage;
    const changed = changes.length;
    const check = openPopup(first, "http://localhost:5173/bank-check") as FakePage;
    expect(check).toBeDefined();
    expect(changes.length).toBeGreaterThan(changed);
    // The captain's view names each page by its own site; the current is the new one.
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      url: "http://localhost:5173/bank-check",
      pages: [
        { site: "localhost:5173", title: "Sign up" },
        { site: "localhost:5173", title: "Sign up" },
      ],
      page: 2,
    });
    const look = (await browser.inspect({})).text;
    expect(look).toContain(
      "The page opened a second page at localhost:5173, page 2, and your commands act on it now.",
    );
    expect(look).toContain('Page 2 of 2: "Sign up" at http://localhost:5173/bank-check');
    expect(look).toContain('Also open: page 1, "Sign up" at http://localhost:5173/pay.');
    // The crewmate's input goes to the second page, by its own refs.
    expect(look).toContain('button "Send" [g2:e3]');
    first.effects = [];
    await browser.act({ action: "click", ref: "g2:e3" });
    expect(check.effects).toContain("click 40,315");
    expect(first.effects).toEqual([]);
    // The first page's ref is refused here, never used on the second page's element.
    check.effects = [];
    expect((await browser.act({ action: "click", ref: "g1:e3" })).text).toBe(
      "g1:e3 is a ref on page 1, and your commands act on page 2 now. Use this page's refs, or switch with `infinitary-browser-axi selectpage 1`.",
    );
    expect(check.effects).toEqual([]);
    // It switches back by place, and its first page's refs still stand.
    expect((await browser.navigate({ page: 1 })).text).toContain("Switched to page 1.");
    expect(browsers.fact("t1")).toMatchObject({ page: 1, url: "http://localhost:5173/pay" });
    await browser.act({ action: "click", ref: "g1:e3" });
    expect(first.effects).toContain("click 40,315");
    expect((await browser.act({ action: "click", ref: "g2:e3" })).text).toContain(
      "g2:e3 is a ref on page 2, and your commands act on page 1 now.",
    );
    expect((await browser.navigate({ page: 3 })).text).toContain("there is no page 3");
    await browser.navigate({ page: 2 });
    // The bank's check closes itself, its window gone with its address: the
    // commands go back to the first page.
    check.current = "";
    check.opened.onClosed();
    expect(browsers.fact("t1")).not.toHaveProperty("pages");
    expect(browsers.fact("t1")).toMatchObject({ url: "http://localhost:5173/pay" });
    const after = (await browser.inspect({})).text;
    expect(after).toContain(
      "Page 2 (localhost:5173) closed itself; your commands act on page 1 again.",
    );
    expect(after).toContain('Page: "Sign up" at http://localhost:5173/pay');
  });

  it("keeps two pages at most, refuses a popup where a page may not go, and closes them all at the end", async () => {
    const { browsers, pages, guards } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const first = pages[0] as FakePage;
    // A popup to another server on this Mac the crewmate never opened is refused.
    expect(openPopup(first, "http://localhost:6006/")).toBeUndefined();
    const second = openPopup(first, "https://bank.example/check") as FakePage;
    expect(second).toBeDefined();
    // A third page is one too many, from either page.
    expect(openPopup(second, "https://bank.example/more")).toBeUndefined();
    const look = (await browser.inspect({})).text;
    expect(look).toContain("other servers on this computer: localhost:6006.");
    expect(look).toContain("The page tried to open another page, refused");
    expect(look).toContain("- https://bank.example/more");
    // The crewmate closes the second page by its place; page 1 only with the browser.
    expect((await browser.close({ page: 1 })).text).toContain("Page 1 is this browser's own page");
    const closed = await browser.close({ page: 2 });
    expect(closed.text).toContain("Closed page 2 (bank.example); your commands act on page 1.");
    expect(second.closed).toBe(true);
    expect(first.closed).toBe(false);
    // Stopping the browser closes every page and its guard.
    const again = openPopup(first, "https://bank.example/check") as FakePage;
    browsers.stopByCaptain("t1");
    expect([first.closed, again.closed, guards[0]?.closed]).toEqual([true, true, true]);
  });

  it("lets the captain pick the page he works on, and the view watch the page that is current", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "https://aurora.example/pay" });
    const first = pages[0] as FakePage;
    const frames: string[] = [];
    const unwatch = browsers.watch("t1", (frame) => frames.push(frame.data));
    first.paint("pay");
    const check = openPopup(first, "https://bank.example/check") as FakePage;
    // The view moves to the new page: the first page's pictures stop, the new one's start.
    expect(first.effects.slice(-1)).toEqual(["unwatch"]);
    expect(check.effects).toContain("watch");
    check.paint("check");
    first.paint("stale");
    expect(frames).toEqual(["pay", "check"]);
    // Watching is not control: the selector is the captain's only while he holds it.
    expect(await browsers.captainInput("t1", { kind: "page", page: 1 })).toMatchObject({
      ok: false,
    });
    expect(await browsers.takeControl("t1")).toEqual({ ok: true });
    expect(await browsers.captainInput("t1", { kind: "page", page: 1 })).toEqual({ ok: true });
    expect(browsers.fact("t1")).toMatchObject({ page: 1, site: "aurora.example" });
    expect(await browsers.captainInput("t1", { kind: "page", page: 2 })).toEqual({ ok: true });
    // His keys go to the page he picked.
    await browsers.captainInput("t1", {
      kind: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      text: "a",
      modifiers: 0,
    });
    expect(check.effects.at(-1)).toBe("input key down");
    // A popup opened in his time is his: the crewmate hears nothing of it.
    check.opened.onClosed();
    expect(
      await browsers.returnControl("t1", { session: browsers.session, generation: 1 }),
    ).toEqual({ ok: true });
    const look = (await browser.inspect({})).text;
    expect(look).not.toContain("closed itself");
    expect(look).toContain('Page: "Sign up" at https://aurora.example/pay');
    unwatch();
  });
});

describe('a browser handed back keeps only what the task needs (docs/task-browser.md, "A signed-in page")', () => {
  async function signedIn() {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "https://aurora.example/sign-in" });
    const handle = { session: h.browsers.session, generation: 1 };
    expect(await h.browsers.takeControl("t1", handle)).toEqual({ ok: true });
    const page = h.pages[0] as FakePage;
    page.current = "https://aurora.example/bookings?session=s3cret#top";
    expect(await h.browsers.returnControl("t1", handle)).toEqual({ ok: true });
    return { ...h, browser, page };
  }

  it("takes a picture only with the task's reason, and says so on the record", async () => {
    const { browser, page, notes, evidence } = await signedIn();
    const refused = await browser.capture({ name: "booking" });
    expect(refused.text).toContain("a picture is taken only when the task needs one");
    expect(refused.image).toBeUndefined();
    expect(page.effects).not.toContain("capture");
    const taken = await browser.capture({
      name: "booking",
      reason: "the captain asked for the booking confirmation",
    });
    expect(taken.image).toBeDefined();
    expect(readFileSync(join(evidence, "t1", "booking.png"))).toEqual(Buffer.from(PNG));
    expect(notes).toContain(
      "t1: photographed its browser's page at aurora.example after you returned control: the captain asked for the booking confirmation",
    );
  });

  it("never reads out or photographs what the captain typed, and reads what the crewmate types itself", async () => {
    const { browsers, browser, page, evidence } = await signedIn();
    // The captain typed a name and a card number into the page and sent nothing.
    const typed = (name: string, card: string): BrowserNode[] => [
      ...formNodes().map((node) => {
        if (node.role === "textbox") return { ...node, value: name };
        if (node.role === "RootWebArea") return { ...node, childIds: [...node.childIds, "6"] };
        return node;
      }),
      {
        id: "6",
        role: "textbox",
        name: "Card number",
        ignored: false,
        childIds: [],
        target: 13,
        value: card,
        properties: {},
      },
    ];
    page.nodeList = typed("Sam Rivera", "4111 1111 1111 1111");
    const look = (await browser.inspect({})).text;
    expect(look).not.toContain("Sam Rivera");
    expect(look).not.toContain("4111");
    // It still reads that each field holds something, and a list's choice.
    expect(look).toContain('textbox "Name" [g2:e1] (value hidden)');
    expect(look).toContain('textbox "Card number" [g2:e4] (value hidden)');
    expect(look).toContain('combobox "Seat" [g2:e2]: "Aisle"');
    // A search never reads it either.
    const search = (await browser.inspect({ find: "4111 1111" })).text;
    expect(search).toContain('No line holds "4111 1111".');
    expect(search).not.toContain('textbox "Card number" [g2:e4]: ');
    const passage = (await browser.inspect({ ref: "g2:e4" })).text;
    expect(passage).toContain("(value hidden)");
    expect(passage).not.toContain("4111");
    // A picture would show them: none is taken, whatever the reason.
    const refused = await browser.capture({ name: "pay", reason: "the task needs the total" });
    expect(refused.image).toBeUndefined();
    expect(refused.text).toContain('textbox "Name" [g2:e1]');
    expect(refused.text).toContain('textbox "Card number" [g2:e4]');
    expect(refused.text).not.toContain("4111");
    expect(page.effects).not.toContain("capture");
    expect(existsSync(join(evidence, "t1", "pay.png"))).toBe(false);
    // What the crewmate types itself is its own to read.
    await browser.act({ action: "type", ref: "g2:e1", text: "Sam Rivera" });
    expect((await browser.inspect({})).text).toContain('textbox "Name" [g2:e1]: "Sam Rivera"');
    // The captain holds the page again: once he hands it back, the name may be his.
    const handle = { session: browsers.session, generation: 1 };
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    expect(await browsers.returnControl("t1", handle)).toEqual({ ok: true });
    expect((await browser.inspect({})).text).toContain('textbox "Name" [g3:e1] (value hidden)');
    // Cleared, the page holds nothing of his, and its picture is taken.
    page.nodeList = typed("", "");
    const taken = await browser.capture({ name: "pay", reason: "the task needs the total" });
    expect(taken.image).toBeDefined();
  });

  it("passes on no address details and no error words, and Open again starts from the bare address", async () => {
    const { browsers, browser, page } = await signedIn();
    page.opened.onPageError("TypeError: account 4421 has no card");
    page.opened.onNavigated("https://aurora.example/manage?ref=AUR-7K2Q&token=abc");
    page.current = "https://aurora.example/manage?ref=AUR-7K2Q&token=abc";
    const look = (await browser.inspect({})).text;
    expect(look).toContain("The page moved to https://aurora.example/manage.");
    expect(look).toContain('Page: "Sign up" at https://aurora.example/manage');
    expect(look).toContain(
      "The page logged an error; on a page that may show the captain's account their words are not passed on.",
    );
    for (const kept of ["token=abc", "AUR-7K2Q", "4421", "session=s3cret"]) {
      expect(look).not.toContain(kept);
    }
    // The fact the captain's own view reads keeps the whole address.
    expect(browsers.fact("t1")).toMatchObject({ url: page.current });
    browsers.stopByCaptain("t1");
    expect(browsers.fact("t1")).toMatchObject({
      state: "stopped",
      url: "https://aurora.example/manage",
    });
  });
});

describe('saved website sign-ins (docs/task-browser.md, "Saved sign-ins")', () => {
  const request = {
    site: "localhost:5173",
    reason: "The account page needs your sign-in",
    after: "read the account page",
  };
  /** The site's own sign-in, one its parent shares, and another site's, as the page left them. */
  const SIGNED_IN: HostCookie[] = [
    {
      name: "sid",
      value: "sam-1",
      domain: "localhost",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "lax",
    },
    {
      name: "tracker",
      value: "elsewhere",
      domain: ".tracker.example",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: false,
      expirationDate: 4_000_000_000,
      sameSite: "no_restriction",
    },
  ];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  /** The browsers on one Mac whose saved sign-ins live in a scratch folder. */
  function onThisMac() {
    const signIns = new WebSignIns(scratchDir("infinitary-web-sign-ins-"), () => 1_000);
    return { ...harness({ signIns, now: () => 1_000 }), signIns };
  }

  /** Task t1's browser, signed in by the captain and handed back, with the tick or without. */
  async function signedInAndReturned(h: ReturnType<typeof onThisMac>, remember: boolean) {
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    page.cookies.cookies = SIGNED_IN.map((cookie) => ({ ...cookie }));
    expect(await h.browsers.returnControl("t1", handle, { remember })).toEqual({ ok: true });
    return { browser, page, handle };
  }

  /** Task t2's browser, asking for the captain's sign-in on the same site. */
  async function asking(h: ReturnType<typeof onThisMac>) {
    const browser = h.browsers.forTask("t2");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    const asked = await h.browsers.requestHelp("t2", request);
    expect(asked).toEqual({ ok: true, handle });
    return { browser, page, handle };
  }

  it("saves the site's sign-in only with the tick on Return control, and only that site's", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, false);
    expect(h.signIns.list()).toEqual([]);
    expect(h.browsers.fact("t1")).not.toHaveProperty("saved");

    const again = onThisMac();
    await signedInAndReturned(again, true);
    expect(again.browsers.savedSignIns()).toEqual([
      { site: "localhost:5173", savedAt: 1_000, id: again.signIns.get("localhost:5173")?.id },
    ]);
    expect(again.signIns.get("localhost:5173")?.cookies.map((cookie) => cookie.name)).toEqual([
      "sid",
    ]);
    // The browser that saved it uses it from now on, and its foot line says so.
    expect(again.browsers.fact("t1")).toMatchObject({ returned: true, saved: ["localhost:5173"] });
  });

  it("refreshes the shown saved site on human handback, including an account change, but never a removed or replaced record (approved plan C)", async () => {
    const h = onThisMac();
    const { page, handle } = await signedInAndReturned(h, true);
    const saved = h.signIns.get(request.site);
    if (!saved) throw new Error("The fixture did not save its sign-in");
    h.signIns.allowAutomatic(saved.site, saved.id, true);
    await h.browsers.takeControl("t1", handle);
    page.cookies.cookies = [{ ...(SIGNED_IN[0] as HostCookie), value: "other-account-session" }];
    expect(
      await h.browsers.returnControl("t1", handle, { site: saved.site, savedId: saved.id }),
    ).toEqual({ ok: true });
    expect(h.signIns.get(saved.site)).toMatchObject({
      id: saved.id,
      automatic: true,
      cookies: [{ ...(SIGNED_IN[0] as HostCookie), value: "other-account-session" }],
    });
    await h.browsers.takeControl("t1", handle);
    h.signIns.remove(saved.site);
    expect(
      await h.browsers.returnControl("t1", handle, { site: saved.site, savedId: saved.id }),
    ).toMatchObject({ ok: true, warning: expect.stringContaining("removed or replaced") });
    expect(h.signIns.get(saved.site)).toBeUndefined();
    await h.browsers.takeControl("t1", handle);
    const replacement = h.signIns.save(saved.site, { cookies: SIGNED_IN, storage: [] });
    expect(
      await h.browsers.returnControl("t1", handle, { site: saved.site, savedId: saved.id }),
    ).toMatchObject({ ok: true, warning: expect.stringContaining("removed or replaced") });
    expect(h.signIns.get(saved.site)).toEqual(replacement);
  });

  it("does not apply Remember for a different site and reports a failed save without blocking handback (approved plan)", async () => {
    const h = onThisMac();
    const { page, handle } = await asking(h);
    await h.browsers.takeControl("t2", handle);
    page.cookies.cookies = SIGNED_IN;
    expect(
      await h.browsers.returnControl("t2", handle, { site: "another.example", remember: true }),
    ).toMatchObject({ ok: true, warning: expect.stringContaining("changed sites") });
    expect(h.signIns.list()).toEqual([]);
    await h.browsers.takeControl("t2", handle);
    page.cookies.all = async () => {
      throw new Error("page gone");
    };
    expect(
      await h.browsers.returnControl("t2", handle, { site: request.site, remember: true }),
    ).toMatchObject({ ok: true, warning: expect.stringContaining("could not be saved") });
    expect(h.signIns.list()).toEqual([]);
    expect(h.returned.filter((event) => event.taskId === "t2")).toHaveLength(2);
  });

  it("uses only explicitly permitted sites on new visits, never retries a rejected save, and still pauses for final submissions (approved direction C)", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, true);
    const saved = h.signIns.get(request.site);
    if (!saved) throw new Error("The fixture did not save its sign-in");
    const ordinary = h.browsers.forTask("ordinary");
    await ordinary.navigate({ url: "http://localhost:5173/account" });
    expect(h.pages.at(-1)?.cookies.cookies).toEqual([]);
    expect(h.browsers.allowAutomaticSignIn(saved.site, saved.id, true)).toEqual({ ok: true });
    const automatic = h.browsers.forTask("automatic");
    const answer = await automatic.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1);
    if (!page) throw new Error("The fixture did not open a page");
    expect(page.cookies.cookies.map((cookie) => cookie.value)).toEqual(["sam-1"]);
    expect(answer.text).toContain("used it automatically");
    expect(h.returned.filter((event) => event.taskId === "automatic")).toEqual([]);
    page.cookies.cookies = [];
    await automatic.navigate({ url: "http://localhost:5173/account" });
    expect(page.cookies.cookies).toEqual([]);
    expect(h.browsers.savedSignInFor("automatic", request.site)).toBeUndefined();
    expect(
      await h.browsers.requestHelp("automatic", {
        ...request,
        reason: "Review and pay",
        after: "Read confirmation",
      }),
    ).toMatchObject({ ok: true });
    expect(h.browsers.fact("automatic")).toMatchObject({ control: "waiting" });
    h.browsers.allowAutomaticSignIn(saved.site, saved.id, false);
    await h.browsers.forTask("revoked").navigate({ url: "http://localhost:5173/account" });
    expect(h.pages.at(-1)?.cookies.cookies).toEqual([]);
    await h.browsers.removeSavedSignIn(saved.site);
    expect(h.browsers.fact("automatic")).not.toHaveProperty("saved");
  });

  it("awaits the home's live permission lookup before answering a remote visit, and carries on signed out when the home cannot be reached (approved plan C)", async () => {
    const store = new WebSignIns(scratchDir("infinitary-web-sign-ins-"));
    const record = store.save(request.site, { cookies: [SIGNED_IN[0] as HostCookie], storage: [] });
    store.allowAutomatic(record.site, record.id, true);
    const requested: string[] = [];
    const remote = harness({
      automaticSignIn: async (task, site) => {
        requested.push(`${task}:${site}`);
        return store.get(site);
      },
    });
    const answer = await remote.browsers
      .forTask("remote")
      .navigate({ url: "http://localhost:5173/account" });
    expect(requested).toEqual([`remote:${record.site}`]);
    expect(remote.pages[0]?.cookies.cookies.map((cookie) => cookie.value)).toEqual(["sam-1"]);
    expect(answer.text).toContain("used it automatically");
    expect(remote.returned).toEqual([]);
    const unavailable = harness({
      automaticSignIn: async () => {
        throw new Error("out of reach");
      },
    });
    const signedOut = await unavailable.browsers
      .forTask("remote")
      .navigate({ url: "http://localhost:5173/account" });
    expect(signedOut.refused).toBeUndefined();
    expect(unavailable.pages[0]?.cookies.cookies).toEqual([]);
    expect(await unavailable.browsers.requestHelp("remote", request)).toMatchObject({ ok: true });
  });

  it("offers a saved sign-in only on its own site, to a browser that holds none of the captain's", async () => {
    const h = onThisMac();
    expect(h.browsers.savedSignInFor("t1", "localhost:5173")).toBeUndefined();
    await signedInAndReturned(h, true);
    // The browser that holds the captain's sign-in already is never offered one.
    expect(h.browsers.savedSignInFor("t1", "localhost:5173")).toBeUndefined();
    await asking(h);
    expect(h.browsers.savedSignInFor("t2", "http://LOCALHOST:5173/account")).toEqual({
      site: "localhost:5173",
      savedAt: 1_000,
    });
    expect(h.browsers.savedSignInFor("t2", "aurora.example")).toBeUndefined();
    expect(h.browsers.savedSignInFor("t3", "localhost:5173")).toBeUndefined();
  });

  it("copies the saved sign-in into a waiting browser, reloads it, and wakes its crewmate once", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, true);
    const { browser, page, handle } = await asking(h);
    // The crewmate read the sign-in page's refs before it asked.
    expect(page.cookies.cookies).toEqual([]);
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({ ok: true });
    expect(page.cookies.cookies.map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual([
      "sid=sam-1",
    ]);
    expect(page.effects.at(-1)).toBe("reload");
    expect(h.browsers.fact("t2")).toMatchObject({
      state: "open",
      did: "fresh look at the page",
      saved: ["localhost:5173"],
    });
    expect(h.browsers.fact("t2")).not.toHaveProperty("control");
    expect(h.browsers.fact("t2")).not.toHaveProperty("request");
    expect(h.browsers.withCaptain("t2")).toBe(false);
    expect(h.notes).toContain("t2: you let it use your saved sign-in at localhost:5173");
    expect(h.returned.filter((entry) => entry.taskId === "t2")).toEqual([
      {
        taskId: "t2",
        returned: {
          site: "localhost:5173",
          after: request.after,
          saved: true,
          once: `browser-saved-sign-in:${h.browsers.session}:1:localhost:5173`,
        },
      },
    ]);
    // Its refs from before are refused, its first look says why, and the page may show the
    // captain's account, so a picture needs the task's reason.
    expect((await browser.act({ action: "click", ref: "g1:e3" })).text).toContain(
      `g1:e3 ${REF_FROM_BEFORE_HANDBACK}.`,
    );
    expect((await browser.inspect({})).text).toContain(
      "The captain let this task use the sign-in saved for localhost:5173 on this computer, and the page reloaded with it",
    );
    page.opened.onConsole("info", "saved-sign-in-secret");
    const console = (await browser.inspect({ show: "console" })).text;
    expect(console).toContain("info: 1");
    expect(console).not.toContain("saved-sign-in-secret");
    const refused = await browser.capture({});
    expect(refused.text).toContain(
      "This browser uses a sign-in the captain saved, so its pages may show the captain's account",
    );
    await browser.capture({ reason: "the task needs the account's status" });
    expect(h.notes).toContain(
      "t2: photographed its browser's page at localhost:5173 while it used your saved sign-in: the task needs the account's status",
    );
  });

  it("refuses a grant to a browser not waiting for the captain, a stale one, or with nothing saved", async () => {
    const h = onThisMac();
    const { handle } = await asking(h);
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({
      ok: false,
      text: "No sign-in for localhost:5173 is saved on this computer.",
    });
    expect(h.browsers.fact("t2")).toMatchObject({ control: "waiting" });
    await signedInAndReturned(h, true);
    expect(await h.browsers.grantSavedSignIn("t2", { ...handle, generation: 2 })).toMatchObject({
      ok: false,
    });
    expect(await h.browsers.grantSavedSignIn("t1", { ...handle })).toEqual({
      ok: false,
      text: "This browser is no longer waiting for your sign-in.",
    });
    // A browser that takes none of the cookies stays paused for the captain.
    const page = h.pages[0] as FakePage;
    page.cookies.refuse = true;
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({
      ok: false,
      text: "This computer could not use your saved sign-in right now.",
    });
    expect(h.browsers.fact("t2")).toMatchObject({ control: "waiting" });
    expect(h.returned.filter((entry) => entry.taskId === "t2")).toEqual([]);
  });

  it("offers nothing more once a site turned the saved sign-in away, so the captain signs in", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, true);
    const { handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    // The site bound its session to the browser that made it: the crewmate asks again.
    expect(await h.browsers.requestHelp("t2", request)).toMatchObject({ ok: true });
    expect(h.browsers.savedSignInFor("t2", "localhost:5173")).toBeUndefined();
  });

  it("copies the sign-in back when the browser stops, so a refreshed session stays current", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, true);
    const { browser, page, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    const first = h.signIns.get("localhost:5173")?.id;
    // The site refreshed its session while the task used it.
    page.cookies.cookies = page.cookies.cookies.map((cookie) => ({ ...cookie, value: "sam-2" }));
    await browser.close();
    await tick();
    expect(page.closed).toBe(true);
    expect(h.signIns.get("localhost:5173")).toMatchObject({
      id: first,
      savedAt: 1_000,
      cookies: [expect.objectContaining({ name: "sid", value: "sam-2" })],
    });
    // A site that holds nothing now copies nothing back over the save.
    const t1 = h.pages[0] as FakePage;
    t1.cookies.cookies = [];
    h.browsers.stopByCaptain("t1");
    await tick();
    expect(h.signIns.get("localhost:5173")?.cookies).toHaveLength(1);
  });

  it("signs out every browser using a sign-in the captain removes, and never copies it back", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, true);
    const { browser, page, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    page.cookies.cookies.push({ ...SIGNED_IN[1] } as HostCookie);
    expect(await h.browsers.removeSavedSignIn("LOCALHOST:5173")).toEqual({ ok: true });
    expect(h.browsers.savedSignIns()).toEqual([]);
    // Its own cookies go; another site's stay.
    expect(page.cookies.cookies.map((cookie) => cookie.name)).toEqual(["tracker"]);
    expect(h.browsers.fact("t2")).not.toHaveProperty("saved");
    expect(h.browsers.fact("t1")).not.toHaveProperty("saved");
    expect(h.notes).toContain(
      "t2: your saved sign-in at localhost:5173 was removed, and its browser signed out of it",
    );
    expect((await browser.inspect({})).text).toContain(
      "The captain removed the sign-in saved for localhost:5173 from this computer, so this browser is no longer signed in there.",
    );
    page.cookies.cookies.push({ ...(SIGNED_IN[0] as HostCookie) });
    await browser.close();
    await tick();
    expect(h.signIns.get("localhost:5173")).toBeUndefined();
    expect(await h.browsers.removeSavedSignIn("localhost:5173")).toEqual({
      ok: false,
      text: "No sign-in for localhost:5173 is saved on this computer.",
    });
  });

  /** The account page's own origin, where a site may keep its sign-in in page storage. */
  const ORIGIN = "http://localhost:5173";

  /** Task t1's browser, signed in by the captain on a page that keeps its sign-in in page storage, handed back with the tick. */
  async function storedAndReturned(h: ReturnType<typeof onThisMac>) {
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    page.store.put(ORIGIN, { session: "sam-1" });
    page.store.put("https://aurora.example", { token: "another site's" });
    expect(await h.browsers.returnControl("t1", handle, { remember: true })).toEqual({ ok: true });
    return { browser, page, handle };
  }

  it("saves a site that keeps its sign-in in page storage, its own origin's alone, and nothing for a site holding neither", async () => {
    const empty = onThisMac();
    const { page: blank, handle } = await asking(empty);
    await empty.browsers.takeControl("t2", handle);
    expect(await empty.browsers.returnControl("t2", handle, { remember: true })).toEqual({
      ok: true,
      warning: "Control returned, but this site has no supported sign-in to save.",
    });
    expect(blank.effects).toContain(`read storage ${ORIGIN}`);
    expect(empty.signIns.list()).toEqual([]);
    expect(empty.browsers.fact("t2")).not.toHaveProperty("saved");

    const h = onThisMac();
    await storedAndReturned(h);
    expect(h.signIns.get("localhost:5173")).toMatchObject({
      cookies: [],
      storage: [{ origin: ORIGIN, items: [["session", "sam-1"]] }],
    });
    expect(h.browsers.fact("t1")).toMatchObject({ returned: true, saved: ["localhost:5173"] });
  });

  it("copies the page storage into the waiting page's own origin before it reloads", async () => {
    const h = onThisMac();
    await storedAndReturned(h);
    const { page, handle } = await asking(h);
    // The browser started empty: nothing of the site's storage is in it.
    expect(page.store.origins.size).toBe(0);
    expect(h.browsers.savedSignInFor("t2", "localhost:5173")).toEqual({
      site: "localhost:5173",
      savedAt: 1_000,
    });
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({ ok: true });
    expect(page.store.of(ORIGIN)).toEqual({ session: "sam-1" });
    expect([...page.store.origins.keys()]).toEqual([ORIGIN]);
    // The site reads it on the load after.
    expect(page.effects.slice(-2)).toEqual([`write storage ${ORIGIN}`, "reload"]);
    expect(h.browsers.fact("t2")).toMatchObject({ saved: ["localhost:5173"] });
    expect(h.returned.filter((entry) => entry.taskId === "t2")).toHaveLength(1);
  });

  it("offers no page storage to a page on another of the site's origins, and grants none", async () => {
    const h = onThisMac();
    h.signIns.save("localhost:5173", {
      cookies: [],
      storage: [{ origin: "https://localhost:5173", items: [["session", "sam-1"]] }],
    });
    const { page, handle } = await asking(h);
    expect(h.browsers.savedSignInFor("t2", "localhost:5173")).toBeUndefined();
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({
      ok: false,
      text: "No sign-in for localhost:5173 is saved on this computer.",
    });
    expect(page.store.origins.size).toBe(0);
    expect(h.browsers.fact("t2")).toMatchObject({ control: "waiting" });
  });

  it("leaves the browser paused for the captain when its page refuses the storage", async () => {
    const h = onThisMac();
    await storedAndReturned(h);
    const { page, handle } = await asking(h);
    page.store.refuse = true;
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({
      ok: false,
      text: "This computer could not use your saved sign-in right now.",
    });
    expect(page.effects).not.toContain("reload");
    expect(h.browsers.fact("t2")).toMatchObject({ control: "waiting" });
    expect(h.returned.filter((entry) => entry.taskId === "t2")).toEqual([]);
  });

  it("copies the page storage back when the browser stops, and never reads a page on another site", async () => {
    const h = onThisMac();
    await storedAndReturned(h);
    const { browser, page, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    // The site refreshed its session while the task used it, and a page opened on another site.
    page.store.put(ORIGIN, { session: "sam-2", visit: "2" });
    const bank = openPopup(page, "https://bank.example/check") as FakePage;
    page.store.put("https://bank.example", { token: "the bank's" });
    await browser.close();
    await tick();
    expect(h.signIns.get("localhost:5173")?.storage).toEqual([
      {
        origin: ORIGIN,
        items: [
          ["session", "sam-2"],
          ["visit", "2"],
        ],
      },
    ]);
    expect(bank.effects.filter((effect) => effect.startsWith("read storage"))).toEqual([]);
  });

  it("clears the site's own page storage in every browser using a sign-in the captain removes", async () => {
    const h = onThisMac();
    const { page: first } = await storedAndReturned(h);
    const { page, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    page.store.put("https://localhost:5173", { session: "the secure one" });
    page.store.put("https://aurora.example", { token: "another site's" });
    expect(await h.browsers.removeSavedSignIn("localhost:5173")).toEqual({ ok: true });
    // Its own origins' storage goes; another site's stays.
    expect([...page.store.origins.keys()]).toEqual(["https://aurora.example"]);
    expect([...first.store.origins.keys()]).toEqual(["https://aurora.example"]);
  });

  it("closes at once when the app quits, and copies nothing back", async () => {
    const h = onThisMac();
    const { page } = await signedInAndReturned(h, true);
    page.cookies.cookies = page.cookies.cookies.map((cookie) => ({ ...cookie, value: "late" }));
    h.browsers.closeAll();
    expect(page.closed).toBe(true);
    await tick();
    expect(h.signIns.get("localhost:5173")?.cookies[0]?.value).toBe("sam-1");
  });
});

describe('a final submission is never sent twice (docs/task-browser.md, "A final submission")', () => {
  const request = {
    site: "localhost:5173",
    reason: "The final payment is yours to make",
    after: "read the confirmation and keep the reference",
  };

  it("refuses to reload a form's answer for the crewmate, and to go back to one the browser did not keep", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/pay" });
    const page = pages[0] as FakePage;
    // The page now answers the form the captain sent: the host will not load it again.
    page.reloadOutcome = { ok: false, code: FORM_RESEND };
    const reload = await browser.navigate({ go: "reload" });
    expect(reload.text).toContain(
      "Did not reload: this page is the answer to a form that was sent, and reloading it would send the form again. This browser never sends a form twice.",
    );
    expect(reload.text).not.toContain("Reloaded the page.");
    // It still reads the page as it is, and the captain's line says it sent nothing.
    expect(reload.text).toContain('Page: "Sign up" at http://localhost:5173/pay');
    expect(page.effects).not.toContain("reload");
    expect(browsers.fact("t1")).toMatchObject({ did: "did not resend a form" });
    // Back to a form's answer the browser did not keep would send the form too.
    page.historyOutcome = { ok: false, code: "ERR_CACHE_MISS" };
    expect((await browser.navigate({ go: "back" })).text).toContain(
      "That page was the answer to a form that was sent, and going to it again would send the form again, so the browser showed nothing",
    );
  });

  it("refuses the captain's Reload of a form's answer in words, and sends his other moves", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/pay" });
    const page = pages[0] as FakePage;
    const handle = { session: browsers.session, generation: 1 };
    await browsers.requestHelp("t1", request);
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    page.reloadOutcome = { ok: false, code: FORM_RESEND };
    expect(await browsers.captainInput("t1", { kind: "go", go: "reload" })).toEqual({
      ok: false,
      text: FORM_RESEND_CAPTAIN_WORDS,
    });
    expect(page.effects).not.toContain("reload");
    page.historyOutcome = { ok: true };
    expect(await browsers.captainInput("t1", { kind: "go", go: "back" })).toEqual({ ok: true });
    expect(page.effects.at(-1)).toBe("history back");
  });

  it("keeps a waiting page that answers a form as it is when a saved sign-in is granted", async () => {
    const signIns = new WebSignIns(scratchDir("infinitary-web-sign-ins-"), () => 1_000);
    signIns.save("localhost:5173", {
      cookies: [
        {
          name: "sid",
          value: "sam-1",
          domain: "localhost",
          hostOnly: true,
          path: "/",
          secure: false,
          httpOnly: true,
          sameSite: "lax",
        },
      ],
      storage: [],
    });
    const { browsers, pages } = harness({ signIns, now: () => 1_000 });
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/pay" });
    const page = pages[0] as FakePage;
    page.reloadOutcome = { ok: false, code: FORM_RESEND };
    await browsers.requestHelp("t1", request);
    expect(
      await browsers.grantSavedSignIn("t1", { session: browsers.session, generation: 1 }),
    ).toEqual({ ok: true });
    expect(page.effects).not.toContain("reload");
    // Its fresh look says so rather than claiming a reload.
    const look = (await browser.inspect({})).text;
    expect(look).toContain("The page answers a form that was sent, so it was not reloaded");
    expect(look).not.toContain("the page reloaded with it");
  });
});

describe("piece 4 browser actions", () => {
  it("hovers, drags, fills text without submitting, and scrolls to either edge", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    await browser.act({ action: "hover", ref: "g1:e3" });
    await browser.act({ action: "drag", ref: "g1:e1", to: "g1:e3" });
    await browser.act({ action: "fill", fields: [{ ref: "g1:e1", text: "Ada" }] });
    await browser.act({ action: "fill", fields: [{ ref: "g1:e1", text: "" }] });
    await browser.act({ action: "scroll", direction: "top" });
    await browser.act({ action: "scroll", direction: "bottom" });
    expect(page.effects).toEqual(
      expect.arrayContaining([
        "hover 40,315",
        "drag 12 30",
        "insert Ada",
        "press Backspace",
        "scroll top",
        "scroll bottom",
      ]),
    );
    expect(page.effects).not.toContain("press Enter");
    const fact = browsers.fact("t1");
    expect(fact?.state === "open" ? fact.did : undefined).not.toContain("Ada");
  });

  it("refuses stale destinations and later fields before any input, plus non-text fields", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    const before = [...page.effects];
    expect((await browser.act({ action: "drag", ref: "g1:e1", to: "g9:e1" })).text).toContain(
      "ref",
    );
    expect(
      (
        await browser.act({
          action: "fill",
          fields: [
            { ref: "g1:e1", text: "Ada" },
            { ref: "g9:e1", text: "bad" },
          ],
        })
      ).text,
    ).toContain("ref");
    expect(
      (await browser.act({ action: "fill", fields: [{ ref: "g1:e3", text: "bad" }] })).text,
    ).toContain("not an editable text field");
    expect(page.effects).toEqual(before);
    expect((await browser.capture({ ref: "g9:e1" })).image).toBeUndefined();
    expect(page.effects).toEqual(before);
  });

  it("stops a multi-field fill after a move rather than using old targets", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    page.insertText = async (text) => {
      page.effects.push(`insert ${text}`);
      page.current = "http://localhost:5173/next";
      page.opened.onNavigated(page.current);
    };
    const result = await browser.act({
      action: "fill",
      fields: [
        { ref: "g1:e1", text: "first" },
        { ref: "g1:e1", text: "second" },
      ],
    });
    expect(result.text).toContain("Stopped after filling 1 fields");
    expect(page.effects).not.toContain("insert second");
  });

  it("captures an element but keeps whole-page privacy and captain-control guards", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    expect((await browser.capture({ ref: "g1:e3" })).image).toBeDefined();
    expect(page.effects).toContain("capture target 30");
    expect((await browser.capture({ ref: "g1:e3", fullPage: true })).image).toBeUndefined();
    const handle = { session: browsers.session, generation: 1 };
    await browsers.takeControl("t1", handle);
    const before = [...page.effects];
    for (const input of [
      { action: "hover" as const, ref: "g1:e3" },
      { action: "drag" as const, ref: "g1:e1", to: "g1:e3" },
      { action: "fill" as const, fields: [{ ref: "g1:e1", text: "Ada" }] },
      { action: "scroll" as const, direction: "bottom" as const },
    ])
      expect((await browser.act(input)).text).toContain("captain");
    expect((await browser.capture({ ref: "g1:e3" })).image).toBeUndefined();
    expect(page.effects).toEqual(before);
    await browsers.returnControl("t1", handle);
    page.nodeList = formNodes().map((node) =>
      node.role === "textbox" ? { ...node, value: "private" } : node,
    );
    await browser.inspect({});
    expect((await browser.capture({ ref: "g2:e3" })).text).toContain("reason");
    const refused = await browser.capture({ ref: "g2:e3", reason: "Need the button" });
    expect(refused.image).toBeUndefined();
    expect(refused.text).not.toContain("private");
    expect(refused.text).toContain("holds text you did not type");
    expect(page.effects.filter((effect) => effect.startsWith("capture"))).toEqual([
      "capture target 30",
    ]);
  });
});

// The captain's words (INF-1454): "shouldn't task browser be invisible on my
// desktop?" A page's file request goes to no picker on the page's hidden
// window: the captain's own pick when they hold it, and otherwise, by their
// choice, a file the crewmate attaches from its own working copy.
describe("a page that asks for a file", () => {
  /** A working copy with a file to attach, and a file outside it a link leads to. */
  function workingCopy(): { root: string; outside: string } {
    const dir = scratchDir("infinitary-browser-files-");
    const root = join(dir, "work");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "certificate.pdf"), "%PDF-1.4");
    writeFileSync(join(root, ".git", "config"), "[core]");
    const outside = join(dir, "private.txt");
    writeFileSync(outside, "not the task's");
    symlinkSync(outside, join(root, "link.txt"));
    return { root, outside };
  }

  it("tells the crewmate, which attaches a file from its working copy and nothing outside it", async () => {
    const { root, outside } = workingCopy();
    const h = harness({ workingCopy: root });
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    expect(
      (await browser.act({ action: "upload", files: ["docs/certificate.pdf"] })).text,
    ).toContain("has not asked for a file");
    page.opened.onFileChooser({ target: 40, multiple: false });
    expect((await browser.inspect({})).text).toContain("The page asks for a file");
    for (const file of [outside, "link.txt", "../private.txt", ".git/config"]) {
      expect((await browser.act({ action: "upload", files: [file] })).text).toContain(
        "not in your working copy",
      );
    }
    expect((await browser.act({ action: "upload", files: ["docs"] })).text).toContain(
      "is not a file in your working copy",
    );
    expect(
      (
        await browser.act({
          action: "upload",
          files: ["docs/certificate.pdf", "docs/certificate.pdf"],
        })
      ).text,
    ).toContain("takes one file");
    expect(page.effects.filter((effect) => effect.startsWith("files"))).toEqual([]);
    const attached = await browser.act({ action: "upload", files: ["docs/certificate.pdf"] });
    expect(attached.text).toContain('Attached "certificate.pdf"');
    expect(attached.text).not.toContain("The page asks for a file");
    expect(page.effects.filter((effect) => effect.startsWith("files"))).toEqual([
      `files 40 ${realpathSync(join(root, "docs", "certificate.pdf"))}`,
    ]);
    // A request the page moved away from is gone with its document.
    page.opened.onFileChooser({ target: 41, multiple: true });
    page.opened.onNavigated("http://localhost:5173/next");
    expect(
      (await browser.act({ action: "upload", files: ["docs/certificate.pdf"] })).text,
    ).toContain("has not asked for a file");
  });

  it("opens the app's own picker for the captain, and the crewmate is told nothing of it", async () => {
    const picks: boolean[] = [];
    const h = harness({
      chooseFiles: async ({ multiple }) => {
        picks.push(multiple);
        return ["/Users/captain/receipt.pdf", "/Users/captain/other.pdf"];
      },
    });
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    page.opened.onFileChooser({ target: 40, multiple: false });
    await expect
      .poll(() => page.effects.filter((effect) => effect.startsWith("files")))
      .toEqual(["files 40 /Users/captain/receipt.pdf"]);
    expect(picks).toEqual([false]);
    await h.browsers.returnControl("t1", handle);
    expect((await browser.inspect({})).text).not.toContain("asks for a file");
  });

  it("leaves a request on another computer's browser to the crewmate, and says so on the record", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    page.opened.onFileChooser({ target: 40, multiple: false });
    expect(h.notes.some((note) => note.includes("its page asked for a file"))).toBe(true);
    await h.browsers.returnControl("t1", handle);
    expect((await browser.inspect({})).text).toContain("The page asks for a file");
  });

  it("tells the crewmate a page asked to print or opened a color picker, which never open", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    page.opened.onPicker("print");
    page.opened.onPicker("color");
    const text = (await browser.inspect({})).text;
    expect(text).toContain("this browser never prints");
    expect(text).toContain("color picker: this browser never shows one");
  });
});
