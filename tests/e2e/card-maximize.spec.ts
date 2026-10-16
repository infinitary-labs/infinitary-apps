import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import type { Card } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { ANY_CARD_BODY_SELECTOR, cardBody } from "./frames";
import { launchApp } from "./launch";
import { type Rect, resizeWindow, settled, within } from "./layout";
import { promptInput } from "./prompt";
import { expandDock, openGroup, pressRow, recordCard } from "./rails";
import {
  cardReply,
  cardSurface,
  clickInBody,
  closeQuestion,
  showCard,
  shownCard,
  shownEntry,
} from "./stack";
import { boardCard, boardEntry, boardFocusOn, boardsOnStage, hideBoard } from "./taskBoard";
import { pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * A card made almost full screen and given back (design skill ResponseCard,
 * "Maximize"; FI3-1133's approved plan, extent A): the size control beside
 * Close, or Maximize or restore card in command search, gives the shown card
 * the window below its top bar, with the side panels and the main message
 * aside; Restore, or an Escape nothing in the card used, gives it back the
 * same card - its page, its answer, its reply and its reading place intact.
 */

const READ = "Compare the two launch plans";
const THREADED = "Pick the release window";
const PARTS = 24;

function card(id: string, title: string, priority: number): Card {
  return {
    id,
    author: "firstmate",
    meta: "firstmate",
    priority,
    title,
    body:
      `<p>I recommend the second plan: it keeps billing and login in one release.</p>` +
      `<fieldset><legend>Which plan should ship?</legend>` +
      `<label><input type="radio" name="plan" value="one"> Ship Tuesday</label>` +
      `<label><input type="radio" name="plan" value="two"> Wait a week</label>` +
      `<label><input type="radio" name="plan" value="else" data-inf-write-in> Something else</label></fieldset>` +
      Array.from(
        { length: PARTS },
        (_, n) =>
          `<p data-part="${n + 1}">Part ${n + 1}. The first plan ships the login fix on Tuesday, and the second waits a week for the billing review so both land together.</p>`,
      ).join(""),
    status: "ready",
    createdAt: Date.now(),
    actions: [
      { id: "later", label: "Save for later", variant: "secondary" },
      { id: "go", label: "Approve", variant: "primary", default: true },
    ],
  };
}

/** The shown entry's size control, by the words it reads now. */
const sizeControl = (page: Page, label: string) =>
  shownEntry(page).getByRole("button", { name: label, exact: true });

const box = (page: Page, selector: string): Promise<Rect> =>
  page.locator(selector).evaluate((element) => element.getBoundingClientRect().toJSON());

const windowBox = (page: Page): Promise<Rect> =>
  page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));

/**
 * Whether the part of the body numbered `part` lies in the visible part of
 * the card's body: the body's page draws whole, and the card scrolls it.
 */
async function partInView(page: Page, frame: FrameLocator, part: number): Promise<boolean> {
  const seen = await shownEntry(page)
    .locator("[data-card-body]")
    .evaluate((scroller, bodySelector) => {
      const page = scroller.querySelector(bodySelector);
      if (!page) return null;
      const top = scroller.getBoundingClientRect().top - page.getBoundingClientRect().top;
      return { top, bottom: top + scroller.clientHeight };
    }, ANY_CARD_BODY_SELECTOR);
  if (!seen) return false;
  const at = await frame
    .locator(`[data-part="${part}"]`)
    .evaluate((element) => element.getBoundingClientRect().top);
  return at >= seen.top - 1 && at <= seen.bottom;
}

/** The body's part whose top is the first in sight. */
async function partAtTop(page: Page, frame: FrameLocator): Promise<number> {
  for (let part = 1; part <= PARTS; part++) if (await partInView(page, frame, part)) return part;
  return 0;
}

test("a card maximizes into the window and comes back with its page, answers, reply and place", async () => {
  test.setTimeout(150_000);
  const userDataDir = scratchDir("infinitary-card-maximize-");
  const db = openDatabase(userDataDir);
  try {
    seedTask(new TaskService({ db, strict: true }), {
      id: "maximize-launch",
      title: "Prepare the launch checklist",
      status: "queued",
      startPolicy: "on-request",
    });
    const store = new CardStore(db);
    store.upsert(card("card-read", READ, 30));
    store.upsert(card("card-threaded", THREADED, 20));
    store.appendMessage({ cardId: "card-threaded", who: "captain", text: "Keep them together." });
    store.appendMessage({ cardId: "card-threaded", who: "firstmate", text: "Kept beside it." });
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await showCard(page, READ);
    const frame = cardBody(page, READ);
    const answer = frame.getByRole("radio", { name: "Wait a week" });
    const reply = cardReply(page).field;
    const surface = cardSurface(page);
    let usual: Rect = { x: 0, y: 0, width: 0, height: 0 };

    await test.step("Maximize gives the same card the window, with the panels and the main message aside", async () => {
      await clickInBody(answer);
      await expect(answer).toBeChecked();
      await reply.fill("draft beside the card");
      // The body's page is the same document after every change of size.
      await frame.locator("body").evaluate(() => {
        (window as unknown as { kept?: string }).kept = "this page";
      });
      await shownEntry(page)
        .locator("[data-card-body]")
        .evaluate((scroller) => {
          scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
        });
      usual = await settled(() => surface.evaluate((e) => e.getBoundingClientRect().toJSON()));
      const reading = await partAtTop(page, frame);
      expect(reading).toBeGreaterThan(1);

      await sizeControl(page, MAXIMIZE_LABEL).click();
      await expect(sizeControl(page, RESTORE_LABEL)).toBeFocused();
      await expect(promptInput(page)).toBeHidden();
      await expect(page.locator('[data-side-panel="now"]')).toBeHidden();
      const big = await settled(() => surface.evaluate((e) => e.getBoundingClientRect().toJSON()));
      expect(big.width).toBeGreaterThan(usual.width);
      expect(big.height).toBeGreaterThan(usual.height);
      expect(within(big, await windowBox(page))).toEqual([]);
      const bar = await box(page, "[data-topbar]");
      expect(big.y).toBeGreaterThanOrEqual(bar.y + bar.height);
      // The pager keeps its own lane under the card.
      expect(within(await box(page, "[data-card-pager]"), await windowBox(page))).toEqual([]);
      expect((await box(page, "[data-card-pager]")).y).toBeGreaterThanOrEqual(big.y + big.height);
      await expect.poll(() => partInView(page, frame, reading)).toBe(true);
      await expect(answer).toBeChecked();
      await expect(reply).toHaveValue("draft beside the card");
      expect(
        await frame
          .locator("body")
          .evaluate(() => (window as unknown as { kept?: string }).kept ?? null),
      ).toBe("this page");
    });

    await test.step("Tab and Shift+Tab go round the card and its pager", async () => {
      await page.keyboard.press("Shift+Tab");
      await expect
        .poll(() =>
          page.evaluate(() => document.activeElement?.closest("[data-card-pager]") !== null),
        )
        .toBe(true);
      await page.keyboard.press("Tab");
      await expect(sizeControl(page, RESTORE_LABEL)).toBeFocused();
    });

    await test.step("the close question takes the first Escape, and the next restores the card", async () => {
      await shownCard(page, READ).getByRole("button", { name: "Close", exact: true }).click();
      const question = closeQuestion(page);
      await expect(question).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(question).toHaveCount(0);
      await expect(sizeControl(page, RESTORE_LABEL)).toBeVisible();
      await pressKey(sizeControl(page, RESTORE_LABEL), "Escape");
      await expect(sizeControl(page, MAXIMIZE_LABEL)).toBeFocused();
      await expect(promptInput(page)).toBeVisible();
      await expect(page.locator('[data-side-panel="now"]')).toBeVisible();
      const back = await settled(() => surface.evaluate((e) => e.getBoundingClientRect().toJSON()));
      expect(back.width).toBe(usual.width);
      await expect(answer).toBeChecked();
      await expect(reply).toHaveValue("draft beside the card");
      expect(
        await frame
          .locator("body")
          .evaluate(() => (window as unknown as { kept?: string }).kept ?? null),
      ).toBe("this page");
    });

    await test.step("command search maximizes it, and Go to the main message restores it first", async () => {
      await runFromSearch(app, page, "cards.maximize");
      await expect(sizeControl(page, RESTORE_LABEL)).toBeFocused();
      await expect(promptInput(page)).toBeHidden();
      await pressWindowKey(app, "l", ["meta"]);
      await expect(promptInput(page)).toBeFocused();
      await expect(sizeControl(page, MAXIMIZE_LABEL)).toBeVisible();
    });

    await test.step("paging leaves maximize, and a thread stays beside a maximized card", async () => {
      await sizeControl(page, MAXIMIZE_LABEL).click();
      await expect(promptInput(page)).toBeHidden();
      await page.getByRole("button", { name: "Next card" }).click();
      await expect(shownCard(page, THREADED)).toBeVisible();
      await expect(promptInput(page)).toBeVisible();
      await sizeControl(page, MAXIMIZE_LABEL).click();
      await expect(promptInput(page)).toBeHidden();
      const pair = shownEntry(page).locator("[data-card-pair]");
      await expect(pair).toBeVisible();
      await expect(shownEntry(page).getByText("Kept beside it.")).toBeVisible();
      await sizeControl(page, RESTORE_LABEL).click();
      await expect(promptInput(page)).toBeVisible();
      await expect(pair).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});

test("a task's record, a past card and the task board maximize too, and Escape restores before it hides", async () => {
  test.setTimeout(150_000);
  const userDataDir = scratchDir("infinitary-card-maximize-held-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    key = seedTask(new TaskService({ db, strict: true }), {
      id: "maximize-record",
      title: "Prepare the launch checklist",
      status: "queued",
      startPolicy: "on-request",
    }).key;
    const store = new CardStore(db);
    store.upsert(card("card-past", READ, 30));
    store.resolve("card-past", "later");
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });

    await test.step("a task's record", async () => {
      await expandDock(page, "now");
      await openGroup(page, "backlog");
      await pressRow(page, key);
      await expect(recordCard(page)).toBeVisible();
      await sizeControl(page, MAXIMIZE_LABEL).click();
      await expect(promptInput(page)).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(sizeControl(page, MAXIMIZE_LABEL)).toBeFocused();
      await expect(recordCard(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(recordCard(page)).toHaveCount(0);
    });

    await test.step("a past card", async () => {
      await page.evaluate((id) => window.infinitary.cards.showPast(id), "card-past");
      const past = shownEntry(page).locator("[data-past-strip]");
      await expect(past).toBeVisible();
      await sizeControl(page, MAXIMIZE_LABEL).click();
      await expect(promptInput(page)).toBeHidden();
      await sizeControl(page, RESTORE_LABEL).click();
      await expect(promptInput(page)).toBeVisible();
      await shownEntry(page).getByRole("button", { name: "Hide", exact: true }).click();
      await expect(past).toHaveCount(0);
    });

    await test.step("the task board: an Escape in its page restores it, and the next hides it", async () => {
      // Find with no words uses no Escape. Opened on a tile instead, the
      // board's page gives focus back to that tile, and its summary takes
      // the first Escape (docs/task-board.md).
      await runFromSearch(app, page, "panel:now/board-find");
      const find = boardEntry(page).locator("[data-board-find]");
      await expect.poll(() => boardFocusOn(page, find)).toBe(true);
      await expect(find).toHaveValue("");
      await sizeControl(page, MAXIMIZE_LABEL).click();
      await expect(promptInput(page)).toBeHidden();
      await expect(hideBoard(page)).toBeVisible();
      await pressKey(find, "Escape");
      await expect(sizeControl(page, MAXIMIZE_LABEL)).toBeVisible();
      await expect(promptInput(page)).toBeVisible();
      await expect(boardCard(page)).toBeVisible();
      await pressKey(find, "Escape");
      await expect(boardsOnStage(page)).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});
