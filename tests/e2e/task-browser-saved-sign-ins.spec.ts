import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { HERE } from "../../src/shared/deviceNames";
import {
  RETURN_CONTROL_LABEL,
  rememberSignInLabel,
  SAVED_SIGN_IN_FAILED_LABEL,
  SIGN_IN_MYSELF_LABEL,
  savedCaption,
  savedSignInLabel,
} from "../../src/shared/taskBrowser";
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
  TASK_BROWSER_SAVED_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { SHOWN_ENTRY, showCard, shownCard } from "./stack";
import {
  canvasReading,
  clickOnPage,
  closeSite,
  filesHolding,
  pageSays,
  stopTaskBrowsers,
  typeOnPage,
  browserView as view,
} from "./taskBrowser";
import { setThemeViaSettings } from "./theme";
import { runFromSearch } from "./windowKeys";

/**
 * Saved sign-ins in a task's own browser (docs/task-browser.md, "Saved
 * sign-ins"). The captain signs in to a club page and saves its sign-in
 * while returning control, a later task's request offers it on one click,
 * Settings removes it, and a site that turned it away leads the next
 * request with Sign in myself - for a site that keeps its sign-in in a
 * cookie, in its page storage, or in its page's session storage alone. Each
 * journey serves its own club page on this Mac.
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

/** A saved sign-in's file, as the store wrote it. */
type SavedSignInFile = {
  site: string;
  failedAt?: number;
  cookies: { name: string; value: string }[];
  storage?: { origin: string; items: [string, string][] }[];
  session?: { origin: string; items: [string, string][] }[];
};

/** The saved sign-ins' files on this Mac, each as the store wrote it. */
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

test("without future-task permission a saved sign-in reaches a later task only on the captain's click, and Settings removes it", async () => {
  // One journey: a sign-in saved as one task's browser is handed back, its
  // grant to a second task, and its removal while that task uses it.
  test.setTimeout(240_000);
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let visits = 0;
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
    const who = cookies.get("who");
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (who) {
      visits += 1;
      headers["set-cookie"] = `visit=${visits}; Path=/; HttpOnly; SameSite=Lax`;
    }
    response.writeHead(200, headers);
    response.end(clubPage(who));
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const PASSWORD = "club-hunter2-correct-horse";
  /** The cookies a task's hidden page holds now, by name. */
  const pageCookies = (): Promise<string[]> =>
    app.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(url));
      return contents ? (await contents.session.cookies.get({})).map((cookie) => cookie.name) : [];
    }, clubUrl);
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("the first task");
    const second = titled("the second task");

    const a =
      await test.step("with nothing saved, the request offers only the captain's own sign-in", async () => {
        const task = await askToSignIn(first);
        expect((await savedCardOf(task.id))?.actions.map((action) => action.label)).toEqual([
          "Leave waiting",
          MOCK_SAVED_ACTION,
        ]);
        expect(await page.evaluate(() => window.infinitary.browser.signIns())).toEqual({
          available: true,
          signIns: [],
        });
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        return task;
      });

    await test.step("the captain signs in, and Return control's tick saves the site's sign-in on this Mac", async () => {
      await typeOnPage(launched.app, page, a.id, clubUrl, "email", "sam@example.com");
      await typeOnPage(launched.app, page, a.id, clubUrl, "password", PASSWORD);
      await clickOnPage(launched.app, page, a.id, clubUrl, "sign-in");
      await expect
        .poll(() => pageSays(launched.app, clubUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      const question = view(page, a.id).locator("[data-browser-sharing]");
      const tick = question.getByRole("checkbox", {
        name: rememberSignInLabel(site),
      });
      const asking = async (): Promise<void> => {
        // Nothing is saved without the tick, and it never starts ticked.
        await expect(tick).not.toBeChecked();
      };
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await asking();
        await tick.check();
        await shoot(view(page, a.id), "view-return-remember-ticked-light.png");
        await tick.uncheck();
        await setThemeViaSettings(page, "dark");
      }
      await asking();
      await shoot(view(page, a.id), "view-return-remember-dark.png");
      await tick.check();
      await shoot(view(page, a.id), "view-return-remember-ticked-dark.png");
      expect(savedSignInFiles()).toEqual([]);
      await view(page, a.id)
        .getByRole("button", { name: RETURN_CONTROL_LABEL, exact: true })
        .click();
      await expect
        .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      expect((await detailTitled(first))?.browser).toMatchObject({ saved: [site], returned: true });
      await expect(view(page, a.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${savedCaption([site])}`,
      );
      await shoot(view(page, a.id), "view-saved-in-use-dark.png");
      // The site's own cookies are saved, never what the captain typed.
      expect(savedSignInFiles()).toEqual([
        expect.objectContaining({
          site,
          cookies: expect.arrayContaining([
            expect.objectContaining({ name: "who", value: "sam%40example.com" }),
          ]),
        }),
      ]);
      expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
      const listed = await page.evaluate(() => window.infinitary.browser.signIns());
      expect(listed.signIns).toEqual([
        { site, savedAt: expect.any(Number), id: expect.any(String) },
      ]);
    });

    await test.step("Settings lists it, and the browser copies it back when it stops", async () => {
      const section = await openGeneralSettings();
      const row = section.locator(`[data-website-sign-in="${site}"]`);
      await expect(row).toContainText(site);
      await shoot(section, "settings-website-sign-ins-dark.png");
      await closeSettings();
      // The crewmate opened the page again after the return, so the club counted a new visit.
      const latest = String(visits);
      expect(
        savedSignInFiles()[0]?.cookies.find((cookie) => cookie.name === "visit")?.value,
      ).not.toBe(latest);
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
        ok: true,
      });
      await expect
        .poll(() => savedSignInFiles()[0]?.cookies.find((cookie) => cookie.name === "visit")?.value)
        .toBe(latest);
    });

    const b =
      await test.step("a later task's request offers the saved sign-in as its default", async () => {
        const task = await askToSignIn(second);
        const card = await savedCardOf(task.id);
        expect(
          card?.actions.map((action) => ({
            label: action.label,
            default: action.default === true,
            savedSignIn: action.effect?.kind === "open" && action.effect.savedSignIn === true,
          })),
        ).toEqual([
          { label: "Leave waiting", default: false, savedSignIn: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false, savedSignIn: false },
          { label: savedSignInLabel(site), default: true, savedSignIn: true },
        ]);
        // Its browser started empty: the card is up on a page that is not signed in.
        expect(await pageSays(launched.app, clubUrl, "state")).toBe("Not signed in");
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await shoot(page.locator(SHOWN_ENTRY), "card-saved-sign-in-dark.png");
        if (evidence) {
          await setThemeViaSettings(page, "light");
          await showCard(page, MOCK_SAVED_CARD_TITLE);
          await shoot(page.locator(SHOWN_ENTRY), "card-saved-sign-in-light.png");
          await setThemeViaSettings(page, "dark");
          await showCard(page, MOCK_SAVED_CARD_TITLE);
        }
        return task;
      });

    await test.step("one click signs its browser in and hands it back, and the crewmate carries on", async () => {
      await savedCardRegion()
        .getByRole("button", { name: savedSignInLabel(site) })
        .click();
      await expect(view(page, b.id)).toBeVisible();
      await expect
        .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      const current = (await detailTitled(second)) as TaskDetail;
      expect(current.outcome).toContain(
        `The wake said "The captain let this task use the sign-in saved on ${HERE.this} for ${site}, and your browser is yours again:"`,
      );
      expect(current.browser).toMatchObject({ state: "open", saved: [site] });
      expect(current.browser).not.toHaveProperty("control");
      const lines = current.events.map((event) => event.text);
      expect(lines).toContain(`you let it use your saved sign-in at ${site}`);
      // The captain never took the page: the grant is the one line beside the handoffs.
      expect(lines).not.toContain("you took control of its browser");
      await expect(view(page, b.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${savedCaption([site])}`,
      );
      // The view watches the page the saved sign-in reloaded, signed in.
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, b.id), "view-saved-granted-dark.png");
      expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
      expect(await pageCookies()).toEqual(expect.arrayContaining(["who"]));
    });

    await test.step("Remove in Settings signs out the browser using it, and nothing copies it back", async () => {
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
        `your saved sign-in at ${site} was removed, and its browser signed out of it`,
      );
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), b.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(second))?.browser?.state).toBe("stopped");
      expect(savedSignInFiles()).toEqual([]);
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

test("a site that keeps its sign-in in its own page storage is saved, used and removed like one in cookies", async () => {
  // One journey: the page storage saved as one task's browser is handed
  // back, copied back when it stops, granted to a second task, and removed
  // while that task uses it.
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
  const origin = new URL(clubUrl).origin;
  const PASSWORD = "stored-club-hunter2-battery-staple";
  /** What a saved file keeps of the club's own page storage, by key. */
  const savedStorage = (): Record<string, string> =>
    Object.fromEntries(
      savedSignInFiles()[0]?.storage?.find((held) => held.origin === origin)?.items ?? [],
    );
  /** The page storage a task's hidden page on the club holds now, by key. */
  const pageStorage = (): Promise<Record<string, string> | null> =>
    app.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(url));
      return contents
        ? JSON.parse(await contents.executeJavaScript("JSON.stringify({ ...localStorage })"))
        : null;
    }, clubUrl);
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("stored task one");
    const second = titled("stored task two");

    const a =
      await test.step("the captain signs in, and Return control's tick saves the page's own storage", async () => {
        const task = await askToSignIn(first);
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await typeOnPage(app, page, task.id, clubUrl, "email", "sam@example.com");
        await typeOnPage(app, page, task.id, clubUrl, "password", PASSWORD);
        await clickOnPage(app, page, task.id, clubUrl, "sign-in");
        await expect
          .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
          .toBe("Signed in as sam@example.com");
        const sharing = view(page, task.id).locator("[data-browser-sharing]");
        await sharing.getByRole("checkbox", { name: rememberSignInLabel(site) }).check();
        await runFromSearch(app, page, "browser.control");
        await expect
          .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        expect((await detailTitled(first))?.browser).toMatchObject({
          saved: [site],
          returned: true,
        });
        // The site keeps no cookie: its sign-in is the page's own storage, for its own origin alone.
        expect(savedSignInFiles()).toEqual([
          expect.objectContaining({
            site,
            cookies: [],
            storage: [expect.objectContaining({ origin })],
          }),
        ]);
        expect(JSON.parse(savedStorage().session ?? "{}")).toMatchObject({
          who: "sam@example.com",
        });
        expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
        const section = await openGeneralSettings();
        await expect(section.locator(`[data-website-sign-in="${site}"]`)).toContainText(site);
        await shoot(section, "settings-stored-sign-in-after-dark.png");
        await closeSettings();
        return task;
      });

    await test.step("the browser copies the page's refreshed storage back when it stops", async () => {
      // The crewmate opened the page again after the return, so the page counted a new visit.
      const latest = (await pageStorage())?.visit;
      expect(latest).toBeTruthy();
      expect(savedStorage().visit).not.toBe(latest);
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
        ok: true,
      });
      await expect.poll(() => savedStorage().visit).toBe(latest);
    });

    const b =
      await test.step("a later task's request offers it, and one click signs its page in from storage", async () => {
        const task = await askToSignIn(second);
        expect(
          (await savedCardOf(task.id))?.actions.map((action) => ({
            label: action.label,
            default: action.default === true,
          })),
        ).toEqual([
          { label: "Leave waiting", default: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false },
          { label: savedSignInLabel(site), default: true },
        ]);
        // Its browser started empty: nothing of the club's storage is in it yet.
        expect(await pageSays(app, clubUrl, "state")).toBe("Not signed in");
        expect(await pageStorage()).toEqual({});
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await shoot(page.locator(SHOWN_ENTRY), "card-stored-sign-in-after-dark.png");
        await savedCardRegion()
          .getByRole("button", { name: savedSignInLabel(site) })
          .click();
        await expect(view(page, task.id)).toBeVisible();
        await expect
          .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        const current = (await detailTitled(second)) as TaskDetail;
        expect(current.browser).toMatchObject({ state: "open", saved: [site] });
        expect(current.events.map((event) => event.text)).toContain(
          `you let it use your saved sign-in at ${site}`,
        );
        expect(await pageStorage()).toMatchObject({ session: expect.stringContaining("sam@") });
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await shoot(view(page, task.id), "view-stored-sign-in-granted-after-dark.png");
        expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
        return task;
      });

    await test.step("Remove in Settings clears the page's storage in the browser using it", async () => {
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
      expect(savedSignInFiles()).toEqual([]);
    });
  } finally {
    await closeSite(club);
  }
});

/**
 * A club page that keeps its sign-in in its page's session storage alone,
 * as a site that signs its page in with a token does: its server sets no
 * cookie, and it keeps nothing in local storage. Sign in (a real click
 * only) keeps the token there and reloads. The password never leaves the
 * page.
 */
const SESSION_CLUB_PAGE = `<!doctype html>
<html>
  <head><title>Club</title><style>body { background: rgb(40, 110, 90); color: white; font: 18px sans-serif; } input, button { font: inherit; margin: 8px; }</style></head>
  <body>
    <h1>Club</h1>
    <p id="state">Not signed in</p>
    <p><label>Email <input id="email" type="email"></label></p>
    <p><label>Password <input id="password" type="password"></label></p>
    <p><button id="sign-in">Sign in</button></p>
    <script>
      const repository = JSON.parse(sessionStorage.getItem("repository") || "null");
      if (repository) document.getElementById("state").textContent = "Signed in as " + repository.who;
      document.getElementById("sign-in").addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        const who = document.getElementById("email").value;
        sessionStorage.setItem("repository", JSON.stringify({ who, token: Math.random().toString(36).slice(2) }));
        location.reload();
      });
    </script>
  </body>
</html>`;

test("a site that keeps its sign-in in its page's session storage is saved at the hand-back, used on one click and removed (INF-1849)", async () => {
  // One journey, the captain's approved INF-1849 plan: the session storage
  // saved as one task's browser is handed back, left as saved when that
  // browser stops after the site cleared it, granted to a second task on
  // one click, and removed while that task uses it.
  test.setTimeout(240_000);
  const { page, app } = launched;
  await stopTaskBrowsers(page);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const club = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SESSION_CLUB_PAGE);
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const origin = new URL(clubUrl).origin;
  const PASSWORD = "session-club-hunter2-battery-staple";
  /** What a saved file keeps of the club's own session storage, by key. */
  const savedSession = (): Record<string, string> =>
    Object.fromEntries(
      savedSignInFiles()[0]?.session?.find((held) => held.origin === origin)?.items ?? [],
    );
  /** Run a script in a task's hidden page on the club: nothing when none is open. */
  const onClubPage = (script: string): Promise<unknown> =>
    app.evaluate(
      async ({ webContents }, { url, script }) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => candidate.getURL().startsWith(url));
        return contents ? contents.executeJavaScript(script) : null;
      },
      { url: clubUrl, script },
    );
  /** The session storage a task's hidden page on the club holds now, by key. */
  const pageSession = async (): Promise<Record<string, string> | null> => {
    const held = await onClubPage("JSON.stringify({ ...sessionStorage })");
    return typeof held === "string" ? JSON.parse(held) : null;
  };
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("session task one");
    const second = titled("session task two");

    const a =
      await test.step("the captain signs in, and Return control's tick saves the page's session storage", async () => {
        const task = await askToSignIn(first);
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await typeOnPage(app, page, task.id, clubUrl, "email", "sam@example.com");
        await typeOnPage(app, page, task.id, clubUrl, "password", PASSWORD);
        await clickOnPage(app, page, task.id, clubUrl, "sign-in");
        await expect
          .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
          .toBe("Signed in as sam@example.com");
        const sharing = view(page, task.id).locator("[data-browser-sharing]");
        await sharing.getByRole("checkbox", { name: rememberSignInLabel(site) }).check();
        await runFromSearch(app, page, "browser.control");
        await expect
          .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        expect((await detailTitled(first))?.browser).toMatchObject({
          saved: [site],
          returned: true,
        });
        // The site keeps no cookie and no local storage: its sign-in is its page's session storage.
        expect(savedSignInFiles()).toEqual([
          expect.objectContaining({
            site,
            cookies: [],
            storage: [],
            session: [expect.objectContaining({ origin })],
          }),
        ]);
        expect(JSON.parse(savedSession().repository ?? "{}")).toMatchObject({
          who: "sam@example.com",
        });
        await shoot(view(page, task.id), "view-session-returned-after-dark.png");
        expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
        const section = await openGeneralSettings();
        await expect(section.locator(`[data-website-sign-in="${site}"]`)).toContainText(site);
        await shoot(section, "settings-session-sign-in-after-dark.png");
        await closeSettings();
        return task;
      });

    await test.step("the browser's stop leaves the saved session storage as the hand-back saved it", async () => {
      const saved = savedSession().repository;
      // The site signs its page out while the browser sits idle, before the browser stops.
      await onClubPage('sessionStorage.removeItem("repository")');
      expect(await pageSession()).toEqual({});
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(first))?.browser?.state).toBe("stopped");
      expect(savedSession().repository).toBe(saved);
    });

    const b =
      await test.step("a later task's request offers it, and one click signs its page in from session storage", async () => {
        const task = await askToSignIn(second);
        expect(
          (await savedCardOf(task.id))?.actions.map((action) => ({
            label: action.label,
            default: action.default === true,
          })),
        ).toEqual([
          { label: "Leave waiting", default: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false },
          { label: savedSignInLabel(site), default: true },
        ]);
        // Its browser started empty: nothing of the club's session storage is in it yet.
        expect(await pageSays(app, clubUrl, "state")).toBe("Not signed in");
        expect(await pageSession()).toEqual({});
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await shoot(page.locator(SHOWN_ENTRY), "card-session-sign-in-after-dark.png");
        await savedCardRegion()
          .getByRole("button", { name: savedSignInLabel(site) })
          .click();
        await expect(view(page, task.id)).toBeVisible();
        await expect
          .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        const current = (await detailTitled(second)) as TaskDetail;
        expect(current.browser).toMatchObject({ state: "open", saved: [site] });
        expect(current.events.map((event) => event.text)).toContain(
          `you let it use your saved sign-in at ${site}`,
        );
        expect(await pageSession()).toMatchObject({ repository: expect.stringContaining("sam@") });
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await shoot(view(page, task.id), "view-session-sign-in-granted-after-dark.png");
        if (evidence)
          await heroShot(app, page, {
            region: view(page, task.id),
            name: "task-browser-saved-session-storage",
          });
        expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
        return task;
      });

    await test.step("Remove in Settings clears the page's session storage, so it reloads signed out", async () => {
      const section = await openGeneralSettings();
      await section
        .locator(`[data-website-sign-in="${site}"]`)
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(section.locator(`[data-website-sign-in="${site}"]`)).toHaveCount(0);
      await closeSettings();
      expect(savedSignInFiles()).toEqual([]);
      await expect.poll(pageSession).toEqual({});
      // A reload may end the script's page before it answers.
      await onClubPage("location.reload()").catch(() => null);
      await expect
        .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
        .toBe("Not signed in");
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), b.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(second))?.browser?.state).toBe("stopped");
      expect(savedSignInFiles()).toEqual([]);
    });
  } finally {
    await closeSite(club);
  }
});

test("a saved sign-in the site turned away is marked by the crewmate, and the next request leads with Sign in myself (INF-1849)", async () => {
  // One journey, the captain's approved INF-1849 plan, piece 2: a club that
  // ends its sessions on its own schedule turns a day-old saved sign-in
  // away; the crewmate says so on its next card, and a later task's
  // request keeps the save as a second choice that says it did not work.
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

    await test.step("the captain signs in and Return control's tick saves the club's sign-in", async () => {
      const task = await askToSignIn(first);
      await showCard(page, MOCK_SAVED_CARD_TITLE);
      await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await typeOnPage(app, page, task.id, clubUrl, "email", "sam@example.com");
      await typeOnPage(app, page, task.id, clubUrl, "password", "strict-club-password");
      await clickOnPage(app, page, task.id, clubUrl, "sign-in");
      await expect
        .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      const sharing = view(page, task.id).locator("[data-browser-sharing]");
      await sharing.getByRole("checkbox", { name: rememberSignInLabel(site) }).check();
      await runFromSearch(app, page, "browser.control");
      await expect
        .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      expect(savedSignInFiles()).toEqual([expect.objectContaining({ site })]);
      expect(savedSignInFiles()[0]).not.toHaveProperty("failedAt");
      await stop(first, task.id);
    });

    const b =
      await test.step("the club ends the session, the saved sign-in leaves the page signed out, and the crewmate marks it", async () => {
        // The club's own schedule: the saved token is no longer accepted.
        sessions.clear();
        const task = await askToSignIn(second);
        expect(await buttons(MOCK_SAVED_CARD_TITLE, task.id)).toEqual([
          { label: "Leave waiting", default: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false },
          { label: savedSignInLabel(site), default: true },
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
        // The host marked the save the browser was given; its tool answer says nothing went unmarked.
        expect(current.outcome).not.toContain("marked nothing");
        expect(savedSignInFiles()).toEqual([
          expect.objectContaining({ site, failedAt: expect.any(Number) }),
        ]);
        expect(current.events.map((event) => event.text)).toContain(
          `said your saved sign-in at ${site} did not sign its page in`,
        );
        // Its browser uses the save already, so its own card offers only the captain's sign-in.
        expect(await buttons(MOCK_SAVED_FAILED_CARD_TITLE, task.id)).toEqual([
          { label: "Leave waiting", default: false },
          { label: MOCK_SAVED_ACTION, default: true },
        ]);
        return task;
      });

    await test.step("a later task's request leads with Sign in myself and keeps the save as a second choice", async () => {
      const task = await askToSignIn(third);
      expect(await buttons(MOCK_SAVED_CARD_TITLE, task.id)).toEqual([
        { label: "Leave waiting", default: false },
        { label: SAVED_SIGN_IN_FAILED_LABEL, default: false },
        { label: SIGN_IN_MYSELF_LABEL, default: true },
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
