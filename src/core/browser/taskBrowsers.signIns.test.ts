import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type FakePage,
  formNodes,
  harness,
  openPopup,
  PNG,
} from "../../../tests/helpers/taskBrowserStandIn";
import type { HostCookie } from "../host";
import { type BrowserNode, REF_FROM_BEFORE_HANDBACK } from "./outline";
import { WebSignIns } from "./webSignIns";

/**
 * Each task's own browser, against the stand-in host whose page records every
 * effect it is asked for (tests/helpers/taskBrowserStandIn.ts): a signed-in
 * page and the saved sign-ins a captain grants a task. The host's real page is
 * the desktop's (src/main/host/taskBrowser.ts), driven end to end by the task
 * browser journeys (tests/e2e/task-browser*.spec.ts).
 */

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

  // INF-1849 piece 2: only the crewmate says a save failed, and the next
  // task's card reads the mark.
  it("marks the exact save a browser was given when its crewmate says it failed, and offers it marked to the next task", async () => {
    const h = onThisMac();
    await signedInAndReturned(h, true);
    const { handle } = await asking(h);
    const id = h.signIns.get("localhost:5173")?.id;
    // A browser that uses no save for the site marks nothing.
    await h.browsers.forTask("t3").navigate({ url: "http://localhost:5173/account" });
    expect(h.browsers.markSavedSignInFailed("t3", "localhost:5173")).toBe(false);
    expect(h.browsers.markSavedSignInFailed("t2", "localhost:5173")).toBe(false);
    expect(h.signIns.get("localhost:5173")?.failedAt).toBeUndefined();
    await h.browsers.grantSavedSignIn("t2", handle);
    expect(h.browsers.markSavedSignInFailed("t2", "http://LOCALHOST:5173/login")).toBe(true);
    expect(h.signIns.get("localhost:5173")).toMatchObject({ id, failedAt: 1_000 });
    expect(h.notes).toContain(
      "t2: said your saved sign-in at localhost:5173 did not sign its page in",
    );
    // The next task asking on the site is offered the save with the mark.
    await h.browsers.requestHelp("t3", request);
    expect(h.browsers.savedSignInFor("t3", "localhost:5173")).toEqual({
      site: "localhost:5173",
      savedAt: 1_000,
      failedAt: 1_000,
    });
    // A save removed since is never marked.
    await h.browsers.removeSavedSignIn("localhost:5173");
    expect(h.browsers.markSavedSignInFailed("t2", "localhost:5173")).toBe(false);
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

  // INF-1849, the captain's approved plan: a save also keeps the session
  // storage of the site's own origins, read at the hand-back, written into
  // the page before it reloads, left as saved at a browser's stop, and
  // cleared in every page by Remove.

  /** Task t1's browser, signed in by the captain on a page that keeps its sign-in in session storage alone, handed back with the tick. */
  async function sessionStoredAndReturned(h: ReturnType<typeof onThisMac>) {
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    page.sessionStore.put(ORIGIN, { repository: "token-1" });
    page.sessionStore.put("https://aurora.example", { token: "another site's" });
    expect(await h.browsers.returnControl("t1", handle, { remember: true })).toEqual({ ok: true });
    return { browser, page, handle };
  }

  it("saves a site that keeps its sign-in in session storage alone, and writes it into the waiting page before it reloads", async () => {
    const h = onThisMac();
    await sessionStoredAndReturned(h);
    expect(h.signIns.get("localhost:5173")).toMatchObject({
      cookies: [],
      storage: [],
      session: [{ origin: ORIGIN, items: [["repository", "token-1"]] }],
    });
    const { page, handle } = await asking(h);
    // A new browser's page starts with no session storage of its own.
    expect(page.sessionStore.origins.size).toBe(0);
    expect(h.browsers.savedSignInFor("t2", "localhost:5173")).toEqual({
      site: "localhost:5173",
      savedAt: 1_000,
    });
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({ ok: true });
    expect(page.sessionStore.of(ORIGIN)).toEqual({ repository: "token-1" });
    expect([...page.sessionStore.origins.keys()]).toEqual([ORIGIN]);
    expect(page.effects.slice(-2)).toEqual([`write session ${ORIGIN}`, "reload"]);
  });

  it("leaves the saved session storage as the hand-back saved it when the browser stops, and refreshes it at the next hand-back", async () => {
    const h = onThisMac();
    const { page: first, handle: firstHandle } = await sessionStoredAndReturned(h);
    const { browser, page, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    // The site signed itself out while the browser sat idle, before it stopped.
    page.sessionStore.origins.delete(ORIGIN);
    page.sessionStore.put(ORIGIN, { idle: "signed out" });
    await browser.close();
    await tick();
    expect(page.effects.filter((effect) => effect.startsWith("read session"))).toEqual([]);
    expect(h.signIns.get("localhost:5173")?.session).toEqual([
      { origin: ORIGIN, items: [["repository", "token-1"]] },
    ]);

    // The captain's next hand-back on the saved site reads it again.
    const saved = h.signIns.get("localhost:5173");
    if (!saved) throw new Error("The fixture did not save its sign-in");
    await h.browsers.takeControl("t1", firstHandle);
    first.sessionStore.put(ORIGIN, { repository: "token-2" });
    expect(
      await h.browsers.returnControl("t1", firstHandle, { site: saved.site, savedId: saved.id }),
    ).toEqual({ ok: true });
    expect(h.signIns.get("localhost:5173")).toMatchObject({
      id: saved.id,
      session: [{ origin: ORIGIN, items: [["repository", "token-2"]] }],
    });
  });

  it("uses the saved session storage on a future task's visit the captain allowed", async () => {
    const h = onThisMac();
    await sessionStoredAndReturned(h);
    const saved = h.signIns.get("localhost:5173");
    if (!saved) throw new Error("The fixture did not save its sign-in");
    expect(h.browsers.allowAutomaticSignIn(saved.site, saved.id, true)).toEqual({ ok: true });
    const answer = await h.browsers
      .forTask("automatic")
      .navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    expect(answer.text).toContain("used it automatically");
    expect(page.sessionStore.of(ORIGIN)).toEqual({ repository: "token-1" });
    expect(page.effects.slice(-2)).toEqual([`write session ${ORIGIN}`, "reload"]);
  });

  it("clears the site's own session storage in every page of each browser using a sign-in the captain removes", async () => {
    const h = onThisMac();
    const { page: first } = await sessionStoredAndReturned(h);
    const { page, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    const second = openPopup(page, "http://localhost:5173/reports") as FakePage;
    second.sessionStore.put(ORIGIN, { repository: "token-1" });
    page.sessionStore.put("https://aurora.example", { token: "another site's" });
    expect(await h.browsers.removeSavedSignIn("localhost:5173")).toEqual({ ok: true });
    // Its own origin's session storage goes from each page; another site's stays.
    expect([...page.sessionStore.origins.keys()]).toEqual(["https://aurora.example"]);
    expect([...second.sessionStore.origins.keys()]).toEqual([]);
    expect([...first.sessionStore.origins.keys()]).toEqual(["https://aurora.example"]);
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
