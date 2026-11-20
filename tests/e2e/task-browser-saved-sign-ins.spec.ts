import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { DECLINE_LABEL } from "../../src/shared/cardLeave";
import { HERE } from "../../src/shared/deviceNames";
import {
  ASK_EACH_TIME_LABEL,
  RETURN_CONTROL_LABEL,
  SAVED_SIGN_IN_FAILED_LABEL,
  SIGN_IN_MYSELF_LABEL,
  savedCaption,
  savedSignInLabel,
  signInRuleLegend,
  USE_WITHOUT_ASKING_LABEL,
} from "../../src/shared/taskBrowser";
import { MOCK_LEAVE_WAITING } from "./browserScript";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { isTaskRequest } from "./providerRequest";
import {
  MOCK_SAVED_ACTION,
  MOCK_SAVED_ASKED_REPORT,
  MOCK_SAVED_CARD_TITLE,
  MOCK_SAVED_FAILED_CARD_TITLE,
  MOCK_SAVED_FAILED_REPORT,
  MOCK_SAVED_REPORT_PREFIX,
  MOCK_SAVED_WAKE_SAID,
  TASK_BROWSER_SAVED_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { SHOWN_ENTRY, showCard, shownCard } from "./stack";
import {
  canvasReading,
  clickOnPage,
  closeSite,
  filesHolding,
  onPage,
  pageCookieNames,
  pageSays,
  stopTaskBrowsers,
  typeOnPage,
  browserView as view,
} from "./taskBrowser";
import { setThemeViaSettings } from "./theme";
import { runFromSearch } from "./windowKeys";

/**
 * Signed-in sites in a task's own browser (docs/task-browser.md, "Signed-in
 * sites"), INF-4585's plan: a sign-in request opens its site in this
 * computer's kept profile, the captain picks the site's rule while
 * returning control, a later task's request offers it on one click and is
 * signed in with nothing copied, a task without it is signed out, Settings'
 * Remove signs the site out, and a site that turned it away leads the next
 * request with Sign in myself - for a site that keeps its sign-in in a
 * cookie or in its page storage. Each journey serves its own club page on
 * this Mac.
 *
 * The crewmate is the mock provider's script (`taskBrowserJourneys`): it
 * acts only on refs the real outline gave it and reports what the real page
 * said, so the report is the page's own words passed through the product.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [taskBrowserJourneys] });
});

test.afterAll(async () => {
  await launched.close();
});

/** A signed-in site's entry, as the list wrote it: never a cookie or page storage. */
type SavedSignInFile = { site: string; failedAt?: number; automatic?: boolean };

/** The signed-in sites' entries on this Mac, each as the list wrote it. */
function savedSignInFiles(): SavedSignInFile[] {
  const store = join(launched.userDataDir, "web-sign-ins");
  return existsSync(store)
    ? readdirSync(store)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(store, name), "utf8")))
    : [];
}

/** A task's record by its title, or nothing before it is filed. */
function detailTitled(title: string): Promise<TaskDetail | null> {
  return launched.page.evaluate(async (wanted) => {
    const row = (await window.infinitary.tasks.board()).tasks.find((task) => task.title === wanted);
    return row ? window.infinitary.tasks.detail(row.id) : null;
  }, title);
}

/** A task's request to sign in to the club page, as the card stack holds it. */
async function savedCardOf(taskId: string) {
  return (await launched.page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === MOCK_SAVED_CARD_TITLE && card.taskId === taskId,
  );
}

/** The request to sign in to the club page, as the stack shows it. */
function savedCardRegion(): Locator {
  return shownCard(launched.page, MOCK_SAVED_CARD_TITLE);
}

/** A crewmate's own model calls, by its task's title. */
function crewmateCalls(title: string): string[] {
  return (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
    isTaskRequest(body, title),
  );
}

/** Ask for a club page task, and wait for its crewmate to ask the captain to sign in. */
async function askToSignIn(title: string): Promise<TaskDetail> {
  const { page } = launched;
  await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await promptInput(page).press("Enter");
  await expect
    .poll(async () => (await detailTitled(title))?.outcome ?? "", { timeout: 60_000 })
    .toContain(MOCK_SAVED_ASKED_REPORT);
  return (await detailTitled(title)) as TaskDetail;
}

/** Settings › General's Website sign-ins. */
async function openGeneralSettings(): Promise<Locator> {
  const { page } = launched;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const section = page.locator("[data-website-sign-ins]");
  await expect(section).toBeVisible();
  return section;
}

async function closeSettings(): Promise<void> {
  const { page } = launched;
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
    "data-screen-label",
    "Settings",
  );
}

/**
 * A club page whose sign-in its server keeps in a cookie: it reads `who`,
 * and counts each signed-in visit in a `visit` cookie it sets anew, so a
 * session the site refreshed is a cookie that changed. Its Sign in button
 * counts only a real click; the password never leaves the page.
 */
const clubPage = (who: string | undefined): string => `<!doctype html>
<html>
  <head><title>Club</title><style>body { background: rgb(30, 110, 80); color: white; font: 18px sans-serif; } input, button { font: inherit; margin: 8px; }</style></head>
  <body>
    <h1>Club</h1>
    <p id="state">${who ? `Signed in as ${who.replace(/[<&"]/g, "")}` : "Not signed in"}</p>
    <p><label>Email <input id="email" type="email"></label></p>
    <p><label>Password <input id="password" type="password"></label></p>
    <p><button id="sign-in">Sign in</button></p>
    <script>
      document.getElementById("sign-in").addEventListener("click", async (event) => {
        if (!event.isTrusted) return;
        await fetch("/sign-in", { method: "POST", body: document.getElementById("email").value });
        location.reload();
      });
    </script>
  </body>
</html>`;

test("a sign-in kept in this computer's profile signs in a later task on the captain's click with nothing copied, leaves one without it signed out, and Remove signs it out", async () => {
  // One journey: a sign-in request opens the kept profile, the captain signs
  // in and picks Ask me each time, a second task waits signed out until the
  // captain's click, and Remove signs it out while that task uses it.
  test.setTimeout(240_000);
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const club = createServer((request, response) => {
    const cookies = new Map(
      (request.headers.cookie ?? "")
        .split(/;\s*/)
        .filter(Boolean)
        .map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))] as const;
        }),
    );
    if (request.method === "POST" && request.url === "/sign-in") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(204, {
          "set-cookie": `who=${encodeURIComponent(body)}; Path=/; HttpOnly; SameSite=Lax`,
        });
        response.end();
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(clubPage(cookies.get("who")));
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const PASSWORD = "club-hunter2-correct-horse";
  /** The cookies a task's hidden page holds now, by name. */
  const pageCookies = (): Promise<string[]> => pageCookieNames(app, clubUrl);
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("the first task");
    const second = titled("the second task");

    const a =
      await test.step("with nothing kept, the request offers only the captain's own sign-in, which opens the kept profile", async () => {
        const task = await askToSignIn(first);
        expect((await savedCardOf(task.id))?.actions.map((action) => action.label)).toEqual([
          MOCK_LEAVE_WAITING,
          MOCK_SAVED_ACTION,
          DECLINE_LABEL, // The app's Decline beside the crewmate's choices (INF-3108).
        ]);
        expect(await page.evaluate(() => window.infinitary.browser.signIns())).toEqual({
          available: true,
          signIns: [],
        });
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect
          .poll(async () => (await detailTitled(first))?.browser)
          .toMatchObject({
            kept: true,
          });
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        return task;
      });

    await test.step("the captain signs in and picks the site's rule on Return control; the list keeps no cookie", async () => {
      await typeOnPage(app, page, a.id, clubUrl, "email", "sam@example.com");
      await typeOnPage(app, page, a.id, clubUrl, "password", PASSWORD);
      await clickOnPage(app, page, a.id, clubUrl, "sign-in");
      await expect
        .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      const question = view(page, a.id).locator("[data-browser-sharing]");
      const rule = question.getByRole("group", { name: signInRuleLegend(site) });
      const ask = rule.getByRole("radio", { name: ASK_EACH_TIME_LABEL });
      const automatic = rule.getByRole("radio", { name: USE_WITHOUT_ASKING_LABEL });
      // Ask me each time leads.
      await expect(ask).toBeChecked();
      await expect(automatic).not.toBeChecked();
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await expect(ask).toBeChecked();
        await shoot(view(page, a.id), "view-return-rule-light.png");
        await setThemeViaSettings(page, "dark");
        // The release note's hero pair: the rule asked as control comes back.
        await heroShot(app, page, { region: view(page, a.id), name: "task-browser-kept-sign-ins" });
      }
      await shoot(view(page, a.id), "view-return-rule-dark.png");
      expect(savedSignInFiles()).toEqual([]);
      await view(page, a.id)
        .getByRole("button", { name: RETURN_CONTROL_LABEL, exact: true })
        .click();
      await expect
        .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      expect((await detailTitled(first))?.browser).toMatchObject({
        saved: [site],
        returned: true,
        kept: true,
      });
      await expect(view(page, a.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${savedCaption([site])}`,
      );
      // The list names the site and its rule, never its cookies or what the captain typed.
      expect(savedSignInFiles()).toEqual([
        { version: 2, site, savedAt: expect.any(Number), id: expect.any(String) },
      ]);
      expect(filesHolding(join(launched.userDataDir, "web-sign-ins"), "sam%40example.com")).toEqual(
        [],
      );
      expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
      const listed = await page.evaluate(() => window.infinitary.browser.signIns());
      expect(listed.signIns).toEqual([
        { site, savedAt: expect.any(Number), id: expect.any(String) },
      ]);
    });

    await test.step("Settings lists it with its rule, and the browser's stop leaves the kept profile signed in", async () => {
      const section = await openGeneralSettings();
      const row = section.locator(`[data-website-sign-in="${site}"]`);
      await expect(row).toContainText(site);
      await expect(row.getByRole("combobox")).toHaveValue("ask");
      await shoot(section, "settings-website-sign-ins-dark.png");
      await closeSettings();
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(first))?.browser?.state).toBe("stopped");
    });

    const b =
      await test.step("a later task without the captain's allowance is signed out, and its request offers the kept sign-in as its default", async () => {
        const task = await askToSignIn(second);
        const card = await savedCardOf(task.id);
        expect(
          card?.actions.map((action) => ({
            label: action.label,
            default: action.default === true,
            savedSignIn: action.effect?.kind === "open" && action.effect.savedSignIn === true,
          })),
        ).toEqual([
          { label: MOCK_LEAVE_WAITING, default: false, savedSignIn: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false, savedSignIn: false },
          { label: savedSignInLabel(site), default: true, savedSignIn: true },
          { label: DECLINE_LABEL, default: false, savedSignIn: false }, // The app's Decline (INF-3108).
        ]);
        // Its browser opened in an empty context of its own: the page is not signed in.
        expect(await pageSays(app, clubUrl, "state")).toBe("Not signed in");
        expect(await pageCookies()).not.toContain("who");
        expect((await detailTitled(second))?.browser).not.toHaveProperty("kept");
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await shoot(page.locator(SHOWN_ENTRY), "card-kept-sign-in-dark.png");
        return task;
      });

    await test.step("one click opens its page in the kept profile, signed in with nothing copied, and the crewmate carries on", async () => {
      await savedCardRegion()
        .getByRole("button", { name: savedSignInLabel(site) })
        .click();
      await expect(view(page, b.id)).toBeVisible();
      await expect
        .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      const current = (await detailTitled(second)) as TaskDetail;
      expect(current.outcome).toContain(
        `${MOCK_SAVED_WAKE_SAID} "The captain let this task use the sign-in kept on ${HERE.this} for ${site}, and your browser is yours again:"`,
      );
      expect(current.browser).toMatchObject({ state: "open", saved: [site], kept: true });
      expect(current.browser).not.toHaveProperty("control");
      const lines = current.events.map((event) => event.text);
      expect(lines).toContain(`you let it use your sign-in at ${site}`);
      // The captain never took the page: the grant is the one line beside the handoffs.
      expect(lines).not.toContain("you took control of its browser");
      await expect(view(page, b.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${savedCaption([site])}`,
      );
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, b.id), "view-kept-granted-dark.png");
      expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
      expect(await pageCookies()).toEqual(expect.arrayContaining(["who"]));
      // Still nothing of the sign-in in the list.
      expect(savedSignInFiles()).toEqual([
        expect.not.objectContaining({ cookies: expect.anything() }),
      ]);
    });

    await test.step("Remove in Settings signs the kept profile out of the site, and the browser using it with it", async () => {
      const section = await openGeneralSettings();
      await section
        .locator(`[data-website-sign-in="${site}"]`)
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(section.locator("[data-website-sign-ins-empty]")).toBeVisible();
      await expect(section.locator(`[data-website-sign-in="${site}"]`)).toHaveCount(0);
      await shoot(section, "settings-website-sign-ins-removed-dark.png");
      await closeSettings();
      expect(savedSignInFiles()).toEqual([]);
      await expect.poll(pageCookies).not.toContain("who");
      const current = (await detailTitled(second)) as TaskDetail;
      expect(current.browser).not.toHaveProperty("saved");
      expect(current.events.map((event) => event.text)).toContain(
        `your sign-in at ${site} was removed, and its browser signed out of it`,
      );
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), b.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(second))?.browser?.state).toBe("stopped");
    });
  } finally {
    await closeSite(club);
  }
});

/**
 * A club page that keeps its sign-in in its own page storage, never in a
 * cookie: its server sets none. Sign in (a real click only) keeps the
 * session in local storage and reloads, and each signed-in visit counts
 * itself there, so a session the page refreshed is storage that changed.
 * The password never leaves the page.
 */
const STORED_CLUB_PAGE = `<!doctype html>
<html>
  <head><title>Club</title><style>body { background: rgb(40, 70, 130); color: white; font: 18px sans-serif; } input, button { font: inherit; margin: 8px; }</style></head>
  <body>
    <h1>Club</h1>
    <p id="state">Not signed in</p>
    <p id="visit"></p>
    <p><label>Email <input id="email" type="email"></label></p>
    <p><label>Password <input id="password" type="password"></label></p>
    <p><button id="sign-in">Sign in</button></p>
    <script>
      const session = JSON.parse(localStorage.getItem("session") || "null");
      if (session) {
        document.getElementById("state").textContent = "Signed in as " + session.who;
        const visit = Number(localStorage.getItem("visit") || "0") + 1;
        localStorage.setItem("visit", String(visit));
        document.getElementById("visit").textContent = "Visit " + visit;
      }
      document.getElementById("sign-in").addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        const who = document.getElementById("email").value;
        localStorage.setItem("session", JSON.stringify({ who, token: Math.random().toString(36).slice(2) }));
        location.reload();
      });
    </script>
  </body>
</html>`;

test("a site that keeps its sign-in in its own page storage stays signed in for a later task by its rule, and Remove clears that storage", async () => {
  // One journey: the page storage a sign-in left in the kept profile is used
  // by a second task under Use it without asking, and Remove clears it.
  test.setTimeout(240_000);
  const { page, app } = launched;
  await stopTaskBrowsers(page);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const club = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(STORED_CLUB_PAGE);
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const PASSWORD = "stored-club-hunter2-battery-staple";
  /** The page storage a task's hidden page on the club holds now, by key. */
  const pageStorage = async (): Promise<Record<string, string> | null> => {
    const held = await onPage(app, clubUrl, "JSON.stringify({ ...localStorage })");
    return typeof held === "string" ? JSON.parse(held) : null;
  };
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("stored task one");
    const second = titled("stored task two");

    const a =
      await test.step("the captain signs in and picks Use it without asking; the page's storage stays in the kept profile", async () => {
        const task = await askToSignIn(first);
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        // The page the captain signs in on is the one moved into the kept profile,
        // never the empty context's it replaces, which Chrome may still be closing.
        await expect
          .poll(async () => (await detailTitled(first))?.browser)
          .toMatchObject({ kept: true });
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await typeOnPage(app, page, task.id, clubUrl, "email", "sam@example.com");
        await typeOnPage(app, page, task.id, clubUrl, "password", PASSWORD);
        await clickOnPage(app, page, task.id, clubUrl, "sign-in");
        await expect
          .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
          .toBe("Signed in as sam@example.com");
        const rule = view(page, task.id)
          .locator("[data-browser-sharing]")
          .getByRole("group", { name: signInRuleLegend(site) });
        await rule.getByRole("radio", { name: USE_WITHOUT_ASKING_LABEL }).check();
        await runFromSearch(app, page, "browser.control");
        await expect
          .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        expect(savedSignInFiles()).toEqual([
          {
            version: 2,
            site,
            savedAt: expect.any(Number),
            id: expect.any(String),
            automatic: true,
          },
        ]);
        expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
        const section = await openGeneralSettings();
        await expect(
          section.locator(`[data-website-sign-in="${site}"]`).getByRole("combobox"),
        ).toHaveValue("automatic");
        await shoot(section, "settings-stored-sign-in-rule-dark.png");
        await closeSettings();
        return task;
      });

    const b =
      await test.step("a later task's browser opens the site signed in without a card, by the rule", async () => {
        expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
          ok: true,
        });
        await expect.poll(async () => (await detailTitled(first))?.browser?.state).toBe("stopped");
        const task = await askToSignIn(second);
        // The crewmate's own open used the kept sign-in, so its request offers nothing more.
        expect(await pageSays(app, clubUrl, "state")).toBe("Signed in as sam@example.com");
        expect(await pageStorage()).toMatchObject({ session: expect.stringContaining("sam@") });
        const current = (await detailTitled(second)) as TaskDetail;
        expect(current.browser).toMatchObject({ state: "open", saved: [site], kept: true });
        expect(current.events.map((event) => event.text)).toContain(
          `used your sign-in at ${site}, as your rule for it allows`,
        );
        expect((await savedCardOf(task.id))?.actions.map((action) => action.label)).not.toContain(
          savedSignInLabel(site),
        );
        expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
        // The page is signed in already: the captain declines the request, which leaves the stack.
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: DECLINE_LABEL }).click();
        await expect.poll(() => savedCardOf(task.id)).toBeUndefined();
        return task;
      });

    await test.step("Remove in Settings clears the site's storage in the kept profile", async () => {
      const section = await openGeneralSettings();
      await section
        .locator(`[data-website-sign-in="${site}"]`)
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(section.locator(`[data-website-sign-in="${site}"]`)).toHaveCount(0);
      await closeSettings();
      expect(savedSignInFiles()).toEqual([]);
      await expect.poll(pageStorage).toEqual({});
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), b.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(second))?.browser?.state).toBe("stopped");
    });
  } finally {
    await closeSite(club);
  }
});

test("a kept sign-in the site turned away is marked by the crewmate, and the next request leads with Sign in myself (INF-1849)", async () => {
  // One journey, the captain's approved INF-1849 plan, piece 2: a club that
  // ends its sessions on its own schedule turns a day-old saved sign-in
  // away; the crewmate says so on its next card, and a later task's
  // request keeps the kept sign-in as a second choice that says it did not work.
  test.setTimeout(240_000);
  const { page, app } = launched;
  await stopTaskBrowsers(page);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  /** The club's live sessions, by token: ending them is the club's own schedule. */
  const sessions = new Map<string, string>();
  const club = createServer((request, response) => {
    const token = (request.headers.cookie ?? "").match(/(?:^|;\s*)token=([^;]+)/)?.[1];
    if (request.method === "POST" && request.url === "/sign-in") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const minted = `t${sessions.size + 1}-${Date.now()}`;
        sessions.set(minted, body);
        response.writeHead(204, {
          "set-cookie": `token=${minted}; Path=/; HttpOnly; SameSite=Lax`,
        });
        response.end();
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(clubPage(token ? sessions.get(token) : undefined));
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  const stop = async (title: string, id: string): Promise<void> => {
    expect(await page.evaluate((task) => window.infinitary.browser.stop(task), id)).toEqual({
      ok: true,
    });
    await expect.poll(async () => (await detailTitled(title))?.browser?.state).toBe("stopped");
  };
  /** A card's buttons as the stack holds them: label and whether it is the default. */
  const buttons = async (title: string, taskId: string) =>
    (await page.evaluate(() => window.infinitary.cards.list()))
      .find((card) => card.title === title && card.taskId === taskId)
      ?.actions.map((action) => ({ label: action.label, default: action.default === true }));
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("strict one");
    const second = titled("strict two");
    const third = titled("strict three");

    await test.step("the captain signs in and Return control keeps the club's sign-in", async () => {
      const task = await askToSignIn(first);
      await showCard(page, MOCK_SAVED_CARD_TITLE);
      await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
      // The page the captain signs in on is the one moved into the kept profile,
      // never the empty context's it replaces, which Chrome may still be closing.
      await expect
        .poll(async () => (await detailTitled(first))?.browser)
        .toMatchObject({ kept: true });
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await typeOnPage(app, page, task.id, clubUrl, "email", "sam@example.com");
      await typeOnPage(app, page, task.id, clubUrl, "password", "strict-club-password");
      await clickOnPage(app, page, task.id, clubUrl, "sign-in");
      await expect
        .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      await runFromSearch(app, page, "browser.control");
      await expect
        .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      expect(savedSignInFiles()).toEqual([expect.objectContaining({ site })]);
      expect(savedSignInFiles()[0]).not.toHaveProperty("failedAt");
      await stop(first, task.id);
    });

    const b =
      await test.step("the club ends the session, the kept sign-in leaves the page signed out, and the crewmate marks it", async () => {
        // The club's own schedule: the kept token is no longer accepted.
        sessions.clear();
        const task = await askToSignIn(second);
        expect(await buttons(MOCK_SAVED_CARD_TITLE, task.id)).toEqual([
          { label: MOCK_LEAVE_WAITING, default: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false },
          { label: savedSignInLabel(site), default: true },
          { label: DECLINE_LABEL, default: false }, // The app's Decline (INF-3108).
        ]);
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        // The same crop as the request after the mark, into the evidence folder alone.
        if (evidence)
          await heroShot(app, page, {
            region: savedCardRegion(),
            name: "card-saved-sign-in-before",
            dir: evidence,
          });
        await savedCardRegion()
          .getByRole("button", { name: savedSignInLabel(site) })
          .click();
        await expect
          .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
          .toContain(MOCK_SAVED_FAILED_REPORT);
        const current = (await detailTitled(second)) as TaskDetail;
        // The host marked the entry the browser was given; its tool answer says nothing went unmarked.
        expect(current.outcome).not.toContain("marked nothing");
        expect(savedSignInFiles()).toEqual([
          expect.objectContaining({ site, failedAt: expect.any(Number) }),
        ]);
        expect(current.events.map((event) => event.text)).toContain(
          `said your sign-in at ${site} did not sign its page in`,
        );
        // Its browser uses the kept sign-in already, so its own card offers only the captain's sign-in.
        expect(await buttons(MOCK_SAVED_FAILED_CARD_TITLE, task.id)).toEqual([
          { label: MOCK_LEAVE_WAITING, default: false },
          { label: MOCK_SAVED_ACTION, default: true },
          { label: DECLINE_LABEL, default: false }, // The app's Decline (INF-3108).
        ]);
        return task;
      });

    await test.step("a later task's request leads with Sign in myself and keeps the kept sign-in as a second choice", async () => {
      const task = await askToSignIn(third);
      expect(await buttons(MOCK_SAVED_CARD_TITLE, task.id)).toEqual([
        { label: MOCK_LEAVE_WAITING, default: false },
        { label: SAVED_SIGN_IN_FAILED_LABEL, default: false },
        { label: SIGN_IN_MYSELF_LABEL, default: true },
        { label: DECLINE_LABEL, default: false }, // The app's Decline (INF-3108).
      ]);
      await showCard(page, MOCK_SAVED_CARD_TITLE);
      const card = savedCardRegion();
      await expect(card.getByRole("button", { name: SAVED_SIGN_IN_FAILED_LABEL })).toBeVisible();
      if (evidence)
        await heroShot(app, page, { region: card, name: "task-browser-saved-sign-in-failed" });
      await stop(third, task.id);
      await stop(second, b.id);
    });
  } finally {
    await page.evaluate((named) => window.infinitary.browser.removeSignIn(named), site);
    await closeSite(club);
  }
});
