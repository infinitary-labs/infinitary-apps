import { expect, test } from "@playwright/test";
import { reportSummary } from "../../src/shared/feed";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_COMPLETION_TEXT, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { dockSummaryLine, dockTitle, reportLine, taskKey } from "./rails";

/**
 * A task's updates in the Activity panel: each line carries the task's key
 * and what it said, never the task's long title, and the same lines read
 * the same after a restart, the collapsed panel showing the last of them.
 */

let launched: LaunchedApp;

test.afterAll(async () => {
  await launched?.close();
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("task updates show the key and content without a long title", async ({}, testInfo) => {
  launched = await launchApp({ withMockProvider: true });
  const { page } = launched;
  const title = "Make the activity updates readable when task titles are lengthy";
  const input = promptInput(page);
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const key = await taskKey(page, title);
  const report = reportLine(page, key).last();
  await expect(report).toBeVisible({ timeout: 30_000 });

  const update = reportSummary(MOCK_COMPLETION_TEXT);
  await expect(report.locator("[data-feed-key]")).toHaveText(key);
  await expect(report.locator("[data-feed-text]")).toContainText(update);
  const picture = testInfo.outputPath("task-updates.png");
  await page.screenshot({ path: picture });
  await testInfo.attach("Task key and update in Activity", {
    path: picture,
    contentType: "image/png",
  });
  await expect(report.locator("[data-feed-text]")).not.toContainText(title);

  // The same derived feed is read again on restart; no stored title prefix returns.
  await page.getByRole("button", { name: `Collapse ${dockTitle("activity")}` }).click();
  const { userDataDir, homeDir } = launched;
  await launched.close();
  launched = await launchApp({ withMockProvider: true, userDataDir, homeDir });
  await expect(dockSummaryLine(launched.page, "activity")).toBeVisible();
  const restored = reportLine(launched.page, key).last();
  await expect(restored).toBeVisible();
  await expect(restored.locator("[data-feed-key]")).toHaveText(key);
  await expect(restored.locator("[data-feed-text]")).toContainText(update);
  await expect(restored.locator("[data-feed-text]")).not.toContainText(title);
});
