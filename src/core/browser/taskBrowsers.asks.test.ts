import { describe, expect, it } from "vitest";
import { type FakePage, flush, harness } from "../../../tests/helpers/taskBrowserStandIn";
import type { HostAskKind } from "../host";

/**
 * What a task's page asks for that needs a yes (docs/task-browser.md, "A
 * site's asks"), against the stand-in host: INF-4585's plan has a site's
 * permission asks reach the captain as Allow once or Not now on both
 * engines, and a passkey wait for Use passkey or Not now only where the
 * captain sits at the computer Chrome runs on, Chrome's window going back to
 * the Dock when it ends (INF-5199's plan: "Ask first, then put the window
 * away"); anywhere else, or on the
 * built-in engine, the passkey request ends as not allowed and the captain
 * is told ("Tell the site no passkey is available, so it offers a password
 * or a code, and tell me"). The host's real guard and grants are driven end
 * to end by tests/e2e/task-browser-asks.spec.ts.
 */

const SITE = "meet.example";
const URL = `https://${SITE}`;

/** A browser on the site, held by the captain, from the computer it runs on unless `here` is false. */
async function held(options: { chrome?: boolean; here?: boolean } = {}) {
  const h = harness();
  const browser = h.browsers.forTask("t1");
  await browser.navigate({ url: `${URL}/` });
  const page = h.pages[0] as FakePage;
  const shown: boolean[] = [];
  if (options.chrome) {
    page.showWindow = async (on) => {
      shown.push(on);
    };
  }
  const handle = { session: h.browsers.session, generation: 1 };
  h.browsers.captainAt("t1", options.here !== false);
  expect(await h.browsers.takeControl("t1", handle)).toEqual({ ok: true });
  return { ...h, browser, page, handle, shown };
}

/** One ask of the page, with the end the host tells once its call finished or its document went. */
function asks(page: FakePage, kind: HostAskKind) {
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return { answer: page.opened.onAsk({ kind, url: URL, ended }), end };
}

describe("a site's asks while the crewmate drives (docs/task-browser.md, \"A site's asks\")", () => {
  it("refuses every ask, and tells the crewmate a passkey was asked for", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: `${URL}/` });
    const page = pages[0] as FakePage;
    for (const kind of ["camera", "notifications", "clipboard", "platform"] as const) {
      expect(await asks(page, kind).answer).toBe(false);
    }
    expect(await asks(page, "passkey").answer).toBe(false);
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
    expect(browsers.fact("t1")).not.toHaveProperty("told");
    expect((await browser.inspect({})).text).toContain(
      `- ${SITE}: it asked for a passkey, which this browser does not have, so it told the site at once that none is available.`,
    );
  });
});

describe("a permission the captain is asked", () => {
  it("waits for Allow once, then for Not now, one ask at a time", async () => {
    const { browsers, page, handle } = await held();
    const camera = asks(page, "camera-microphone");
    await flush();
    expect(browsers.fact("t1")).toMatchObject({
      ask: { id: 1, kind: "camera-microphone", site: SITE },
    });
    // A second ask while the first waits is no.
    expect(await asks(page, "notifications").answer).toBe(false);
    expect(await browsers.answerAsk("t1", handle, 1, "allow")).toEqual({ ok: true });
    expect(await camera.answer).toBe(true);
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
    const clipboard = asks(page, "clipboard");
    await flush();
    expect(browsers.fact("t1")).toMatchObject({ ask: { id: 2, kind: "clipboard" } });
    expect(await browsers.answerAsk("t1", handle, 1, "allow")).toEqual({
      ok: false,
      text: "The page no longer asks for that.",
    });
    expect(await browsers.answerAsk("t1", handle, 2, "not-now")).toEqual({ ok: true });
    expect(await clipboard.answer).toBe(false);
  });

  it("goes when the page that asked goes, answered no", async () => {
    const { browsers, page } = await held();
    const notify = asks(page, "notifications");
    await flush();
    expect(browsers.fact("t1")).toHaveProperty("ask");
    notify.end();
    expect(await notify.answer).toBe(false);
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
  });

  it("answers a waiting ask no and takes back every permission when control returns", async () => {
    const { browsers, page, handle } = await held();
    const camera = asks(page, "camera");
    await flush();
    expect(await browsers.returnControl("t1", handle)).toEqual({ ok: true });
    expect(await camera.answer).toBe(false);
    expect(page.effects).toContain("revoke asks");
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
  });
});

describe("a passkey the captain's site asks for", () => {
  it("is told no on the built-in engine, and the captain is told why", async () => {
    const { browsers, page, handle } = await held();
    expect(await asks(page, "platform").answer).toBe(false);
    expect(await asks(page, "passkey").answer).toBe(false);
    expect(browsers.fact("t1")).toMatchObject({
      told: { kind: "passkey", site: SITE, where: "engine" },
    });
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
    await browsers.returnControl("t1", handle);
    expect(browsers.fact("t1")).not.toHaveProperty("told");
  });

  it("is told no in Chrome when the captain is away from its computer", async () => {
    const { browsers, page, shown } = await held({ chrome: true, here: false });
    expect(await asks(page, "platform").answer).toBe(false);
    expect(await asks(page, "passkey").answer).toBe(false);
    expect(browsers.fact("t1")).toMatchObject({ told: { where: "away", site: SITE } });
    expect(shown).toEqual([]);
  });

  it("waits in Chrome for Use passkey, then puts Chrome's window back when it ends", async () => {
    const { browsers, page, handle, shown } = await held({ chrome: true });
    expect(await asks(page, "platform").answer).toBe(true);
    const passkey = asks(page, "passkey");
    let answered: boolean | undefined;
    void passkey.answer.then((allow) => {
      answered = allow;
    });
    await flush();
    // Chrome gets nothing, and its window stays in the Dock, until the captain says so.
    expect(answered).toBeUndefined();
    expect(shown).toEqual([]);
    expect(browsers.fact("t1")).toMatchObject({ ask: { id: 1, kind: "passkey", site: SITE } });
    expect(browsers.fact("t1")).not.toHaveProperty("ask.allowed");
    // Use passkey.
    expect(await browsers.answerAsk("t1", handle, 1, "show")).toEqual({ ok: true });
    expect(await passkey.answer).toBe(true);
    expect(shown).toEqual([true]);
    expect(browsers.fact("t1")).toMatchObject({ ask: { id: 1, kind: "passkey", allowed: true } });
    // Once let run, Not now is no longer the captain's: Chrome's own prompt answers it.
    expect(await browsers.answerAsk("t1", handle, 1, "not-now")).toMatchObject({ ok: false });
    expect(await browsers.answerAsk("t1", handle, 1, "show")).toEqual({ ok: true });
    expect(shown).toEqual([true, true]);
    passkey.end();
    await flush();
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
    expect(shown).toEqual([true, true, false]);
  });

  it("is told no in Chrome on Not now, with Chrome's window never brought out", async () => {
    const { browsers, page, handle, shown } = await held({ chrome: true });
    const passkey = asks(page, "passkey");
    await flush();
    expect(await browsers.answerAsk("t1", handle, 1, "not-now")).toEqual({ ok: true });
    expect(await passkey.answer).toBe(false);
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
    expect(shown).not.toContain(true);
  });

  it("puts Chrome's window back when a request ends with no press, and at Return control", async () => {
    const { browsers, page, handle, shown } = await held({ chrome: true });
    // The site gave up, or Chrome's window came out by itself: it still goes back.
    const passkey = asks(page, "passkey");
    await flush();
    passkey.end();
    expect(await passkey.answer).toBe(false);
    await flush();
    expect(browsers.fact("t1")).not.toHaveProperty("ask");
    expect(shown).toEqual([false]);
    // With no ask open at all, Return control puts every Chrome window back.
    expect(await browsers.returnControl("t1", handle)).toEqual({ ok: true });
    expect(shown).toEqual([false, false]);
  });

  it("follows the captain: one who moves away from Chrome's computer is told no", async () => {
    const { browsers, page } = await held({ chrome: true });
    browsers.captainAt("t1", false);
    expect(await asks(page, "passkey").answer).toBe(false);
    expect(browsers.fact("t1")).toMatchObject({ told: { where: "away" } });
  });
});
