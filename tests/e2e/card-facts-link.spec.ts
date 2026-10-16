import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type Card, SETTLE_FACTS_OPEN } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { atRest, holdPointer } from "./layout";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockProvider";
import { promptInput } from "./prompt";
import { factsStrip, showCard } from "./stack";
import { focusOn } from "./windowKeys";

/**
 * A merge card's fact strip refreshes while it is up (FI3-1093): the host
 * rewrites its facts whenever the task's record changes - the checks
 * reading's age, a new reading - and the stage hands the strip the new
 * facts. A press the captain has started on the strip's pull request link
 * when that happens still opens the pull request when he lets go.
 *
 * The host's refresh is the card list it pushes, with the strip's checks
 * reading a minute older; the press is Chromium's own pointer, held down
 * while the refresh lands and let go after it (`holdPointer`).
 */

const PR = "https://github.com/octo/meterlab/pull/58";
const TITLE = "The meter fix is ready to merge";
const TASK = "task-meter-fix";

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
    const release = await holdPointer(page, link);
    await release();
    await expect.poll(opened).toEqual([PR]);

    // The captain's focus is back in the main message, as it is when he
    // reaches for the link. The strip's own document notes, in order, the
    // button going down, the refresh reaching its checks cell and the click
    // the release makes.
    await focusOn(promptInput(page));
    await link.evaluate((anchor) => {
      const strip = anchor.ownerDocument;
      const seen: string[] = [];
      (strip.defaultView as unknown as { __fmPress: string[] }).__fmPress = seen;
      strip.addEventListener("pointerdown", () => seen.push("down"), true);
      strip.addEventListener("click", () => seen.push("click"), true);
      new MutationObserver(() => {
        const checks = strip.querySelector('[data-fact="checks"]');
        if (checks?.getAttribute("title") === "read 3 min ago" && !seen.includes("refreshed"))
          seen.push("refreshed");
      }).observe(strip.body, { subtree: true, childList: true, attributes: true });
    });
    const noted = () =>
      link.evaluate(
        (anchor) =>
          (anchor.ownerDocument.defaultView as unknown as { __fmPress?: string[] }).__fmPress,
      );
    // The host's refresh: the card list with the strip's checks read a
    // minute later, pushed while the button is down.
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    const refreshed = cards.map((card) =>
      card.id === "card-meter-fix"
        ? { ...card, body: card.body.replace('title="read 2 min ago"', 'title="read 3 min ago"') }
        : card,
    );
    expect(refreshed).not.toEqual(cards);
    const letGo = await holdPointer(page, link);
    // The strip has the button down before the refresh is pushed.
    await expect.poll(noted).toEqual(["down"]);
    await app.evaluate(({ BrowserWindow }, refreshed) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inf:cards", refreshed);
    }, refreshed);
    await expect(facts.cell("checks")).toHaveAttribute("title", "read 3 min ago");
    await letGo();
    await expect.poll(opened).toEqual([PR, PR]);
    // The strip refreshed while the button was down: after it went down and
    // before the click its release made, all in the one document the strip
    // keeps.
    expect(await noted()).toEqual(["down", "refreshed", "click"]);
  } finally {
    await launched.close();
  }
});
