import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { PresetId } from "../../src/shared/keyPresets";
import { scratchDir } from "../helpers/scratchDirs";
import { THIS_DESKTOP } from "./desktop";
import { cardBody, cardBodyElement } from "./frames";
import { takeTurn } from "./inputQueue";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { expandDock } from "./rails";
import {
  cardReply,
  cardScroller,
  noteDone,
  pager,
  pagerAt,
  SHOWN_ENTRY,
  shownCard,
  stageAtRest,
} from "./stack";
import { MAC_ONLY_TAG } from "./tags";
import {
  focusedRegion,
  focusOn,
  frameHoldsWindowFocus,
  pressKey,
  pressWindowKey,
  typeInto,
  type WindowKeyModifier,
} from "./windowKeys";

/**
 * INF-3818's accepted plan, "Where focus lands" (docs/keyboard.md): a
 * shortcut never changes whether the person is typing while a card is left,
 * so a key that pages, answers or puts a card aside can be pressed again at
 * once in every preset; the captain's later ask puts the caret in the main
 * message once a key closes the last card. Data: four ordinary first mate
 * cards in a private home, two questions and two notes, one long enough to
 * scroll. Signal: the pager's position, the focused element and its ring,
 * and the main message's words. Hidden Electron with the mock provider; no
 * Mac-only resource, sign-in or real data.
 */

const LONG_NOTE = "Tide tables for the week";
const lines = Array.from(
  { length: 60 },
  (_, i) => `<p>Day ${Math.floor(i / 8) + 1}, reading ${(i % 8) + 1}: high water at the pier.</p>`,
).join("");

/** The four cards, oldest first, which is the stack's order at one priority. */
const CARDS = [
  {
    id: "harbour",
    title: "Choose the harbour",
    body: "<p>Two harbours are free this week.</p>",
    actions: [
      { id: "north", label: "North harbour", default: true },
      { id: "south", label: "South harbour" },
    ],
  },
  { id: "tides", title: LONG_NOTE, body: lines, actions: [] },
  {
    id: "crew",
    title: "Choose the crew",
    body: "<p>Both crews can sail on Friday.</p>",
    actions: [
      { id: "blue", label: "Blue crew", default: true },
      { id: "green", label: "Green crew" },
    ],
  },
  { id: "weather", title: "Weather looks calm", body: "<p>Light winds all week.</p>", actions: [] },
];

async function launchWithCards(keys: PresetId, cards: readonly (typeof CARDS)[number][] = CARDS) {
  const userDataDir = scratchDir("infinitary-focus-landing-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  for (const [index, card] of cards.entries()) {
    store.upsert({
      ...card,
      author: "firstmate",
      priority: 25,
      meta: "firstmate",
      status: "ready",
      createdAt: 1000 + index,
    });
  }
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true, keys });
  await expect(pagerAt(launched.page, 1, cards.length)).toBeVisible();
  return launched;
}

/** The shown card holds focus whole, with the ring a key draws. */
async function expectCardFocused(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const entry = document.querySelector(selector);
        return (
          entry !== null && document.activeElement === entry && entry.matches(":focus-visible")
        );
      }, SHOWN_ENTRY),
    )
    .toBe(true);
}

/** Presses window keys until focus is in `region`, the way F6 walks the window's parts. */
async function walkTo(app: ElectronApplication, page: Page, region: string): Promise<void> {
  for (let press = 0; press < 8 && (await focusedRegion(page)) !== region; press++) {
    const from = await focusedRegion(page);
    await pressWindowKey(app, "F6");
    await expect.poll(() => focusedRegion(page)).not.toBe(from);
  }
  expect(await focusedRegion(page)).toBe(region);
}

const NEXT: Record<"legacy" | "vscode", [string, WindowKeyModifier[]]> = {
  legacy: ["]", ["meta", "shift"]],
  vscode: ["]", ["meta", "shift"]],
};

test("Vim: paging, putting aside and answering chain from the shown card, with no Escape between", async () => {
  test.setTimeout(150_000);
  const { app, page, close } = await launchWithCards("vim");
  const prompt = promptInput(page);
  try {
    await test.step("each next-card key lands on the card it shows, ringed", async () => {
      await focusOn(prompt);
      await pressWindowKey(app, "Escape");
      await expectCardFocused(page);
      for (const position of [2, 3, 4]) {
        await pressWindowKey(app, "L", ["shift"]);
        await expect(pagerAt(page, position, 4)).toBeVisible();
        await expectCardFocused(page);
      }
    });

    await test.step("three presses with no wait between still reach the last card", async () => {
      for (const position of [3, 2, 1]) {
        await pressWindowKey(app, "H", ["shift"]);
        await expect(pagerAt(page, position, 4)).toBeVisible();
      }
      await pressWindowKey(app, "L", ["shift"]);
      await pressWindowKey(app, "L", ["shift"]);
      await pressWindowKey(app, "L", ["shift"]);
      await expect(pagerAt(page, 4, 4)).toBeVisible();
      await expectCardFocused(page);
      await expect(prompt).toHaveValue("");
    });

    await test.step("leaving Keyboard settings returns focus to the card", async () => {
      await pressWindowKey(app, "?", ["shift"]);
      await expect(page.getByRole("tab", { name: "Keyboard", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await pressWindowKey(app, "Escape");
      await expect(pagerAt(page, 4, 4)).toBeVisible();
      await expectCardFocused(page);
    });

    await test.step("putting two cards aside in a row lands on the next card each time", async () => {
      for (const count of [3, 2]) {
        await pressWindowKey(app, "Q");
        await expect(pager(page, count)).toBeVisible();
        await expectCardFocused(page);
      }
    });

    // The captain's ask: a key that closes the last card drops focus into the
    // main message, where Vim's plain keys type words instead of running.
    await test.step("answering two cards in a row lands on the next card, then in the main message", async () => {
      await pressWindowKey(app, "1", ["meta"]);
      await expect(pager(page, 2)).toHaveCount(0);
      await expectCardFocused(page);
      await pressWindowKey(app, "1", ["meta"]);
      await expect(page.locator(SHOWN_ENTRY)).toHaveCount(0);
      await expect(prompt).toBeFocused();
      await typeInto(prompt, "go with the blue crew");
      await expect(prompt).toHaveValue("go with the blue crew");
    });
  } finally {
    await close();
  }
});

/** Four decision cards whose bodies each hold a button of their own. */
const FIRST_BUTTON_CARD = "Pick a berth";
const BUTTON_CARDS = [FIRST_BUTTON_CARD, "Pick a pilot", "Pick a tug", "Pick a mooring"].map(
  (title, index) => ({
    id: `button-${index + 1}`,
    title,
    body: '<p>Both are free.</p><p><button type="button">Show tides</button></p>',
    actions: [
      { id: "first", label: "First one", default: true },
      { id: "second", label: "Second one" },
    ],
  }),
);

// The captain's report: with focus on something inside the card, Shift+L
// paged once and dropped focus in the main message, where the next Shift+L
// typed instead of paging. Both pages here go one after the other with no
// Escape between, from a button in the body and from a button a pointer focused.
test("Vim: paging from a control inside the card, or one a pointer focused, keeps paging", async () => {
  test.setTimeout(150_000);
  const { app, page, close } = await launchWithCards("vim", BUTTON_CARDS);
  try {
    await test.step("from a button in the card's body, Shift+L pages and the next Shift+L pages again", async () => {
      const title = FIRST_BUTTON_CARD;
      await focusOn(cardBodyElement(page, title));
      const button = cardBody(page, title).getByRole("button", { name: "Show tides" });
      await focusOn(button);
      await frameHoldsWindowFocus(button);
      // The window hears the native press first; the key itself goes into the
      // frame, whose bridge offers it back (docs/keyboard.md, "Keys used when not typing").
      await pressWindowKey(app, "L", ["shift"]);
      await takeTurn(page, async () => {
        await page.keyboard.down("Shift");
        await page.keyboard.down("L");
        await expect(pagerAt(page, 2, 4)).toBeVisible();
        await page.keyboard.up("L");
        await page.keyboard.up("Shift");
      });
      await expectCardFocused(page);
      await pressWindowKey(app, "L", ["shift"]);
      await expect(pagerAt(page, 3, 4)).toBeVisible();
      await expectCardFocused(page);
    });

    await test.step("from a card button a pointer pressed, Shift+L pages and Shift+H pages back", async () => {
      const button = page.locator(SHOWN_ENTRY).getByRole("button", { name: "First one" });
      // Measured once the card stopped moving, so the press lands on the button.
      await stageAtRest(page);
      const box = await button.boundingBox();
      if (!box) throw new Error("the card's button is not drawn");
      // Pressed and let go away from it, so it takes focus and nothing is chosen.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await expect(button).toBeFocused();
      await pressWindowKey(app, "L", ["shift"]);
      await expect(pagerAt(page, 4, 4)).toBeVisible();
      await expectCardFocused(page);
      await pressWindowKey(app, "H", ["shift"]);
      await expect(pagerAt(page, 3, 4)).toBeVisible();
      await expectCardFocused(page);
    });
  } finally {
    await close();
  }
});

test("Legacy: the next card takes the keys; typing and a side panel keep their focus; a click goes to the main message", async () => {
  test.setTimeout(150_000);
  const { app, page, close } = await launchWithCards("legacy");
  const prompt = promptInput(page);
  const [next, mods] = NEXT.legacy;
  try {
    await test.step("from the card, the next card scrolls by its reading keys and Up recalls nothing", async () => {
      await prompt.fill("Note the tide times");
      await pressKey(prompt, "Enter");
      await expect(prompt).toHaveValue("");
      await walkTo(app, page, "card");
      await pressWindowKey(app, next, mods);
      await expect(pagerAt(page, 2, 4)).toBeVisible();
      await expect(shownCard(page, LONG_NOTE)).toBeVisible();
      await expectCardFocused(page);
      const scroller = cardScroller(page);
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 40))
        .toBe(true);
      await pressWindowKey(app, "Down");
      await pressWindowKey(app, "Down");
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await pressWindowKey(app, "Up");
      await expectCardFocused(page);
      await expect(prompt).toHaveValue("");
    });

    await test.step("with a draft in the main message, the caret and the draft stay", async () => {
      await prompt.fill("Draft for the harbour master");
      await focusOn(prompt);
      await pressWindowKey(app, next, mods);
      await expect(pagerAt(page, 3, 4)).toBeVisible();
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue("Draft for the harbour master");
      await prompt.fill("");
    });

    await test.step("with the caret in a card's reply, paging lands in the main message", async () => {
      await focusOn(cardReply(page).field);
      await pressWindowKey(app, next, mods);
      await expect(pagerAt(page, 4, 4)).toBeVisible();
      await expect(prompt).toBeFocused();
    });

    await test.step("focus in the Tasks panel stays there when the shown card is answered", async () => {
      await pressWindowKey(app, "[", ["meta", "shift"]);
      await expect(pagerAt(page, 3, 4)).toBeVisible();
      await expandDock(page, "now");
      await walkTo(app, page, "panel:now");
      await pressWindowKey(app, "1", ["meta"]);
      await expect(pager(page, 3)).toBeVisible();
      await expect.poll(() => focusedRegion(page)).toBe("panel:now");
    });

    await test.step("a click on Got it leaves the caret in the main message", async () => {
      const weather = shownCard(page, "Weather looks calm");
      await focusOn(prompt);
      for (let press = 0; press < 3 && !(await weather.isVisible()); press++) {
        await pressWindowKey(app, next, mods);
        await stageAtRest(page);
      }
      await expect(weather).toBeVisible();
      await walkTo(app, page, "card");
      await stageAtRest(page);
      await noteDone(page).click();
      await expect(pager(page, 3)).toHaveCount(0);
      await expect(prompt).toBeFocused();
    });
  } finally {
    await close();
  }
});

/** Pages twice from the shown card with `next`, landing on each card it shows. */
async function pageTwiceFromCard(
  preset: PresetId,
  next: (app: ElectronApplication) => Promise<void>,
) {
  const { app, page, close } = await launchWithCards(preset);
  try {
    await walkTo(app, page, "card");
    for (const position of [2, 3]) {
      await next(app);
      await expect(pagerAt(page, position, 4)).toBeVisible();
      await expectCardFocused(page);
    }
  } finally {
    await close();
  }
}

test("vscode: the next-card key twice from a card lands on each card it shows", async () => {
  test.setTimeout(120_000);
  await pageTwiceFromCard("vscode", (app) => pressWindowKey(app, ...NEXT.vscode));
});

test("emacs: the next-card key twice from a card lands on each card it shows", {
  tag: MAC_ONLY_TAG,
}, async () => {
  // Emacs is offered only on a Mac, where Ctrl is free of the command key (`presetsOffered`).
  test.skip(THIS_DESKTOP.keys !== "mac", "Emacs is offered only on a Mac");
  test.setTimeout(120_000);
  await pageTwiceFromCard("emacs", async (app) => {
    await pressWindowKey(app, "X", ["control"]);
    await pressWindowKey(app, "Right");
  });
});
