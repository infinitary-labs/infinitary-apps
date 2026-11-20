import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type FakePage,
  flush,
  formNodes,
  harness,
  openPopup,
  PICTURE,
  PNG,
} from "../../../tests/helpers/taskBrowserStandIn";
import type { HostCookie } from "../host";
import type { BrowserNode } from "./outline";
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
    expect(taken.image).toEqual(PICTURE);
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
    expect(taken.image).toEqual(PICTURE);
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

describe('signed-in sites in the kept profile (docs/task-browser.md, "Signed-in sites")', () => {
  // INF-4585's plan, piece 3: a sign-in request opens its site in the kept profile;
  // a task may open there only its allowed sites and the sign-in pages passed through.
  const request = {
    site: "localhost:5173",
    reason: "The account page needs your sign-in",
    after: "read the account page",
    signIn: true as const,
  };
  /** The site's own sign-in, and another site's, as the page left them in the kept profile. */
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
      name: "idp",
      value: "sam-idp",
      domain: "login.example",
      hostOnly: true,
      path: "/",
      secure: true,
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

  /** The browsers on one computer, with its list of signed-in sites in a scratch folder. */
  function onThisComputer() {
    const signIns = new WebSignIns(scratchDir("infinitary-web-sign-ins-"), () => 1_000);
    return { ...harness({ signIns, now: () => 1_000 }), signIns };
  }

  /**
   * Task t1's browser asks for a sign-in; the captain takes it, signs in at
   * the site through another site's sign-in page, and returns it with a rule.
   */
  async function signedInAndReturned(h: ReturnType<typeof onThisComputer>, automatic = false) {
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const handle = { session: h.browsers.session, generation: 1 };
    expect(await h.browsers.requestHelp("t1", request)).toEqual({ ok: true, handle });
    expect(await h.browsers.takeControl("t1", handle)).toEqual({ ok: true });
    const page = h.pages.at(-1) as FakePage;
    expect(page.opened.kept).toBe(true);
    // The captain passes through the sign-in page and comes back signed in.
    await page.load("https://login.example/authorize");
    await page.load("http://localhost:5173/account");
    h.kept.cookies.cookies = SIGNED_IN.map((cookie) => ({ ...cookie }));
    expect(
      await h.browsers.returnControl("t1", handle, { site: "localhost:5173", automatic }),
    ).toEqual({ ok: true });
    return { browser, page, handle };
  }

  /** Task t2's browser, on the same site, asking the captain on a card. */
  async function asking(h: ReturnType<typeof onThisComputer>) {
    const browser = h.browsers.forTask("t2");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    const { signIn: _signIn, ...plain } = request;
    expect(await h.browsers.requestHelp("t2", plain)).toEqual({ ok: true, handle });
    return { browser, page, handle };
  }

  it("opens a sign-in request's page in the kept profile at its address, and keeps the site with the rule and nothing copied", async () => {
    const h = onThisComputer();
    const own = h.browsers.forTask("t1");
    await own.navigate({ url: "http://localhost:5173/account" });
    const first = h.pages[0] as FakePage;
    expect(first.opened.kept).toBeUndefined();
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    const kept = h.pages[1] as FakePage;
    expect(first.closed).toBe(true);
    expect(kept.opened.kept).toBe(true);
    expect(kept.effects).toContain("load http://localhost:5173/account");
    expect(h.browsers.fact("t1")).toMatchObject({ kept: true, control: "captain" });
    await kept.load("https://login.example/authorize");
    await kept.load("http://localhost:5173/account");
    h.kept.cookies.cookies = SIGNED_IN.map((cookie) => ({ ...cookie }));
    expect(
      await h.browsers.returnControl("t1", handle, { site: "localhost:5173", automatic: true }),
    ).toEqual({ ok: true });
    expect(h.signIns.records()).toEqual([
      {
        site: "localhost:5173",
        savedAt: 1_000,
        id: expect.any(String),
        automatic: true,
        via: ["login.example"],
      },
    ]);
    expect(h.browsers.fact("t1")).toMatchObject({ kept: true, saved: ["localhost:5173"] });
    // The browser's own stop leaves the kept profile signed in.
    h.browsers.closeTask("t1");
    expect(h.kept.cookies.cookies.map((cookie) => cookie.name)).toContain("sid");
  });

  it("carries the site's rule on this computer's list in the fact while the captain holds the kept browser, so Return control starts from it", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h, true);
    // The crewmate holds it again: the fact names no rule.
    expect(h.browsers.fact("t1")).not.toHaveProperty("rule");
    const asked = await h.browsers.requestHelp("t1", request);
    if (!asked.ok) throw new Error(asked.text);
    expect(await h.browsers.takeControl("t1", asked.handle)).toEqual({ ok: true });
    expect(h.browsers.fact("t1")).toMatchObject({
      kept: true,
      control: "captain",
      rule: "automatic",
    });
    // Returning with that rule leaves it as the captain chose it.
    expect(
      await h.browsers.returnControl("t1", asked.handle, {
        site: "localhost:5173",
        automatic: true,
      }),
    ).toEqual({ ok: true });
    expect(h.signIns.get("localhost:5173")?.automatic).toBe(true);
  });

  it("keeps a request without a sign-in, and the captain's own take, in the browser's own context", async () => {
    const h = onThisComputer();
    const { handle } = await asking(h);
    await h.browsers.takeControl("t2", handle);
    expect(h.pages).toHaveLength(1);
    expect(h.browsers.fact("t2")).not.toHaveProperty("kept");
    expect(await h.browsers.returnControl("t2", handle, { site: "localhost:5173" })).toEqual({
      ok: true,
    });
    expect(h.signIns.records()).toEqual([]);
  });

  it("adds nothing for a site that holds no sign-in, and says so on Return control", async () => {
    const h = onThisComputer();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/account" });
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.requestHelp("t1", request);
    await h.browsers.takeControl("t1", handle);
    expect(await h.browsers.returnControl("t1", handle, { site: "localhost:5173" })).toEqual({
      ok: true,
      warning:
        "Control returned. This site holds no sign-in, so nothing was added for later tasks.",
    });
    expect(h.signIns.records()).toEqual([]);
  });

  it("signs a second task in with the captain's allowance, and leaves a task without it signed out", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { browser, page, handle } = await asking(h);
    // Its own context holds none of the captain's sign-ins.
    expect(page.opened.kept).toBeUndefined();
    expect(page.cookies.cookies).toEqual([]);
    expect(h.browsers.savedSignInFor("t2", "localhost:5173")).toEqual({
      site: "localhost:5173",
      savedAt: 1_000,
    });
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({ ok: true });
    const signedIn = h.pages.at(-1) as FakePage;
    expect(signedIn.opened.kept).toBe(true);
    expect(page.closed).toBe(true);
    // Nothing was copied: the page reads the kept profile's own sign-in.
    expect(signedIn.cookies).toBe(h.kept.cookies);
    expect(signedIn.cookies.cookies.map((cookie) => cookie.name)).toContain("sid");
    expect(h.browsers.fact("t2")).toMatchObject({
      state: "open",
      kept: true,
      did: "fresh look at the page",
      saved: ["localhost:5173"],
    });
    expect(h.browsers.withCaptain("t2")).toBe(false);
    expect(h.notes).toContain("t2: you let it use your sign-in at localhost:5173");
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
    expect((await browser.inspect({})).text).toContain(
      "The captain let this task use the sign-in kept for localhost:5173 on this computer, and the page opened with it",
    );
    // The page may show the captain's account, so a picture needs the task's reason.
    expect((await browser.capture({})).image).toBeUndefined();
    // A third task, never allowed, opens the site in its own empty context.
    const third = h.browsers.forTask("t3");
    await third.navigate({ url: "http://localhost:5173/account" });
    const signedOut = h.pages.at(-1) as FakePage;
    expect(signedOut.opened.kept).toBeUndefined();
    expect(signedOut.cookies.cookies).toEqual([]);
    expect(h.browsers.fact("t3")).not.toHaveProperty("kept");
  });

  it("opens only the allowed site and the sign-in pages passed through in the kept profile, and anything else in an empty context", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { browser, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    const inKept = h.pages.at(-1) as FakePage;
    // The sign-in page the captain passed through stays in the kept profile.
    await browser.navigate({ url: "https://login.example/authorize" });
    expect(h.pages.at(-1)).toBe(inKept);
    // Another site leaves it for an empty context, signed out.
    const answer = await browser.navigate({ url: "https://tracker.example/" });
    const outside = h.pages.at(-1) as FakePage;
    expect(outside).not.toBe(inKept);
    expect(outside.opened.kept).toBeUndefined();
    expect(outside.cookies.cookies).toEqual([]);
    expect(inKept.closed).toBe(true);
    expect(answer.text).toContain(
      "This task may not use the captain's sign-ins at tracker.example, so the browser opened it in an empty context of its own, signed out",
    );
    // Back to its allowed site, it opens in the kept profile again.
    await browser.navigate({ url: "http://localhost:5173/account" });
    expect((h.pages.at(-1) as FakePage).opened.kept).toBe(true);
  });

  it("refuses a kept page's own move to a site the task may not use, and opens it in an empty context", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    const inKept = h.pages.at(-1) as FakePage;
    // A link on the page leads elsewhere.
    expect(await inKept.load("https://tracker.example/")).toEqual({
      ok: false,
      code: "ERR_BLOCKED_BY_CLIENT",
    });
    await flush();
    await flush();
    const outside = h.pages.at(-1) as FakePage;
    expect(outside).not.toBe(inKept);
    expect(outside.opened.kept).toBeUndefined();
    expect(outside.current).toBe("https://tracker.example/");
  });

  it("opens a kept page's new window only on a site the task may use there", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    const inKept = h.pages.at(-1) as FakePage;
    expect(openPopup(inKept, "https://tracker.example/ad")).toBeUndefined();
    expect(openPopup(inKept, "https://login.example/authorize")?.opened.kept).toBe(true);
  });

  it("uses a site whose rule allows it without asking on a crewmate's own open, and says so", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h, true);
    const browser = h.browsers.forTask("t2");
    const answer = await browser.navigate({ url: "http://localhost:5173/account" });
    const page = h.pages.at(-1) as FakePage;
    expect(page.opened.kept).toBe(true);
    expect(page.cookies.cookies.map((cookie) => cookie.name)).toContain("sid");
    expect(answer.text).toContain(
      "The captain lets tasks use the sign-in kept for localhost:5173 on this computer without asking",
    );
    expect(h.notes).toContain(
      "t2: used your sign-in at localhost:5173, as your rule for it allows",
    );
    // A site asked about each time opens signed out until the captain allows it.
    expect(
      h.signIns.allowAutomatic("localhost:5173", h.signIns.get("localhost:5173")?.id ?? "", false),
    ).toBe(true);
    const asked = h.browsers.forTask("t3");
    await asked.navigate({ url: "http://localhost:5173/account" });
    expect((h.pages.at(-1) as FakePage).opened.kept).toBeUndefined();
  });

  it("offers a kept site only on its own site, to a browser not already allowed it", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    expect(h.browsers.savedSignInFor("t1", "localhost:5173")).toBeUndefined();
    const { handle } = await asking(h);
    expect(h.browsers.savedSignInFor("t2", "elsewhere.example")).toBeUndefined();
    expect(h.browsers.fact("t2")).toMatchObject({
      offer: { site: "localhost:5173", savedAt: 1_000 },
    });
    await h.browsers.grantSavedSignIn("t2", handle);
    // The kept sign-in ended at the site: the crewmate asks again, and the captain signs in.
    expect(await h.browsers.requestHelp("t2", request)).toMatchObject({ ok: true });
    expect(h.browsers.savedSignInFor("t2", "localhost:5173")).toBeUndefined();
  });

  it("refuses a grant to a browser not waiting for the captain, a stale one, or a site not kept", async () => {
    const h = onThisComputer();
    const { handle } = await asking(h);
    expect(await h.browsers.grantSavedSignIn("t2", handle)).toEqual({
      ok: false,
      text: "No sign-in for localhost:5173 is kept on this computer.",
    });
    expect(h.browsers.fact("t2")).toMatchObject({ control: "waiting" });
    await signedInAndReturned(h);
    expect(await h.browsers.grantSavedSignIn("t2", { ...handle, generation: 2 })).toMatchObject({
      ok: false,
    });
    expect(await h.browsers.grantSavedSignIn("t1", { ...handle })).toEqual({
      ok: false,
      text: "This browser is no longer waiting for your sign-in.",
    });
  });

  // INF-1849 piece 2: only the crewmate says a sign-in failed, and the next task's card reads the mark.
  it("marks the entry a browser was given when its crewmate says it failed, and offers it marked to the next task", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { handle } = await asking(h);
    expect(h.browsers.markSavedSignInFailed("t2", "localhost:5173")).toBe(false);
    await h.browsers.grantSavedSignIn("t2", handle);
    expect(h.browsers.markSavedSignInFailed("t2", "localhost:5173")).toBe(true);
    expect(h.notes).toContain("t2: said your sign-in at localhost:5173 did not sign its page in");
    const next = h.browsers.forTask("t4");
    await next.navigate({ url: "http://localhost:5173/account" });
    await h.browsers.requestHelp("t4", request);
    expect(h.browsers.savedSignInFor("t4", "localhost:5173")).toEqual({
      site: "localhost:5173",
      savedAt: 1_000,
      failedAt: 1_000,
    });
  });

  it("signs the kept profile out of a removed site and the sign-in pages only it passed through, and tells every browser using it", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    h.kept.store.put("http://localhost:5173", { token: "sam" });
    h.kept.store.put("https://login.example", { idp: "sam" });
    h.kept.store.put("https://tracker.example", { other: "kept" });
    const { browser, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    expect(await h.browsers.removeSavedSignIn("localhost:5173")).toEqual({ ok: true });
    expect(h.signIns.records()).toEqual([]);
    expect(h.kept.cookies.cookies.map((cookie) => cookie.name)).toEqual(["tracker"]);
    expect([...h.kept.store.origins.keys()]).toEqual(["https://tracker.example"]);
    expect(h.browsers.fact("t2")).not.toHaveProperty("saved");
    expect(h.notes).toContain(
      "t2: your sign-in at localhost:5173 was removed, and its browser signed out of it",
    );
    expect((await browser.inspect({})).text).toContain(
      "The captain removed the sign-in kept for localhost:5173 from this computer",
    );
    expect(await h.browsers.removeSavedSignIn("localhost:5173")).toEqual({
      ok: false,
      text: "This computer keeps no sign-in for localhost:5173.",
    });
  });

  it("keeps a sign-in page another kept site still names when one site is removed", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    h.signIns.record("aurora.example", { automatic: false, via: ["login.example"] });
    await h.browsers.removeSavedSignIn("localhost:5173");
    expect(h.kept.cookies.cookies.map((cookie) => cookie.name)).toEqual(["idp", "tracker"]);
  });

  // The captain's answer on INF-4597's review: "Say the sign-in stays, and add Remove all to Settings."
  it("signs the kept profile out of every site on Remove all, listed or not, and moves every kept browser out first", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    h.kept.store.put("http://localhost:5173", { token: "sam" });
    h.kept.store.put("https://tracker.example", { other: "kept" });
    const { browser, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    expect(h.browsers.fact("t2")).toHaveProperty("kept", true);
    expect(await h.browsers.removeAllSavedSignIns()).toEqual({ ok: true });
    expect(h.signIns.records()).toEqual([]);
    expect(h.kept.cookies.cookies).toEqual([]);
    expect([...h.kept.store.origins.keys()]).toEqual([]);
    const fact = h.browsers.fact("t2");
    expect(fact).not.toHaveProperty("saved");
    expect(fact).not.toHaveProperty("kept");
    expect(h.pages.at(-1)?.opened.kept).toBeUndefined();
    expect(h.notes).toContain("t2: your sign-ins were removed, and its browser signed out of them");
    expect((await browser.inspect({})).text).toContain(
      "The captain removed every sign-in kept on this computer",
    );
  });

  // INF-4767's review of Remove all: no grant may outlive the press, while the profile empties or after it failed.
  it("keeps a browser out of the kept profile while Remove all empties it, and after it failed", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { browser, handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    let release: (() => void) | undefined;
    h.kept.emptying = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const removing = h.browsers.removeAllSavedSignIns();
    await expect.poll(() => release).toBeDefined();
    await browser.navigate({ url: "http://localhost:5173/account" });
    expect(h.browsers.fact("t2")).not.toHaveProperty("kept");
    release?.();
    expect(await removing).toEqual({ ok: true });

    const again = onThisComputer();
    await signedInAndReturned(again);
    const asked = await asking(again);
    await again.browsers.grantSavedSignIn("t2", asked.handle);
    again.kept.emptying = async () => {
      throw new Error("the profile is busy");
    };
    expect(await again.browsers.removeAllSavedSignIns()).toEqual({
      ok: false,
      text: "This computer removed every site from the list, but could not sign the kept profile out of them all. Remove all again.",
    });
    await asked.browser.navigate({ url: "http://localhost:5173/account" });
    expect(again.browsers.fact("t2")).not.toHaveProperty("kept");
    expect(again.browsers.fact("t2")).not.toHaveProperty("saved");
  });

  it("opens every kept page through the one kept guard, never a browser's own", async () => {
    const h = onThisComputer();
    await signedInAndReturned(h);
    const { handle } = await asking(h);
    await h.browsers.grantSavedSignIn("t2", handle);
    const kept = h.pages.filter((page) => page.opened.kept);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.opened.proxy).toEqual(kept[1]?.opened.proxy);
    const own = h.pages.filter((page) => !page.opened.kept);
    expect(own.every((page) => page.opened.proxy !== kept[0]?.opened.proxy)).toBe(true);
  });
});
