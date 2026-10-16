import { expect, test } from "@playwright/test";
import { STANDARD_PLACEHOLDER } from "@shared/firstRun";
import { scratchDir } from "../helpers/scratchDirs";
import { DICTATION_KEY, hintOnThisComputer } from "./dictation";
import { launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";

test("dictation key taps toggle talking while a hold stops on release", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-voice-claude-")) },
  });
  const { page } = launched;
  const abandon = page.getByRole("button", { name: "Abandon" });
  try {
    await expect(page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER))).toBeVisible();
    await page.waitForTimeout(1000); // Let the asynchronous voice capability check settle.
    // A hold remains live until release, then ends without latching.
    await page.keyboard.down(DICTATION_KEY);
    await expect(abandon).toBeVisible();
    await page.waitForTimeout(600);
    await page.keyboard.up(DICTATION_KEY);
    await expect(abandon).toHaveCount(0);

    // A quick tap leaves the microphone active. Another quick tap stops it.
    await page.keyboard.down(DICTATION_KEY);
    await page.waitForTimeout(80);
    await page.keyboard.up(DICTATION_KEY);
    await expect(abandon, "quick press should leave talking started").toBeVisible();
    await page.screenshot({ path: test.info().outputPath("voice-quick-press-on.png") });
    await page.waitForTimeout(450);
    await page.keyboard.down(DICTATION_KEY);
    await expect(abandon, "second press should stop talking").toHaveCount(0);
    await page.keyboard.up(DICTATION_KEY);
    await expect(abandon).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("voice-second-press-off.png") });

    // A later hold still works after a toggled session has stopped.
    await page.keyboard.down(DICTATION_KEY);
    await expect(abandon).toBeVisible();
    await page.waitForTimeout(600);
    await page.keyboard.up(DICTATION_KEY);
    await expect(abandon).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
