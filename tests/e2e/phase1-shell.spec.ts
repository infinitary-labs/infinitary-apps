import { expect, test } from "@playwright/test";
import { reportSummary } from "../../src/shared/feed";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { DICTATION_KEY } from "./dictation";
import { type LaunchedApp, launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { MOCK_COMPLETION_TEXT } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, startedLine, taskKey } from "./rails";

/**
 * Phase 1 acceptance (docs/architecture.md §17): walk the shell states
 * listening (the dictation key, synthetic) -> working (stub card) -> settings and
 * back in the dark theme; screenshots land in each test's own output directory
 * (docs/testing.md, "Per-run e2e evidence") for review against the design
 * skill's reference states.
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
      // Let the tesseract morph into the listening rings before the shot.
      await page.waitForTimeout(1200);
      await page.screenshot({ path: test.info().outputPath(`${theme.name}-listening.png`) });
      await page.keyboard.up(DICTATION_KEY);
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Null state",
        { timeout: 15_000 },
      );
      // The fake e2e voice model cannot transcribe; close the quiet error
      // notice if it surfaced.
      const close = page.getByRole("button", { name: "Close", exact: true });
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
      await input.fill("commission a crewmate: refactor the auth middleware");
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
      await page.waitForTimeout(400);
      await page.screenshot({ path: test.info().outputPath(`${theme.name}-idle.png`) });
    });

    test("settings opens as its own state, and the keyboard leaves it", async () => {
      const { page } = launched;
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Settings",
      );
      // Focus lands on the back control, so a keyboard user leaves the way
      // they came.
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Null state",
      );
    });

    if (theme.name === "dark") {
    }
  });
}
