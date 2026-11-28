import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import * as m from "../../src/shared/i18n/messages.generated";
import { launchApp } from "./launch";
import { pressKey } from "./windowKeys";

const KEPT = "text the person copied before";

const clipboardText = (app: ElectronApplication) =>
  app.evaluate(({ clipboard }) => clipboard.readText());
const keepClipboard = (app: ElectronApplication) =>
  app.evaluate(({ clipboard }, text) => clipboard.writeText(text), KEPT);

/** Drags across a row's description with the real pointer, the way a person selects words. */
async function dragAcross(page: Page, text: string) {
  const box = await page.getByText(text, { exact: true }).boundingBox();
  if (!box) throw new Error("The description is not on screen");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 8 });
  await page.mouse.up();
}

// The captain's ask for Copy on select (INA-32's plan): off until switched on
// from the keyboard, then letting go of a drag, or a double-click, copies the
// words; a click with nothing selected leaves the clipboard as it was.
test("Copy on select copies a drag and a double-click only while it is on", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    await page.getByRole("button", { name: m.shellTopBarSettings(), exact: true }).click();
    await page.getByRole("tab", { name: m.panelSettingsAppearance(), exact: true }).click();
    const copy = page.getByRole("switch", {
      name: m.settingsAppearanceCopyOnSelect(),
      exact: true,
    });
    const description = m.settingsAppearanceCopyOnSelectDescription();
    await expect(copy).not.toBeChecked();

    await keepClipboard(app);
    await dragAcross(page, description);
    expect(await clipboardText(app), "off: a drag copies nothing").toBe(KEPT);

    await pressKey(copy, "Space");
    await expect(copy).toBeChecked();

    await keepClipboard(app);
    await page.mouse.click(5, 5);
    expect(await clipboardText(app), "a click with nothing selected").toBe(KEPT);

    await dragAcross(page, description);
    await expect.poll(() => clipboardText(app)).toBe(description);

    await keepClipboard(app);
    // The title is a block wider than its words: the left edge lands on its first word.
    await page
      .getByText(m.settingsAppearanceCopyOnSelect(), { exact: true })
      .first()
      .dblclick({ position: { x: 4, y: 8 } });
    await expect.poll(async () => (await clipboardText(app)).trim()).toBe("Copy");
  } finally {
    await launched.close();
  }
});
