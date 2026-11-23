import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type FakePage, harness } from "../../../tests/helpers/taskBrowserStandIn";
import type { HostCookie } from "../host";
import { type KeptPages, keptPagesIn } from "./keptPages";
import { TASK_BROWSER_IDLE_MS } from "./taskBrowsers";
import { WebSignIns } from "./webSignIns";

/**
 * A sign-in the captain made once, found by later tasks and kept by the same
 * task across its browser's stops (docs/task-browser.md, "Signed-in sites"):
 * the four gaps a task on a developer site met, where it asked the captain to
 * sign in three times in one night - the kept list looked up only by the
 * page's exact name, a sibling page counted as another site, a task's
 * allowance ended with each browser, and the stand-in host's sign-in page sits
 * on a sibling of the page that asked for it.
 */

/** A developer site whose sign-in lives on a sibling sign-in page, both under one company's name. */
const DEVELOPER = "https://developer.apple.example/account";
const SIGN_IN_PAGE = "https://idmsa.apple.example/signin";
const SIBLING = "https://appstoreconnect.apple.example/apps";

/** The session cookie the sign-in page leaves, shared with every name under the company's. */
const SESSION: HostCookie = {
  name: "myacinfo",
  value: "session-1",
  domain: ".apple.example",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
};

const request = {
  site: "developer.apple.example",
  reason: "The account page needs your sign-in",
  after: "read the account page",
  signIn: true as const,
};

/** A project folder the captain opens a page from, served on a loopback address of its own. */
function serve(folder: string) {
  return Promise.resolve({ folder, origin: "http://127.0.0.1:41000", close: () => undefined });
}

function onThisComputer(
  options: { signIns?: WebSignIns; keptPages?: KeptPages; session?: string } = {},
) {
  const signIns =
    options.signIns ?? new WebSignIns(scratchDir("infinitary-web-sign-ins-"), () => 1_000);
  return {
    ...harness({
      signIns,
      now: () => 1_000,
      serve,
      ...(options.keptPages ? { keptPages: options.keptPages } : {}),
      ...(options.session ? { session: options.session } : {}),
    }),
    signIns,
  };
}

/**
 * The captain takes t1's browser, signs in on the sign-in page, which sends
 * him back to the developer page signed in, and hands it back with the
 * site the Return control question named.
 */
async function signInOnce(h: ReturnType<typeof onThisComputer>, automatic: boolean) {
  const browser = h.browsers.forTask("t1");
  await browser.navigate({ url: DEVELOPER });
  const handle = { session: h.browsers.session, generation: 1 };
  await h.browsers.requestHelp("t1", request);
  await h.browsers.takeControl("t1", handle);
  const page = h.pages.at(-1) as FakePage;
  await page.load(SIGN_IN_PAGE);
  h.kept.cookies.cookies = [{ ...SESSION }];
  await page.load(DEVELOPER);
  const shown = await vi.waitFor(() => {
    const fact = h.browsers.fact("t1");
    expect(fact).toMatchObject({ keepAs: "apple.example" });
    return fact?.state === "open" ? (fact.keepAs ?? fact.site) : "";
  });
  expect(await h.browsers.returnControl("t1", handle, { site: shown, automatic })).toEqual({
    ok: true,
  });
}

/** A later task whose browser lands on `url` and asks the captain for help there. */
async function askingAt(h: ReturnType<typeof onThisComputer>, taskId: string, url: string) {
  const browser = h.browsers.forTask(taskId);
  await browser.navigate({ url });
  const handle = { session: h.browsers.session, generation: 1 };
  const { signIn: _signIn, ...plain } = request;
  await h.browsers.requestHelp(taskId, { ...plain, site: new URL(url).host });
  return { browser, handle };
}

describe("a kept sign-in covers the whole site its cookies cover", () => {
  it("keeps the sign-in for the company's name, with the page signed in at and the sign-in page passed through", async () => {
    const h = onThisComputer();
    await signInOnce(h, false);
    expect(h.signIns.records()).toEqual([
      {
        site: "apple.example",
        savedAt: 1_000,
        id: expect.any(String),
        via: expect.arrayContaining(["idmsa.apple.example", "developer.apple.example"]),
      },
    ]);
  });

  it("keeps it under the page's own name when the question named only that", async () => {
    const h = onThisComputer();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: DEVELOPER });
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    // The session cookie arrives with no page load after it, so the question still names the page.
    h.kept.cookies.cookies = [{ ...SESSION }];
    expect(h.browsers.fact("t1")).not.toHaveProperty("keepAs");
    await h.browsers.returnControl("t1", handle, {
      site: "developer.apple.example",
      automatic: false,
    });
    expect(h.signIns.records().map((record) => record.site)).toEqual(["developer.apple.example"]);
  });

  it("keeps nothing when the page reached a wider name than the question named", async () => {
    const h = onThisComputer();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: DEVELOPER });
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    h.kept.cookies.cookies = [{ ...SESSION }];
    await (h.pages.at(-1) as FakePage).load("https://apple.example/");
    await h.browsers.returnControl("t1", handle, {
      site: "developer.apple.example",
      automatic: true,
    });
    expect(h.signIns.records()).toEqual([]);
  });

  it("offers it to a later task that stops on the sign-in page, and on a sibling page", async () => {
    const h = onThisComputer();
    await signInOnce(h, false);
    await askingAt(h, "t2", SIGN_IN_PAGE);
    expect(h.browsers.fact("t2")).toMatchObject({ offer: { site: "apple.example" } });
    const { handle } = await askingAt(h, "t3", SIBLING);
    expect(h.browsers.fact("t3")).toMatchObject({ offer: { site: "apple.example" } });
    expect(await h.browsers.grantSavedSignIn("t3", handle)).toEqual({ ok: true });
    const page = h.pages.at(-1) as FakePage;
    expect(page.opened.kept).toBe(true);
    expect(page.cookies.cookies.map((cookie) => cookie.name)).toEqual(["myacinfo"]);
  });

  it("finds an entry kept before by the page's exact name from the sign-in page it passed through", async () => {
    const h = onThisComputer();
    h.signIns.record("developer.apple.example", { automatic: false, via: ["idmsa.apple.example"] });
    await askingAt(h, "t2", SIGN_IN_PAGE);
    expect(h.browsers.fact("t2")).toMatchObject({ offer: { site: "developer.apple.example" } });
  });

  it("signs a later task in on a sibling page with no card when the rule allows it", async () => {
    const h = onThisComputer();
    await signInOnce(h, true);
    const browser = h.browsers.forTask("t2");
    const answer = await browser.navigate({ url: SIBLING });
    expect((h.pages.at(-1) as FakePage).opened.kept).toBe(true);
    expect(answer.text).toContain("The captain lets tasks use the sign-in kept for apple.example");
  });

  it("signs the kept profile out of a sibling page a task opened, its page storage included, on Remove", async () => {
    const h = onThisComputer();
    await signInOnce(h, true);
    await h.browsers.forTask("t2").navigate({ url: SIBLING });
    h.kept.store.put("https://appstoreconnect.apple.example", { session: "s-2" });
    expect(await h.browsers.removeSavedSignIn("apple.example")).toEqual({ ok: true });
    expect(h.kept.store.of("https://appstoreconnect.apple.example")).toEqual({});
    expect(h.kept.cookies.cookies).toEqual([]);
  });
});

describe("a task keeps the sign-ins it may use until the captain stops its browser or it closes", () => {
  async function allowedOnT2(h: ReturnType<typeof onThisComputer>) {
    await signInOnce(h, false);
    const { browser, handle } = await askingAt(h, "t2", DEVELOPER);
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({ ok: true });
    return browser;
  }

  it("opens the site signed in again after its crewmate's stop, and after the idle stop", async () => {
    const h = onThisComputer();
    const browser = await allowedOnT2(h);
    await browser.close({});
    await browser.navigate({ url: SIBLING });
    expect(h.browsers.fact("t2")).toMatchObject({ kept: true, saved: ["apple.example"] });
    h.fire(TASK_BROWSER_IDLE_MS);
    expect(h.browsers.fact("t2")).toMatchObject({ state: "stopped", stopped: "idle" });
    const again = await browser.navigate({ url: DEVELOPER });
    expect(h.browsers.fact("t2")).toMatchObject({ kept: true, saved: ["apple.example"] });
    expect(again.text).toContain("the captain's sign-ins this task may use stay");
  });

  it("opens the site signed in again after the app restarts", async () => {
    const folders = scratchDir("infinitary-task-folders-");
    const keptPages = keptPagesIn((taskId) => join(folders, taskId));
    const before = onThisComputer({ keptPages, session: "run-1" });
    await allowedOnT2(before);
    before.browsers.closeAll();
    const after = onThisComputer({ signIns: before.signIns, keptPages, session: "run-2" });
    await after.browsers.forTask("t2").navigate({ url: DEVELOPER });
    expect(after.browsers.fact("t2")).toMatchObject({ kept: true, saved: ["apple.example"] });
  });

  it("keeps it when the captain closes a page he opened from the project with Return control", async () => {
    const h = onThisComputer();
    const browser = await allowedOnT2(h);
    await browser.close({});
    const opened = await h.browsers.openPage("t2", { folder: "/project", path: "index.html" });
    if (!opened.ok) throw new Error(opened.text);
    expect(h.browsers.fact("t2")).not.toHaveProperty("saved");
    expect(await h.browsers.returnControl("t2", opened.handle)).toEqual({ ok: true });
    await browser.navigate({ url: DEVELOPER });
    expect(h.browsers.fact("t2")).toMatchObject({ kept: true, saved: ["apple.example"] });
  });

  it("keeps it across a quit while the captain's page from the project is open", async () => {
    const folders = scratchDir("infinitary-task-folders-");
    const keptPages = keptPagesIn((taskId) => join(folders, taskId));
    const before = onThisComputer({ keptPages, session: "run-1" });
    const browser = await allowedOnT2(before);
    await browser.close({});
    const opened = await before.browsers.openPage("t2", { folder: "/project", path: "index.html" });
    expect(opened.ok).toBe(true);
    before.browsers.closeAll();
    const after = onThisComputer({ signIns: before.signIns, keptPages, session: "run-2" });
    await after.browsers.forTask("t2").navigate({ url: DEVELOPER });
    expect(after.browsers.fact("t2")).toMatchObject({ kept: true, saved: ["apple.example"] });
  });

  it("forgets it on the captain's Stop browser, on the task's close, and once the captain removed the site", async () => {
    const h = onThisComputer();
    const browser = await allowedOnT2(h);
    h.browsers.stopByCaptain("t2");
    await browser.navigate({ url: DEVELOPER });
    expect(h.browsers.fact("t2")).not.toHaveProperty("saved");
    expect((h.pages.at(-1) as FakePage).opened.kept).toBeUndefined();

    const removed = onThisComputer();
    const other = await allowedOnT2(removed);
    await other.close({});
    expect(await removed.browsers.removeSavedSignIn("apple.example")).toEqual({ ok: true });
    await other.navigate({ url: DEVELOPER });
    expect(removed.browsers.fact("t2")).not.toHaveProperty("saved");

    const closed = onThisComputer();
    const third = await allowedOnT2(closed);
    await third.close({});
    closed.browsers.closeTask("t2");
    await third.navigate({ url: DEVELOPER });
    expect(closed.browsers.fact("t2")).not.toHaveProperty("saved");
  });
});
