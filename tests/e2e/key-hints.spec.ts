import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { boardEntry, boardMore, boardPage, boardViewTab, focusedTileKey } from "./taskBoard";
import {
  commandSearch,
  endRecording,
  focusOn,
  keyboardSettings,
  pressWindowKey,
  startRecording,
} from "./windowKeys";

/**
 * A control's label teaches its command's key as it is now (INF-3019's plan,
 * direction A, guard; docs/keyboard.md, "Key hints"; the captain: "the
 * tooltip should include the current keyboard shortcut assigned to the
 * button"): a person gives Open Automation a key in Keyboard settings and
 * Settings' Automation tab names it on rest, gives it another and the tab
 * names the new one, and removes it and the tab names none. A panel's page
 * reads its own commands' keys the same way (`PanelProps.keys`): the task
 * board's Find, Backlog, Done, Dropped and a tile's ⋯ name the keys the
 * Tasks panel's commands that do the same have now.
 */

async function openKeyboardSettings(app: LaunchedApp["app"], page: Page): Promise<void> {
  await pressWindowKey(app, "k", ["meta"]);
  const search = commandSearch(page);
  await search.field.fill("keyboard");
  await expect(search.row("settings.keyboard")).toBeVisible();
  await pressWindowKey(app, "Enter");
  await expect(search.dialog).toBeHidden();
  await expect(keyboardSettings(page).search).toBeFocused();
}

test("a control's label names the key its command has now, as Keyboard settings sets, changes and removes it", async () => {
  test.setTimeout(90_000);
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);
    const tab = page.locator('[data-settings-tab="automation"]');
    const label = page.locator("[data-icon-label]");
    // The keyboard rests on the tab as a person's Tab would: the app's label shows.
    const restOnTab = () => focusOn(tab, { focusVisible: true });

    await openKeyboardSettings(app, page);

    await test.step("with no key, the tab names none", async () => {
      await expect(tab).not.toHaveAttribute("aria-keyshortcuts");
      await restOnTab();
      await expect(label).toBeHidden();
    });

    await test.step("records F7 for Open Automation, and the tab's label names F7", async () => {
      await startRecording(page, "settings.automation");
      await pressWindowKey(app, "F7");
      await expect(keyboard.verdict("settings.automation")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("settings.automation").locator("kbd")).toHaveText(["F7"]);
      await expect(tab).toHaveAttribute("aria-keyshortcuts", "F7");
      await restOnTab();
      await expect(label).toBeVisible();
      await expect(label).toContainText("Automation");
      await expect(label).toContainText("F7");
    });

    await test.step("records F8 in its place, and the label follows", async () => {
      await startRecording(page, "settings.automation");
      await pressWindowKey(app, "F8");
      await expect(keyboard.verdict("settings.automation")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("settings.automation").locator("kbd")).toHaveText(["F8"]);
      await expect(tab).toHaveAttribute("aria-keyshortcuts", "F8");
      await restOnTab();
      await expect(label).toContainText("F8");
      await expect(label).not.toContainText("F7");
    });

    await test.step("removes the key, and the tab names none again", async () => {
      await keyboard
        .row("settings.automation")
        .getByRole("button", { name: /^Remove / })
        .click();
      await expect(keyboard.keys("settings.automation").locator("kbd")).toHaveCount(0);
      await expect(tab).not.toHaveAttribute("aria-keyshortcuts");
      await restOnTab();
      await expect(label).toBeHidden();
    });
  } finally {
    await launched.close();
  }
});

async function recordKey(
  app: LaunchedApp["app"],
  page: Page,
  command: string,
  key: string,
): Promise<void> {
  const keyboard = keyboardSettings(page);
  await startRecording(page, command);
  await pressWindowKey(app, key);
  await expect(keyboard.verdict(command)).toHaveAttribute("data-keyboard-verdict", "free");
  await endRecording(app, page, "Enter");
  await expect(keyboard.keys(command).locator("kbd")).toHaveText([key]);
}

async function backToBoard(app: LaunchedApp["app"], page: Page, key: string): Promise<void> {
  await pressWindowKey(app, "Escape");
  await expect(keyboardSettings(page).section).toBeHidden();
  await pressWindowKey(app, "b", ["meta"]);
  await expect.poll(() => focusedTileKey(page)).toBe(key);
}

test("the task board's own controls name the keys the Tasks panel's commands have now", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-board-keys-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    key = seedTask(new TaskService({ db, strict: true }), {
      id: "board-keys-launch",
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
    const board = boardEntry(page);
    const drawn = (target: string) => board.locator(`[data-board-command-key="${target}"]`);
    const find = board.locator("[data-board-find]");
    const backlog = boardViewTab(page, "backlog");
    const done = boardViewTab(page, "landed");
    const dropped = board.locator("[data-board-dropped-toggle]");
    const more = boardMore(page, key);
    // The ⋯'s label, in the board's own page, as the keyboard resting on it shows it.
    const label = boardPage(page).locator("[data-icon-label]");

    await test.step("with no keys given, the board names none", async () => {
      await pressWindowKey(app, "b", ["meta"]);
      await expect.poll(() => focusedTileKey(page)).toBe(key);
      await expect(board.locator("[data-board-command-key]")).toHaveCount(0);
      for (const control of [find, backlog, done, dropped, more]) {
        await expect(control).not.toHaveAttribute("aria-keyshortcuts");
      }
    });

    await test.step("gives the board's five commands keys, and each control names its own", async () => {
      await openKeyboardSettings(app, page);
      await recordKey(app, page, "panel:now/board-find", "F7");
      await recordKey(app, page, "panel:now/board-backlog", "F8");
      await recordKey(app, page, "panel:now/board-done", "F9");
      await recordKey(app, page, "panel:now/board-dropped", "F10");
      await recordKey(app, page, "panel:now/board-move", "F2");
      await backToBoard(app, page, key);
      await expect(drawn("find")).toHaveText("F7");
      await expect(find).toHaveAttribute("aria-keyshortcuts", "F7");
      await expect(drawn("backlog")).toHaveText("F8");
      await expect(backlog).toHaveAttribute("aria-keyshortcuts", "F8");
      await expect(drawn("landed")).toHaveText("F9");
      await expect(done).toHaveAttribute("aria-keyshortcuts", "F9");
      await expect(drawn("dropped")).toHaveText("F10");
      await expect(dropped).toHaveAttribute("aria-keyshortcuts", "F10");
      await expect(more).toHaveAttribute("aria-keyshortcuts", "F2");
      await focusOn(more, { focusVisible: true });
      await expect(label).toBeVisible();
      await expect(label).toContainText(`${key} actions`);
      await expect(label).toContainText("F2");
    });

    await test.step("Find's key goes while the caret is in it", async () => {
      await focusOn(find);
      await expect(drawn("find")).toBeHidden();
    });

    await test.step("a key changed in Keyboard settings reaches the board, and one removed leaves", async () => {
      await openKeyboardSettings(app, page);
      await recordKey(app, page, "panel:now/board-backlog", "F3");
      await keyboardSettings(page)
        .row("panel:now/board-dropped")
        .getByRole("button", { name: /^Remove / })
        .click();
      await expect(
        keyboardSettings(page).keys("panel:now/board-dropped").locator("kbd"),
      ).toHaveCount(0);
      await backToBoard(app, page, key);
      await expect(drawn("backlog")).toHaveText("F3");
      await expect(backlog).toHaveAttribute("aria-keyshortcuts", "F3");
      await expect(drawn("dropped")).toHaveCount(0);
      await expect(dropped).not.toHaveAttribute("aria-keyshortcuts");
      await expect(drawn("landed")).toHaveText("F9");
    });
  } finally {
    await launched.close();
  }
});
