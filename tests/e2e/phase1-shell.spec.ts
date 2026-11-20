import { expect, test } from "@playwright/test";
import { reportSummary } from "../../src/shared/feed";
import { scratchDir } from "../helpers/scratchDirs";
import { firstmateClipDrawn, waitForFirstmateIdle } from "./crew";
import { DICTATION_KEY } from "./dictation";
import { type LaunchedApp, launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { MOCK_COMPLETION_TEXT, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, startedLine, taskKey } from "./rails";
import { cardLeave } from "./stack";

/**
 * Phase 1 acceptance (docs/architecture.md §17): walk the shell states
 * listening (the dictation key, synthetic) -> working (stub card) in the dark
 * theme; screenshots land in each test's own output directory (docs/testing.md,
 * "Per-run e2e evidence") for review against the design skill's reference
 * states. Settings and back is the browser test's
 * (tests/browser/phase1-shell.test.tsx).
 */

const themes = [{ name: "dark" }] as const;

for (const theme of themes) {
  test.describe(`${theme.name} theme`, () => {
    let launched: LaunchedApp;

    test.beforeAll(async () => {
      // The Claude row is only offered when its client is present, so pin
      // a stand-in: the offered catalog is then the same on
      // any machine, and nothing here can reach a real sign-in.
      launched = await launchApp({
        withMockProvider: true,
        env: {
          INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
        },
      });
      await expect
        .poll(() => launched.page.evaluate(() => document.body.dataset.theme))
        .toBe(theme.name);
      // Every case below needs the ungated home: a subscription that answers.
      await expect(promptInput(launched.page)).toBeEnabled({ timeout: 20_000 });
    });

    test.afterAll(async () => {
      await launched.close();
    });

    test("the dictation key holds into listening and release returns", async () => {
      const { page } = launched;
      await page.keyboard.down(DICTATION_KEY);
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Listening",
      );
      await expect(page.getByRole("img", { name: "First mate - listening" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Live voice level" })).toBeVisible();
      // The tesseract has morphed into the listening rings before the shot.
      await firstmateClipDrawn(page, "attend");
      await page.screenshot({ path: test.info().outputPath(`${theme.name}-listening.png`) });
      await page.keyboard.up(DICTATION_KEY);
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Null state",
        { timeout: 15_000 },
      );
      // The fake e2e voice model cannot transcribe; close the quiet error
      // notice if it surfaced.
      const close = cardLeave(page);
      if (await close.isVisible().catch(() => false)) {
        await close.click();
      }
    });

    test("escape abandons a recording", async () => {
      const { page } = launched;
      await page.keyboard.down(DICTATION_KEY);
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Listening",
      );
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Null state",
      );
      await page.keyboard.up(DICTATION_KEY);
    });

    test("submitting a prompt heats Firstmate only while it spawns", async () => {
      const { page } = launched;
      // The app opens with a 2.1 s greet, and a submit during an emote waits
      // for it to end, so a short turn can finish before working ever shows
      // (INF-2045: run alone, this test submitted mid-greet and missed it).
      // Start from idle so the submit heats the first mate at once.
      await waitForFirstmateIdle(page);
      const input = promptInput(page);
      await input.click();
      await input.fill(`${SPAWN_PROMPT_MARKER} refactor the auth middleware`);
      await input.press("Enter");
      // Thinking: the Firstmate agent heats up while it decides and spawns.
      await expect(page.getByRole("img", { name: "First mate - working" })).toBeVisible();
      const key = await taskKey(page, "refactor the auth middleware");
      await expect(startedLine(page, key)).toBeVisible({ timeout: 20_000 });
      // Crew work is not a task card and does not animate the tesseract.
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Null state",
      );
      await expect(
        reportLine(page, key).filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("img", { name: "First mate - idle" })).toBeVisible({
        timeout: 20_000,
      });
      await firstmateClipDrawn(page, "settle");
      await page.screenshot({ path: test.info().outputPath(`${theme.name}-idle.png`) });
    });

    if (theme.name === "dark") {
    }
  });
}
