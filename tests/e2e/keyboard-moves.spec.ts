import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask, type TaskSeed } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { Card } from "../../src/shared/cards";
import { chordLabel } from "../../src/shared/keyboard";
import { bindingWarning, type SavedKeymap } from "../../src/shared/keymap";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { promptInput } from "./prompt";
import { expandDock, nowFrame } from "./rails";
import { showCard, shownEntry } from "./stack";
import { boardEntry } from "./taskBoard";
import {
  commandSearch,
  endRecording,
  focusedRegion,
  focusOn,
  keyboardSettings,
  pressWindowKey,
  regionAfter,
  runFromSearch,
  startRecording,
} from "./windowKeys";

/**
 * Moving by keys of a person's own (docs/keyboard.md, "Moving by a key of
 * your own"; INF-3547's accepted plan, piece 2: "a key bound to Move down
 * does what ↓ does everywhere it works today"). With Move down, Move up,
 * Move right, Move to the end, Cancel and the directional parts given keys
 * held with ⌥, each key does what its arrow, End or Escape does: command
 * search's rows, Settings' tabs, the Tasks list and its search in the
 * Tasks panel's frame, the task board in that panel's card, a card read
 * whole, and a card's question options in its frame. Keyboard settings
 * records a key held with ⌥ and names the character it stops typing, and
 * takes ⌃Tab.
 *
 * Every key of a person's own goes through the window's own input path
 * (`pressWindowKey`): the main process hears it first, as it hears a
 * person's, and presses the arrow where focus is. Enter on a card's button,
 * which no command of this journey owns, goes through Playwright's keyboard
 * to the focused button, as in card-keyboard.spec.ts.
 */

const TITLE = "Pick the launch window";

/** The keys a person who moves with their left hand might give the movement commands. */
const OWN_KEYS: SavedKeymap = {
  version: 1,
  keys: {
    "move.down": [{ key: "j", alt: true }],
    "move.up": [{ key: "k", alt: true }],
    "move.right": [{ key: "l", alt: true }],
    "move.last": [{ key: "e", alt: true }],
    cancel: [{ key: "g", alt: true }],
    "regions.right": [{ key: "l", alt: true, shift: true }],
    "regions.left": [{ key: "h", alt: true, shift: true }],
  },
};

/** A decision with a question to pick and a body longer than the card shows. */
function decisionCard(): Card {
  return {
    id: "card-fm-launch-window",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: TITLE,
    body:
      "<p>The checklist is ready. Pick when the launch goes out.</p>" +
      "<fieldset><legend>When should it launch?</legend>" +
      '<label><input type="radio" name="window" value="morning" required> Tomorrow morning</label>' +
      '<label><input type="radio" name="window" value="evening"> Tomorrow evening</label></fieldset>' +
      "<p>The rest of the plan follows, one step a line.</p>".repeat(16),
    status: "ready",
    createdAt: Date.now(),
    actions: [
      { id: "hold", label: "Hold", variant: "secondary" },
      { id: "launch", label: "Launch it", variant: "primary", default: true },
    ],
  };
}

/** Three tasks held until next month, so they wait in the Tasks list without starting, and the card. */
function seed(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  try {
    const now = Date.now();
    let clock = now - 60 * 60_000;
    const tasks = new TaskService({ db, strict: true, now: () => clock });
    const held = { kind: "at-time" as const, until: now + 30 * 24 * 60 * 60_000 };
    const add = (value: TaskSeed) => {
      clock += 60_000;
      seedTask(tasks, value);
    };
    add({ id: "launch", title: "Plan the spring launch email", status: "queued", gate: held });
    add({ id: "venue", title: "Book the venue for the offsite", status: "queued", gate: held });
    add({ id: "notes", title: "Sort the release notes by area", status: "queued", gate: held });
    new CardStore(db).upsert(decisionCard());
  } finally {
    db.close();
  }
}

/** The Tasks row that holds the keyboard's focus, by its task's key. */
function focusedRowKey(page: Page): Promise<string | null> {
  return nowFrame(page)
    .locator("[data-now-row]:focus")
    .evaluateAll((rows) => rows[0]?.getAttribute("data-now-key") ?? null);
}

/** The task board's selected tile, by its task's key. */
function selectedTileKey(page: Page): Promise<string | null> {
  return boardEntry(page)
    .locator("[data-board-tile][data-board-selected]")
    .evaluateAll((tiles) => tiles[0]?.getAttribute("data-board-key") ?? null);
}

/**
 * The value of the option that holds focus inside the card's frame. A
 * hidden window's frame never reports focus to the page, so this reads the
 * frame's own active element.
 */
function focusedOption(page: Page): Promise<string | null> {
  return cardBody(page, TITLE)
    .locator("body")
    .evaluate(() => document.activeElement?.getAttribute("value") ?? null)
    .catch(() => null);
}

/** How far the shown card's body, the one place it scrolls, is scrolled. */
const cardScroll = (page: Page) =>
  shownEntry(page)
    .locator("[data-card-body]")
    .evaluate((scroller) => scroller.scrollTop);

test("keys of a person's own move as the arrows, End and Escape do, everywhere they work", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-keyboard-moves-");
  seed(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 820 });
    await expect(promptInput(page)).toBeVisible();
    await page.evaluate((keys) => window.infinitary.keyboard.save(keys), OWN_KEYS);
    const down = () => pressWindowKey(app, "j", ["alt"]);
    const up = () => pressWindowKey(app, "k", ["alt"]);

    await test.step("command search's rows follow Move down and Move up, and Cancel closes it", async () => {
      const search = commandSearch(page);
      await pressWindowKey(app, "k", ["meta"]);
      await expect(search.field).toBeFocused();
      const active = () => search.field.getAttribute("aria-activedescendant");
      const first = await active();
      await down();
      await expect.poll(active).not.toBe(first);
      await up();
      await expect.poll(active).toBe(first);
      await pressWindowKey(app, "g", ["alt"]);
      await expect(search.dialog).toBeHidden();
    });

    await test.step("Settings' tabs follow Move right, as they follow →", async () => {
      await pressWindowKey(app, ",", ["meta"]);
      const selected = page.getByRole("tab", { selected: true });
      await expect(selected).toBeVisible();
      expect(await regionAfter(app, page, await focusedRegion(page), "F6")).toBe("settings-tabs");
      const first = await selected.textContent();
      await pressWindowKey(app, "l", ["alt"]);
      await expect(selected).not.toHaveText(first ?? "");
      await expect(selected).toBeFocused();
      await pressWindowKey(app, "Escape");
      await expect(page.getByRole("tab")).toHaveCount(0);
    });

    await test.step("in the Tasks panel's frame, the list follows Move down, Move up and Move to the end", async () => {
      await expandDock(page, "now");
      await expect(nowFrame(page).locator("[data-now-row]")).toHaveCount(3);
      // Expanding the panel pressed its chevron, so focus is already in the
      // panel: F6 goes on from it and comes round to where the list starts.
      let at = await regionAfter(app, page, await focusedRegion(page), "F6");
      while (at !== "panel:now") at = await regionAfter(app, page, at, "F6");
      await expect.poll(() => focusedRowKey(page)).not.toBeNull();
      const first = await focusedRowKey(page);
      await down();
      await expect.poll(() => focusedRowKey(page)).not.toBe(first);
      const second = await focusedRowKey(page);
      await up();
      await expect.poll(() => focusedRowKey(page)).toBe(first);
      await pressWindowKey(app, "e", ["alt"]);
      await expect.poll(() => focusedRowKey(page)).not.toBe(first);
      await expect.poll(() => focusedRowKey(page)).not.toBe(second);
    });

    await test.step("the Tasks search hands Move down to its first match, and Cancel closes it", async () => {
      const filters = nowFrame(page).locator("[data-now-filters]");
      const query = nowFrame(page).locator("[data-now-query]");
      await pressWindowKey(app, "f", ["meta", "shift"]);
      await expect(query).toBeFocused();
      await down();
      await expect.poll(() => focusedRowKey(page)).not.toBeNull();
      await focusOn(query);
      await pressWindowKey(app, "g", ["alt"]);
      await expect(filters).toBeHidden();
    });

    await test.step("the directional parts go left from the Tasks panel to the card and back right", async () => {
      let at = await focusedRegion(page);
      while (at !== "panel:now") at = await regionAfter(app, page, at, "F6");
      // The Tasks panel sits on the right rail, with the card to its left.
      await pressWindowKey(app, "h", ["alt", "shift"]);
      await expect.poll(() => focusedRegion(page)).toBe("card");
      await pressWindowKey(app, "l", ["alt", "shift"]);
      await expect.poll(() => focusedRegion(page)).toBe("panel:now");
    });

    await test.step("the task board in the Tasks panel's card follows Move down", async () => {
      await pressWindowKey(app, "b", ["meta"]);
      await expect(boardEntry(page)).toBeVisible();
      await expect.poll(() => selectedTileKey(page)).not.toBeNull();
      const first = await selectedTileKey(page);
      await down();
      await expect.poll(() => selectedTileKey(page)).not.toBe(first);
      await up();
      await expect.poll(() => selectedTileKey(page)).toBe(first);
      await runFromSearch(app, page, "cards.minimize");
      await expect(boardEntry(page)).toHaveCount(0);
    });

    await test.step("a card read whole scrolls on Move down, and its question options follow it in the card's frame", async () => {
      await showCard(page, TITLE);
      let at = await focusedRegion(page);
      while (at !== "card") at = await regionAfter(app, page, at, "F6");
      expect(await cardScroll(page)).toBe(0);
      await down();
      await expect.poll(() => cardScroll(page)).toBeGreaterThan(0);
      await pressWindowKey(app, "e", ["alt"]);
      const end = await cardScroll(page);
      await up();
      await expect.poll(() => cardScroll(page)).toBeLessThan(end);

      const morning = cardBody(page, TITLE).getByRole("radio", { name: "Tomorrow morning" });
      const evening = cardBody(page, TITLE).getByRole("radio", { name: "Tomorrow evening" });
      // The default with the question unanswered puts focus on the question.
      await runFromSearch(app, page, "focus.card-actions");
      await expect(shownEntry(page).getByRole("button", { name: "Launch it" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => focusedOption(page)).toBe("morning");
      await down();
      await expect(evening).toBeChecked();
      await expect.poll(() => focusedOption(page)).toBe("evening");
      await up();
      await expect(morning).toBeChecked();
      await expect.poll(() => focusedOption(page)).toBe("morning");
    });
  } finally {
    await launched.close();
  }
});

test("Keyboard settings records a key held with Option, naming what it stops typing, and takes Ctrl+Tab", async () => {
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await runFromSearch(app, page, "settings.keyboard");
    const keyboard = keyboardSettings(page);

    await keyboard.search.fill("move down");
    await startRecording(page, "move.down");
    await pressWindowKey(app, "j", ["alt"]);
    await expect(keyboard.verdict("move.down")).toHaveAttribute("data-keyboard-verdict", "free");
    // A key pressed through the window's input path reports its own letter,
    // so the warning names no character; its words after the key are the
    // owner's, the same on every system.
    const ownKey = { key: "j", alt: true };
    const warning = bindingWarning(ownKey, "move.down", [], "mac") ?? "";
    await expect(keyboard.row("move.down")).toContainText(
      warning.slice(chordLabel(ownKey, "mac").length),
    );
    await endRecording(app, page, "Enter");
    await expect(keyboard.keys("move.down").locator("select")).toHaveValue("anywhere");

    await keyboard.search.fill("next tab");
    await startRecording(page, "cards.next-tab");
    await pressWindowKey(app, "Tab", ["control"]);
    await expect(keyboard.verdict("cards.next-tab")).toHaveAttribute(
      "data-keyboard-verdict",
      "free",
    );
    await endRecording(app, page, "Enter");
    await expect(keyboard.keys("cards.next-tab").locator("kbd")).toHaveCount(1);
  } finally {
    await launched.close();
  }
});
