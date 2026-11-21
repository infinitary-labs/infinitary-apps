import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { PAGE_UNANSWERED_OPENING } from "../../src/core/prompts/pageUnanswered";
import { unansweredWords } from "../../src/shared/taskBrowser";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { isTaskRequest, providerMessages } from "./providerRequest";
import {
  BUILD_PAGE_GATES,
  BUILD_PAGE_TITLE,
  MOCK_BROWSER_BUTTON,
  MOCK_START_CARD_REPORT,
  MOCK_START_CARD_TITLE,
  MOCK_START_WOKEN_REPORT,
  TASK_BROWSER_START_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { SHOWN_ENTRY, showCard, shownCard } from "./stack";
import { stopTaskBrowsers, browserView as view } from "./taskBrowser";
import { focusOn, pressKey } from "./windowKeys";

/**
 * A page's saved start (docs/task-browser.md, "Starting a page again";
 * INF-5474's plan, piece 2, the captain's pick that Infinitary starts the
 * build). The crewmate opens its build's page with `--start` while nothing
 * answers there, so Infinitary starts it and opens the page; the captain's
 * Stop browser stops that build with it; and the captain's Try it press
 * starts it again and shows the page, with no turn of the crewmate's.
 *
 * The build is a real program on this computer (`buildPageCommand`): a
 * server that listens on its port only once the journey opens its gate,
 * so the view's line while it starts is read before it can answer.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [taskBrowserJourneys] });
});

test.afterAll(async () => {
  await launched.close();
});

/** A loopback port nothing listens on now. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Whether anything answers at the build's page now. */
async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

test("a saved start brings a card's build back on Try it, with no turn of its crewmate's", async () => {
  test.setTimeout(180_000);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const { app, page } = launched;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const title = `${TASK_BROWSER_START_MARKER}${url} then`;
  // The build answers only while its gate is open: each step opens or shuts it.
  const gate = join(scratchDir("infinitary-build-gate-"), "open");
  BUILD_PAGE_GATES.set(port, gate);
  writeFileSync(gate, "");
  const detail = async (): Promise<TaskDetail | null> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find(
        (task) => task.title === wanted,
      );
      return row ? window.infinitary.tasks.detail(row.id) : null;
    }, title);
  const wakes = () =>
    (launched.mockProvider?.requestBodies() ?? [])
      .filter((body) => isTaskRequest(body, title))
      .flatMap((body) => providerMessages(body))
      .filter(
        (message) => message.role === "user" && message.text.includes(PAGE_UNANSWERED_OPENING),
      ).length;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const task =
      await test.step("the crewmate opens its page with --start while nothing answers, and Infinitary starts it", async () => {
        expect(await answers(url)).toBe(false);
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
          .toContain(MOCK_START_CARD_REPORT);
        // The open's answer, which the report carries, says Infinitary ran the command.
        expect((await detail())?.outcome).toContain("Infinitary ran your --start command");
        expect((await detail())?.browser).toMatchObject({ state: "open", url });
        expect(await answers(url)).toBe(true);
        return (await detail()) as TaskDetail;
      });

    const strip = page.locator(`${SHOWN_ENTRY} [data-card-attachment="browser"]`);
    await test.step("the captain's Stop browser stops the build Infinitary started with it", async () => {
      await showCard(page, MOCK_START_CARD_TITLE);
      await strip.getByRole("button", { name: MOCK_BROWSER_BUTTON }).click();
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await page.locator('[role="menu"] [data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      await expect.poll(() => answers(url), { timeout: 10_000 }).toBe(false);
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(shownCard(page, MOCK_START_CARD_TITLE)).toBeVisible();
      // The build will not answer until the view has been read while it starts.
      rmSync(gate);
    });

    await test.step("Try it starts the saved build again and shows its page, waking nobody", async () => {
      const tryIt = strip.getByRole("button", { name: MOCK_BROWSER_BUTTON });
      await focusOn(tryIt);
      await pressKey(tryIt, "Enter");
      await expect(view(page, task.id)).not.toHaveAttribute("data-browser-state", "stopped");
      // While the build starts, the view says Infinitary is starting it.
      const notice = view(page, task.id).locator("[data-browser-notice]");
      await expect(notice).toHaveText(unansweredWords(`127.0.0.1:${port}`, "nobody", true));
      expect((await detail())?.browser).toMatchObject({
        state: "open",
        unanswered: true,
        starting: true,
      });
      if (evidence) {
        await view(page, task.id).screenshot({ path: join(evidence, "view-starting-dark.png") });
        await heroShot(app, page, {
          region: view(page, task.id),
          name: "try-it-starts-build",
          ready: () => page.mouse.move(1, 1),
        });
      }
      // The build may answer now: the page loads.
      writeFileSync(gate, "");
      await expect
        .poll(async () => (await detail())?.browser, { timeout: 30_000 })
        .toMatchObject({ state: "open", url, title: BUILD_PAGE_TITLE });
      expect((await detail())?.browser).not.toHaveProperty("unanswered");
      // The starting line goes; the line that the card's own browser was replaced stays (piece 1).
      await expect(notice).not.toHaveAttribute("data-browser-notice", "unanswered");
      expect(await answers(url)).toBe(true);
      if (evidence) {
        await view(page, task.id).screenshot({ path: join(evidence, "view-started-dark.png") });
      }
      // No model was asked: the crewmate was never woken for this outage.
      expect(wakes()).toBe(0);
      expect((await detail())?.outcome).not.toContain(MOCK_START_WOKEN_REPORT);
    });
  } finally {
    // Stopping its browser stops the build Infinitary started.
    await stopTaskBrowsers(page);
    await expect.poll(() => answers(url), { timeout: 10_000 }).toBe(false);
    BUILD_PAGE_GATES.delete(port);
  }
});
