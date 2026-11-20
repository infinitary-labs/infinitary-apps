import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";
import { startMockProvider } from "./mockProvider";
import { pastePictures, promptInput } from "./prompt";
import {
  newestPictures,
  PICTURE_RETRY_ANSWER,
  PICTURE_RETRY_WORDS,
  pictureRetry,
} from "./scenarios/pictureRetry";

/**
 * INF-1433: Ask again sends the original retained picture, not just the words.
 * Real pasted PNG bytes go through the composer, saved message, host notice,
 * and session into the local provider's newest input (not its history).
 * The picture-only case restarts the isolated app before the click.
 * Prerequisites: built Electron app; only scratch homes and a loopback provider.
 */
for (const words of [PICTURE_RETRY_WORDS, ""]) {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
  test(`Ask again retains a picture ${words ? "with words" : "without words after restart"}`, async ({}, testInfo) => {
    const provider = await startMockProvider({ scenarios: [pictureRetry] });
    let launched: LaunchedApp | undefined;
    try {
      launched = await launchApp({ reuseMockProvider: provider });
      await expect(promptInput(launched.page)).toBeEnabled();
      await pastePictures(promptInput(launched.page), [{ name: "screenshot.png" }]);
      await expect(launched.page.locator("[data-voice-input-attachment]")).toHaveCount(1);
      await promptInput(launched.page).fill(words);
      await promptInput(launched.page).press("Enter");
      await expect(
        launched.page.getByRole("button", { name: "Ask again", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      const original = provider.requestBodies().find((body) => newestPictures(body).length > 0);
      expect(original).toBeDefined();
      const pictures = newestPictures(original as string);
      expect(pictures).toHaveLength(1);

      if (!words) {
        const { userDataDir, homeDir } = launched;
        await launched.close();
        launched = undefined;
        launched = await launchApp({ reuseMockProvider: provider, userDataDir, homeDir });
      }
      const before = provider.requestBodies().length;
      await launched.page.getByRole("button", { name: "Ask again", exact: true }).click();
      await expect(launched.page.getByText(PICTURE_RETRY_ANSWER, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const retry = provider
        .requestBodies()
        .slice(before)
        .find((body) => newestPictures(body).length > 0);
      expect(retry).toBeDefined();
      expect(newestPictures(retry as string)).toEqual(pictures);
      writeFileSync(
        testInfo.outputPath("picture-retry.json"),
        JSON.stringify(
          { original: JSON.parse(original as string), retry: JSON.parse(retry as string) },
          null,
          2,
        ),
      );
    } finally {
      await launched?.close();
      await provider.close();
    }
  });
}
