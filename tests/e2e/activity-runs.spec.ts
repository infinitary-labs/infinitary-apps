import { expect, type Page, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { feedLineFrom } from "../../src/shared/feed";
import { waitForFirstmateIdle } from "./crew";
import { THIS_DESKTOP } from "./desktop";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { dockTitle, feedLine } from "./rails";

/**
 * A run of the captain's own steps on one setting settles where it is
 * written (docs/orchestrator-contract.md, "Settled runs"): one drag of the
 * window wash is one Activity line naming where it started and where it
 * settled, and one change on the record, also after a restart. Anything
 * else in Activity - Firstmate's change among them - ends the run, and a
 * panel folded and opened again leaves nothing.
 */

const wash = ACTIONS["window-wash"];

/** The captain's line for a run of the wash from one strength to another. */
function captainWash(from: number, to: number): string {
  const text = wash.settled?.({ strength: from }, { strength: to }) ?? "";
  return feedLineFrom({ type: "personalized", actor: "captain", text })?.text ?? text;
}

/** Activity's lines as the core keeps them, oldest first. */
async function activityLines(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.infinitary.feed.recent())).map((line) => line.text);
}

/** The titles of the operations on the record, oldest first. */
async function operations(page: Page): Promise<string[]> {
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  return board.tasks
    .filter((task) => task.kind === "operation")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((task) => task.title);
}

/** The wash slider moved through `strengths`, one saved step each, as a drag moves it. */
async function dragWash(page: Page, strengths: number[]): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Window wash" });
  for (const strength of strengths) {
    await slider.fill(String(strength));
    // Each step is saved on its own, as a drag saves it.
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.settings.getAppearance())).washStrength,
      )
      .toBe(strength);
  }
  await page.keyboard.press("Escape");
}

test("a drag of the window wash is one Activity line and one change, also after a restart", async () => {
  // Its setting is the Mac's window wash, which Settings offers only there.
  test.skip(!THIS_DESKTOP.material, "the window wash is the Mac's");
  let launched: LaunchedApp = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = launched;
  try {
    // One drag: one line from where it started to where it settled, and one change.
    const { page } = launched;
    const before = await operations(page);
    await dragWash(page, [20, 35, 50]);
    await expect(feedLine(page, captainWash(0, 50))).toBeVisible();
    const lines = await activityLines(page);
    expect(lines.filter((line) => line === captainWash(0, 50))).toHaveLength(1);
    expect(lines).not.toContain(captainWash(0, 20));
    expect(lines).not.toContain(captainWash(0, 35));
    expect(await operations(page)).toEqual([
      ...before,
      wash.settled?.({ strength: 0 }, { strength: 50 }),
    ]);
  } finally {
    await launched.close();
  }

  launched = await launchApp({ withMockProvider: true, userDataDir, homeDir });
  try {
    const { page } = launched;
    // After a restart: still the one line and the one change.
    await expect(feedLine(page, captainWash(0, 50))).toBeVisible();
    expect((await activityLines(page)).filter((line) => line === captainWash(0, 50))).toHaveLength(
      1,
    );
    const kept = await operations(page);
    expect(
      kept.filter((title) => title === wash.settled?.({ strength: 0 }, { strength: 50 })),
    ).toHaveLength(1);

    // Firstmate's change in the middle ends the captain's run: the next step starts another.
    await dragWash(page, [60]);
    await expect(feedLine(page, captainWash(50, 60))).toBeVisible();
    const input = promptInput(page);
    await input.fill(
      `${APP_CATALOG_PROMPT_MARKER}${JSON.stringify({ action: "window-wash", value: { strength: 30 } })}`,
    );
    await input.press("Enter");
    const firstmate = feedLineFrom({
      type: "personalized",
      actor: "firstmate",
      text: wash.done({ strength: 30 }),
    })?.text;
    if (!firstmate) throw new Error("Firstmate's change writes no line");
    await expect(feedLine(page, firstmate)).toBeVisible({ timeout: 30_000 });
    await waitForFirstmateIdle(page);
    await dragWash(page, [70]);
    await expect(feedLine(page, captainWash(30, 70))).toBeVisible();
    const after = await activityLines(page);
    const order = [captainWash(50, 60), firstmate, captainWash(30, 70)].map((line) =>
      after.indexOf(line),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(await operations(page)).toEqual([
      ...kept,
      wash.settled?.({ strength: 50 }, { strength: 60 }),
      wash.done({ strength: 30 }),
      wash.settled?.({ strength: 30 }, { strength: 70 }),
    ]);

    // A panel folded and opened again comes back where it started: no line, no change.
    const activity = page.locator('[data-side-panel="activity"]');
    const collapse = ACTIONS["panel-collapse"];
    const foldLines = [true, false].map(
      (collapsed) =>
        feedLineFrom({
          type: "personalized",
          actor: "captain",
          text: collapse.done({ surface: "activity", collapsed }),
        })?.text,
    );
    const linesBefore = await activityLines(page);
    const operationsBefore = await operations(page);
    await activity.getByRole("button", { name: `Collapse ${dockTitle("activity")}` }).click();
    await expect(activity).toHaveAttribute("data-side-panel-collapsed", "");
    await activity.getByRole("button", { name: `Expand ${dockTitle("activity")}` }).click();
    await expect(activity).not.toHaveAttribute("data-side-panel-collapsed", "");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.settings.getLayout())).collapsedPanels
            .activity,
      )
      .toBeFalsy();
    await expect.poll(() => activityLines(page)).toEqual(linesBefore);
    for (const line of foldLines) expect(await activityLines(page)).not.toContain(line);
    expect(await operations(page)).toEqual(operationsBefore);
  } finally {
    await launched.close();
  }
});
