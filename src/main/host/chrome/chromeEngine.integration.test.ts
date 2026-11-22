import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ConnectionGuardHandle, startConnectionGuard } from "@core/browser/connectionGuard";
import {
  FORM_RESEND,
  type HostAskKind,
  type HostBrowserOpen,
  type HostBrowserPage,
  type HostBrowserRefusal,
  type HostDownloadOutcome,
  type HostPopup,
} from "@core/host";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { customApiCaFixture } from "../../../../tests/helpers/customApiCaFixture";
import { scratchDir } from "../../../../tests/helpers/scratchDirs";
import {
  type ChromeEngine,
  ChromeUnavailable,
  chromeMajor,
  createChromeEngine,
} from "./chromeEngine";
import { findChrome } from "./findChrome";

/**
 * Google Chrome as the task browser's second engine (docs/task-browser.md,
 * "Google Chrome as a second engine"; INF-4585's plan, piece 2), driven for
 * real: the Chrome installed on this computer, a local site, and the
 * browser's own connection guard. Each case is a promise the plan makes of
 * the engine. A computer without Chrome has nothing to drive, so the file
 * is a probe and its cases say so rather than pass.
 */

// Each case starts its own Chrome (docs/test-cohorts.md budget).
vi.setConfig({ testTimeout: 15_000 });

/**
 * The Chrome to drive: this computer's, where it can draw. Chrome opens
 * real windows, so a Linux computer with no display has nothing to drive
 * even when Chrome is installed.
 */
const chrome =
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? undefined
    : findChrome(process.platform, process.env, homedir());
const site = { server: undefined as Server | undefined, port: 0 };
/** What the local site saw: each path it was asked for. */
const seen: { path: string }[] = [];
/** Connections the guard made for a browser, each to a public address it checked. */
const guarded: string[] = [];
/** A name off this computer the guard resolves to a stand-in address, which it reaches on loopback. */
const PUBLIC_NAME = "shop.example.com";
const PUBLIC_ADDRESS = "93.184.215.14";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Sign up</title><h1>Sign up</h1>
<label>Name <input id="name"></label>
<button id="go" onclick="document.getElementById('out').textContent = 'hi ' + document.getElementById('name').value">Go</button>
<p id="out"></p>`,
  "/facts": `<!doctype html><title>Facts</title><p id="facts"></p><script>
document.getElementById('facts').textContent = JSON.stringify({
  webdriver: navigator.webdriver,
  brands: (navigator.userAgentData?.brands ?? []).map((b) => b.brand),
  ua: navigator.userAgent,
  width: innerWidth,
  height: innerHeight,
});</script>`,
  "/picture": `<!doctype html><title>Picture</title><img src="/refused.png"><img src="/allowed.png">`,
  "/dialog": `<!doctype html><title>Dialog</title><button id="ask" onclick="document.getElementById('said').textContent = String(confirm('Pay now?'))">Ask</button><p id="said"></p>`,
  "/file": `<!doctype html><title>File</title><input type="file" id="f">`,
  "/opens": `<!doctype html><title>Opener</title><button id="open" onclick="window.open('/second')">Open</button><button id="other" onclick="window.open('/refused-window')">Other</button>`,
  "/second": `<!doctype html><title>Second</title><p>second page</p>`,
  "/opens-check": `<!doctype html><title>Shop</title><button onclick="window.open('/check', 'bank-check')">Pay</button>`,
  "/check": `<!doctype html><title>Check</title><button onclick="window.close()">Approve</button>`,
  "/download": `<!doctype html><title>Download</title><a id="get" href="/file.txt" download>Get</a>`,
  "/form": `<!doctype html><title>Form</title><form method="post" action="/sent"><button id="send">Send</button></form>`,
  "/form-popup": `<!doctype html><title>Form popup</title><form method="post" action="/sent" target="_blank"><input name="confirmation" value="draft"><button>Send</button></form>`,
  "/asks": `<!doctype html><title>Asks</title><button id="notify" onclick="Notification.requestPermission().then((a) => { document.getElementById('said').textContent = 'answer ' + a + ', now ' + Notification.permission })">Notify</button><p id="said"></p>`,
  "/cookie": `<!doctype html><title>Cookie</title><script>document.cookie = "club=member; path=/"</script>`,
  "/stored": `<!doctype html><title>Stored</title><script>localStorage.setItem("session", "sam")</script>`,
  "/show": `<!doctype html><title>Show</title><p id="v"></p><script>document.getElementById("v").textContent = "stored " + localStorage.getItem("session")</script>`,
};

function serve(request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? "/").replace(/^https?:\/\/[^/]+/, "");
  seen.push({ path });
  if (path === "/sign-in-box") {
    response.writeHead(401, { "www-authenticate": 'Basic realm="club"' });
    response.end("no");
    return;
  }
  if (path === "/file.txt") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="receipt.txt"',
    });
    response.end("a receipt");
    return;
  }
  if (path === "/sent") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Sent</title><p>sent</p>");
    return;
  }
  if (path.endsWith(".png")) {
    response.writeHead(200, { "content-type": "image/png" });
    response.end();
    return;
  }
  // Three sites: a page off this computer, a frame on localhost, and inside
  // it a frame on 127.0.0.1, which Chrome runs in a process of its own
  // under the middle frame's. Its own requests and its worker's reach a
  // loopback address: the core judges each.
  const nested: Record<string, string> = {
    "/nest-top": `<!doctype html><title>Nest</title><iframe src="http://localhost:${site.port}/nest-middle"></iframe>`,
    "/nest-middle": `<!doctype html><title>Middle</title><iframe src="http://127.0.0.1:${site.port}/nest-inner"></iframe>`,
    "/nest-inner": `<!doctype html><title>Inner</title><script>
fetch("http://127.0.0.1:${site.port}/refused-nested").catch(() => undefined);
new Worker(URL.createObjectURL(new Blob(['fetch("http://127.0.0.1:${site.port}/refused-worker").catch(() => undefined)'], { type: "text/javascript" })));
</script>`,
  };
  // A page that opens a websocket to the site it is on, and one to a port
  // no browser opened, which only the guard can refuse.
  if (path === "/sockets") {
    nested[path] = `<!doctype html><title>Sockets</title><script>
new WebSocket("ws://127.0.0.1:${site.port}/live");
new WebSocket("ws://127.0.0.1:${other.port}/elsewhere");
new WebSocket("ws://localhost:${other.port}/elsewhere");
</script>`;
  }
  const page = nested[path] ?? PAGES[path];
  response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html" });
  response.end(page ?? "not here");
}

/** Other ports on this computer a case's browser opened, as a crewmate opening them registers them. */
const openedPorts = new Set<number>();

/** A server on another port of this computer, which no browser opened: each connection it was asked for. */
const other = { server: undefined as Server | undefined, port: 0, reached: 0 };

beforeAll(async () => {
  const unopened = createServer(() => undefined);
  unopened.on("connection", (socket) => {
    other.reached += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => unopened.listen(0, "127.0.0.1", resolve));
  other.server = unopened;
  other.port = (unopened.address() as { port: number }).port;
  const server = createServer(serve);
  // A live-reload socket asks to upgrade; the site notes it and hangs up.
  server.on("upgrade", (request: IncomingMessage, socket) => {
    seen.push({ path: `upgrade ${request.url}` });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.server = server;
  site.port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => other.server?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => site.server?.close(() => resolve()) ?? resolve());
});

type Recorded = {
  refused: HostBrowserRefusal[];
  dialogs: string[];
  choosers: number;
  popups: string[];
  navigated: string[];
  downloads: HostDownloadOutcome[];
  blocked: string[];
  /** How each page that went ended: closed itself, or gone with a reason. */
  ended: string[];
  /** Each ask the page put to the core. */
  asks: HostAskKind[];
};

const engines: ChromeEngine[] = [];
const guards: ConnectionGuardHandle[] = [];

afterEach(async () => {
  // Chrome lets go of its profile only when it exits, before the scratch folder goes.
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  for (const guard of guards.splice(0)) guard.close();
});

function engine(dir = scratchDir("chrome-engine-"), kept?: { kept: true }): ChromeEngine {
  const made = createChromeEngine({
    ...kept,
    executable: () => chrome,
    platform: process.platform,
    profileDir: join(dir, "profile"),
    downloadsDir: join(dir, "downloads"),
    env: () => process.env,
    clipboardText: () => "",
    log: () => undefined,
  });
  engines.push(made);
  return made;
}

/** A browser open as the core asks for one: its policy refuses `/refused` paths. */
async function opening(
  options: { popups?: boolean; downloads?: string; ask?: (kind: HostAskKind) => boolean } = {},
): Promise<{ open: HostBrowserOpen; recorded: Recorded }> {
  const recorded: Recorded = {
    refused: [],
    dialogs: [],
    choosers: 0,
    popups: [],
    navigated: [],
    downloads: [],
    blocked: [],
    ended: [],
    asks: [],
  };
  const guard = await startConnectionGuard({
    onRefused: () => undefined,
    lookup: async (host) => (host === PUBLIC_NAME ? [PUBLIC_ADDRESS] : []),
    // A plain http page off this computer is carried only for a listed name.
    listed: (host) => host === PUBLIC_NAME,
    // The browser opened the local site, on either of its names: only its
    // port on this computer is the browser's.
    local: (_host, port) => port === site.port || openedPorts.has(port),
    connect: (address, port) => {
      if (address !== PUBLIC_ADDRESS) return connect(port, address);
      // The stand-in public address is the local site.
      guarded.push(address);
      return connect(site.port, "127.0.0.1");
    },
  });
  guards.push(guard);
  const events = (sink: string[]) => ({
    onNavigated: (url: string) => sink.push(url),
    onLoadFailed: () => undefined,
    onDialog: (kind: string, message: string) => recorded.dialogs.push(`${kind}: ${message}`),
    onFileChooser: () => {
      recorded.choosers += 1;
    },
    onPicker: () => undefined,
    onPopup: (url: string): HostPopup | undefined => {
      recorded.popups.push(url);
      if (!options.popups || url.includes("refused")) return undefined;
      return {
        events: events([]),
        viewport: { width: 800, height: 600 },
        opened: (page) => secondPages.push(page),
      };
    },
    onPageError: () => undefined,
    onConsole: () => undefined,
    onNetwork: () => undefined,
    onGone: (reason: string) => recorded.ended.push(`gone: ${reason}`),
    onClosed: () => recorded.ended.push("closed itself"),
    onAsk: async ({ kind }: { kind: HostAskKind }) => {
      recorded.asks.push(kind);
      return options.ask?.(kind) ?? false;
    },
  });
  const open: HostBrowserOpen = {
    ...events(recorded.navigated),
    viewport: { width: 1280, height: 800 },
    proxy: {
      host: guard.host,
      port: guard.port,
      username: guard.username,
      password: guard.password,
    },
    allow: ({ url }) => {
      if (new URL(url).pathname.startsWith("/refused")) {
        recorded.blocked.push(url);
        return false;
      }
      return true;
    },
    onRefused: (refusal) => recorded.refused.push(refusal),
    onDownload: (offer) =>
      options.downloads
        ? {
            path: join(options.downloads, offer.name),
            done: (outcome) => recorded.downloads.push(outcome),
          }
        : undefined,
  };
  return { open, recorded };
}

const secondPages: HostBrowserPage[] = [];
const local = (path: string): string => `http://127.0.0.1:${site.port}${path}`;

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let round = 0; round < 100; round++) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the page never showed it");
}

/** The page's own words for one element, read from its accessibility tree. */
async function textOf(page: HostBrowserPage, words: string): Promise<string | undefined> {
  const nodes = await page.nodes();
  return nodes.find((node) => node.name.includes(words))?.name;
}

async function targetNamed(page: HostBrowserPage, name: string, role?: string): Promise<number> {
  const nodes = await page.nodes();
  const node = nodes.find((n) => n.name === name && (!role || n.role === role) && n.target);
  if (!node?.target) throw new Error(`no ${name} on the page`);
  return node.target;
}

async function press(page: HostBrowserPage, name: string, role = "button"): Promise<void> {
  const box = await page.box(await targetNamed(page, name, role));
  if (!box) throw new Error(`${name} has no box`);
  await page.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

describe.skipIf(!chrome)("Google Chrome as the task browser's second engine", () => {
  it("opens a page in this computer's Chrome that sites see as Google Chrome, not automation", async () => {
    const { open } = await opening();
    const dir = scratchDir("chrome-capture-");
    const running = engine(dir);
    const page = await running.open(open);
    expect(page.engine).toMatchObject({ kind: "chrome" });
    expect(chromeMajor(`Chrome/${(page.engine as { version: string }).version}`)).toBeGreaterThan(
      0,
    );
    expect(await page.load(local("/facts"))).toEqual({ ok: true, status: 200 });
    const facts = JSON.parse(await until(() => textOf(page, "webdriver")));
    expect(facts.webdriver).toBe(false);
    expect(facts.brands).toContain("Google Chrome");
    expect(facts.ua).not.toMatch(/Electron|Headless|infinitary/i);
    // The page is sized, not Chrome's window, whose own bars take room of their own.
    expect({ width: facts.width, height: facts.height }).toEqual({ width: 1280, height: 800 });
    const reading = running.pages()[0];
    expect(await reading?.shown()).toBe(false);
    const picture = await page.capture({ fullPage: false });
    expect(picture).toMatchObject({ width: 1280, height: 800 });
    expect(await reading?.shown()).toBe(false);
    page.close();
    await running.stop();
    expect(existsSync(join(dir, "downloads"))).toBe(false);
  });

  it("types and clicks with real input, and asks the core about every request", async () => {
    const { open, recorded } = await opening();
    const page = await engine().open(open);
    await page.load(local("/"));
    await page.focus(await targetNamed(page, "Name", "textbox"));
    await page.insertText("Ada");
    await press(page, "Go");
    expect(await until(() => textOf(page, "hi Ada"))).toBe("hi Ada");
    seen.length = 0;
    await page.load(local("/picture"));
    await until(() => seen.some((hit) => hit.path === "/allowed.png") || undefined);
    expect(seen.map((hit) => hit.path)).not.toContain("/refused.png");
    expect(recorded.blocked).toContain(local("/refused.png"));
    expect(await page.load(local("/refused-page"))).toEqual({
      ok: false,
      code: "ERR_BLOCKED_BY_CLIENT",
    });
    page.close();
  });

  it("asks the core about the requests of a frame inside a frame from other sites, and of its worker", async () => {
    const { open, recorded } = await opening();
    const page = await engine().open(open);
    seen.length = 0;
    await page.load(`http://${PUBLIC_NAME}:${site.port}/nest-top`);
    await until(
      () =>
        (recorded.blocked.includes(local("/refused-nested")) &&
          recorded.blocked.includes(local("/refused-worker"))) ||
        undefined,
    );
    expect(seen.map((hit) => hit.path)).toContain("/nest-inner");
    expect(seen.map((hit) => hit.path)).not.toContain("/refused-nested");
    expect(seen.map((hit) => hit.path)).not.toContain("/refused-worker");
    page.close();
  });

  it("opens a websocket only to a port on this computer the browser opened, from a page here or off it", async () => {
    const { open } = await opening();
    const page = await engine().open(open);
    seen.length = 0;
    other.reached = 0;
    await page.load(local("/sockets"));
    await until(() => seen.some((hit) => hit.path === "upgrade /live") || undefined);
    await page.load(`http://${PUBLIC_NAME}:${site.port}/sockets`);
    await until(() => seen.filter((hit) => hit.path === "upgrade /live").length === 2 || undefined);
    expect(other.reached).toBe(0);
    page.close();
  });

  it("reaches a name off this computer only through the browser's guard, signed in as that browser", async () => {
    const { open } = await opening();
    const page = await engine().open(open);
    guarded.length = 0;
    expect(await page.load(`http://${PUBLIC_NAME}:${site.port}/facts`)).toEqual({
      ok: true,
      status: 200,
    });
    // A page on plain http is no secure context, so Chrome gives it no brands to show.
    expect(await until(() => textOf(page, "webdriver"))).toContain('"webdriver":false');
    expect(guarded).toContain(PUBLIC_ADDRESS);
    page.close();
  });

  it("never goes past a certificate that does not verify, and tells the core", async () => {
    const certificates = customApiCaFixture(scratchDir("chrome-ca-"));
    const untrusted = createSecureServer(
      { key: certificates.leafKey, cert: certificates.leaf },
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Untrusted</title><p>This page should not open</p>");
      },
    );
    await new Promise<void>((resolve) => untrusted.listen(0, "127.0.0.1", resolve));
    try {
      const port = (untrusted.address() as { port: number }).port;
      openedPorts.add(port);
      const at = `https://localhost:${port}/`;
      const { open, recorded } = await opening();
      const page = await engine().open(open);
      const outcome = await page.load(at);
      expect(outcome).toMatchObject({ ok: false, code: expect.stringMatching(/^ERR_CERT_/) });
      expect(recorded.refused).toContainEqual({
        kind: "certificate",
        url: at,
        code: expect.stringMatching(/^net::ERR_CERT_/),
      });
      // Nothing on the page offers to go on anyway.
      const words = (await page.nodes()).map((node) => node.name).join(" ");
      expect(words).not.toMatch(/proceed|should not open/i);
      page.close();
    } finally {
      openedPorts.clear();
      untrusted.close();
    }
  });

  it("refuses a site's sign-in box and tells the core", async () => {
    const { open, recorded } = await opening();
    const page = await engine().open(open);
    await page.load(local("/sign-in-box"));
    expect(recorded.refused).toContainEqual({ kind: "sign-in-box", url: local("/sign-in-box") });
    page.close();
  });

  it("dismisses a dialog and takes a page's request for a file", async () => {
    const { open, recorded } = await opening();
    const page = await engine().open(open);
    await page.load(local("/dialog"));
    await press(page, "Ask");
    expect(await until(() => textOf(page, "false"))).toBe("false");
    expect(recorded.dialogs).toEqual(["confirm: Pay now?"]);
    await page.load(local("/file"));
    const field = await targetNamed(page, "Choose File", "button").catch(async () => {
      const nodes = await page.nodes();
      const node = nodes.find((n) => n.role === "button" && n.target);
      if (!node?.target) throw new Error("no file field");
      return node.target;
    });
    const box = await page.box(field);
    if (!box) throw new Error("the file field has no box");
    await page.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await until(() => recorded.choosers > 0 || undefined);
    page.close();
  });

  it("asks the core before a site's permission, grants a yes in Chrome, and takes it back", async () => {
    let allow = true;
    const { open, recorded } = await opening({ ask: (kind) => allow && kind === "notifications" });
    const page = await engine().open(open);
    await page.load(local("/asks"));
    await press(page, "Notify");
    expect(await until(() => textOf(page, "answer"))).toBe("answer granted, now granted");
    expect(recorded.asks).toEqual(["notifications"]);
    await page.revokeAsks();
    allow = false;
    await page.load(local("/asks"));
    await press(page, "Notify");
    expect(await until(() => textOf(page, "answer"))).toBe("answer denied, now denied");
    expect(recorded.asks).toEqual(["notifications", "notifications"]);
    page.close();
  });

  it("opens a second page the core lets in, and never one it refuses", async () => {
    secondPages.length = 0;
    const { open, recorded } = await opening({ popups: true });
    const page = await engine().open(open);
    await page.load(local("/opens"));
    await press(page, "Open");
    const second = await until(() => secondPages[0]);
    await until(() => second.url().endsWith("/second") || undefined);
    await until(() => second.title() === "Second" || undefined);
    await press(page, "Other");
    await until(() => recorded.popups.find((url) => url.includes("refused-window")));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondPages).toHaveLength(1);
    page.close();
  });

  it("tells the core a second page closed itself", async () => {
    secondPages.length = 0;
    const { open, recorded } = await opening({ popups: true });
    const page = await engine().open(open);
    await page.load(local("/opens-check"));
    await press(page, "Pay");
    const second = await until(() => secondPages[0]);
    await until(() => second.title() === "Check" || undefined);
    await press(second, "Approve");
    await until(() => recorded.ended[0]);
    expect(recorded.ended).toEqual(["closed itself"]);
    expect(page.url()).toBe(local("/opens-check"));
    page.close();
  });

  it("opens a form's answer in a second page, sent once and never again on reload", async () => {
    secondPages.length = 0;
    const { open, recorded } = await opening({ popups: true });
    const page = await engine().open(open);
    await page.load(local("/form-popup"));
    const before = seen.filter((request) => request.path === "/sent").length;
    await press(page, "Send");
    const second = await until(() => secondPages[0]);
    await until(() => second.url().endsWith("/sent") || undefined);
    expect(recorded.popups).toEqual([local("/sent")]);
    expect(seen.filter((request) => request.path === "/sent").length).toBe(before + 1);
    await second.settle();
    expect(await second.reload()).toEqual({ ok: false, code: FORM_RESEND });
    expect(seen.filter((request) => request.path === "/sent").length).toBe(before + 1);
    page.close();
  });

  it("saves a download where the core says", async () => {
    const downloads = scratchDir("chrome-downloads-");
    const { open, recorded } = await opening({ downloads });
    const page = await engine().open(open);
    await page.load(local("/download"));
    await press(page, "Get", "link");
    const outcome = await until(() => recorded.downloads[0]);
    expect(outcome.state).toBe("completed");
    expect(readFileSync(join(downloads, "receipt.txt"), "utf8")).toBe("a receipt");
    page.close();
  });

  it("never reloads the answer to a form that was sent", async () => {
    const { open } = await opening();
    const page = await engine().open(open);
    await page.load(local("/form"));
    await press(page, "Send");
    await until(() => page.url().endsWith("/sent") || undefined);
    await page.settle();
    expect(await page.reload()).toEqual({ ok: false, code: FORM_RESEND });
    page.close();
  });

  it("gives each browser its own empty site data, gone when it closes", async () => {
    const chromeEngine = engine();
    const first = await opening();
    const one = await chromeEngine.open(first.open);
    await one.load(local("/cookie"));
    expect((await one.cookies.all()).map((cookie) => cookie.name)).toContain("club");
    const second = await opening();
    const two = await chromeEngine.open(second.open);
    expect(await two.cookies.all()).toEqual([]);
    one.close();
    two.close();
  });

  it("keeps a sign-in held only for the browser's session in the kept profile after its last browser closed", async () => {
    // The kept profile lasts while the app runs, as the built-in engine's
    // kept partition does: a later task allowed the site finds the cookie.
    const kept = engine(undefined, { kept: true });
    const { open } = await opening();
    const one = await kept.open(open);
    await one.load(local("/cookie"));
    expect((await one.cookies.all()).map((cookie) => cookie.name)).toContain("club");
    one.close();
    const two = await kept.open(open);
    expect((await two.cookies.all()).map((cookie) => cookie.name)).toContain("club");
    two.close();
  });

  it("signs the kept profile out of a site's page storage, with a page open there and with none", async () => {
    const kept = engine(undefined, { kept: true });
    const { open } = await opening();
    const origin = `http://127.0.0.1:${site.port}`;
    const one = await kept.open(open);
    await one.load(local("/stored"));
    await one.load(local("/show"));
    expect(await until(() => textOf(one, "stored"))).toBe("stored sam");
    // Remove while a task's page is open in the kept profile.
    await kept.forget?.(() => [], [origin]);
    await one.load(local("/show"));
    expect(await until(() => textOf(one, "stored"))).toBe("stored null");
    await one.load(local("/stored"));
    one.close();
    // Remove with no page open there.
    await kept.forget?.(() => [], [origin]);
    const two = await kept.open(open);
    await two.load(local("/show"));
    expect(await until(() => textOf(two, "stored"))).toBe("stored null");
    two.close();
  });
});

describe("a computer whose Chrome cannot open the browser", () => {
  it("says Chrome is not installed when the computer has none", async () => {
    const { open } = await opening();
    const dir = scratchDir("chrome-none-");
    const none = createChromeEngine({
      executable: () => undefined,
      platform: process.platform,
      profileDir: join(dir, "profile"),
      downloadsDir: join(dir, "downloads"),
      env: () => process.env,
      clipboardText: () => "",
      log: () => undefined,
    });
    await expect(none.open(open)).rejects.toMatchObject({ reason: "not-installed" });
  });

  /** A stand-in Chrome that answers its pipe as a Chrome of `product` would, or ends at once. */
  function standIn(dir: string, product: string | undefined): string {
    const path = join(dir, "chrome");
    const answer = product
      ? `const out = require("node:fs").createWriteStream(null, { fd: 4 });
require("node:fs").createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  for (const text of chunk.toString().split("\\0").filter(Boolean)) {
    const { id } = JSON.parse(text);
    out.write(JSON.stringify({ id, result: { product: ${JSON.stringify(product)} } }) + "\\0");
  }
});`
      : "process.exit(3);";
    writeFileSync(path, `#!${process.execPath}\n${answer}\n`, { mode: 0o755 });
    return path;
  }

  it.each([
    ["too-old", "Chrome/120.0.6099.71"],
    ["would-not-start", undefined],
  ] as const)("says %s for a Chrome that answers as %s", async (reason, product) => {
    const { open } = await opening();
    const dir = scratchDir("chrome-stand-in-");
    const executable = standIn(dir, product);
    expect(existsSync(executable)).toBe(true);
    const declined = createChromeEngine({
      executable: () => executable,
      platform: process.platform,
      profileDir: join(dir, "profile"),
      downloadsDir: join(dir, "downloads"),
      env: () => process.env,
      clipboardText: () => "",
      log: () => undefined,
    });
    const error = await declined.open(open).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ChromeUnavailable);
    expect(error).toMatchObject({ reason });
  });

  it("stops a Chrome that a failed open was the only use of", async () => {
    const { open } = await opening();
    const dir = scratchDir("chrome-refuses-");
    const executable = join(dir, "chrome");
    const closed = join(dir, "closed");
    // Answers as a current Chrome, refuses to make a browser, and marks Browser.close.
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const out = fs.createWriteStream(null, { fd: 4 });
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  for (const text of chunk.toString().split("\\0").filter(Boolean)) {
    const { id, method } = JSON.parse(text);
    if (method === "Browser.close") {
      fs.writeFileSync(${JSON.stringify(closed)}, "");
      process.exit(0);
    }
    const answer = method === "Target.createBrowserContext"
      ? { id, error: { code: -32000, message: "no browser here" } }
      : { id, result: method === "Browser.getVersion" ? { product: "Chrome/157.0.0.0" } : {} };
    out.write(JSON.stringify(answer) + "\\0");
  }
});
`,
      { mode: 0o755 },
    );
    const refusing = createChromeEngine({
      executable: () => executable,
      platform: process.platform,
      profileDir: join(dir, "profile"),
      downloadsDir: join(dir, "downloads"),
      env: () => process.env,
      clipboardText: () => "",
      log: () => undefined,
    });
    await expect(refusing.open(open)).rejects.toMatchObject({ reason: "would-not-start" });
    await until(() => existsSync(closed));
  });
});
