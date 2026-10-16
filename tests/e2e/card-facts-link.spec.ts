import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type Card, SETTLE_FACTS_OPEN } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { atRest, pressPointer } from "./layout";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockProvider";
import { promptInput } from "./prompt";
import { FACTS_FRAME_SELECTOR, factsStrip, showCard } from "./stack";
import { focusOn } from "./windowKeys";

/**
 * A merge card's fact strip refreshes while it is up (FI3-1093): the host
 * rewrites its facts whenever the task's record changes - the checks
 * reading's age, a new reading - and the stage hands the strip the new
 * facts. A press the captain has started on the strip's pull request link
 * when that happens still opens the pull request when he lets go.
 *
 * The host's refresh is the card list it pushes, with the strip's checks
 * reading a minute older; the press is Chromium's own pointer, held as a
 * person holds a click (`pressPointer`).
 */

const PR = "https://github.com/octo/meterlab/pull/58";
const TITLE = "The meter fix is ready to merge";
const TASK = "task-meter-fix";
/** How long the press holds the button, and when within it the strip refreshes. */
const HOLD_MS = 900;
const REFRESH_AFTER_MS = 300;

function mergeCard(): Card {
  return {
    id: "card-meter-fix",
    taskId: TASK,
    author: "crewmate",
    meta: "crewmate",
    priority: 30,
    title: TITLE,
    // The host writes its fact strip where its marker stands.
    body: `<h2>Why</h2><p>The meter read the wrong unit.</p>${SETTLE_FACTS_OPEN}</div>`,
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "merge",
        label: "Merge the pull request",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
      { id: "discard", label: "Discard", effect: { kind: "settle", mode: "discard" } },
    ],
  };
}

test("a press on the fact strip's pull request link opens it though the strip refreshes under it", async () => {
  const userDataDir = scratchDir("infinitary-card-facts-link-");
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db });
    // The crewmate's model is on the record from the start, so the strip
    // has every cell before the first press.
    seedTask(tasks, {
      id: TASK,
      title: "Fix the meter",
      status: "completed",
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
    });
    // Read 93 s ago: the strip says "read 2 min ago" for the next minute, so
    // the host's own refreshes leave it as it is while the test runs.
    tasks.recordDelivery(TASK, {
      mode: "direct-pr",
      prNumber: 58,
      prUrl: PR,
      ci: "green",
      ciAt: Date.now() - 93_000,
    });
    new CardStore(db).upsert(mergeCard());
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    // The system browser, replaced by a recorder: nothing here opens a page.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const opened = () =>
      app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);

    await showCard(page, TITLE);
    const facts = factsStrip(cardBody(page, TITLE));
    const link = facts.change.locator(`a[href="${PR}"]`);
    await expect(link).toBeVisible();
    await expect(facts.cell("checks")).toHaveAttribute("title", "read 2 min ago");
    // The card grows into place as it arrives; the press goes where it rests.
    await atRest(page.locator("[data-card-facts]"));

    // A press with nothing refreshing opens the pull request.
    await pressPointer(page, link, HOLD_MS);
    await expect.poll(opened).toEqual([PR]);

    // The captain's focus is back in the main message, as it is when he
    // reaches for the link. The window's own clock orders the refresh and
    // the click the press made.
    await focusOn(promptInput(page));
    await page.evaluate((stripSelector) => {
      const strip = document.querySelector<HTMLIFrameElement>(stripSelector);
      const seen = { refreshed: 0, clicked: 0 };
      (window as unknown as { __fmPress: typeof seen }).__fmPress = seen;
      window.infinitary.cards.onCards(() => {
        if (!seen.refreshed) seen.refreshed = performance.now();
      });
      window.addEventListener("message", (event) => {
        if (event.source !== strip?.contentWindow) return;
        if ((event.data as { type?: string })?.type === "link") seen.clicked = performance.now();
      });
    }, FACTS_FRAME_SELECTOR);
    // The host's refresh: the card list with the strip's checks read a
    // minute later, pushed while the button is down.
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    const refreshed = cards.map((card) =>
      card.id === "card-meter-fix"
        ? { ...card, body: card.body.replace('title="read 2 min ago"', 'title="read 3 min ago"') }
        : card,
    );
    expect(refreshed).not.toEqual(cards);
    await app.evaluate(
      ({ BrowserWindow }, { refreshed, after }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        setTimeout(() => contents?.send("inf:cards", refreshed), after);
      },
      { refreshed, after: REFRESH_AFTER_MS },
    );
    await pressPointer(page, link, HOLD_MS);
    await expect(facts.cell("checks")).toHaveAttribute("title", "read 3 min ago");
    await expect.poll(opened).toEqual([PR, PR]);
    // The strip refreshed while the button was down: after it went down -
    // the click comes HOLD_MS after that at the earliest - and before the
    // click.
    const order = await page.evaluate(
      () => (window as unknown as { __fmPress: { refreshed: number; clicked: number } }).__fmPress,
    );
    expect(order.refreshed).toBeGreaterThan(order.clicked - HOLD_MS);
    expect(order.clicked).toBeGreaterThan(order.refreshed);
  } finally {
    await launched.close();
  }
});
