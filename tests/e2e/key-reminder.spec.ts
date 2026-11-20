import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import * as m from "../../src/shared/i18n/messages.generated";
import { type AnyCommandId, commandEntry, keyHint } from "../../src/shared/keyboard";
import { keymapSnapshot, presetKeymap } from "../../src/shared/keymap";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { cardLeave, showCard, shownCard, stageAtRest } from "./stack";
import { boardPage, boardView, boardViewTab, focusedTileKey } from "./taskBoard";
import { pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * The key reminder (INF-4555's accepted plan, direction A, done items 1, 6
 * and 9; docs/keyboard.md, "The key reminder"; the captain's picks: "it stops
 * once the person has pressed that action's key", "it shows the tooltip's
 * key", "on for everyone, with the switch to turn them off"). On Vim keys, a
 * mouse click on Put aside names the key its label shows, Q, "when not
 * typing", at the bottom of the window, and Enter on it names nothing.
 * Pressing ⇧⌘M, Put aside's other key, stops its reminder while another
 * control's still shows. Keyboard settings' switch, reached by Tab and
 * switched by Space, turns every reminder off. A control inside a panel's
 * own page, such as the task board's Backlog, does the same through its page
 * (INF-4555's second piece): its page tells the window of the click.
 */

const TITLE = "Choose the launch window";
const vim = keymapSnapshot({ saved: presetKeymap("vim"), unreadable: false }, 1).bindings;

test("a mouse click names its action's key until that key is pressed, and the switch turns it off", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-key-reminder-");
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      id: "key-reminder-choice",
      author: "firstmate",
      meta: "firstmate",
      title: TITLE,
      priority: 20,
      status: "ready",
      createdAt: Date.now(),
      body: "<p>Keep the launch and its review together.</p>",
      actions: [{ id: "go", label: "Use this window", default: true }],
    });
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, keys: "vim" });
  try {
    const { app, page } = launched;
    const reminder = page.locator("[data-key-reminder]");
    const bringBack = async () => {
      await runFromSearch(app, page, "cards.minimize-all");
      await showCard(page, TITLE);
    };

    await test.step("a mouse click on Put aside names Q, when not typing", async () => {
      await showCard(page, TITLE);
      await cardLeave(page).click();
      await expect(shownCard(page, TITLE)).toBeHidden();
      await expect(reminder).toHaveAttribute("data-key-reminder", "cards.minimize");
      await expect(reminder.locator("kbd")).toHaveText(keyHint("cards.minimize", vim) ?? "");
      await expect(reminder.locator("[data-key-reminder-label]")).toHaveText(
        commandEntry("cards.minimize")?.label ?? "",
      );
      await expect(reminder.locator("[data-key-reminder-not-typing]")).toHaveText(
        m.shellKeyReminderNotTyping(),
      );
      await goesByItself(page, reminder);
    });

    await test.step("Enter on Put aside names nothing", async () => {
      // From here a reminder stays until something takes it away.
      await holdReminders(page);
      await bringBack();
      await pressKey(cardLeave(page), "Enter");
      await expect(shownCard(page, TITLE)).toBeHidden();
      await expect(reminder).toHaveCount(0);
    });

    await test.step("pressing Put aside's key stops its reminder, and the gear's still shows", async () => {
      await bringBack();
      await pressWindowKey(app, "m", ["meta", "shift"]);
      await expect(shownCard(page, TITLE)).toBeHidden();
      await expect
        .poll(async () =>
          page.evaluate(async () => (await window.infinitary.keyboard.reminders()).pressed),
        )
        .toHaveProperty(["cards.minimize"]);
      await bringBack();
      await cardLeave(page).click();
      await expect(shownCard(page, TITLE)).toBeHidden();
      await expect(reminder).toHaveCount(0);
      await page.getByRole("button", { name: m.shellTopBarSettings(), exact: true }).click();
      await expect(reminder).toHaveAttribute("data-key-reminder", "settings.open");
    });

    await test.step("Keyboard settings' switch, by Tab and Space, turns every reminder off", async () => {
      const keyboardTab = page.locator('[data-settings-tab="keyboard"]');
      await keyboardTab.click();
      await expect(reminder).toHaveAttribute("data-key-reminder", "settings.keyboard");
      const preset = page.locator('[data-keyboard-settings] input[name="keyboard-preset"]:checked');
      await pressKey(preset, "Tab");
      const toggle = page.locator('[data-keyboard-reminders] [role="switch"]');
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await pressKey(toggle, " ");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await keyboardTab.click();
      await expect(page.locator('[data-settings-tab="keyboard"]')).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(reminder).toHaveCount(0);
      expect((await page.evaluate(() => window.infinitary.keyboard.reminders())).on).toBe(false);
    });
  } finally {
    await launched.close();
  }
});

/**
 * The reminder goes by itself once its hold is over (`--hold-key-reminder`),
 * which can outlast an assertion's usual wait.
 */
async function goesByItself(page: Page, reminder: Locator): Promise<void> {
  const hold = await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--hold-key-reminder"),
    ),
  );
  await expect(reminder).toBeHidden({ timeout: 2 * hold });
}

/**
 * Holds every reminder until something takes it away (`--hold-key-reminder`),
 * so a check that one is gone, or never showed, proves a press, a key or the
 * switch did it, and not its hold running out within the check's wait.
 */
async function holdReminders(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--hold-key-reminder", "600000ms"),
  );
}

/** The board's page has drawn the stage at rest, so a native press lands inside it. */
async function boardDrawn(page: Page): Promise<void> {
  await stageAtRest(page);
  await boardPage(page)
    .locator("body")
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
}

test("a mouse click on a task board control names the key the Tasks panel's command has, until that key is pressed", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-key-reminder-board-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    key = seedTask(new TaskService({ db, strict: true }), {
      id: "key-reminder-board",
      title: "Prepare the launch checklist",
      status: "queued",
      startPolicy: "on-request",
    }).key;
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const reminder = page.locator("[data-key-reminder]");
    const backlog = boardViewTab(page, "backlog");
    const done = boardViewTab(page, "landed");
    // The board's own controls name a key only once their commands have one.
    const panels = await page.evaluate(async () => {
      const { saved, panels } = await window.infinitary.keyboard.keymap();
      await window.infinitary.keyboard.save({
        ...saved,
        keys: {
          ...saved.keys,
          "panel:now/board-backlog": [{ key: "F8" }],
          "panel:now/board-done": [{ key: "F9" }],
        },
      });
      return panels;
    });
    const labelOf = (id: AnyCommandId) => commandEntry(id, panels)?.label ?? "";

    await test.step("a mouse click on Backlog names F8, Show the backlog", async () => {
      await pressWindowKey(app, "b", ["meta"]);
      await expect.poll(() => focusedTileKey(page)).toBe(key);
      await expect(backlog).toHaveAttribute("aria-keyshortcuts", "F8");
      await boardDrawn(page);
      // e2e-frame-actions: native -- The reminder answers only a real mouse click inside the panel's page.
      await backlog.click();
      await expect.poll(() => boardView(page)).toBe("backlog");
      await expect(reminder).toHaveAttribute("data-key-reminder", "panel:now/board-backlog");
      await expect(reminder.locator("kbd")).toHaveText("F8");
      await expect(reminder.locator("[data-key-reminder-label]")).toHaveText(
        labelOf("panel:now/board-backlog"),
      );
      await expect(reminder.locator("[data-key-reminder-not-typing]")).toHaveCount(0);
      await goesByItself(page, reminder);
    });

    await test.step("Enter on Done names nothing", async () => {
      // From here a reminder stays until something takes it away.
      await holdReminders(page);
      await pressKey(done, "Enter");
      await expect.poll(() => boardView(page)).toBe("landed");
      await expect(reminder).toHaveCount(0);
    });

    await test.step("pressing F8 stops Backlog's reminder, and Done's still shows", async () => {
      await pressWindowKey(app, "F8");
      await expect.poll(() => boardView(page)).toBe("backlog");
      await expect
        .poll(async () =>
          page.evaluate(async () => (await window.infinitary.keyboard.reminders()).pressed),
        )
        .toHaveProperty(["panel:now/board-backlog"]);
      await boardDrawn(page);
      // e2e-frame-actions: native -- The reminder answers only a real mouse click inside the panel's page.
      await done.click();
      await expect.poll(() => boardView(page)).toBe("landed");
      await expect(reminder).toHaveAttribute("data-key-reminder", "panel:now/board-done");
      await expect(reminder.locator("kbd")).toHaveText("F9");
      // A press inside the board's page takes Done's away, and Backlog's click names nothing.
      // e2e-frame-actions: native -- The reminder answers only a real mouse click inside the panel's page.
      await backlog.click();
      await expect.poll(() => boardView(page)).toBe("backlog");
      await expect(reminder).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});
