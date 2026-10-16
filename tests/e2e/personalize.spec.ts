import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ACTIONS } from "@shared/actions";
import { standingInstructionLine } from "../../src/core/personal/panelLines";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import {
  APP_CATALOG_PROMPT_MARKER,
  MOCK_STANDING_INSTRUCTION,
  PERSONALIZE_HIDE_PROMPT_MARKER,
  PERSONALIZE_INSTRUCTION_PROMPT_MARKER,
  PERSONALIZE_SHOW_PROMPT_MARKER,
  PERSONALIZE_THEME_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine, nowFrame } from "./rails";
import { oneNewSavePoint, savePointCount } from "./savePoints";

/**
 * Preferences by talking (talk-to-personalize Step 1, plan section 7): each
 * ask is one `app_change` or retained `personalize` call through the real Firstmate session and the
 * mock provider, applied by the host the moment the core pushes it, and one
 * feed line - never a card. "switch to light" flips the theme; "hide tasks"
 * leaves the right rail zero-width while the board still has a row; "always
 * use compact rows in my panels" appends to the workspace's captain skill
 * and commits it. The preferences relaunch proof is preferences.spec.ts.
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

async function say(page: Page, words: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(words);
  await input.press("Enter");
}

function theme(page: Page): Promise<string> {
  return page.evaluate(() => document.body.dataset.theme ?? "");
}

test("switch to light flips the theme with one feed line and no card", async () => {
  const { page } = launched;
  expect(await theme(page)).toBe("dark");
  await page.screenshot({ path: test.info().outputPath("theme-before.png") });
  await askFirstmate(page, PERSONALIZE_THEME_PROMPT_MARKER);
  await expect(feedLine(page, ACTIONS.theme.done({ theme: "light" }))).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => theme(page)).toBe("light");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("theme-after.png") });
  await page.keyboard.press("Escape");
  const operations = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.filter(
    (t) => t.kind === "operation",
  );
  const applied = operations.filter((t) => t.title === ACTIONS.theme.done({ theme: "light" }));
  expect(applied).toHaveLength(1);
  // No card: the line is the whole answer (captain decision Q5).
  await expect(page.locator("[data-card-layer]")).toHaveCount(0);
});

test("hide tasks removes the panel without losing its tasks, and show brings it back", async () => {
  const { page } = launched;
  // A crewmate at work puts a row on the board, so Tasks docks on the right.
  await say(page, `${SPAWN_PROMPT_MARKER} tidy the personalize fixture`);
  await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: test.info().outputPath("panel-before.png") });
  await say(page, PERSONALIZE_HIDE_PROMPT_MARKER);
  await expect(
    feedLine(page, ACTIONS.panel.done({ surface: "Tasks", description: "hidden" })),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-side-panel="now"]')).toHaveCount(0);
  await expect(page.locator("[data-card-layer]")).toHaveCount(0);
  // The record is the core's, and it says exactly that.
  const layout = await page.evaluate(() => window.infinitary.settings.getLayout());
  expect(layout.hiddenPanels).toEqual({ now: true });
  await page.screenshot({ path: test.info().outputPath("panel-hidden.png") });

  await say(page, PERSONALIZE_SHOW_PROMPT_MARKER);
  await expect(
    feedLine(page, ACTIONS.panel.done({ surface: "Tasks", description: "shown" })),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-side-panel="now"]')).toHaveCount(1);
  await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("panel-shown.png") });
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  for (const description of ["hidden", "shown"]) {
    const applied = board.tasks.filter(
      (t) =>
        t.kind === "operation" && t.title === ACTIONS.panel.done({ surface: "Tasks", description }),
    );
    expect(applied).toHaveLength(1);
  }
  await test.info().attach("panel-saved-state", {
    body: JSON.stringify(
      {
        layout: await page.evaluate(() => window.infinitary.settings.getLayout()),
        operations: board.tasks.filter((t) => t.kind === "operation"),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("move Activity to the right changes its rail without changing collapse or opening a card", async () => {
  const { page } = launched;
  const before = await page.evaluate(() => window.infinitary.settings.getLayout());
  await say(
    page,
    APP_CATALOG_PROMPT_MARKER +
      JSON.stringify({
        action: "panel",
        value: { surface: "activity", rail: "right", position: "top" },
      }),
  );
  await expect
    .poll(() => page.evaluate(() => window.infinitary.settings.getLayout()))
    .toMatchObject({
      collapsedPanels: before.collapsedPanels,
      hiddenPanels: before.hiddenPanels,
      placements: { ...before.placements, activity: { x: "right", y: "top" } },
    });
  await expect(page.locator('[data-rail="right"] [data-side-panel="activity"]')).toBeVisible();
  await expect(page.locator("[data-card-layer]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("panel-moved.png") });
});

test("a standing instruction appends to the workspace's captain skill and is committed", async () => {
  const { page, userDataDir } = launched;
  const workspace = join(userDataDir, "fleet", "personal");
  const before = savePointCount(workspace);
  await say(page, PERSONALIZE_INSTRUCTION_PROMPT_MARKER);
  await expect(feedLine(page, standingInstructionLine(MOCK_STANDING_INSTRUCTION))).toBeVisible({
    timeout: 30_000,
  });
  const skillPath = join(".claude", "skills", "captain", "SKILL.md");
  const skill = readFileSync(join(workspace, skillPath), "utf8");
  expect(skill).toContain("name: captain");
  expect(skill.trimEnd().endsWith(`- ${MOCK_STANDING_INSTRUCTION}`)).toBe(true);
  // One save point holds exactly that change, named as the host's guard
  // wants, with nothing left unsaved; its words are captainSkill.test.ts's.
  const saved = await oneNewSavePoint(workspace, before);
  expect(saved.paths).toEqual([skillPath]);
  await expect(page.locator("[data-card-layer]")).toHaveCount(0);
});
