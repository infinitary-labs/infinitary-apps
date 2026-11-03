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
    // INF-2361: the fixture must run the served, composed program without
    // relaxing its policy. A different inline program still cannot execute.
    const untrustedRan = await page.evaluate(() => {
      const marker = "__record_pointer_untrusted__";
      const script = document.createElement("script");
      script.textContent = `window["${marker}"] = true;`;
      document.body.appendChild(script);
      const ran = (window as unknown as Record<string, unknown>)[marker] === true;
      script.remove();
      return ran;
    });
    expect(untrustedRan).toBe(false);
    const report = page.locator('[data-record-event="report"]');
    const summary = report.locator(":scope > summary");
    const whole = report.locator(":scope > [data-record-whole]");
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
    await test.info().attach("native-record-press", {
      body: JSON.stringify({
        task: detail.key,
        untrustedRan,
        closedAfterKeyboard: !(await whole.isVisible()),
        focused: await summary.evaluate((node) => node.ownerDocument.activeElement === node),
        report: await summary.innerText(),
      }),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});

/** INF-1484 W1: a live Activity repaint must not close retained raw details.
 * Real TaskService brief, actual Chromium/renderer/keyboard; the existing read bridge
 * only orders folded action arrivals. No provider, shared effect or device is required.
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixture slot for retained proof.
test("raw details stay open and keep keyboard focus when folded actions change", async ({}, testInfo) => {
  const app = await launchApp({
    userDataDir: pointerRecordHome({ revisedBrief: true }),
    withMockProvider: true,
  });
  try {
    const detail = await mountPointerRecord(app.page);
    const reading = detail.timeline?.find(
      (entry) => entry.details !== undefined && entry.entry.content.ref.source === "task-event",
    );
    if (reading?.entry.content.ref.source !== "task-event")
      throw new Error("The real revised brief has no raw source");
    const eventId = reading.entry.content.ref.eventId;
    const row = app.page.locator(`[data-timeline-entry="${reading.entry.id}"]`);
    await pressKey(row.locator(":scope > summary"), "Enter");
    const raw = row.locator("[data-record-source-details]");
    const summary = raw.locator(":scope > summary");
    await pressKey(summary, "Enter");
    await expect(raw).toHaveAttribute("open", "");
    await untilFocused(summary);
    const action = { at: detail.updatedAt + 1, text: "Read the saved search check" };
    const updated = {
      ...detail,
      activityLog: detail.activityLog.map((entry) =>
        entry.id === eventId ? { ...entry, actions: [action] } : entry,
      ),
    };
    for (const [stage, value] of [
      ["arrived", updated],
      ["removed", detail],
    ] as const) {
      await pushPointerRecord(app.page, value);
      await expect(row.locator('[data-record-folded="action"]')).toHaveCount(
        stage === "arrived" ? 1 : 0,
      );
      await expect(raw).toHaveAttribute("open", "");
      await expect(raw.locator("pre")).toBeVisible();
      await expect(raw.locator("pre")).toHaveText(reading.details ?? "");
      await untilFocused(summary);
      await testInfo.attach(`raw-${stage}`, {
        body: Buffer.from(
          JSON.stringify({
            entry: reading.entry.id,
            stage,
            open: (await raw.getAttribute("open")) !== null,
            focused: await summary.evaluate((node) => node.ownerDocument.activeElement === node),
            details: await raw.locator("pre").innerText(),
          }),
        ),
        contentType: "application/json",
      });
    }
    // A later repaint must retain an explicit close too, not merely force every panel open.
    await app.page.keyboard.press("Enter");
    await expect(raw).not.toHaveAttribute("open", "");
    await pushPointerRecord(app.page, updated);
    await expect(raw).not.toHaveAttribute("open", "");
    await untilFocused(summary);
  } finally {
    await app.close();
  }
});
