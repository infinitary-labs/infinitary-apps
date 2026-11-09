import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type FakePage,
  formNodes,
  harness,
  openPopup,
  PNG,
} from "../../../tests/helpers/taskBrowserStandIn";
import { addressKind } from "./addresses";
import { NOTHING_CHANGED_LINE } from "./changes";
import type { GuardRefusal } from "./connectionGuard";
import { TASK_BROWSER_COMMAND_MS } from "./crewmateCommands";
import { type BrowserNode, REF_FROM_EARLIER_PAGE, REF_PATTERN, refusedRefWords } from "./outline";
import { TASK_BROWSER_IDLE_MS } from "./taskBrowsers";

/**
 * Each task's own browser, against the stand-in host whose page records every
 * effect it is asked for (tests/helpers/taskBrowserStandIn.ts): what a
 * crewmate reads and does on a page: opening, outlines, refs, actions,
 * pictures, notices and the guarded diagnostic lists. The host's real page is
 * the desktop's (src/main/host/taskBrowser.ts), driven end to end by the task
 * browser journeys (tests/e2e/task-browser*.spec.ts).
 */

/** What the guard reports of a name and the addresses it answered, each read by its kind. */
const guardSaw = (
  host: string,
  kind: GuardRefusal["kind"],
  ...addresses: string[]
): GuardRefusal => ({
  host,
  kind,
  answers: addresses.map((address) => ({ address, kind: addressKind(address) })),
});

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

  it("names the page's ref book in its refs line as the typed facts do, none until a read numbers it", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const refsLine = (text: string) => text.split("\n").find((line) => line.startsWith("refs: "));
    const numbered = await browser.inspect({ show: "console" });
    expect(numbered.page?.refs).toMatch(/^g\d+$/);
    expect(refsLine(numbered.text)).toBe(`refs: ${numbered.page?.refs}`);
    // Handing the page back gives it a fresh book that no read has numbered yet.
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    await h.browsers.returnControl("t1", handle);
    for (const show of ["console", "network"] as const) {
      const listed = await browser.inspect({ show });
      expect(listed.page?.refs).toBe("none");
      expect(refsLine(listed.text)).toBe("refs: none");
    }
    await browser.inspect({});
    const renumbered = await browser.inspect({ show: "network" });
    expect(renumbered.page?.refs).toMatch(/^g\d+$/);
    expect(renumbered.page?.refs).not.toBe(numbered.page?.refs);
    expect(refsLine(renumbered.text)).toBe(`refs: ${renumbered.page?.refs}`);
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

  // INF-3116, answers A, 4 and 5: the captain's private sites list, read
  // again at each open, lets the crewmate and any page reach a listed site
  // over https or http; a list that cannot be read keeps the last one.
  it("opens a private site once the captain lists it, over http too, and lets its pages reach it", async () => {
    let sites: string[] = [];
    let reachable = true;
    const asked: string[] = [];
    const { browsers, pages, guards } = harness({
      privateSites: async (taskId) => {
        asked.push(taskId);
        if (!reachable) throw new Error("the home is out of reach");
        return sites;
      },
    });
    const browser = browsers.forTask("t1");
    const before = await browser.navigate({ url: "http://wiki.corp.example/" });
    expect(before.text).toContain("naming wiki.corp.example.");
    expect(pages).toHaveLength(0);
    sites = [".corp.example"];
    const opened = await browser.navigate({ url: "http://wiki.corp.example/" });
    expect(opened.text).toContain("Opened http://wiki.corp.example/.");
    expect(asked).toEqual(["t1", "t1"]);
    const page = pages[0] as FakePage;
    expect(page.opened.allow({ url: "http://chat.corp.example/live", topLevel: false })).toBe(true);
    expect(page.opened.allow({ url: "http://tracker.example/", topLevel: false })).toBe(false);
    expect(guards[0]?.listed?.("wiki.corp.example")).toBe(true);
    expect(guards[0]?.listed?.("corp.example.org")).toBe(false);
    // The home out of reach: the list last read still stands.
    reachable = false;
    expect((await browser.navigate({ url: "http://docs.corp.example/" })).text).toContain(
      "Opened http://docs.corp.example/.",
    );
    // INF-3129 review, the captain's ruling: a Remove takes effect in the open
    // browser at once - its pages and its guard refuse the site, and the
    // guard ends the connections the listing let through.
    browsers.privateSitesChanged([]);
    expect(page.opened.allow({ url: "http://chat.corp.example/live", topLevel: false })).toBe(
      false,
    );
    expect(guards[0]?.listed?.("wiki.corp.example")).toBe(false);
    expect(guards[0]?.rechecks).toBe(1);
  });

  it("refuses a website over plain http and a private address without opening a browser", async () => {
    const { browsers, pages, guards } = harness();
    const plain = await browsers.forTask("t1").navigate({ url: "http://skyfare.example/" });
    expect(plain.text).toContain(
      "over plain http only when it is a private site the captain allowed",
    );
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
    guards[0]?.onRefused(guardSaw("rebind.skyfare.example", "private", "127.0.0.1"));
    guards[0]?.onRefused(guardSaw("rebind.skyfare.example", "private", "127.0.0.1"));
    guards[0]?.onRefused(guardSaw("ads.nowhere.example", "unresolved"));
    const look = (await browser.inspect({})).text;
    expect(look).toContain(
      "Blocked what the page asked for on this computer's network or another private one: rebind.skyfare.example (2).",
    );
    expect(look).toContain("refused at the connection");
    expect(look).toContain("Could not find what the page asked for: ads.nowhere.example.");
    // Its own load refused at the connection says why, by the guard's word.
    page.loadOutcome = { ok: false, code: "ERR_TUNNEL_CONNECTION_FAILED" };
    // INF-3116: it names the address and its kind, and that the captain can allow it (answer A).
    guards[0]?.onRefused(guardSaw("wiki.corp.example", "private", "10.20.30.40"));
    const refused = await browser.navigate({ url: "https://wiki.corp.example:8443/" });
    expect(refused.text).toContain(
      "wiki.corp.example:8443 leads to 10.20.30.40, an address on a private network such as an office or VPN network, so the browser refused it at the connection. Task browsers reach public websites, the pages on this computer you open and the private sites the captain allowed. The captain can allow it for task browsers: if the task needs wiki.corp.example, ask the first mate in your report (needs_firstmate), naming wiki.corp.example.",
    );
    // Its lead says it once; the summary does not say it again.
    expect(refused.text).not.toContain("Blocked what the page asked for");
    guards[0]?.onRefused(guardSaw("rebind.skyfare.example", "private", "127.0.0.1"));
    const here = await browser.navigate({ url: "https://rebind.skyfare.example/" });
    expect(here.text).toContain(
      "rebind.skyfare.example leads to 127.0.0.1, an address on this computer, so the browser refused it at the connection. To open a page served on this computer, open it by localhost instead",
    );
    guards[0]?.onRefused(guardSaw("filtered.example", "private", "0.0.0.0"));
    const filtered = await browser.navigate({ url: "https://filtered.example/" });
    expect(filtered.text).toContain(
      "filtered.example leads to 0.0.0.0, a reserved address that is not on the internet, so the browser refused it at the connection. A proxy app or DNS filter usually gives such an address in place of a site's own.",
    );
    // A mixed name whose public answer did not respond names what it skipped.
    guards[0]?.onRefused(
      guardSaw("portal.corp.example", "unreachable", "2606:4700:10::6814:2011", "10.0.0.5"),
    );
    const portal = await browser.navigate({ url: "https://portal.corp.example/" });
    expect(portal.text).toContain(
      "portal.corp.example did not answer at its public address, 2606:4700:10::6814:2011. The browser skipped 10.0.0.5, an address on a private network such as an office or VPN network, which it never dials. Task browsers reach public websites",
    );
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
    expect(unchanged.text).toContain(NOTHING_CHANGED_LINE);
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
    expect((await browser.act({ action: "click", ref: "g1:e3" })).text).toBe(
      refusedRefWords("g1:e3", { kind: "earlier-browser" }),
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
