import { describe, expect, it } from "vitest";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type FakePage, harness } from "../../../tests/helpers/taskBrowserStandIn";
import { HERE } from "../../shared/deviceNames";
import { FORM_RESEND, type HostLoadOutcome } from "../host";
import { NOTHING_CHANGED_LINE } from "./changes";
import { type BrowserNode, REF_FROM_BEFORE_HANDBACK } from "./outline";
import type { ProjectServer } from "./projectServer";
import { FORM_RESEND_CAPTAIN_WORDS, TASK_BROWSER_IDLE_MS } from "./taskBrowsers";
import { WebSignIns } from "./webSignIns";

/**
 * Each task's own browser, against the stand-in host whose page records every
 * effect it is asked for (tests/helpers/taskBrowserStandIn.ts): the hand-off
 * between crewmate and captain: taking control, a page from the project,
 * asking for help and a final submission. The host's real page is the
 * desktop's (src/main/host/taskBrowser.ts), driven end to end by the task
 * browser journeys (tests/e2e/task-browser*.spec.ts).
 */

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
    expect(unchanged.text).toContain(NOTHING_CHANGED_LINE);
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
    guards[0]?.onRefused({
      host: "bank-intranet.example",
      kind: "private",
      answers: [{ address: "10.1.2.3", kind: "private" }],
    });
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

  // INF-5578's audit, finding 2: a sign-in the captain made ended on a
  // program's address on this computer the crewmate never opened, and
  // neither the captain nor the crewmate was told why the page was blocked.
  it("names a page resting on a refused address, to the captain's view and in the crewmate's first look", async () => {
    const { browsers, browser, page, handle } = await opened();
    expect(browsers.fact("t1")).not.toHaveProperty("blocked");
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    // A page that rests on a program's address no move reached, as a kept
    // profile's refused page does, shows the engine's own refusal there.
    const callback = "http://localhost:1455/auth/callback?code=secret-sign-in-code";
    page.current = callback;
    // The refusal has no title of its own: the engine gives its address.
    page.pageTitle = callback.replace("http://", "");
    // Its tab reads the refused host and port, never the code its title carries.
    expect(browsers.fact("t1")).toMatchObject({ title: "localhost:1455" });
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      site: "localhost:1455",
      control: "captain",
      blocked: "local",
    });
    expect(await browsers.returnControl("t1", handle)).toEqual({ ok: true });
    const look = (await browser.inspect({})).text;
    expect(look).toContain(
      `The captain returned control of this browser: this is a fresh look at the page as it is now, and refs from before are gone.\nThis page is the browser's own refusal of localhost:1455, another server on ${HERE.this} that this task has not opened`,
    );
    expect(look).toContain("infinitary-browser-axi open http://localhost:1455/");
    // Its host and port alone: the rest of the address may carry the sign-in's code.
    const told = look.split("\n").find((line) => line.startsWith("This page is the browser's"));
    expect(told).not.toContain("auth/callback");
    // Nor does the code reach it through the address the page took as its title.
    expect(look).not.toContain("secret-sign-in-code");
    expect(look).toContain("localhost:1455/auth/callback");
    // Opening the program lets the task's pages reach it, and the page that moved on is not blocked.
    await browser.navigate({ url: "http://localhost:1455/" });
    expect(browsers.fact("t1")).not.toHaveProperty("blocked");
    expect(page.opened.allow({ url: callback, topLevel: true })).toBe(true);
  });

  // The captain's "yeah we should do that" to letting a page's own move open
  // a local address, while a website's hidden requests to it stay refused.
  it("lets a sign-in's return reach a program on this computer and keeps other pages off it", async () => {
    const { browsers, page, handle } = await opened();
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    const callback = "http://localhost:1455/auth/callback?code=secret-sign-in-code";
    const site = "https://auth.example.com/authorize";
    // A website's hidden request to the program, before or after, is refused.
    const hidden = { url: "http://localhost:1455/token", topLevel: false, page: site };
    expect(page.opened.allow(hidden)).toBe(false);
    // The sign-in's redirect is the page's own move, and its page loads its parts.
    expect(page.opened.allow({ url: callback, topLevel: true, page: site })).toBe(true);
    page.current = callback;
    const part = { url: "http://localhost:1455/app.js", topLevel: false, page: callback };
    expect(page.opened.allow(part)).toBe(true);
    expect(browsers.fact("t1")).not.toHaveProperty("blocked");
    expect(page.opened.allow(hidden)).toBe(false);
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

describe('a page from the project (docs/task-browser.md, "A page from the project")', () => {
  // Guardrails for TaskBrowsers.openPage before INF-2625's plan splits
  // taskBrowsers.ts: no other test reaches opening a page, serving its
  // folder or loading it.
  const FOLDER = "/Users/someone/projects/meteor-run";

  /** The project folders the browsers served, each a stand-in for the loopback server. */
  function folderServers(refuse: () => boolean = () => false) {
    const served: { folder: string; origin: string; closed: boolean }[] = [];
    const serve = async (folder: string): Promise<ProjectServer> => {
      if (refuse()) throw new Error("no port to listen on");
      const record = {
        folder,
        origin: `http://127.0.0.1:${41_000 + served.length}`,
        closed: false,
      };
      served.push(record);
      return {
        folder,
        origin: record.origin,
        close: () => {
          record.closed = true;
        },
      };
    };
    return { served, serve };
  }

  it("opens it in a fresh browser that is the captain's own from the start, which only the task's removal stops", async () => {
    const { served, serve } = folderServers();
    const { browsers, pages, notes } = harness({ serve });
    const opened = await browsers.openPage("t1", { folder: FOLDER, path: "play/index.html" });
    expect(opened).toEqual({ ok: true, handle: { session: browsers.session, generation: 1 } });
    expect(served).toEqual([{ folder: FOLDER, origin: "http://127.0.0.1:41000", closed: false }]);
    expect(pages).toHaveLength(1);
    const page = pages[0] as FakePage;
    expect(page.effects).toEqual(["load http://127.0.0.1:41000/play/index.html"]);
    expect(notes).toEqual(["t1: you opened play/index.html from its project in its browser"]);
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      site: "127.0.0.1:41000",
      url: "http://127.0.0.1:41000/play/index.html",
      control: "captain",
      own: true,
      generation: 1,
    });
    // The served folder's origin is the browser's own; another server on this Mac is not.
    expect(page.opened.allow({ url: "http://127.0.0.1:41000/play/game.js", topLevel: false })).toBe(
      true,
    );
    expect(page.opened.allow({ url: "http://127.0.0.1:5173/", topLevel: false })).toBe(false);
    // No crewmate opened it, so none uses it.
    expect((await browsers.forTask("t1").inspect({})).text).toContain(
      "The captain has control of this task's browser",
    );
    browsers.closeTask("t1");
    expect(browsers.isOpen("t1")).toBe(true);
    expect(served[0]?.closed).toBe(false);
    browsers.closeTask("t1", { gone: true });
    expect(browsers.isOpen("t1")).toBe(false);
    expect(page.closed).toBe(true);
    expect(served[0]?.closed).toBe(true);
  });

  it("closes on Close page with its server and wakes nobody, and Open again serves the folder afresh as his", async () => {
    const { served, serve } = folderServers();
    const { browsers, pages, notes, returned } = harness({ serve });
    const opened = await browsers.openPage("t1", { folder: FOLDER, path: "index.html" });
    if (!opened.ok) throw new Error(opened.text);
    expect(await browsers.returnControl("t1", opened.handle)).toEqual({ ok: true });
    expect(browsers.isOpen("t1")).toBe(false);
    expect(served[0]?.closed).toBe(true);
    expect(returned).toEqual([]);
    expect(notes).toContain("t1: you closed the page you opened in its browser");
    expect(browsers.fact("t1")).toMatchObject({ state: "stopped", stopped: "captain" });
    expect(await browsers.reopen("t1")).toEqual({ ok: true });
    expect(served).toEqual([
      { folder: FOLDER, origin: "http://127.0.0.1:41000", closed: true },
      { folder: FOLDER, origin: "http://127.0.0.1:41001", closed: false },
    ]);
    expect(pages[1]?.effects).toEqual(["load http://127.0.0.1:41001/index.html"]);
    expect(browsers.fact("t1")).toMatchObject({
      state: "open",
      url: "http://127.0.0.1:41001/index.html",
      control: "captain",
      own: true,
      generation: 2,
    });
  });

  it("takes the crewmate's open browser first, keeps one server for one folder, and hands it back as usual", async () => {
    const { served, serve } = folderServers();
    const { browsers, pages, notes, returned } = harness({ serve });
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const opened = await browsers.openPage("t1", { folder: FOLDER, path: "index.html" });
    expect(opened).toEqual({ ok: true, handle: { session: browsers.session, generation: 1 } });
    expect(pages).toHaveLength(1);
    expect(notes).toContain("t1: you took control of its browser");
    expect(page.effects.at(-1)).toBe("load http://127.0.0.1:41000/index.html");
    const fact = browsers.fact("t1");
    expect(fact).toMatchObject({ state: "open", control: "captain", generation: 1 });
    expect(fact).not.toHaveProperty("own");
    // The same folder again is served by the same server; another folder replaces it.
    await browsers.openPage("t1", { folder: FOLDER, path: "about.html" });
    expect(page.effects.at(-1)).toBe("load http://127.0.0.1:41000/about.html");
    expect(served).toHaveLength(1);
    await browsers.openPage("t1", { folder: `${FOLDER}-two`, path: "index.html" });
    expect(page.effects.at(-1)).toBe("load http://127.0.0.1:41001/index.html");
    expect(served.map((server) => server.closed)).toEqual([true, false]);
    if (!opened.ok) throw new Error(opened.text);
    expect(await browsers.returnControl("t1", opened.handle)).toEqual({ ok: true });
    expect(returned.map((wake) => wake.taskId)).toEqual(["t1"]);
    expect(browsers.isOpen("t1")).toBe(true);
    expect(served[1]?.closed).toBe(false);
    await browser.close();
    expect(served[1]?.closed).toBe(true);
  });

  it("refuses in words when the folder cannot be served, past the cap, or with no browser to start, keeping no server", async () => {
    let refuseServe = true;
    let refuseOpen = false;
    const { served, serve } = folderServers(() => refuseServe);
    const { browsers, pages } = harness({ serve, max: 1, refuseOpen: () => refuseOpen });
    const page = { folder: FOLDER, path: "index.html" };
    expect(await browsers.openPage("t1", page)).toEqual({
      ok: false,
      text: `${HERE.This} could not serve this project's files.`,
    });
    expect(pages).toHaveLength(0);
    refuseServe = false;
    refuseOpen = true;
    expect(await browsers.openPage("t1", page)).toEqual({
      ok: false,
      text: `${HERE.This} could not open a browser for this task right now.`,
    });
    expect(served).toEqual([{ folder: FOLDER, origin: "http://127.0.0.1:41000", closed: true }]);
    refuseOpen = false;
    await browsers.forTask("t2").navigate({ url: "http://localhost:5174/" });
    expect(await browsers.openPage("t1", page)).toEqual({
      ok: false,
      text: `One task browsers are already open on ${HERE.this}. Stop one, then press the button again.`,
    });
    expect(served).toHaveLength(1);
    expect(browsers.isOpen("t1")).toBe(false);
  });

  it("leaves the crewmate's browser in the captain's hands when the folder cannot be served", async () => {
    let refuseServe = false;
    const { serve } = folderServers(() => refuseServe);
    const { browsers, pages } = harness({ serve });
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    refuseServe = true;
    expect(await browsers.openPage("t1", { folder: FOLDER, path: "index.html" })).toEqual({
      ok: false,
      text: `${HERE.This} could not serve this project's files.`,
    });
    expect(browsers.fact("t1")).toMatchObject({ state: "open", control: "captain" });
    expect(pages[0]?.effects.at(-1)).toBe("load http://localhost:5173/");
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

describe('the crewmate takes back its request (docs/task-browser.md, "Asking for help")', () => {
  const request = {
    site: "localhost:5173",
    reason: "The page needs your account to hold the fare",
    after: "fill in the passenger details",
  };

  it("keeps the browser and its pages, and hands the commands back to the crewmate", async () => {
    const { browsers, pages, notes } = harness();
    const browser = browsers.forTask("t1");
    expect((await browser.close({ withdraw: true })).text).toBe(
      "No browser is open for this task, so no request waits.",
    );
    await browser.navigate({ url: "http://localhost:5173/" });
    expect((await browser.close({ withdraw: true })).text).toBe(
      "No request for the captain's help waits on this browser: it is yours to use as it is.",
    );
    await browsers.requestHelp("t1", request);
    expect((await browser.inspect({})).text).toContain("withdraw");
    expect((await browser.close({ withdraw: true })).text).toBe(
      `Withdrew your request: the browser is yours again at localhost:5173, with its pages, history and sign-ins as they were. Close your request card with close_card if it is still up, and run \`infinitary-browser-axi snapshot\` to read the page.`,
    );
    expect(notes).toContain(
      "t1: withdrew its request for you to take over its browser at localhost:5173",
    );
    expect(browsers.fact("t1")).toMatchObject({ state: "open" });
    expect(browsers.fact("t1")).not.toHaveProperty("control");
    expect(browsers.fact("t1")).not.toHaveProperty("request");
    expect(browsers.withCaptain("t1")).toBe(false);
    expect(pages[0]?.closed).toBe(false);
    expect((await browser.inspect({})).text).toContain('textbox "Name" [g1:e1]');
  });

  it("is refused once the captain holds the browser", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    await browsers.requestHelp("t1", request);
    expect(await browsers.takeControl("t1")).toEqual({ ok: true });
    expect((await browser.close({ withdraw: true })).text).toContain(
      "The captain has control of this task's browser",
    );
    expect(browsers.fact("t1")).toMatchObject({ control: "captain" });
    expect(pages[0]?.closed).toBe(false);
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

  it("opens a waiting page that answers a form at its address in the kept profile when a kept sign-in is granted, never resending the form", async () => {
    const signIns = new WebSignIns(scratchDir("infinitary-web-sign-ins-"), () => 1_000);
    signIns.record("localhost:5173", { automatic: false });
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
    const kept = pages.at(-1) as FakePage;
    expect(kept.opened.kept).toBe(true);
    expect(kept.effects).toContain("load http://localhost:5173/pay");
    expect((await browser.inspect({})).text).toContain("the page opened with it");
  });
});
