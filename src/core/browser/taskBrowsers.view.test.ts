import { describe, expect, it } from "vitest";
import {
  deferred,
  FakePage,
  flush,
  harness,
  openPopup,
} from "../../../tests/helpers/taskBrowserStandIn";
import type { HostBrowserFrame, HostLoadOutcome } from "../host";
import { REF_PATTERN } from "./outline";
import { TASK_BROWSER_IDLE_MS } from "./taskBrowsers";

/**
 * Each task's own browser, against the stand-in host whose page records every
 * effect it is asked for (tests/helpers/taskBrowserStandIn.ts): what the
 * captain sees: the live view, the maximized room, which browser a card names
 * and a second page. The host's real page is the desktop's
 * (src/main/host/taskBrowser.ts), driven end to end by the task browser
 * journeys (tests/e2e/task-browser*.spec.ts).
 */

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
