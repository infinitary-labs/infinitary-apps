import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { LIVE_VALIDATION_WORDS } from "../../src/shared/liveValidation";
import { launchApp } from "../e2e/launch";
import { pressKey } from "../e2e/windowKeys";

// INF-100 captain reply: live proof belongs primarily in the merge completion
// card; the record keeps supporting history, behind its existing Details row.
// This component check exercises the production template's native disclosure,
// not a copied layout or a source-text assertion.
test("record proof stays behind Details and remains keyboard-accessible", async () => {
  const launched = await launchApp();
  const { page } = launched;
  try {
    await page.goto("about:blank");
    await page.setContent(
      readFileSync("src/renderer/src/plugins/builtin/record/record.html", "utf8"),
    );
    // The record painter reveals these regions when it receives proof. A
    // prose-only change is a truthful no-running-surface presentation fixture.
    await page
      .locator(
        '[data-record-content], [data-record-section="details"], [data-record-section="validation"]',
      )
      .evaluateAll((nodes) => {
        for (const node of nodes) (node as HTMLElement).hidden = false;
      });
    await page.locator("[data-validation-label]").evaluate((node, label) => {
      node.textContent = label;
    }, LIVE_VALIDATION_WORDS.noSurface);
    const proof = page.locator('[data-record-section="validation"]');
    const details = page.locator('[data-record-section="details"] > summary');
    await expect(proof).toBeHidden();
    await pressKey(details, "Enter");
    await expect(proof).toBeVisible();
    await expect(proof).toContainText(LIVE_VALIDATION_WORDS.noSurface);
    await pressKey(details, "Enter");
    await expect(proof).toBeHidden();
    await expect(proof).toHaveCount(1);
  } finally {
    await launched.close();
  }
});
