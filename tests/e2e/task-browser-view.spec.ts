import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { CREWMATE_TAB_LABEL } from "../../src/shared/crewTranscript";
import {
  ACTIVITY_TAB_LABEL,
  browserTabLabel,
  INFO_TAB_LABEL,
  TASK_BROWSER_PAGE,
} from "../../src/shared/taskBrowser";
import { customApiCaFixture } from "../helpers/customApiCaFixture";
import { scratchDir } from "../helpers/scratchDirs";
import { crewmateView } from "./crewmateTab";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, pressRow, recordCard, taskFact } from "./rails";
import {
  MOCK_BROWSER_BUTTON,
  MOCK_BROWSER_CARD_DEFAULT,
  MOCK_BROWSER_CARD_REPORT,
  MOCK_BROWSER_CARD_TITLE,
  MOCK_BROWSER_WATCH_REPORT_PREFIX,
  MOCK_PAGES_REPORT_PREFIX,
  MOCK_PAGES_SAID,
  TASK_BROWSER_APPROVE_WORDS,
  TASK_BROWSER_CARD_MARKER,
  TASK_BROWSER_PAGES_MARKER,
  TASK_BROWSER_READY_WORDS,
  TASK_BROWSER_WATCH_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { SHOWN_ENTRY, showCard, shownCard } from "./stack";
import {
  canvasReading,
  closeSite,
  pageFillsView,
  pageLaidOutAt,
  pageSays,
  SIZE,
  stopTaskBrowsers,
  taskTabs,
  browserView as view,
  windowCount,
} from "./taskBrowser";
import { setThemeViaSettings } from "./theme";
import { pressKey, runFromSearch, untilFocused } from "./windowKeys";

/**
 * A task's own browser as the captain sees it (docs/task-browser.md, "The
 * view", "From a card" and "A second page"). The captain opens a task's
 * browser from its record and watches the crewmate drive it, a crewmate's
 * card opens its task's browser and answers nothing, and a page's second
 * page opens inside the task's browser, named by its own site. Each journey
 * serves its own pages on this Mac.
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

/**
 * The page the captain watches: green, so its own pixels can be told from
 * the app's in the view; it keeps a name in its site data, and it says
 * "Ready to send" only once the spec tells its server so, which is what
 * keeps the crewmate's turn - its driving - running until then.
 */
const WATCHED_PAGE = `<!doctype html>
<html>
  <head><title>Sign up</title><style>body { background: rgb(43, 138, 62); color: white; }</style></head>
  <body>
    <h1>Sign up</h1>
    <p id="state"></p>
    <label>Name <input id="name"></label>
    <button id="send">Send</button>
    <p id="ready"></p>
    <p id="out"></p>
    <script>
      const saved = localStorage.getItem("name");
      document.getElementById("state").textContent = saved ? "Signed up as " + saved : "Not signed up yet";
      setInterval(async () => {
        const ready = await (await fetch("/ready")).text();
        if (ready === "yes") document.getElementById("ready").textContent = "${TASK_BROWSER_READY_WORDS}";
      }, 200);
      document.getElementById("send").addEventListener("click", () => {
        const name = document.getElementById("name").value;
        localStorage.setItem("name", name);
        document.getElementById("out").textContent = "Thanks, " + name;
      });
    </script>
  </body>
</html>`;

test("the captain opens a task's browser from its record and watches the crewmate drive it", async () => {
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let ready = false;
  const watched = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(ready ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(WATCHED_PAGE);
  });
  await new Promise<void>((resolve) => watched.listen(0, "127.0.0.1", resolve));
  const watchedUrl = `http://127.0.0.1:${(watched.address() as AddressInfo).port}/`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const before = await windowCount(launched.app);
    const title = `${TASK_BROWSER_WATCH_MARKER}${watchedUrl} as Sam`;
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);

    const task =
      await test.step("the crewmate opens its browser and keeps driving it", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.browser?.state ?? "", { timeout: 60_000 })
          .toBe("open");
        // The name is typed and the crewmate waits on the page: its turn runs.
        await expect
          .poll(() => pageSays(launched.app, watchedUrl, "name").catch(() => null))
          .not.toBeNull();
        await expect
          .poll(async () => (await detail())?.browser, { timeout: 30_000 })
          .toMatchObject({ state: "open", site: new URL(watchedUrl).host });
        return (await detail()) as TaskDetail;
      });

    await test.step("its record's Browser line names the site and who drives, and Open shows the view", async () => {
      await expandDock(page, "now");
      await pressRow(page, task.key);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      const line = taskFact(recordCard(page), "browser");
      await expect(line).toHaveAttribute("data-browser-driver", "crewmate");
      await expect(line).toContainText(new URL(watchedUrl).host);
      await shoot(recordCard(page), "record-after-dark.png");
      await line.locator("[data-browser-open]").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
    });

    await test.step("the card's tabs read Info, Activity, Crewmate and Browser with the page's title, and the keys and command search move between them", async () => {
      const { tabs, selected } = taskTabs(page);
      // INF-2261: Activity is its own tab between Info and Crewmate.
      await expect(tabs).toHaveText([
        INFO_TAB_LABEL,
        ACTIVITY_TAB_LABEL,
        CREWMATE_TAB_LABEL,
        browserTabLabel("Sign up"),
      ]);
      await shoot(view(page, task.id), "tabs-browser-dark.png");
      // Home to Info, Enter shows it in the card's place: one entry per task.
      await pressKey(selected, "Home");
      await pressKey(tabs.first(), "Enter");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toHaveCount(0);
      await expect(selected).toHaveText(INFO_TAB_LABEL);
      // The strip the swap drew holds focus on the shown tab.
      await untilFocused(selected);
      await shoot(recordCard(page), "tabs-info-dark.png");
      if (evidence) await heroShot(app, page, { region: recordCard(page), name: "task-card-tabs" });
      await runFromSearch(app, page, "cards.show-browser");
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
      await expect(selected).toHaveText(browserTabLabel("Sign up"));
      // The tab before Browser is the crewmate's session.
      await runFromSearch(app, page, "cards.previous-tab");
      await expect(crewmateView(page, task.id)).toBeVisible();
      await runFromSearch(app, page, "cards.next-tab");
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
    });

    await test.step("the view draws the task's own page, live, at the check's size", async () => {
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      const reading = await canvasReading(page);
      expect(reading.size).toBe(`${TASK_BROWSER_PAGE.width}x${TASK_BROWSER_PAGE.height}`);
      // The page's own green, not the app's surface: the pixels are the page's.
      const [red = 0, green = 0, blue = 0] = reading.centre;
      expect(green).toBeGreaterThan(110);
      expect(red).toBeLessThan(80);
      expect(blue).toBeLessThan(100);
      // Watching sends nothing: Back, Forward and Reload are the controller's,
      // marked off and still reachable, their labels saying who drives.
      await expect(
        view(page, task.id).locator('[data-browser-chrome] button[aria-disabled="true"]'),
      ).toHaveCount(3);
      await shoot(view(page, task.id), "view-watching-dark.png");
    });

    await test.step("maximized, the page lays out in the view's room and follows the window; restored, it is the check's size again", async () => {
      const checkSize = `${TASK_BROWSER_PAGE.width}x${TASK_BROWSER_PAGE.height}`;
      await resizeWindow(app, page, { width: 1600, height: 1000 });
      await view(page, task.id).getByRole("button", { name: MAXIMIZE_LABEL, exact: true }).click();
      await expect.poll(() => pageFillsView(page, app, task.id, watchedUrl)).toMatch(SIZE);
      const wide = await pageFillsView(page, app, task.id, watchedUrl);
      // The room is the page's own layout, not a stretched picture of the check's size.
      expect(wide).not.toBe(checkSize);
      await shoot(view(page, task.id), "view-maximized-dark.png");
      await resizeWindow(app, page, { width: 1440, height: 900 });
      await expect.poll(() => pageFillsView(page, app, task.id, watchedUrl)).not.toBe(wide);
      await expect.poll(() => pageFillsView(page, app, task.id, watchedUrl)).toMatch(SIZE);
      await view(page, task.id).getByRole("button", { name: RESTORE_LABEL, exact: true }).click();
      await expect.poll(() => pageLaidOutAt(app, watchedUrl)).toBe(checkSize);
      await expect.poll(async () => (await canvasReading(page)).size).toBe(checkSize);
      await resizeWindow(app, page, { width: 1280, height: 900 });
    });

    await test.step("the Firstmate input under the view carries the task", async () => {
      await promptInput(page).fill("how is the check going?");
      await promptInput(page).press("Enter");
      await expect
        .poll(async () => (await detail())?.asks.map((ask) => ask.text) ?? [], { timeout: 20_000 })
        .toContain("how is the check going?");
      await expect(view(page, task.id)).toBeVisible();
    });

    await test.step("once the crewmate's turn ends, nobody drives and its browser stays", async () => {
      ready = true;
      await expect
        .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_BROWSER_WATCH_REPORT_PREFIX} "Thanks, Sam"`);
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody", {
        timeout: 30_000,
      });
      expect((await detail())?.browser?.state).toBe("open");
      expect(await windowCount(launched.app)).toBe(before + 1);
      await shoot(view(page, task.id), "view-nobody-dark.png");
    });

    await test.step("More holds Fit; Stop browser stops it, and the view says so", async () => {
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      const menu = page.locator('[role="menu"]');
      if (evidence) {
        await expect(menu).toHaveCSS("opacity", "1");
        await shoot(page.locator(SHOWN_ENTRY), "view-more-dark.png");
      }
      await menu.locator('[data-menu-item="fit"]').click();
      await expect(view(page, task.id).locator("[data-browser-canvas]")).toHaveAttribute(
        "data-browser-fit",
        "actual",
      );
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await menu.locator('[data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      await expect(view(page, task.id).locator("[data-browser-stopped]")).toHaveAttribute(
        "data-browser-stopped",
        "captain",
      );
      await expect.poll(() => windowCount(launched.app)).toBe(before);
      await shoot(view(page, task.id), "view-stopped-dark.png");
    });

    await test.step("Open again starts a fresh browser at the same page, with nothing it kept", async () => {
      await view(page, task.id).locator("[data-browser-open-again] button").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody");
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      // The first browser saved the name; the fresh one has none of it.
      await expect
        .poll(() => pageSays(launched.app, watchedUrl, "state").catch(() => null))
        .toBe("Not signed up yet");
      expect(await windowCount(launched.app)).toBe(before + 1);
    });

    await test.step("Hide puts the view away and the browser keeps running", async () => {
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-nobody-light.png");
        await setThemeViaSettings(page, "dark");
      }
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toHaveCount(0);
      expect((await detail())?.browser?.state).toBe("open");
      expect(await windowCount(launched.app)).toBe(before + 1);
    });
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(watched);
  }
});

test("a crewmate's card opens its task's browser and answers nothing", async () => {
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const watched = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("yes");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(WATCHED_PAGE);
  });
  await new Promise<void>((resolve) => watched.listen(0, "127.0.0.1", resolve));
  const watchedUrl = `http://127.0.0.1:${(watched.address() as AddressInfo).port}/`;
  const site = new URL(watchedUrl).host;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const title = `${TASK_BROWSER_CARD_MARKER}${watchedUrl} as Sam`;
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);
    const savedCard = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.title === MOCK_BROWSER_CARD_TITLE,
      );
    const strip = page.locator(`${SHOWN_ENTRY} [data-card-attachment="browser"]`);
    const cardRegion = shownCard(page, MOCK_BROWSER_CARD_TITLE);

    const task =
      await test.step("the crewmate leaves its browser open and a card whose button reads Try it", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
          .toContain(MOCK_BROWSER_CARD_REPORT);
        const current = (await detail()) as TaskDetail;
        // The host named the browser the task holds, and the crewmate only the label.
        expect(await savedCard()).toMatchObject({
          taskId: current.id,
          attachment: {
            kind: "browser",
            label: MOCK_BROWSER_BUTTON,
            taskId: current.id,
            session: current.browser?.session,
            generation: current.browser?.generation,
          },
        });
        await showCard(page, MOCK_BROWSER_CARD_TITLE);
        await expect(strip).toHaveAttribute("data-attachment-standing", "same");
        // The site and who drives it, as the record reads them: the turn has ended.
        await expect(strip.locator("[data-attachment-line]")).toHaveAttribute(
          "data-browser-driver",
          "nobody",
        );
        await expect(strip.locator("[data-attachment-line]")).toContainText(site);
        await shoot(page.locator(SHOWN_ENTRY), "card-after-dark.png");
        return current;
      });

    await test.step("Try it opens the task's browser view, and the card stays unanswered behind it", async () => {
      const before = await savedCard();
      await strip.getByRole("button", { name: MOCK_BROWSER_BUTTON }).click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody");
      await expect(view(page, task.id).locator("[data-browser-notice]")).toHaveCount(0);
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, task.id), "view-from-card-dark.png");
      // The same card, the same offer, nothing said under it, and the task where it was.
      const after = await savedCard();
      expect(after).toMatchObject({
        id: before?.id,
        offerId: before?.offerId,
        lifecycleId: before?.lifecycleId,
        status: "ready",
      });
      expect(after?.awaiting).toBeUndefined();
      const thread = await page.evaluate(
        (id) => window.infinitary.cards.thread(id),
        after?.id ?? "",
      );
      expect(thread.messages).toEqual([]);
      expect((await detail())?.status).toBe(task.status);
    });

    await test.step("Hide returns to the card, its buttons as they were", async () => {
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toHaveCount(0);
      await expect(cardRegion).toBeVisible();
      await expect(
        cardRegion.getByRole("button", { name: MOCK_BROWSER_CARD_DEFAULT }),
      ).toBeEnabled();
    });

    await test.step("once its browser is replaced, the card says so, and so does the view it opens", async () => {
      await strip.getByRole("button", { name: MOCK_BROWSER_BUTTON }).click();
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await page.locator('[role="menu"] [data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      // Still the card's browser, stopped: no line.
      await expect(view(page, task.id).locator("[data-browser-notice]")).toHaveCount(0);
      await view(page, task.id).locator("[data-browser-open-again] button").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody");
      await expect(view(page, task.id).locator("[data-browser-notice]")).toHaveAttribute(
        "data-browser-notice",
        "replaced",
      );
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, task.id), "view-replaced-dark.png");
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(strip).toHaveAttribute("data-attachment-standing", "replaced");
      await shoot(page.locator(SHOWN_ENTRY), "card-replaced-dark.png");
      expect(await savedCard()).toMatchObject({ status: "ready" });
    });
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(watched);
  }
});

/**
 * A shop and its bank, on two servers this Mac serves under two names, so
 * each page has a site of its own. The shop's Pay opens the bank's check as
 * a second page and says it was paid once the bank answers it. The check is
 * green, so its pixels show in the view; it says "Ready to approve" only
 * once the spec tells its server so, which keeps the crewmate's turn - and
 * both pages - up until then, and closes itself a moment after Approve.
 */
const shopPage = (bank: string): string => `<!doctype html>
<html>
  <head><title>Payment</title></head>
  <body>
    <h1>Payment</h1>
    <p id="state">Waiting for payment</p>
    <button id="pay">Pay</button>
    <script>
      document.getElementById("pay").addEventListener("click", () => {
        window.open(${JSON.stringify(`${bank}check`)}, "bank-check");
      });
      window.addEventListener("message", (event) => {
        if (event.data === "approved") {
          document.getElementById("state").textContent = "Paid with the bank's approval";
        }
      });
    </script>
  </body>
</html>`;

const BANK_HOME = `<!doctype html><html><head><title>Bank</title></head><body><h1>Bank</h1><p>Bank ready</p></body></html>`;

const BANK_CHECK = `<!doctype html>
<html>
  <head><title>Verify payment</title><style>body { background: rgb(43, 138, 62); color: white; font: 18px sans-serif; }</style></head>
  <body>
    <h1>Verify this payment</h1>
    <p>Payment of 312.00</p>
    <p id="ready"></p>
    <button id="approve">Approve</button>
    <script>
      setInterval(async () => {
        const ready = await (await fetch("/ready")).text();
        if (ready === "yes" && !document.body.dataset.approved) {
          document.getElementById("ready").textContent = "${TASK_BROWSER_APPROVE_WORDS}";
        }
      }, 200);
      document.getElementById("approve").addEventListener("click", () => {
        document.body.dataset.approved = "yes";
        document.getElementById("ready").textContent = "Approved";
        window.opener?.postMessage("approved", "*");
        setTimeout(() => window.close(), 1000);
      });
    </script>
  </body>
</html>`;

test("a page's second page opens inside the task's browser, named by its own site", async () => {
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let ready = false;
  const bank = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(ready ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/check" ? BANK_CHECK : BANK_HOME);
  });
  await new Promise<void>((resolve) => bank.listen(0, "127.0.0.1", resolve));
  const bankUrl = `http://localhost:${(bank.address() as AddressInfo).port}/`;
  const shop = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(shopPage(bankUrl));
  });
  await new Promise<void>((resolve) => shop.listen(0, "127.0.0.1", resolve));
  const shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}/`;
  // A site whose certificate no authority this Mac trusts signed.
  const certificates = customApiCaFixture(scratchDir("task-browser-ca-"));
  const untrusted = createSecureServer(
    { key: certificates.leafKey, cert: certificates.leaf },
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Untrusted</title><p>This page should not open</p>");
    },
  );
  await new Promise<void>((resolve) => untrusted.listen(0, "127.0.0.1", resolve));
  const untrustedUrl = `https://localhost:${(untrusted.address() as AddressInfo).port}/`;
  const shopSite = new URL(shopUrl).host;
  const bankSite = new URL(bankUrl).host;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const before = await windowCount(launched.app);
    const title = `${TASK_BROWSER_PAGES_MARKER}${shopUrl} with the bank at ${bankUrl} after ${untrustedUrl}`;
    // The board shortens a long title; its start names this task alone.
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (start) => {
        const row = (await window.infinitary.tasks.board()).tasks.find((task) =>
          task.title.startsWith(start),
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, `${TASK_BROWSER_PAGES_MARKER}${shopUrl}`);

    const task =
      await test.step("the shop's Pay opens the bank's check as the browser's second page", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.browser, { timeout: 60_000 })
          .toMatchObject({
            state: "open",
            site: bankSite,
            page: 2,
            pages: [
              { site: shopSite, title: "Payment" },
              { site: bankSite, title: "Verify payment" },
            ],
          });
        // Two hidden pages of one browser, never a window of the app's.
        expect(await windowCount(launched.app)).toBe(before + 2);
        return (await detail()) as TaskDetail;
      });

    await test.step("the view names each page by its title, and picking one is the controller's", async () => {
      await expandDock(page, "now");
      await pressRow(page, task.key);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
      const shown = view(page, task.id);
      await expect(shown).toHaveAttribute("data-browser-state", "watching");
      const tabs = shown.locator("[data-browser-page-tab]");
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(0)).toHaveText(browserTabLabel("Payment"));
      await expect(tabs.nth(1)).toHaveText(browserTabLabel("Verify payment"));
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      // Watching is not control: the crewmate's page stays its own.
      await expect(tabs.nth(0)).toBeDisabled();
      await expect(shown.locator("[data-browser-site]")).toHaveText(bankSite);
      // The view draws the bank's own page: its green.
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await expect
        .poll(async () => (await canvasReading(page)).centre[1] ?? 0)
        .toBeGreaterThan(110);
      await shoot(shown, "view-two-pages-dark.png");
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-two-pages-light.png");
        await setThemeViaSettings(page, "dark");
      }
    });

    await test.step("once approved, the check closes itself and the crewmate is back on the shop", async () => {
      ready = true;
      await expect
        .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_PAGES_REPORT_PREFIX);
      const outcome = (await detail())?.outcome ?? "";
      if (evidence) writeFileSync(join(evidence, "task-browser-pages-report.txt"), `${outcome}\n`);
      // A certificate no one trusts is refused in words, never gone past.
      expect(outcome).toMatch(
        /"localhost:\d+'s certificate did not verify \(ERR_CERT_[A-Z_]+\), so the browser did not open it\."/,
      );
      expect(outcome).toContain(
        `The page opened a second page at ${bankSite}, page 2, and your commands act on it now.`,
      );
      expect(outcome).toContain(`${MOCK_PAGES_SAID.check} "page 2 of 2"`);
      expect(outcome).toContain(
        `Page 2 (${bankSite}) closed itself; your commands act on page 1 again.`,
      );
      expect(outcome).toContain(`${MOCK_PAGES_SAID.shop} "Paid with the bank's approval"`);
      // The second page's tab goes with it; the view is on the shop.
      await expect(view(page, task.id).locator("[data-browser-page-tab]")).toHaveCount(1);
      await expect(view(page, task.id).locator("[data-browser-site]")).toHaveText(shopSite);
      await expect.poll(() => windowCount(launched.app)).toBe(before + 1);
      await shoot(view(page, task.id), "view-one-page-after-dark.png");
    });

    await test.step("Stop browser closes it, its last page and all", async () => {
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await page.locator('[role="menu"] [data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      await expect.poll(() => windowCount(launched.app)).toBe(before);
    });
  } finally {
    await Promise.all([bank, shop, untrusted].map(closeSite));
  }
});
