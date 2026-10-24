import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";
import {
  mountPointerRecord,
  pointerRecordHome,
  pushPointerBoard,
  pushPointerRecord,
} from "./recordPointer";
import { pressKey, untilFocused } from "./windowKeys";

/**
 * INF-1140: a native pointer press still opens/closes an Activity line when
 * the read bridge pushes between down and up. The real stored report and
 * renderer run in isolated Electron; the stand-in bridge orders the update,
 * never the browser click. No shared resource beyond the desktop lane.
 */
test("Activity keeps a native press across live updates, including growing folded content", async () => {
  const app = await launchApp({ userDataDir: pointerRecordHome(), withMockProvider: true });
  try {
    const { page } = app;
    const detail = await mountPointerRecord(page);
    const report = page.locator('[data-record-event="report"]');
    const summary = report.locator(":scope > summary");
    const whole = report.locator("[data-record-whole]");
    const press = async (update: () => Promise<void>) => {
      const box = await summary.boundingBox();
      if (!box) throw new Error("The Activity summary has no pointer target");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      try {
        await update();
      } finally {
        await page.mouse.up();
      }
    };
    // First establish that a real, unmodified Chromium click reaches this view.
    await press(async () => {});
    await expect(whole).toBeVisible();
    await press(async () => {});
    await expect(whole).toBeHidden();

    await test.step("both edges survive detail and board pushes before release", async () => {
      const update = async () => {
        await pushPointerRecord(page, detail);
        await pushPointerBoard(page);
        await pushPointerRecord(page, detail);
      };
      await press(update);
      await expect(whole).toBeVisible();
      await press(update);
      await expect(whole).toBeHidden();
    });

    await test.step("replacing an earlier line does not detach the pressed line", async () => {
      const updated = {
        ...detail,
        activityLog: detail.activityLog.map((row, index) =>
          index === 0 ? { ...row, text: "Created the task to fix search." } : row,
        ),
      };
      await press(() => pushPointerRecord(page, updated));
      await expect(whole).toBeVisible();
      await press(() => pushPointerRecord(page, detail));
      await expect(whole).toBeHidden();
    });

    await test.step("new folded actions arrive without replacing the pressed summary", async () => {
      const action = { at: detail.updatedAt + 1, text: "Read the search journey's result" };
      const updated = {
        ...detail,
        activityLog: detail.activityLog.map((row) =>
          row.kind === "report" ? { ...row, actions: [action] } : row,
        ),
      };
      await press(() => pushPointerRecord(page, updated));
      await expect(whole).toBeVisible();
      await expect(report.locator('[data-record-folded="action"]')).toHaveText(
        new RegExp(action.text),
      );
      await expect(report.locator("[data-record-folded-count]")).toHaveText("+1");
      await press(() => pushPointerRecord(page, detail));
      await expect(whole).toBeHidden();
      await expect(report.locator('[data-record-folded="action"]')).toHaveCount(0);
      await expect(report.locator("[data-record-folded-count]")).toBeHidden();
    });

    await test.step("a release outside still cancels; updates retain keyboard focus", async () => {
      const box = await summary.boundingBox();
      if (!box) throw new Error("The Activity summary has no pointer target");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await pushPointerRecord(page, detail);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await expect(whole).toBeHidden();
      await pressKey(summary, "Enter");
      await expect(whole).toBeVisible();
      await pushPointerRecord(page, detail);
      await untilFocused(summary);
      await page.keyboard.press("Enter");
      await expect(whole).toBeHidden();
    });
  } finally {
    await app.close();
  }
});
