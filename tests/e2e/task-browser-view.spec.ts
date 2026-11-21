import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { boxPlace } from "../../src/shared/cardNoteMarks";
import {
  ANNOTATE,
  type CardNote,
  MARKED_PICTURES_LINE,
  NOTE_COMMENT_LABEL,
  type NotePlace,
  PAGE_NOTE_KEY,
  PAGE_NOTE_KIND,
  PAGE_NOTE_SHOWS,
  POINTED_AT,
  pointedAtLines,
} from "../../src/shared/cardNotes";
import { CREWMATE_TAB_LABEL } from "../../src/shared/crewTranscript";
import {
  ACTIVITY_TAB_LABEL,
  browserTabLabel,
  INFO_TAB_LABEL,
  RETURN_CONTROL_LABEL,
  RETURN_CONTROL_NOTICE,
  TAKE_CONTROL_LABEL,
  TASK_BROWSER_PAGE,
} from "../../src/shared/taskBrowser";
import { customApiCaFixture } from "../helpers/customApiCaFixture";
import { scratchDir } from "../helpers/scratchDirs";
import { crewComposer, crewmateView, sentWords } from "./crewmateTab";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { type Rect, resizeWindow, within } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import { atRest, expandDock, expectRecordBody, pressRow, recordCard, taskFact } from "./rails";
import { newestPictures } from "./scenarios/pictureRetry";
import {
  MOCK_BROWSER_BUTTON,
  MOCK_BROWSER_CARD_ANSWER,
  MOCK_BROWSER_CARD_DEFAULT,
  MOCK_BROWSER_CARD_QUESTION,
  MOCK_BROWSER_CARD_REPORT,
  MOCK_BROWSER_CARD_STEPS,
  MOCK_BROWSER_CARD_TITLE,
  MOCK_BROWSER_RAISE_CARD,
  MOCK_BROWSER_RAISED_DEFAULT,
  MOCK_BROWSER_RAISED_STEP,
  MOCK_BROWSER_RAISED_TITLE,
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
  clickOnPage,
  closeSite,
  onPage,
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
import {
  focusOn,
  pressKey,
  pressWindowKey,
  runFromSearch,
  typeInto,
  untilFocused,
} from "./windowKeys";

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

    const browser = view(page, task.id);
    const foldedCrew = browser.locator("[data-browser-crew-folded]");
    const crewDock = browser.locator("[data-browser-crew]");
    const field = crewComposer(crewDock);
    const steer = "Keep the confirmation visible after sending the form.";
    await test.step("the cardless browser starts folded and the reply key sends on the Crewmate tab's lane", async () => {
      await expect(foldedCrew).toBeVisible();
      await expect(field).toHaveCount(0);
      await pressWindowKey(app, "l", ["meta", "shift"]);
      await expect(field).toBeFocused();
      await field.fill(steer);
      await pressKey(field, "Enter");
      await expect(sentWords(crewDock, "captain")).toHaveText(steer);
      await expect(browser).toHaveAttribute("data-browser-state", "watching");
      await pressWindowKey(app, "\\", ["meta"]);
      await expect(foldedCrew.locator("button")).toBeFocused();
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
      await expect(foldedCrew.locator("[data-thread-cue-said]")).toHaveText(/\S/);
      await pressWindowKey(app, "\\", ["meta"]);
      await expect(crewDock.locator("[data-crew-block=report]")).toContainText(
        MOCK_BROWSER_WATCH_REPORT_PREFIX,
      );
      await pressWindowKey(app, "\\", ["meta"]);
      await expect(foldedCrew).toBeVisible();
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

    await test.step("taking the page from the record's browser keeps the Crewmate lane and the privacy notice", async () => {
      await browser.getByRole("button", { name: TAKE_CONTROL_LABEL }).click();
      await expect(browser).toHaveAttribute("data-browser-state", "captain");
      await expect(browser.locator("[data-browser-sharing]")).toContainText(RETURN_CONTROL_NOTICE);
      await pressWindowKey(app, "l", ["meta", "shift"]);
      await expect(field).toBeFocused();
      await expect(sentWords(crewDock, "captain")).toHaveText(steer);
      await runFromSearch(app, page, "browser.page");
      await expect(browser.locator("[data-browser-page]")).toBeFocused();
      await pressWindowKey(app, "\\", ["meta"]);
      await expect(foldedCrew).toBeVisible();
      await expect(browser.locator("[data-browser-page]")).toBeFocused();
      await browser.getByRole("button", { name: RETURN_CONTROL_LABEL }).click();
      await expect(browser).not.toHaveAttribute("data-browser-state", "captain");
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

const KEYS_NOTE = "Say what happens after this";
const POINTER_NOTE = "Make this easier to see";
const PAGE_NOTE_WORDS = "Two things on the sign-up page.";

/**
 * Intent: the accepted Point at plan's running page - "marks a local page and
 * reads the crewmate's side". Promised result: the crewmate reads the page,
 * each numbered place and what is under it, with one marked picture per held
 * picture; nothing leaves before the send, and the pointer never reaches the
 * page while it marks. Data: the sign-up page this journey serves, driven by
 * the scripted crewmate, and the outline the product itself reads of it.
 * Completion signal: the provider request that carries the Pointed at lines.
 * Portable: a local page and the window's own pointer and keys. The app is
 * this file's shared one; the task, its page and its browser are this test's.
 */
test("the captain points at a task's running page by keys and by pointer, and its crewmate reads each place", async () => {
  const { page, app } = launched;
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
    const title = `${TASK_BROWSER_WATCH_MARKER}${watchedUrl} as Sam`;
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);
    await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await promptInput(page).press("Enter");
    await expect
      .poll(async () => (await detail())?.browser?.state ?? "", { timeout: 60_000 })
      .toBe("open");
    // The crewmate typed the name and waits on the page: its turn runs.
    await expect
      .poll(() => pageSays(app, watchedUrl, "name", "value").catch(() => null), {
        timeout: 30_000,
      })
      .toBe("Sam");
    const task = (await detail()) as TaskDetail;
    await expandDock(page, "now");
    await pressRow(page, task.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
    await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
    const browser = view(page, task.id);
    await expect(browser).toHaveAttribute("data-browser-state", "watching");
    await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);

    const pointAt = browser.locator("[data-browser-point-at]");
    const layer = browser.locator("[data-browser-pointing]");
    const queued = browser.locator("[data-crew-notes]");
    const pop = page.getByRole("dialog", { name: new RegExp(`^${ANNOTATE} `) });
    const comment = pop.getByRole("textbox", { name: NOTE_COMMENT_LABEL });
    const picture = { width: TASK_BROWSER_PAGE.width, height: TASK_BROWSER_PAGE.height };
    const reads = () =>
      (launched.mockProvider?.requestBodies() ?? []).filter((body) => {
        const said = providerMessages(body).findLast((message) => message.role === "user")?.text;
        return said?.includes(`${POINTED_AT}:`) && said.includes(KEYS_NOTE);
      });
    const noteOn = (place: NotePlace, said: string): CardNote => ({
      kind: PAGE_NOTE_KIND,
      key: PAGE_NOTE_KEY,
      start: 0,
      line: 1,
      excerpt: "Sign up",
      comment: said,
      place,
      page: { url: watchedUrl, title: "Sign up", under: { role: "button", name: "Send" } },
    });

    const { keyed, button } =
      await test.step("the command's key holds the picture still, the arrows step through what the page names, and Enter writes the note", async () => {
        await pressWindowKey(app, "A", ["meta", "shift"]);
        await expect(layer).toBeVisible();
        await expect(pointAt).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => layer.getAttribute("data-browser-places")).not.toBe("0");
        const still = (await canvasReading(page)).frames;
        // What the product reads of the page: the same read the held picture's outline came from.
        const outline = await page.evaluate((id) => window.infinitary.browser.places(id), task.id);
        expect(outline).toMatchObject({ ok: true, ...picture, url: watchedUrl, title: "Sign up" });
        const send = (outline.ok ? outline.places : []).find(
          (place) => place.role === "button" && place.name === "Send",
        );
        if (!send) throw new Error("the outline names no Send button");
        const button: Rect = { x: send.x, y: send.y, width: send.width, height: send.height };
        // The page changes while its picture is held.
        await onPage(
          app,
          watchedUrl,
          `document.getElementById("state").textContent = "Signing up"`,
        );
        await untilFocused(layer);
        // Forward from nothing is the first thing the page names; back from it wraps to the last.
        await page.keyboard.press("ArrowRight");
        await expect(layer).toHaveAttribute("data-browser-stepped", "heading Sign up");
        await page.keyboard.press("ArrowLeft");
        await expect(layer).toHaveAttribute("data-browser-stepped", "button Send");
        await page.keyboard.press("Enter");
        await expect(pop).toBeVisible();
        // The popover shows the picture that will go; watching, it shows the crewmate nothing new.
        await expect(pop.locator("[data-note-page-picture] [data-marked-copy]")).toBeVisible();
        await expect(pop.locator("[data-note-page-shows]")).toHaveCount(0);
        await untilFocused(comment);
        await typeInto(comment, KEYS_NOTE);
        // Held: nothing was drawn since Point at came on.
        expect((await canvasReading(page)).frames).toBe(still);
        await pressKey(comment, "Enter");
        await expect(pop).toHaveCount(0);
        // Point at ends with its note, and the live pictures resume with the page's change.
        await expect(layer).toHaveCount(0);
        await expect(queued).toHaveAttribute("data-crew-notes", "1");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(still);
        return { keyed: noteOn({ ...picture, box: button }, KEYS_NOTE), button };
      });

    const aimed =
      await test.step("with Point at on, a press on the page's button marks it and never reaches the page", async () => {
        await pointAt.click();
        await expect(layer).toBeVisible();
        await atRest(page, layer);
        const drawn = (await layer.boundingBox()) as Rect;
        const middle = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
        await page.mouse.move(
          drawn.x + (middle.x * drawn.width) / picture.width,
          drawn.y + (middle.y * drawn.height) / picture.height,
        );
        await page.mouse.down();
        await page.mouse.up();
        await expect(pop).toBeVisible();
        await untilFocused(comment);
        await typeInto(comment, POINTER_NOTE);
        await pressKey(comment, "Enter");
        await expect(queued).toHaveAttribute("data-crew-notes", "2");
        // The window's pointer lands on a whole window pixel: the press is this near its aim.
        return { middle, slack: Math.ceil(picture.width / drawn.width) + 1 };
      });

    await test.step("nothing leaves before the send; sent from the crewmate's box, the crewmate reads each place and gets each held picture", async () => {
      expect(reads()).toHaveLength(0);
      const field = crewComposer(browser.locator("[data-browser-crew]"));
      await field.fill(PAGE_NOTE_WORDS);
      await pressKey(field, "Enter");
      await expect.poll(() => reads().length, { timeout: 30_000 }).toBeGreaterThan(0);
      const request = reads()[0] ?? "";
      const served =
        providerMessages(request).findLast((message) => message.role === "user")?.text ?? "";
      expect(served).toContain(PAGE_NOTE_WORDS);
      // The mark made by keys is the outline's own box for the button.
      const [heading, byKeys] = pointedAtLines([keyed]);
      expect(served).toContain(`${heading}\n${byKeys}`);
      expect(served).toContain(MARKED_PICTURES_LINE);
      // The mark made by the pointer is a spot on the same button, second in the order queued.
      const near: string[] = [];
      for (let dx = -aimed.slack; dx <= aimed.slack; dx++)
        for (let dy = -aimed.slack; dy <= aimed.slack; dy++) {
          const at = { x: aimed.middle.x + dx, y: aimed.middle.y + dy };
          const spot = noteOn(boxPlace(picture, at, at), POINTER_NOTE);
          expect(within(spot.place?.box as Rect, button)).toEqual([]);
          near.push(pointedAtLines([keyed, spot])[2] ?? "");
        }
      expect(near.filter((line) => served.includes(line))).toHaveLength(1);
      // Two held pictures, one for each time Point at held the page: the page changed between.
      expect(newestPictures(request)).toHaveLength(2);
      await expect(queued).toHaveAttribute("data-crew-notes", "0");
      // The page never got the press on its button: it says nothing was sent.
      expect(await pageSays(app, watchedUrl, "out")).toBe("");
    });

    await test.step("on a browser the captain holds, a press with Point at on marks the page's button and never presses it, and the note says its picture shows the page to the crewmate", async () => {
      ready = true;
      await expect(browser).toHaveAttribute("data-browser-state", "nobody", { timeout: 60_000 });
      // The crewmate pressed Send as its turn ended. From here the page counts each press on that button.
      await onPage(
        app,
        watchedUrl,
        `(() => {
          const out = document.getElementById("out");
          let presses = 0;
          out.textContent = "0";
          document.getElementById("send").addEventListener("click", () => {
            presses += 1;
            out.textContent = String(presses);
          });
        })()`,
      );
      await browser.getByRole("button", { name: TAKE_CONTROL_LABEL }).click();
      await expect(browser).toHaveAttribute("data-browser-state", "captain");
      await pointAt.click();
      await expect(layer).toBeVisible();
      await atRest(page, layer);
      const drawn = (await layer.boundingBox()) as Rect;
      // The press that marked the button while watching, now that the captain's presses reach the page.
      await page.mouse.move(
        drawn.x + (aimed.middle.x * drawn.width) / picture.width,
        drawn.y + (aimed.middle.y * drawn.height) / picture.height,
      );
      await page.mouse.down();
      await page.mouse.up();
      await expect(pop.locator("[data-note-page-shows]")).toHaveText(PAGE_NOTE_SHOWS);
      // The press marked the held picture: the page's button was not pressed.
      expect(await pageSays(app, watchedUrl, "out")).toBe("0");
      // Put away unwritten, the note is not kept and nothing was sent for it; Point at ends with it.
      await untilFocused(comment);
      await pressKey(comment, "Escape");
      await expect(pop).toHaveCount(0);
      await expect(layer).toHaveCount(0);
      await expect(queued).toHaveAttribute("data-crew-notes", "0");
      // With Point at off, the captain's press on the same button is the first the page counts.
      // The page takes presses in the order they were made, so the one that made the mark never reached it.
      await clickOnPage(app, page, task.id, watchedUrl, "send");
      await expect.poll(() => pageSays(app, watchedUrl, "out")).toBe("1");
      await browser.getByRole("button", { name: RETURN_CONTROL_LABEL }).click();
      await expect(browser).not.toHaveAttribute("data-browser-state", "captain");
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

    // INF-4578's direction A, piece 3: the card whose own button opened the
    // page docks beside it, its checklist readable, its choices behind Back
    // to the card.
    const column = view(page, task.id).locator("[data-browser-request]");
    await test.step("the card docks beside the page with its checklist, its choices left on the card", async () => {
      const opened = await savedCard();
      await expect(column).toHaveAttribute("data-browser-request", opened?.id ?? "");
      const steps = cardBody(column, MOCK_BROWSER_CARD_TITLE).locator("body");
      for (const step of MOCK_BROWSER_CARD_STEPS) await expect(steps).toContainText(step);
      await expect(column.getByRole("button", { name: MOCK_BROWSER_CARD_DEFAULT })).toHaveCount(0);
      await expect(column.locator("[data-browser-card-back]")).toBeVisible();
      await shoot(view(page, task.id), "view-card-docked-dark.png");
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-card-docked-light.png");
        await setThemeViaSettings(page, "dark");
        await heroShot(app, page, {
          region: view(page, task.id),
          name: "browser-card-beside-page",
          // The pointer rests where the last click left it; after the resize it
          // would light the card's resize edge in the picture.
          ready: () => page.mouse.move(1, 1),
        });
      }
      // Back to the card shows the card itself, its buttons as they were.
      await column.locator("[data-browser-card-back]").click();
      await expect(cardRegion).toBeVisible();
      await expect(
        cardRegion.getByRole("button", { name: MOCK_BROWSER_CARD_DEFAULT }),
      ).toBeEnabled();
      await strip.getByRole("button", { name: MOCK_BROWSER_BUTTON }).click();
      await expect(column).toHaveAttribute("data-browser-request", opened?.id ?? "");
    });

    const opened = await savedCard();
    expect(opened).toBeDefined();
    const original = view(page, task.id).locator(`[data-browser-request="${opened?.id}"]`);
    const field = original.locator("[data-card-reply] textarea");
    await test.step("the answer appears in the original card's thread beside the page", async () => {
      await focusOn(view(page, task.id).getByRole("button", { name: "Hide" }));
      await pressWindowKey(app, "l", ["meta", "shift"]);
      await expect(field).toBeFocused();
      await field.fill(MOCK_BROWSER_CARD_QUESTION);
      await field.press("Enter");
      const thread = original.locator("[data-card-thread]");
      await expect(thread).toContainText(MOCK_BROWSER_CARD_QUESTION);
      await expect(thread).toContainText(MOCK_BROWSER_CARD_ANSWER, { timeout: 30_000 });
      await expect
        .poll(async () =>
          (
            await page.evaluate((id) => window.infinitary.cards.thread(id), opened?.id ?? "")
          ).messages.map((message) => message.text),
        )
        .toContain(MOCK_BROWSER_CARD_QUESTION);
    });

    await test.step("a follow-up asks for a new card, which docks beside the same page", async () => {
      // Send this only after reading the original card's answer: the new
      // card displaces that thread, so an assertion cannot follow it there.
      await field.fill(MOCK_BROWSER_RAISE_CARD);
      await field.press("Enter");
      const raised = async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).find(
          (card) => card.title === MOCK_BROWSER_RAISED_TITLE,
        );
      await expect.poll(async () => (await raised())?.id ?? "", { timeout: 30_000 }).not.toBe("");
      await expect(column).toHaveAttribute("data-browser-request", (await raised())?.id ?? "");
      // The follow-up is answered too, so Hide does not put the opener aside.
      await expect.poll(async () => (await savedCard())?.awaiting ?? null).toBeNull();
      await expect(
        view(page, task.id).locator("[data-browser-crew], [data-browser-crew-folded]"),
      ).toHaveCount(0);
      await expect(cardBody(column, MOCK_BROWSER_RAISED_TITLE).locator("body")).toContainText(
        MOCK_BROWSER_RAISED_STEP,
      );
      await expect(view(page, task.id)).toBeVisible();
      await shoot(view(page, task.id), "view-card-arrived-dark.png");
      // Back to the card, chosen from command search, shows the raised card
      // with its own choices.
      await runFromSearch(app, page, "browser.card");
      const raisedRegion = shownCard(page, MOCK_BROWSER_RAISED_TITLE);
      await expect(raisedRegion).toBeVisible();
      await expect(
        raisedRegion.getByRole("button", { name: MOCK_BROWSER_RAISED_DEFAULT }),
      ).toBeEnabled();
      await showCard(page, MOCK_BROWSER_CARD_TITLE);
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
      await expect(view(page, task.id)).toHaveCount(0);
      await expect(cardRegion).toBeVisible();
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
