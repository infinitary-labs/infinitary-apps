import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ACTIONS } from "@shared/actions";
import { PERSONAL_WORKSPACE_NAME } from "../../src/core/paths";
import { OLD_PANEL_INSTRUCTIONS_PATH } from "../../src/core/personal/panelInstructions";
import { OPEN_KNOWLEDGE, row, tab } from "./knowledgeBrowser";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine, nowFrame } from "./rails";
import { savePointCount } from "./savePoints";
import {
  MOCK_STANDING_INSTRUCTION,
  PERSONALIZE_HIDE_PROMPT_MARKER,
  PERSONALIZE_INSTRUCTION_PROMPT_MARKER,
  PERSONALIZE_SHOW_PROMPT_MARKER,
  PERSONALIZE_TIDY_TITLE,
  personalize,
} from "./scenarios/personalize";
import { PERSONALIZE_THEME_PROMPT_MARKER, personalizeTheme } from "./scenarios/personalizeTheme";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * Preferences by talking (talk-to-personalize Step 1, plan section 7): each
 * ask is one `app_change` or retained `personalize` call through the real Firstmate session and the
 * mock provider, applied by the host the moment the core pushes it, and one
 * feed line - never a card. "switch to light" flips the theme; "hide tasks"
 * leaves the right rail zero-width while the board still has a row; "always
 * use compact rows in my panels" is a standing direction scoped to the
 * personal workspace (INF-1054). The preferences relaunch proof is
 * preferences.spec.ts.
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [personalize, personalizeTheme],
  });
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
  await say(page, `${SPAWN_PROMPT_MARKER} ${PERSONALIZE_TIDY_TITLE}`);
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

/**
 * The personal workspace's tasks still open or underway, by key. A crewmate
 * there builds in place, and the host commits its work when it reports,
 * before it closes the task (`commitLiveTurn`): once none is left, every
 * save point a crewmate makes there is already in the workspace's history.
 */
function buildingInWorkspace(page: Page): Promise<string[]> {
  return page.evaluate(
    async (name) =>
      (await window.infinitary.tasks.board()).tasks
        .filter(
          (task) =>
            task.repo?.name === name && (task.status === "open" || task.status === "active"),
        )
        .map((task) => task.key),
    PERSONAL_WORKSPACE_NAME,
  );
}

/**
 * INF-1054 (the captain's "A. One store, one way in: panel instructions are
 * ordinary directions"): a panel instruction is one standing direction
 * scoped to the personal workspace, listed with the captain's other
 * directions, and the workspace gets no file and no commit for it.
 */
test("a panel instruction is a standing direction for the personal workspace", async () => {
  const { app, page, userDataDir } = launched;
  const workspace = join(userDataDir, "fleet", "personal");
  // INF-1131: the file shares one app, and the crewmate the hide-tasks test
  // started builds its panel in this workspace, commits when it reports, and
  // closes when the first mate closes its finished work.
  // The count starts once no crewmate there is still at work, so it measures
  // only what the direction did. Run alone, nothing is at work.
  await expect.poll(() => buildingInWorkspace(page), { timeout: 30_000 }).toEqual([]);
  // That task's close leaves its note for the captain (INF-1677); closing it
  // here keeps the check below about what the direction itself shows.
  for (const card of await page.evaluate(() => window.infinitary.cards.list()))
    await page.evaluate((id) => window.infinitary.cards.close(id), card.id);
  const before = savePointCount(workspace);
  await say(page, PERSONALIZE_INSTRUCTION_PROMPT_MARKER);
  await expect(
    feedLine(page, ACTIONS.direction.done({ op: "add", text: MOCK_STANDING_INSTRUCTION })),
  ).toBeVisible({ timeout: 30_000 });
  const listed = await page.evaluate(() =>
    window.infinitary.plugins.read("knowledge.directions", { scope: "all" }),
  );
  const saved =
    listed.state === "ready"
      ? listed.rows.find(({ text }) => text === MOCK_STANDING_INSTRUCTION)
      : undefined;
  expect(saved).toMatchObject({ scopeName: PERSONAL_WORKSPACE_NAME, authority: "instruction" });
  expect(existsSync(join(workspace, OLD_PANEL_INSTRUCTIONS_PATH))).toBe(false);
  expect(savePointCount(workspace)).toBe(before);
  await expect(page.locator("[data-card-layer]")).toHaveCount(0);
  // The captain sees it among their directions in the Knowledge browser.
  await runFromSearch(app, page, OPEN_KNOWLEDGE);
  await pressKey(tab(page, "directions"), "Enter");
  await expect(row(page, saved?.id ?? "")).toContainText(MOCK_STANDING_INSTRUCTION);
  await page.screenshot({ path: test.info().outputPath("panel-instruction-direction.png") });
});
